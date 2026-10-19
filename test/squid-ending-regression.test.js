import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { readyRoomAction } from './helpers/room-clock.js';

function fixture(t, settings = {}, { start = true } = {}) {
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const users = 'ABCDEF'.split('').map(id => ({ id, name: `Ending ${id}` }));
  const data = { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const f = { data, users, get time() { return time; }, advance(ms) { time += ms; } };
  f.service = new RoomService({ data });
  f.room = f.service.create(users[0], { settings: { squid: true, squidMode: 'unlimited', squidUnitBB: 2, bombPot: true, durationMinutes: 30, ...settings } });
  f.cmd = (id, type, extra = {}) => f.service.command(data.users[id], f.room.code, { commandId: randomUUID(), type,
    handId: f.room.hand?.id, actionSeq: f.room.hand?.log.length, ...extra });
  for (const [seat, user] of users.entries()) {
    if (seat) f.service.join(user, f.room.code, f.room.invite);
    if (seat < 5) { f.cmd(user.id, 'sit', { seat, amountBB: 300 }); f.service.connections.set(`${f.room.code}:${user.id}`, 1); }
  }
  f.start = () => f.service.start(f.room, time, { automatic: true });
  f.win = winner => {
    for (let n = 0; f.room.hand.status === 'playing'; n++) {
      assert.ok(n < 60, 'fold-down must terminate');
      if (!readyRoomAction(f.service, f.room, value => { time = value; })) break;
      const actor = f.room.hand.actingId, actions = availableActions(f.room.hand, actor);
      f.cmd(actor, actor === winner ? actions.canCheck ? 'check' : 'call' : 'fold');
    }
    assert.deepEqual(f.room.hand.result.mainWinnerIds, [winner]);
    f.service.completeRabbit(f.room, time); conserved(f);
  };
  f.roundRows = () => data.ledger.filter(row => row.type === 'squidSettlement');
  f.restart = () => { f.service = new RoomService({ data }); };
  if (start) f.start();
  return f;
}

function conserved(f) {
  const r = f.room, members = Object.values(r.members);
  const pot = r.hand?.status === 'playing' ? r.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0;
  assert.equal(members.reduce((sum, m) => sum + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0)
    + Object.values(r.mini.squid.reserves).reduce((sum, amount) => sum + amount, 0) + pot,
  members.reduce((sum, m) => sum + m.totalBuyIn, 0), 'every bought-in point remains in chips, cashout, live pot or debt');
}

function settledExactlyOnce(f, expected) {
  const rows = f.roundRows();
  assert.equal(rows.length, Object.keys(expected).length);
  assert.equal(new Set(rows.map(row => row.roundSettlementId)).size, 1);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.playerId, row.amount])), expected);
  assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 0);
  for (const [id, amount] of Object.entries(expected)) {
    assert.equal(f.service.stats(id).miniNet, amount, `${id} lifetime statistics count the fish settlement once`);
    assert.equal(f.service.sessionFor(id, f.room.code).session.meMiniNet, amount, `${id} session statistics count the fish settlement once`);
  }
  conserved(f);
}

function noLiveFish(f) {
  const snapshot = structuredClone(f.data), view = f.service.state(f.room, 'A');
  assert.equal(view.mini.squid.active, false);
  assert.ok(view.players.every(p => p.squidCount === 0 && p.squidWon === false), 'inactive fish never look like an unsettled live round');
  assert.deepEqual(view.mini.squid.lastResult, f.room.mini.squid.lastResult, 'the complete settlement remains available for results');
  assert.deepEqual(f.data, snapshot, 'a state projection does not rewrite accounting or historical fish');
}

for (const mode of ['normal', 'unlimited']) test(`${mode}: four holders and one zero-fish player settle before the final cutoff ordinary hand`, t => {
  const f = fixture(t, { squidMode: mode });
  // This reproduces the screenshot's 2/2/0/1/1 distribution in unlimited mode.
  // The round has already started before entering the final five minutes.
  f.room.endsAt = f.time + 4 * 60000;
  for (const [index, winner] of ['A', 'A', 'B', 'B', 'C', 'D'].entries()) {
    if (index) f.start();
    f.win(winner);
    if (winner !== 'D') {
      assert.equal(f.room.mini.squid.active, true);
      assert.equal(f.roundRows().length, 0);
      const view = f.service.state(f.room, 'A');
      for (const p of view.players) assert.equal(p.squidCount, view.mini.squid.counts[p.id] ?? 0);
    }
  }
  const expected = mode === 'unlimited' ? { A: 40, B: 40, C: 20, D: 20, E: -120 } : { A: 20, B: 20, C: 20, D: 20, E: -80 };
  settledExactlyOnce(f, expected); noLiveFish(f);
  const historicCounts = structuredClone(f.room.mini.squid.lastResult.counts), archived = structuredClone(f.data.hands);
  assert.deepEqual(f.room.hand.squidCounts, historicCounts);
  f.start();
  assert.equal(f.room.hand.squidRound, null, 'no new fish round starts during the final five minutes');
  assert.equal(f.room.hand.bombPot, false); noLiveFish(f);
  assert.deepEqual(f.room.mini.squid.lastResult.counts, historicCounts);
  assert.deepEqual(f.data.hands, archived, 'starting an ordinary hand preserves every old fish record');
  f.win('E'); noLiveFish(f); settledExactlyOnce(f, expected);
});

