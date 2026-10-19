import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';

function fixture(t, settings = {}) {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const users = Array.from({ length: 5 }, (_, i) => ({ id: `squid-pause-${i}`, name: `合成测试${i}` }));
  const data = { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data }), room = service.create(users[0], { settings: { squid: true, smallBlind: 1, bigBlind: 2, ...settings } });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && room.hand?.actingId) readyRoomAction(service, room, value => { now = value; });
    const result = service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
    if (action) while (room.hand?.transition) assert.ok(advanceRoomEvent(service, room, value => { now = value; }));
    return result;
  };
  const connect = (i, online) => { service.connections.set(`${room.code}:${users[i].id}`, online ? 1 : 0); service.connectionChanged(room, now, { reconnected: online }); };
  for (let i = 0; i < 4; i++) { cmd(i, 'sit', { seat: i, amountBB: 100 }); connect(i, true); }
  const start = () => service.start(room, now, { automatic: true });
  const win = winner => {
    for (let steps = 0; room.hand.status === 'playing'; steps++) {
      assert.ok(steps < 100); const i = users.findIndex(u => u.id === room.hand.actingId), a = availableActions(room.hand, room.hand.actingId);
      cmd(i, i === winner ? a.canCheck ? 'check' : 'call' : 'fold');
    }
    service.completeRabbit(room, now);
  };
  start();
  return { users, data, service, room, cmd, connect, start, win, get time() { return now; }, advance(ms) { now += ms; } };
}

test('offline original players no longer turn a configured bomb hand into ordinary fallback', t => {
  const f = fixture(t, { bombPot: true, bombIntervalMinutes: 1 });
  assert.equal(f.room.hand.bombPot, false); f.win(0); f.connect(3, false); f.advance(60000); f.start();
  const h = f.room.hand;
  assert.equal(h.bombPot, true); assert.ok(h.ante > 0); assert.equal(h.street, 'flop');
  assert.equal(h.squidRound, 1); assert.equal(h.settings.squid, true);
  assert.equal(h.log.filter(e => e.type === 'smallBlind').length, 0);
  assert.equal(h.log.filter(e => e.type === 'bigBlind').length, 0);
  assert.equal(h.log.filter(e => e.type === 'ante').length, 3);
  assert.equal(h.players.some(p => p.id === f.users[3].id), false);
  f.win(1);
  assert.equal(f.service.handFor(f.users[4].id, f.room.code, h.id).squidRound, 1);
  assert.deepEqual(f.room.mini.squid.won, [f.users[0].id, f.users[1].id]);
  assert.ok(f.service.handFor(f.users[4].id, f.room.code, h.id).players.every(p => p.cards.every(c => c === null)), 'spectator history retains folded and unshown card privacy');
});

test('an absent busted or sitting-out original player does not prevent two or more others continuing squid', t => {
  const f = fixture(t); f.win(0); f.connect(3, false);
  const member = f.room.members[f.users[3].id], stack = member.stack;
  // Simulate a persisted busted state without discarding any points.
  member.stack = 0; member.cashedOut += stack;
  f.service.connectionChanged(f.room, f.time);
  assert.equal(f.service.state(f.room, f.users[0].id).mini.squid.paused, false);
  assert.ok(Number.isFinite(f.room.nextHandAt)); f.start();
  assert.equal(f.room.hand.squidRound, 1); assert.equal(f.room.hand.players.some(p => p.id === member.id), false); f.win(0);
  member.stack = stack; member.cashedOut -= stack; member.sittingOut = true;
  f.service.connectionChanged(f.room, f.time);
  assert.ok(Number.isFinite(f.room.nextHandAt)); f.start();
  assert.equal(f.room.hand.squidRound, 1); assert.equal(f.room.hand.players.some(p => p.id === member.id), false); f.win(0);
  member.sittingOut = false; f.connect(3, true);
  assert.ok(Number.isFinite(f.room.nextHandAt)); f.start(); assert.equal(f.room.hand.squidRound, 1);
});

