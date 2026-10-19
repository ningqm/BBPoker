import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { readyRoomAction } from './helpers/room-clock.js';

// Expected transfers are calculated from declared buy-ins, 5/10 blinds and a
// six-player 20-point bomb ante. No outcome is copied from member balances.
function fixture(t, mode = 'holdem') {
  let time = 1800000000000;
  t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: 11 }, (_, i) => ({ id: `final-${i}`, name: `战绩玩家${i}`, avatar: i % 8 }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  let service = new RoomService(store), room = service.create(users[0], { settings: {
    smallBlind: 5, bigBlind: 10, maxPlayers: 9, squid: mode !== 'holdem', squidMode: mode === 'unlimited' ? 'unlimited' : 'normal',
    squidExtraTokens: 3, squidUnitBB: 2, bombPot: true, bombIntervalMinutes: 1, bombAnteBB: 2,
  } });
  for (const user of users.slice(1, 10)) service.join(user, room.code, room.invite);
  const f = { users, store, get room() { return room; }, get service() { return service; },
    id: i => users[i].id, member: i => room.members[users[i].id],
    advance(ms) { time += ms; },
    cmd(i, type, extra = {}) {
      if (['fold', 'check', 'call', 'raise', 'allin'].includes(type)) assert.ok(readyRoomAction(service, room, value => { time = value; }));
      const q = room.mini.squid, participant = q.active && q.participants.includes(users[i].id);
      return service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length,
        ...(['stand', 'sitout'].includes(type) ? { expectedSquidRound: participant ? q.round : 0,
          expectedSquidCost: participant && !q.counts[users[i].id] ? q.tokenBudget * q.unit : 0 } : {}), ...extra });
    },
    win(i) {
      for (let actions = 0; room.hand.status === 'playing'; actions++) {
        assert.ok(actions < 100, 'the deterministic fold-to-winner hand must finish');
        if (!readyRoomAction(service, room, value => { time = value; })) break;
        const actor = users.findIndex(u => u.id === room.hand.actingId), options = availableActions(room.hand, room.hand.actingId);
        f.cmd(actor, actor === i ? options.canCheck ? 'check' : 'call' : 'fold');
      }
      assert.deepEqual(room.hand.result.mainWinnerIds, [users[i].id]);
      service.completeRabbit(room, time);
    },
    start() { service.start(room, time, { automatic: true }); },
    restart() { store.data = structuredClone(store.data); service = new RoomService(store); room = store.data.rooms[room.code]; },
  };
  for (let i = 0; i < 9; i++) { f.cmd(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  return f;
}

function noPrivateCards(value) {
  const forbidden = new Set(['cards', 'deck', 'audit', 'salt', 'proofs', 'commitment', 'invite', 'token', 'passwordHash', 'recoveryHash', 'log', 'chat']);
  const visit = data => { if (!data || typeof data !== 'object') return; for (const [key, item] of Object.entries(data)) { assert.ok(!forbidden.has(key), `summary must not expose ${key}`); visit(item); } };
  visit(value);
}

for (const mode of ['holdem', 'normal', 'unlimited']) test(`closed nine-player summary includes early leavers and rebuys exactly once (${mode} + bomb)`, t => {
  const f = fixture(t, mode), { room } = f;
  f.cmd(0, 'buyin', { amountBB: 100 }); // Immediate top-up, before first deal.
  f.start(); f.cmd(0, 'autoDeal', { paused: true });
  const firstQueue = randomUUID(), secondQueue = randomUUID(), cancelledQueue = randomUUID();
  f.cmd(1, 'buyin', { amountBB: 100, commandId: firstQueue });
  f.cmd(1, 'buyin', { amountBB: 100, commandId: firstQueue });
  f.cmd(1, 'buyin', { amountBB: 150, commandId: secondQueue });
  f.cmd(2, 'buyin', { amountBB: 100, commandId: cancelledQueue }); f.cmd(2, 'stand'); f.cmd(6, 'stand');
  assert.equal(f.member(1).totalBuyIn, 1000, 'queued chips are not booked yet');
  f.win(0); // SB1 loses5, BB2 loses10, player0 wins15.
  assert.deepEqual(room.hand.players.map(p => p.stack - p.startingStack), [15, -5, -10, 0, 0, 0, 0, 0, 0]);
  assert.equal(f.member(1).totalBuyIn, 3500); assert.equal(f.member(2).totalBuyIn, 1000);
  assert.equal(f.member(2).seat, null); assert.equal(f.member(6).seat, null);
  f.cmd(0, 'stand'); f.cmd(7, 'stand'); // An absent fish-holder still receives its fish transfer on close.
  const returnId = randomUUID();
  f.cmd(2, 'sit', { seat: 2, amountBB: 150, entryMode: 'post', commandId: returnId });
  f.cmd(2, 'sit', { seat: 2, amountBB: 150, entryMode: 'post', commandId: returnId });
  f.cmd(2, 'buyin', { amountBB: 100, commandId: cancelledQueue }); // A cancelled old receipt cannot revive after return.
  assert.equal(f.member(2).totalBuyIn, 2500);
  f.advance(60000); f.start();
  assert.equal(room.hand.bombPot, true); assert.equal(room.hand.players.length, 6);
  f.win(1); // Six antes20: player1 receives120, net+100; the other five lose20.
  assert.equal(room.hand.result.pots.reduce((sum, p) => sum + p.amount, 0), 120);
  const closeId = randomUUID(); f.cmd(0, 'close', { commandId: closeId });
  const closed = structuredClone(f.store.data);
  f.cmd(0, 'close', { commandId: closeId });
  f.cmd(1, 'buyin', { amountBB: 100, commandId: firstQueue });
  f.cmd(1, 'buyin', { amountBB: 150, commandId: secondQueue });
  assert.deepEqual(f.store.data, closed, 'close and accepted financial retries never duplicate balances or records');

  const buyins = [2000, 3500, 2500, 1000, 1000, 1000, 1000, 1000, 1000];
  const poker = [15, 95, -30, -20, -20, -20, 0, 0, -20];
  const fish = mode === 'holdem' ? Array(9).fill(0) : [140, 140, -40, -40, -40, -40, -40, -40, -40];
  for (const restart of [false, true]) {
    if (restart) f.restart();
    const { session } = f.service.sessionFor(f.id(9), f.room.code); noPrivateCards(session);
    assert.equal(session.status, 'closed'); assert.equal(session.handCount, 2); assert.equal(session.handInProgress, false);
    assert.equal(session.players.length, 9, 'pure observer omitted; everyone who bought in remains');
    assert.equal(session.players.reduce((sum, p) => sum + p.net, 0), 0);
    const state = f.service.state(f.room, f.id(9));
    for (let i = 0; i < 9; i++) {
      const member = f.member(i), row = session.players.find(p => p.id === f.id(i)), projected = state.players.find(p => p.id === f.id(i));
      const expectedNet = poker[i] + fish[i], expectedReturn = buyins[i] + expectedNet;
      assert.equal(member.seat, null); assert.equal(member.stack, 0); assert.equal(member.totalBuyIn, buyins[i]);
      assert.equal(member.cashedOut - (member.squidDebt ?? 0), expectedReturn, `player${i} net returns include actual cashouts minus unpaid squid settlement`);
      assert.equal(row.totalBuyIn, buyins[i]); assert.equal(row.holdemNet, poker[i]); assert.equal(row.miniNet, fish[i]);
      assert.equal(row.net, expectedNet); assert.equal(row.totalBuyIn + row.net, expectedReturn);
      assert.equal(row.totalBuyInBB, buyins[i] / 10); assert.equal(row.netBB, expectedNet / 10);
      assert.equal(projected.sessionProfit, expectedNet); assert.equal(projected.totalBuyIn + projected.sessionProfit, expectedReturn);
      assert.deepEqual(projected.cards, [0,6,7].includes(i) ? [] : [null,null], 'closing adds no access to unrevealed hole cards, including the winner');
      assert.equal(f.store.data.ledger.filter(e => e.type === 'buyin' && e.playerId === f.id(i)).reduce((sum, e) => sum + e.amount, 0), buyins[i]);
      const personal = f.service.sessions(f.id(i)).sessions[0]; assert.equal(personal.meNet, expectedNet);
    }
    assert.equal(Object.values(f.room.members).reduce((sum, m) => sum + m.cashedOut - (m.squidDebt ?? 0), 0), 14000);
    assert.throws(() => f.service.sessionFor(f.id(10), f.room.code), error => error.status === 403);
  }
});

test('closing a never-started room still lists funded leavers, but not zero-buyin spectators', t => {
  const f = fixture(t);
  for (const i of [1, 3, 7]) f.cmd(i, 'stand');
  f.cmd(1, 'sit', { seat: 1, amountBB: 200 }); f.cmd(1, 'stand');
  f.cmd(0, 'close');
  const { session } = f.service.sessionFor(f.id(9), f.room.code); noPrivateCards(session);
  assert.equal(session.handCount, 0); assert.equal(session.players.length, 9);
  for (const row of session.players) {
    assert.equal(row.hands, 0); assert.equal(row.net, 0); assert.equal(row.totalBuyIn, row.id === f.id(1) ? 3000 : 1000);
    assert.equal(row.totalBuyIn + row.net, f.room.members[row.id].cashedOut);
  }
});

for (const mode of ['normal', 'unlimited']) test(`a naturally completed ${mode} squid round is counted once across its last hand, ledger and final summary`, t => {
  const f = fixture(t, mode), winners = mode === 'normal' ? [0,1,2,3,4,5,6,7] : Array(12).fill(0), poker = Array(9).fill(0);
  for (const winner of winners) {
    f.start(); f.cmd(0, 'autoDeal', { paused: true });
    assert.equal(f.room.hand.bombPot, false);
    // Public positions define the two compulsory contributions. All others
    // fold, so only the intended winner keeps the other players' blinds.
    poker[f.room.hand.smallBlindSeat] -= 5; poker[f.room.hand.bigBlindSeat] -= 10; poker[winner] += 15;
    f.win(winner);
  }
  assert.equal(f.room.mini.squid.active, false);
  const count = f.store.data.ledger.filter(e => e.type === 'squidSettlement').length;
  assert.equal(count, 9); assert.ok(f.store.data.hands.at(-1).squidSettlementId, 'last hand and settlement share the same transfer');
  f.cmd(0, 'close');
  assert.equal(f.store.data.ledger.filter(e => e.type === 'squidSettlement').length, count);
  const { session } = f.service.sessionFor(f.id(9), f.room.code); noPrivateCards(session);
  for (let i = 0; i < 9; i++) {
    const fish = mode === 'normal' ? i === 8 ? -160 : 20 : i === 0 ? 1920 : -240;
    const row = session.players.find(p => p.id === f.id(i));
    assert.equal(row.holdemNet, poker[i]); assert.equal(row.miniNet, fish);
    assert.equal(row.net, poker[i] + fish); assert.equal(row.totalBuyIn + row.net, f.member(i).cashedOut);
  }
  assert.equal(session.players.reduce((sum, p) => sum + p.net, 0), 0);
});