test('all eight unlimited fish exhausted: four zero-fish players settle fully, including debts, with no duplicate on close or restore', t => {
  const f = fixture(t, { squidUnitBB: 100 });
  for (let index = 0; index < 8; index++) { if (index) f.start(); f.win('A'); }
  assert.equal(f.room.mini.squid.lastResult.tokensExhausted, true);
  assert.deepEqual(f.room.mini.squid.lastResult.counts, { A: 8, B: 0, C: 0, D: 0, E: 0 });
  const expected = { A: 32000, B: -8000, C: -8000, D: -8000, E: -8000 };
  settledExactlyOnce(f, expected); noLiveFish(f);
  for (const id of ['B', 'C', 'D', 'E']) assert.ok(f.room.members[id].squidDebt > 0);
  const commandId = randomUUID(); f.cmd('A', 'close', { commandId });
  const frozen = structuredClone(f.data);
  f.restart(); f.cmd('A', 'close', { commandId }); f.service.tick(f.room, f.time + 90000);
  assert.deepEqual(f.data, frozen, 'retried closure and restored ticks cannot repeat either settlement or cashout');
  settledExactlyOnce(f, expected); noLiveFish(f);
});

for (const mode of ['normal', 'unlimited']) test(`${mode}: a finishing bomb pot awards its fish once and separates poker payout from the fish settlement`, t => {
  const f = fixture(t, { squidMode: mode, bombIntervalMinutes: 1 }); f.win('A');
  for (const winner of ['B', 'C', 'D']) {
    f.advance(60000); f.start();
    assert.equal(f.room.hand.bombPot, true); assert.equal(f.room.hand.street, 'flop');
    assert.equal(f.room.hand.squidRound, 1); f.win(winner);
  }
  assert.equal(f.room.hand.squidAwardedId, 'D');
  const expected = { A: 20, B: 20, C: 20, D: 20, E: -80 };
  settledExactlyOnce(f, expected); noLiveFish(f);
  for (const id of Object.keys(expected)) {
    const pokerNet = f.data.hands.reduce((sum, h) => { const p = h.players.find(p => p.id === id); return sum + (p ? p.stack - p.startingStack : 0); }, 0);
    const stats = f.service.stats(id);
    assert.equal(stats.holdemNet, pokerNet); assert.equal(stats.net, pokerNet + expected[id]);
  }
});

test('expiry plays an unfinished original round to completion, forbids late entrants but allows scheduled bombs, then closes with one settlement', t => {
  const f = fixture(t); f.win('A');
  f.room.endsAt = f.time + 1; f.room.nextBombAt = f.time;
  f.advance(1);
  // An older client's accepted late seat must remain outside this round; all
  // of those chips are returned when the original players finish it.
  f.cmd('F', 'sit', { seat: 5, amountBB: 100, entryMode: 'post' });
  f.service.connections.set(`${f.room.code}:F`, 1);
  for (const winner of ['B', 'C', 'D']) {
    f.start(); assert.equal(f.room.hand.squidRound, 1); assert.equal(f.room.hand.bombPot, winner === 'B');
    assert.ok(!f.room.hand.players.some(p => p.id === 'F')); f.win(winner);
  }
  assert.equal(f.room.status, 'closed');
  assert.equal(f.room.hand.number, 4); assert.equal(f.room.hand.status, 'complete');
  assert.equal(f.room.mini.squid.round, 1);
  assert.equal(f.room.members.F.cashedOut, 1000); assert.equal(f.room.members.F.totalBuyIn, 1000);
  const expected = { A: 20, B: 20, C: 20, D: 20, E: -80 };
  settledExactlyOnce(f, expected); noLiveFish(f);
  const frozen = structuredClone(f.data); f.service.tick(f.room, f.time + 100000); f.service.finish(f.room, f.time + 100000);
  assert.deepEqual(f.data, frozen);
});

