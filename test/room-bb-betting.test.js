import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';

function fixture(t, { count = 2, settings = {}, stacks = [] } = {}) {
  const time = 1800000000000; t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: count }, (_, i) => ({ id: `bb-player-${i}`, name: `朋友${i}` }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], { settings });
  const command = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (const [i, user] of users.entries()) {
    if (i) service.join(user, room.code, room.invite);
    command(i, 'sit', { seat: i, amountBB: 100 });
    if (stacks[i] !== undefined) room.members[user.id].stack = stacks[i]; // Prior-hand winnings may be fractional BB.
    service.connections.set(`${room.code}:${user.id}`, 1);
  }
  command(0, 'start');
  const act = (type, extra = {}) => command(users.findIndex(u => u.id === room.hand.actingId), type, extra);
  return { service, store, room, users, command, act, time };
}

test('new room action clock is 20 seconds and explicit settings retain their duration', t => {
  const f = fixture(t); assert.equal(f.room.deadline, f.time + 20000);
  f.act('call'); assert.equal(f.room.deadline, f.time + 20000);
  const old = fixture(t, { settings: { actionSeconds: 30 } }); assert.equal(old.room.deadline, old.time + 30000);
});

test('non-integer-BB voluntary raises fail before any hand, stack, command or ledger mutation', t => {
  const f = fixture(t);
  for (const amount of [21, 25, 37, 999]) {
    const before = structuredClone(f.store.data);
    assert.throws(() => f.act('raise', { amount }), e => e.status === 400 && /整数 BB/.test(e.message));
    assert.deepEqual(f.store.data, before);
  }
  // The active hand owns its denomination even if a loaded room setting differs.
  f.room.settings.bigBlind = 5;
  assert.throws(() => f.act('raise', { amount: 25 }), /整数 BB/);
  f.room.settings.bigBlind = 10;
  const commandId = randomUUID(), actor = f.room.hand.actingId;
  f.act('raise', { amount: 30, commandId });
  assert.equal(f.room.hand.currentBet, 30);
  const accepted = structuredClone(f.store.data);
  f.command(f.users.findIndex(u => u.id === actor), 'raise', { amount: 30, commandId });
  assert.deepEqual(f.store.data, accepted);
});

test('blinds and calls keep exact fractional BB while postflop bets use whole BB', t => {
  const f = fixture(t);
  assert.deepEqual(f.room.hand.players.map(p => p.bet).sort((a, b) => a - b), [5, 10]);
  assert.equal(availableActions(f.room.hand, f.room.hand.actingId).callAmount, 5);
  f.act('call'); assert.equal(f.room.hand.log.at(-1).amount, 5);
  f.act('check'); assert.equal(f.room.hand.board.length, 3);
  assert.throws(() => f.act('raise', { amount: 15 }), /整数 BB/);
  f.act('raise', { amount: 10 }); assert.equal(f.room.hand.currentBet, 10);
});

test('a multiway short all-in can create a fractional minimum, next full raise rounds upward legally', t => {
  const f = fixture(t, { count: 3, stacks: [15, 1000, 1000] });
  assert.equal(f.room.hand.actingId, f.users[0].id);
  f.act('allin'); assert.equal(f.room.hand.currentBet, 15);
  assert.equal(availableActions(f.room.hand, f.room.hand.actingId).minRaiseTo, 25);
  for (const amount of [20, 25]) {
    const before = structuredClone(f.store.data);
    assert.throws(() => f.act('raise', { amount }), amount === 25 ? /整数 BB/ : /最小额度/);
    assert.deepEqual(f.store.data, before);
  }
  f.act('raise', { amount: 30 });
  assert.equal(f.room.hand.currentBet, 30);
  f.act('call'); assert.equal(f.room.hand.board.length, 3);
});

test('exact remaining-stack raises and short all-in calls keep fractional BB', t => {
  const f = fixture(t, { stacks: [25, 1000] });
  f.act('raise', { amount: 25 });
  assert.equal(f.room.hand.players[0].stack, 0); assert.equal(f.room.hand.currentBet, 25);
  assert.equal(availableActions(f.room.hand, f.room.hand.actingId).callAmount, 15);
  f.act('call'); assert.equal(f.room.hand.runout.active, true);
  const short = fixture(t, { count: 3, stacks: [15, 1000, 1000] });
  short.act('raise', { amount: 15 }); assert.equal(short.room.hand.currentBet, 15);
  const call = fixture(t, { stacks: [7, 1000] });
  assert.equal(availableActions(call.room.hand, call.room.hand.actingId).callAmount, 2);
  call.act('call'); assert.equal(call.room.hand.players[0].stack, 0);
});

test('integer-BB validation uses configured big blind rather than fixed points', t => {
  const f = fixture(t, { settings: { smallBlind: 5, bigBlind: 12 } });
  assert.throws(() => f.act('raise', { amount: 30 }), /整数 BB/);
  f.act('raise', { amount: 24 }); assert.equal(f.room.hand.currentBet, 24);
});