test('a live all-in is not misclassified as busted; projections and rejected mid-hand settlement remain pure', t => {
  const f = fixture(t); f.win(0); f.connect(3, false); f.start();
  const actor = f.users.findIndex(u => u.id === f.room.hand.actingId);
  f.cmd(actor, 'allin'); assert.equal(f.room.members[f.users[actor].id].stack, 0);
  assert.equal(f.service.squidBlock(f.room), null);
  assert.equal(f.room.mini.squid.blockerSince ?? null, null);
  const before = structuredClone(f.data);
  f.service.state(f.room, f.users[0].id); f.service.autoPlan(f.room, f.time); f.service.needsTick(f.room, f.time);
  assert.deepEqual(f.data, before, 'public projections and scheduling reads are side effect free');
  assert.throws(() => f.service.settleSquid(f.room, { reason: 'partial' }), /本手结算/);
  assert.deepEqual(f.data, before, 'direct mid-hand settlement cannot alter balances');
});

test('upgrading a legacy squid hand retains eligibility while a saved explicit ordinary marker never changes', t => {
  const f = fixture(t), round = f.room.mini.squid.round;
  delete f.room.hand.squidRound;
  assert.equal(f.service.state(f.room, f.users[0].id).hand.squidRound, round);
  f.connect(3, false); f.win(0); assert.deepEqual(f.room.mini.squid.won, [f.users[0].id]);
  f.start();
  // A 0.11.1 server could persist a hand under the now-removed ordinary fallback.
  // Its explicit contract must remain ordinary when 0.12 resumes that save.
  f.room.hand.squidRound = null; f.room.hand.settings.squid = false;
  f.connect(3, true); assert.equal(f.service.state(f.room, f.users[0].id).hand.squidRound, null); f.win(1);
  assert.deepEqual(f.room.mini.squid.won, [f.users[0].id]);
  f.start(); assert.equal(f.room.hand.squidRound, round);
});

test('a newcomer can join the ongoing round while an original reconnect still waits for the next hand', t => {
  const f = fixture(t); f.win(0); f.connect(3, false);
  f.cmd(4, 'sit', { seat: 4, amountBB: 100 }); f.connect(4, true); f.start();
  const hand = structuredClone(f.room.hand); f.connect(3, true);
  let view = f.service.state(f.room, f.users[4].id);
  assert.equal(view.hand.squidRound, 1); assert.equal(view.players.find(p => p.id === f.users[4].id).waitingFor, null);
  assert.equal(view.players.find(p => p.id === f.users[4].id).cards.length, 2); assert.deepEqual(f.room.hand, hand);
  assert.equal(view.players.find(p => p.id === f.users[3].id).waitingFor,'hand');
  assert.equal(view.players.find(p => p.id === f.users[3].id).cards.length,0);
  f.win(1); view = f.service.state(f.room, f.users[4].id);
  assert.equal(view.players.find(p => p.id === f.users[4].id).waitingFor, null);
  assert.equal(view.players.find(p => p.id === f.users[4].id).squidReserve, 0);
  assert.equal(f.room.mini.squid.tokenBudget,4);assert.equal(f.room.mini.squid.participants.length,5);
});

test('overtime waiting does not repeatedly write or refresh an already observed deadline', t => {
  const f = fixture(t); f.win(0); for (const i of [0, 2, 3]) f.connect(i, false); f.cmd(0, 'autoDeal', { paused: true });
  f.advance(f.room.endsAt - f.time); assert.equal(f.service.tick(f.room, f.time), true);
  const deadline = f.service.state(f.room, f.users[0].id).mini.squid.expiryGraceEndsAt;
  const snapshot = structuredClone(f.data);
  for (let i = 0; i < 10; i++) { f.advance(1); assert.equal(f.service.tick(f.room, f.time), false); }
  assert.deepEqual(f.data, snapshot); assert.equal(deadline, f.time - 10 + 90000);
  assert.equal(f.room.autoDealPaused, false); // Expiry removes the pause; lack of participants still waits.
  f.advance(deadline - f.time); f.service.tick(f.room, f.time);
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.mini.squid.lastResult.reason, 'partial');
});