test('expiry recovery closes an unavailable unfinished round after its one 90-second window without losing or repeating fish', t => {
  const f = fixture(t); f.win('A');
  // Keep a zero-fish player online so the separate five-second absent-loss rule
  // cannot finish this fixture early. There are too few players to deal again.
  for (const id of ['A', 'B', 'C', 'D']) f.service.connections.set(`${f.room.code}:${id}`, 0);
  f.room.endsAt = f.time; f.service.connectionChanged(f.room, f.time);
  const deadline = f.service.state(f.room, 'E').mini.squid.expiryGraceEndsAt;
  assert.equal(deadline, f.time + 90000);
  f.advance(89999); f.service.tick(f.room, f.time); assert.notEqual(f.room.status, 'closed');
  f.advance(1); f.service.tick(f.room, f.time);
  assert.equal(f.room.status, 'closed');
  assert.equal(f.room.mini.squid.lastResult.reason, 'partial');
  settledExactlyOnce(f, { A: 80, B: -20, C: -20, D: -20, E: -20 }); noLiveFish(f);
  const frozen = structuredClone(f.data); f.restart(); f.service.tick(f.room, f.time + 90000);
  assert.deepEqual(f.data, frozen);
});

test('closing an ordinary final hand after an earlier fish round does not pay those old fish again', t => {
  const f = fixture(t); f.room.endsAt = f.time + 4 * 60000;
  for (const [index, winner] of ['A', 'B', 'C', 'D'].entries()) { if (index) f.start(); f.win(winner); }
  const expected = { A: 20, B: 20, C: 20, D: 20, E: -80 };
  f.start(); assert.equal(f.room.hand.squidRound, null);
  f.room.endsAt = f.time; f.win('E');
  assert.equal(f.room.status, 'closed'); settledExactlyOnce(f, expected); noLiveFish(f);
  const settledPlayers = f.service.sessionFor('A', f.room.code).session.players;
  assert.equal(settledPlayers.reduce((sum, p) => sum + p.net, 0), 0, 'final results preserve the whole-table balance');
});

test('closing before the first deal returns exactly the funded chips, with no synthetic hands, fish or profit', t => {
  const f = fixture(t, {}, { start: false }), commandId = randomUUID();
  f.cmd('A', 'close', { commandId });
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.hand, null); assert.equal(f.room.startedAt, null);
  assert.equal(f.data.hands.length, 0); assert.equal(f.roundRows().length, 0);
  const session = f.service.sessionFor('A', f.room.code).session;
  assert.equal(session.players.length, 5);
  assert.ok(session.players.every(p => p.hands === 0 && p.net === 0 && p.totalBuyIn === 3000));
  assert.ok(Object.values(f.room.members).filter(m => m.totalBuyIn > 0).every(m => m.stack === 0 && m.cashedOut === 3000));
  const frozen = structuredClone(f.data);
  f.advance(5000); f.cmd('A', 'close', { commandId }); f.service.tick(f.room, f.time);
  assert.deepEqual(f.data, frozen); conserved(f);
});

test('final scores include departed holders and the full unpaid loser balance after manual closure', t => {
  const f = fixture(t, { squidUnitBB: 200 }); f.win('A');
  f.cmd('A', 'stand', { expectedSquidRound: 1, expectedSquidCost: 0 });
  const cashed = f.room.members.A.cashedOut;
  f.cmd('B', 'stand', { expectedSquidRound: 1, expectedSquidCost: 16000 });
  const loserCashout = f.room.members.B.cashedOut;
  const commandId = randomUUID(); f.cmd('A', 'close', { commandId });
  const expected = { A: 8000, B: -2000, C: -2000, D: -2000, E: -2000 };
  settledExactlyOnce(f, expected); noLiveFish(f);
  assert.equal(f.room.members.A.cashedOut, cashed + 8000);
  assert.equal(f.room.members.B.cashedOut, loserCashout, 'historical cashout is not rewritten to hide a later loss');
  assert.equal(f.room.members.B.squidDebt, 2000);
  const session = f.service.sessionFor('A', f.room.code).session;
  assert.equal(session.players.length, 5);
  for (const player of session.players) {
    const m = f.room.members[player.id];
    assert.equal(player.net, m.cashedOut - (m.squidDebt ?? 0) - m.totalBuyIn);
    assert.equal(player.miniNet, expected[player.id]);
  }
  const frozen = structuredClone(f.data); f.restart(); f.cmd('A', 'close', { commandId });
  f.service.tick(f.room, f.time + 90000); assert.deepEqual(f.data, frozen);
});
