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
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
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

test('fallback hands use normal blinds even when every configured hand is a bomb pot', t => {
  const f = fixture(t, { bombPot: true, bombEveryHands: 1 });
  assert.equal(f.room.hand.bombPot, true); f.win(0); f.connect(3, false); f.start();
  const h = f.room.hand;
  assert.equal(h.bombPot, false); assert.equal(h.ante, 0); assert.equal(h.street, 'preflop');
  assert.equal(h.squidRound, null); assert.equal(h.settings.squid, false);
  assert.equal(h.log.filter(e => e.type === 'smallBlind').length, 1);
  assert.equal(h.log.filter(e => e.type === 'bigBlind').length, 1);
  assert.equal(h.log.filter(e => e.type === 'ante').length, 0);
  f.win(1);
  assert.equal(f.service.handFor(f.users[4].id, f.room.code, h.id).squidRound, null);
  assert.deepEqual(f.room.mini.squid.won, [f.users[0].id]);
});

test('fallback is unavailable when a required player is also out of chips or sitting out', t => {
  const f = fixture(t); f.win(0); f.connect(3, false);
  const member = f.room.members[f.users[3].id], stack = member.stack;
  // Simulate an already persisted busted/legacy sit-out state without discarding any points.
  member.stack = 0; member.cashedOut += stack;
  f.service.connectionChanged(f.room, f.time);
  assert.equal(f.service.state(f.room, f.users[0].id).mini.squid.paused, false);
  assert.equal(f.room.nextHandAt, null); assert.throws(f.start, /积分不足/);
  member.stack = stack; member.cashedOut -= stack; member.sittingOut = true;
  f.service.connectionChanged(f.room, f.time);
  assert.equal(f.room.nextHandAt, null); assert.throws(f.start, /暂离/);
  member.sittingOut = false; f.service.connectionChanged(f.room, f.time);
  assert.ok(Number.isFinite(f.room.nextHandAt)); f.start(); assert.equal(f.room.hand.squidRound, null);
});

test('a live all-in is not misclassified as busted and does not erase an existing offline grace clock', t => {
  const f = fixture(t); f.win(0); f.connect(3, false); f.start();
  const since = f.room.mini.squid.blockerSince;
  const actor = f.users.findIndex(u => u.id === f.room.hand.actingId);
  f.cmd(actor, 'allin'); assert.equal(f.room.members[f.users[actor].id].stack, 0);
  assert.equal(f.service.squidBlock(f.room).offlineOnly, true);
  assert.equal(f.room.mini.squid.blockerSince, since);
  const before = structuredClone(f.data);
  f.service.state(f.room, f.users[0].id); f.service.autoPlan(f.room, f.time); f.service.needsTick(f.room, f.time);
  assert.deepEqual(f.data, before, 'public projections and scheduling reads are side effect free');
  assert.throws(() => f.service.settleSquid(f.room, { reason: 'partial' }), /本手结算/);
  assert.deepEqual(f.data, before, 'direct mid-hand settlement cannot alter balances');
});

test('upgrading an active legacy squid hand retains its original round while an explicit ordinary marker never changes', t => {
  const f = fixture(t), round = f.room.mini.squid.round;
  delete f.room.hand.squidRound;
  assert.equal(f.service.state(f.room, f.users[0].id).hand.squidRound, round);
  f.connect(3, false); f.win(0); assert.deepEqual(f.room.mini.squid.won, [f.users[0].id]);
  f.start(); assert.equal(f.room.hand.squidRound, null);
  f.connect(3, true); f.win(1);
  assert.deepEqual(f.room.mini.squid.won, [f.users[0].id]);
  f.start(); assert.equal(f.room.hand.squidRound, round);
});

test('a newcomer currently playing an ordinary hand is not presented as waiting when the old round becomes ready', t => {
  const f = fixture(t); f.win(0); f.connect(3, false);
  f.cmd(4, 'sit', { seat: 4, amountBB: 100 }); f.connect(4, true); f.start();
  f.connect(3, true);
  let view = f.service.state(f.room, f.users[4].id);
  assert.equal(view.hand.squidRound, null); assert.equal(view.players.find(p => p.id === f.users[4].id).waitingFor, null);
  f.win(4); view = f.service.state(f.room, f.users[4].id);
  assert.equal(view.players.find(p => p.id === f.users[4].id).waitingFor, 'squid');
});

test('overtime waiting does not repeatedly write or refresh an already observed deadline', t => {
  const f = fixture(t); f.win(0); f.connect(3, false); f.cmd(0, 'autoDeal', { paused: true });
  f.advance(f.room.endsAt - f.time); assert.equal(f.service.tick(f.room, f.time), true);
  const deadline = f.service.state(f.room, f.users[0].id).mini.squid.expiryGraceEndsAt;
  const snapshot = structuredClone(f.data);
  for (let i = 0; i < 10; i++) { f.advance(1); assert.equal(f.service.tick(f.room, f.time), false); }
  assert.deepEqual(f.data, snapshot); assert.equal(deadline, f.time - 10 + 90000);
  assert.equal(f.room.autoDealPaused, true);
  f.advance(deadline - f.time); f.service.tick(f.room, f.time);
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.mini.squid.lastResult.reason, 'partial');
});
