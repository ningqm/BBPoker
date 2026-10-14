import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { EncryptedStore } from '../src/store.js';
import { directRecordLibrary } from '../src/direct-records.js';

// Independent rule oracle. Use public room commands and real shuffled poker
// hands; scripted folds choose a winner, not a deck, equity or payout result.
const IDS = [...'ABCDEFGHIJKLM'];
function fixture(t, { count = 3, mode = 'normal', bomb = false, duration = 30, unitBB = 2, buyinBB = 100 } = {}) {
  let clock = Date.parse('2026-10-14T08:00:00.000Z');
  t.mock.method(Date, 'now', () => clock);
  const users = IDS.map(id => ({ id, name: `Synthetic ${id}`, avatar: 0 }));
  const f = { store: { data: { users: Object.fromEntries(users.map(user => [user.id, user])), rooms: {}, hands: [], ledger: [] } },
    get time() { return clock; }, advance(ms) { clock += ms; }, users };
  f.service = new RoomService(f.store);
  f.room = f.service.create(users[0], { access: 'invite', settings: { smallBlind: 1, bigBlind: 2, maxPlayers: 9,
    squid: true, squidMode: mode, squidExtraTokens: 3, squidUnitBB: unitBB,
    bombPot: bomb, bombIntervalMinutes: 1, bombAnteBB: 2, durationMinutes: duration } });
  for (const user of users.slice(1)) f.service.join(user, f.room.code, f.room.invite);
  f.cmd = (id, type, extra = {}) => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && f.room.hand?.actingId) readyRoomAction(f.service, f.room, value => { clock = value; });
    const result = f.service.command(f.store.data.users[id], f.room.code,
    { commandId: randomUUID(), handId: f.room.hand?.id, actionSeq: f.room.hand?.log.length, type, ...extra });
    if (action) while (f.room.hand?.transition) assert.ok(advanceRoomEvent(f.service, f.room, value => { clock = value; }));
    return result;
  };
  f.connect = (id, value) => {
    f.service.connections.set(`${f.room.code}:${id}`, value ? 1 : 0);
    f.service.connectionChanged(f.room, clock, { reconnected: value });
  };
  f.sit = (id, seat, extra = {}) => { f.cmd(id, 'sit', { seat, amountBB: 100, entryMode: 'post', ...extra }); f.connect(id, true); };
  f.start = () => f.service.start(f.room, clock, { automatic: true });
  f.win = id => {
    for (let actions = 0; f.room.hand.status === 'playing'; actions++) {
      assert.ok(actions < 60, 'fold-down hand must terminate');
      const actor = f.room.hand.actingId, legal = availableActions(f.room.hand, actor);
      assert.ok(actor, 'script never waits for an all-in runout');
      f.cmd(actor, actor === id ? legal.canCheck ? 'check' : 'call' : 'fold');
    }
    assert.deepEqual(f.room.hand.result.mainWinnerIds, [id]);
    f.service.completeRabbit(f.room, clock); conserved(f);
  };
  f.consent = id => ({ expectedSquidRound: f.room.mini.squid.round,
    expectedSquidCost: f.room.mini.squid.won.includes(id) ? 0 : f.room.mini.squid.tokenBudget * f.room.mini.squid.unit });
  f.restore = () => {
    const directory = mkdtempSync(join(tmpdir(), 'bbpoker-midround-oracle-'));
    try {
      const disk = new EncryptedStore(directory); disk.data = f.store.data; disk.save();
      f.store = new EncryptedStore(directory); f.service = new RoomService(f.store);
      f.room = f.store.data.rooms[f.room.code];
      for (const member of Object.values(f.room.members)) if (member.seat !== null) f.connect(member.id, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  };
  for (let i = 0; i < count; i++) f.sit(IDS[i], i, { amountBB: buyinBB });
  f.start(); conserved(f); return f;
}
function conserved(f) {
  const room = f.room, members = Object.values(room.members), reserves = Object.values(room.mini.squid.reserves);
  const committed = room.hand?.status === 'playing' ? room.hand.players.reduce((sum, player) => sum + player.contributed, 0) : 0;
  assert.ok(members.every(m => m.stack >= 0 && m.cashedOut >= 0), 'no player can become overdrawn');
  assert.ok(reserves.every(n => Number.isSafeInteger(n) && n >= 0), 'reserves are funded nonnegative integers');
  assert.equal(members.reduce((sum, m) => sum + m.stack + m.cashedOut, 0) + reserves.reduce((sum, n) => sum + n, 0) + committed,
    members.reduce((sum, m) => sum + m.totalBuyIn, 0), 'all buy-ins remain in stacks, reserves, pots or cashouts');
}
const fishRows = f => f.store.data.ledger.filter(row => row.type === 'squidSettlement');
const counts = f => Object.fromEntries(f.room.mini.squid.participants.map(id => [id, f.room.mini.squid.counts[id]]));
const pokerPosts = (hand, id) => hand.log.filter(row => row.playerId === id && ['smallBlind', 'bigBlind', 'entryBlind', 'deadBlind'].includes(row.type));

for (const mode of ['normal', 'unlimited']) test(`midround oracle: ${mode} adds two true newcomers only at their first dealt hand`, t => {
  const f = fixture(t, { mode }), oldBudget = mode === 'normal' ? 2 : 6;
  const live = structuredClone(f.room.hand), oldEnd = f.room.endsAt;
  const sitD = { seat: 3, amountBB: 100, entryMode: 'post', commandId: randomUUID() };
  f.sit('D', 3, sitD); f.cmd('D', 'sit', sitD); f.sit('E', 4);
  assert.deepEqual(f.room.hand, live, 'joining cannot change dealt cards, actions, pots or the original hand snapshot');
  assert.deepEqual(f.room.mini.squid.participants, ['A', 'B', 'C']);
  assert.equal(f.room.mini.squid.tokenBudget, oldBudget);
  assert.equal(f.room.members.D.totalBuyIn, 200, 'same command ID cannot charge a second buy-in');
  f.win('A'); const archive = structuredClone(f.store.data.hands[0]);
  f.start();
  assert.deepEqual(f.room.hand.players.map(p => p.id), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(f.room.mini.squid.participants, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(f.room.mini.squid.tokenBudget, oldBudget + 2);
  assert.deepEqual(counts(f), { A: 1, B: 0, C: 0, D: 0, E: 0 });
  assert.equal(f.room.mini.squid.reserves.A, oldBudget * 4, 'a fish holder needs no increased loss reserve');
  for (const id of ['B', 'C', 'D', 'E']) assert.equal(f.room.mini.squid.reserves[id], (oldBudget + 2) * 4);
  assert.deepEqual(pokerPosts(f.room.hand, 'D').map(row => [row.type, row.amount]), [['bigBlind', 2]], 'natural BB is not also charged an entry BB');
  assert.deepEqual(pokerPosts(f.room.hand, 'E').map(row => [row.type, row.amount]), [['entryBlind', 2]], 'out-of-position newcomer posts exactly one live BB');
  assert.deepEqual(f.store.data.hands[0], archive); assert.equal(f.room.endsAt, oldEnd); conserved(f);
});

for (const mode of ['normal', 'unlimited']) test(`midround oracle: ${mode} nine-seat replacement keeps ten financial identities and settles them exactly once`, t => {
  const f = fixture(t, { count: 9, mode }); f.win('A'); f.cmd('A', 'stand');
  const departedCash = f.room.members.A.cashedOut;
  const archive = structuredClone(f.store.data.hands[0]);
  assert.equal(archive.miniBefore.squid.rulesVersion, 5, 'the pre-admission hand retains its original rules version');
  f.sit('J', 0); f.start();
  assert.equal(f.room.hand.players.length, 9); assert.ok(!f.room.hand.players.some(p => p.id === 'A'));
  assert.equal(f.room.mini.squid.participants.length, 10);
  assert.equal(new Set(f.room.mini.squid.participants).size, 10);
  assert.equal(f.room.mini.squid.tokenBudget, mode === 'normal' ? 9 : 13);
  assert.equal(f.room.mini.squid.counts.J, 0); assert.equal(f.room.members.A.cashedOut, departedCash);
  if (mode === 'normal') {
    const winners = ['J', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    for (const [index, winner] of winners.entries()) { if (index) f.start(); f.win(winner); }
  } else {
    for (let n = 0; n < 12; n++) { if (n) f.start(); f.win('J'); }
  }
  assert.equal(f.room.mini.squid.active, false);
  const actual = Object.fromEntries(fishRows(f).map(row => [row.playerId, row.amount]));
  const expected = mode === 'normal' ? { A: 4, B: 4, C: 4, D: 4, E: 4, F: 4, G: 4, H: 4, I: -36, J: 4 }
    : { A: 32, B: -52, C: -52, D: -52, E: -52, F: -52, G: -52, H: -52, I: -52, J: 384 };
  assert.deepEqual(actual, expected); assert.equal(fishRows(f).length, 10);
  assert.ok(fishRows(f).every(row => row.rulesVersion === 6), 'every expanded-round settlement row identifies the admission rules');
  assert.equal(fishRows(f).reduce((sum, row) => sum + row.amount, 0), 0);
  assert.deepEqual(f.store.data.hands[0], archive, 'later identities cannot rewrite an old archived hand');
  assert.equal(directRecordLibrary(f.store.data, 'A').opponents.summary.squid.net, expected.A);
  assert.equal(directRecordLibrary(f.store.data, 'J').opponents.summary.squid.net, expected.J);
  const before = structuredClone(f.store.data.ledger); f.service.finish(f.room, f.time);
  assert.deepEqual(f.store.data.ledger, before, 'repeated finish cannot pay the round twice'); conserved(f);
});

test('midround oracle: an absent no-fish player cannot fund a newcomer from already cashed-out chips', t => {
  const f = fixture(t, { count: 9 }); f.win('A'); f.cmd('I', 'stand', f.consent('I'));
  const cash = f.room.members.I.cashedOut, reserve = structuredClone(f.room.mini.squid.reserves);
  f.sit('J', 8); f.start();
  assert.equal(f.room.hand.players.length, 8); assert.ok(!f.room.hand.players.some(p => p.id === 'J'));
  assert.equal(f.room.mini.squid.tokenBudget, 8); assert.equal(f.room.mini.squid.participants.length, 9);
  assert.equal(f.room.members.I.cashedOut, cash); assert.deepEqual(f.room.mini.squid.reserves, reserve);
  assert.equal(f.room.members.J.totalBuyIn, 200); assert.equal(f.room.members.J.stack, 200);
  f.win('B'); conserved(f);
});

for (const mode of ['normal', 'unlimited']) test(`midround oracle: ${mode} reconnect, rebuy and leave-return preserve the same identity's fish and admission`, t => {
  const f = fixture(t, { mode }); f.win('A'); f.sit('D', 3); f.start(); f.win('D');
  const before = { budget: f.room.mini.squid.tokenBudget, participants: [...f.room.mini.squid.participants],
    counts: counts(f), reserves: structuredClone(f.room.mini.squid.reserves) };
  f.connect('D', false); f.connect('D', true);
  const buy = { amountBB: 100, commandId: randomUUID() }; f.cmd('D', 'buyin', buy); f.cmd('D', 'buyin', buy);
  f.cmd('D', 'stand'); f.sit('D', 3);
  assert.equal(f.room.members.D.totalBuyIn, 600, 'initial buy-in + one replay-safe rebuy + one re-seat buy-in');
  assert.deepEqual({ budget: f.room.mini.squid.tokenBudget, participants: [...f.room.mini.squid.participants], counts: counts(f), reserves: f.room.mini.squid.reserves }, before);
  f.start();
  assert.equal(f.room.mini.squid.tokenBudget, before.budget); assert.equal(f.room.mini.squid.participants.filter(id => id === 'D').length, 1);
  assert.equal(f.room.mini.squid.counts.D, 1); conserved(f);
});

for (const mode of ['normal', 'unlimited']) test(`midround oracle: ${mode} due bomb pot cannot bypass a newcomer's entry blind`, t => {
  const f = fixture(t, { mode, bomb: true }); f.win('A'); f.advance(60000); f.sit('D', 3); f.start();
  assert.equal(f.room.hand.bombPot, false, 'entry must first be satisfied by an ordinary hand');
  assert.deepEqual(pokerPosts(f.room.hand, 'D').map(row => [row.type, row.amount]), [['bigBlind', 2]]);
  const budget = f.room.mini.squid.tokenBudget; f.win('A'); f.start();
  assert.equal(f.room.hand.bombPot, true); assert.equal(f.room.hand.players.length, 4);
  assert.equal(f.room.mini.squid.tokenBudget, budget);
  assert.equal(f.room.hand.log.filter(row => row.type === 'ante').length, 4);
  assert.ok(f.room.hand.log.every(row => !['smallBlind', 'bigBlind', 'entryBlind', 'deadBlind'].includes(row.type)));
  f.win('D'); conserved(f);
});

test('midround oracle: persistence restores admission, reserves and command dedup without charging again', t => {
  const f = fixture(t, { mode: 'unlimited' }); f.win('A');
  const sit = { seat: 3, amountBB: 100, entryMode: 'post', commandId: randomUUID() }; f.sit('D', 3, sit); f.start();
  const savedHand = structuredClone(f.room.hand), savedFish = structuredClone(f.room.mini.squid), amount = f.room.members.D.totalBuyIn;
  f.restore();
  // Reconnecting one socket at a time can establish a new observation epoch.
  // Only that process ID may differ; every rule, balance and admission stays.
  const restored = structuredClone(f.room.mini.squid);
  assert.equal(restored.blockerEpoch, f.service.observationId);
  delete restored.blockerEpoch; delete savedFish.blockerEpoch;
  assert.deepEqual(f.room.hand, savedHand); assert.deepEqual(restored, savedFish);
  const beforeReplay = structuredClone(f.room.mini.squid);
  f.cmd('D', 'sit', sit); assert.equal(f.room.members.D.totalBuyIn, amount);
  assert.deepEqual(f.room.mini.squid, beforeReplay); f.win('D'); conserved(f);
});

test('midround oracle: an admission queued during a live hand survives restart and commits once on automatic deal', t => {
  const f = fixture(t), budget = f.room.mini.squid.tokenBudget;
  const sit = { seat: 3, amountBB: 100, entryMode: 'post', commandId: randomUUID() };
  f.sit('D', 3, sit); const current = structuredClone(f.room.hand);
  f.restore(); f.cmd('D', 'sit', sit);
  assert.deepEqual(f.room.hand, current); assert.equal(f.room.mini.squid.tokenBudget, budget);
  assert.ok(!f.room.mini.squid.participants.includes('D'));
  f.win('A'); const due = f.room.nextHandAt;
  assert.ok(Number.isFinite(due) && due > f.time);
  f.advance(due - f.time); f.service.tick(f.room, f.time);
  assert.equal(f.room.handNumber, 2); assert.equal(f.room.hand.status, 'playing');
  assert.ok(f.room.hand.players.some(p => p.id === 'D'));
  assert.equal(f.room.mini.squid.tokenBudget, budget + 1);
  assert.equal(f.room.mini.squid.participants.filter(id => id === 'D').length, 1);
  assert.equal(f.room.members.D.totalBuyIn, 200); conserved(f);
});

test('midround oracle: an unaffordable newcomer stays out without charging others or blocking the old hand', t => {
  const f = fixture(t, { mode: 'unlimited', unitBB: 20, buyinBB: 500 }); f.win('A');
  const reserves = structuredClone(f.room.mini.squid.reserves); f.sit('D', 3); f.start();
  assert.equal(f.room.hand.players.length, 3); assert.ok(!f.room.hand.players.some(p => p.id === 'D'));
  assert.equal(f.room.mini.squid.tokenBudget, 6); assert.deepEqual(f.room.mini.squid.reserves, reserves);
  assert.equal(f.room.members.D.stack, 200, '200 available cannot fund the new 7 * 40 reserve plus a live blind');
  f.win('A'); f.cmd('D', 'buyin', { amountBB: 100 });
  for (let attempt = 0; !f.room.mini.squid.participants.includes('D'); attempt++) {
    assert.ok(attempt < 4, 'funded posting newcomer eventually reaches a legal entry position');
    f.start(); if (!f.room.mini.squid.participants.includes('D')) f.win('A');
  }
  assert.equal(f.room.mini.squid.tokenBudget, 7); assert.equal(f.room.mini.squid.reserves.D, 280);
  assert.equal(f.room.members.D.totalBuyIn, 400); conserved(f);
});

test('midround oracle: one unaffordable newcomer cannot block a funded newcomer and later adds only its own fish', t => {
  const f = fixture(t, { mode: 'unlimited', unitBB: 20, buyinBB: 500 }); f.win('A');
  f.sit('D', 3, { amountBB: 500 }); f.sit('E', 4); f.start();
  assert.ok(f.room.hand.players.some(p => p.id === 'D')); assert.ok(!f.room.hand.players.some(p => p.id === 'E'));
  assert.equal(f.room.mini.squid.tokenBudget, 7); assert.equal(f.room.mini.squid.reserves.D, 280);
  assert.equal(f.room.members.E.stack, 200); assert.equal(f.room.mini.squid.reserves.E, undefined);
  f.win('A'); f.cmd('E', 'buyin', { amountBB: 100 }); f.start();
  assert.ok(f.room.hand.players.some(p => p.id === 'E')); assert.equal(f.room.mini.squid.tokenBudget, 8);
  for (const id of ['B', 'C', 'D', 'E']) assert.equal(f.room.mini.squid.reserves[id], 320);
  assert.equal(f.room.mini.squid.reserves.A, 240); assert.equal(f.room.members.E.totalBuyIn, 400); conserved(f);
});

test('midround oracle: funded newcomers resume one online original while absent zero-fish identities retain liability', t => {
  const f = fixture(t, { mode: 'unlimited' }); f.win('A'); f.connect('B', false); f.connect('C', false);
  const before = Object.fromEntries(['B', 'C'].map(id => [id, f.room.members[id].stack]));
  f.sit('D', 3); f.sit('E', 4); f.start();
  assert.deepEqual(f.room.hand.players.map(p => p.id), ['A', 'D']);
  assert.equal(f.room.mini.squid.tokenBudget, 7);
  for (const id of ['B', 'C']) {
    assert.equal(f.room.members[id].stack, before[id] - 4);
    assert.equal(f.room.mini.squid.reserves[id], 28);
  }
  f.win('A'); f.start();
  assert.deepEqual(f.room.hand.players.map(p => p.id), ['A', 'D', 'E']);
  assert.equal(f.room.mini.squid.tokenBudget, 8);
  for (const id of ['B', 'C']) assert.equal(f.room.members[id].stack, before[id] - 8);
  assert.deepEqual(f.room.mini.squid.participants, ['A', 'B', 'C', 'D', 'E']); conserved(f);
});

test('midround oracle: repeated read-only previews do not reserve chips and old departure confirmations cannot use the earlier budget', t => {
  const f = fixture(t); f.win('A'); const consent = f.consent('B'); f.sit('D', 3);
  const before = structuredClone(f.store.data);
  for (let n = 0; n < 8; n++) {
    f.service.state(f.room, 'D'); f.service.state(f.room, 'A');
    f.service.prepareStart(f.room, f.time, { requireOnline: true });
  }
  assert.deepEqual(f.store.data, before, 'planning and public projections must be side-effect free');
  f.start(); f.win('A'); const after = structuredClone(f.store.data);
  assert.throws(() => f.cmd('B', 'stand', consent), /退出费用已变化|重新确认/);
  assert.deepEqual(f.store.data, after); conserved(f);
});

test('midround oracle: the next round resets admissions while preserving the prior round archive and settlement', t => {
  const f = fixture(t); f.win('A'); f.sit('D', 3); f.start(); f.win('D'); f.start(); f.win('B');
  assert.equal(f.room.mini.squid.active, false); assert.equal(f.room.mini.squid.admissions.length, 1);
  const archive = structuredClone(f.store.data.hands), settlement = structuredClone(fishRows(f));
  assert.equal(settlement.length, 4); assert.ok(settlement.every(row => row.rulesVersion === 6));
  f.start();
  assert.equal(f.room.mini.squid.round, 2); assert.equal(f.room.mini.squid.tokenBudget, 3);
  assert.equal(f.room.mini.squid.rulesVersion, 5, 'a fresh round without mid-round admission uses the original rules');
  assert.equal(f.room.hand.miniBefore.squid.rulesVersion, 5);
  assert.deepEqual(f.room.mini.squid.admissions, []); assert.deepEqual(f.room.hand.miniBefore.squid.admissions, []);
  assert.deepEqual(counts(f), { A: 0, B: 0, C: 0, D: 0 });
  assert.deepEqual(f.store.data.hands, archive); assert.deepEqual(fishRows(f), settlement); conserved(f);
  f.win('A'); f.start(); f.win('B'); f.start(); f.win('C');
  const nextSettlement = fishRows(f).slice(settlement.length);
  assert.equal(nextSettlement.length, 4); assert.ok(nextSettlement.every(row => row.rulesVersion === 5));
  assert.deepEqual(fishRows(f).slice(0, settlement.length), settlement, 'new-round settlement cannot change old rule versions or amounts');
  assert.deepEqual(f.store.data.hands.slice(0, archive.length), archive, 'later rounds cannot rewrite earlier hand versions or snapshots');
  conserved(f);
});

test('midround oracle: joining in the final five minutes is allowed but expiry cannot be extended by a newcomer', t => {
  const f = fixture(t); f.win('A'); const originalEnd = f.room.endsAt;
  f.advance(originalEnd - f.time - 240000); f.sit('D', 3); f.start();
  assert.ok(f.room.hand.players.some(p => p.id === 'D')); assert.equal(f.room.mini.squid.tokenBudget, 3);
  f.win('A'); f.advance(originalEnd - f.time + 1); f.sit('E', 4); f.start();
  assert.ok(!f.room.hand.players.some(p => p.id === 'E'));
  assert.equal(f.room.mini.squid.tokenBudget, 3); assert.equal(f.room.endsAt, originalEnd);
  f.win('B'); f.start(); f.win('C');
  assert.equal(f.room.mini.squid.active, false); assert.equal(f.room.status, 'closed');
  assert.equal(f.room.members.E.totalBuyIn, 200); assert.equal(f.room.members.E.cashedOut, 200);
  assert.equal(fishRows(f).some(row => row.playerId === 'E'), false); conserved(f);
});
