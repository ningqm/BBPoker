import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { entryBlindView, entryChoiceFeedback, buyinTiming } from '../public/lifecycle.js';
import { readyRoomAction } from './helpers/room-clock.js';

function fixture(t, { squid = false, mode = 'normal', bomb = false } = {}) {
  let time = 1800000000000;
  t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: 9 }, (_, i) => ({ id: `entry-${i}`, name: `Entry ${i}`, avatar: 0 }));
  const store = { data: { users: Object.fromEntries(users.map(user => [user.id, user])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], { settings: { maxPlayers: 9, squid, squidMode: mode === 'unlimited' ? 'unlimited' : 'normal',
    squidUnitBB: 1, bombPot: bomb, bombIntervalMinutes: 1 } });
  const cmd = (i, type, data = {}) => service.command(users[i], room.code, { commandId: randomUUID(), type, handId: room.hand?.id, actionSeq: room.hand?.log.length, ...data });
  for (const [i, user] of users.entries()) {
    if (i) service.join(user, room.code, room.invite);
    service.connections.set(`${room.code}:${user.id}`, 1);
  }
  for (const i of [0, 2, 4, 6, 8]) cmd(i, 'sit', { seat: i, amountBB: 200 });
  cmd(0, 'start'); cmd(0, 'autoDeal', { paused: true });
  const ready = () => readyRoomAction(service, room, value => { time = value; });
  const finish = (winner = 0) => {
    for (let n = 0; room.hand.status === 'playing'; n++) {
      assert.ok(n < 100);
      if (!ready()) break;
      const actor = users.findIndex(user => user.id === room.hand.actingId), legal = availableActions(room.hand, room.hand.actingId);
      cmd(actor, actor === winner ? legal.canCheck ? 'check' : 'call' : 'fold');
    }
    service.completeRabbit(room, time);
    time += 5000;
  };
  const state = i => { const result = service.state(room, users[i].id); return { room: result, player: result.players.find(player => player.id === users[i].id) }; };
  return { users, room, service, store, cmd, ready, finish, state,
    start() { service.start(room, time, { automatic: true }); },
    member(i) { return room.members[users[i].id]; },
    advance(ms) { time += ms; },
    conserved() {
      const all = Object.values(room.members), pot = room.hand?.status === 'playing' ? room.hand.players.reduce((sum, player) => sum + player.contributed, 0) : 0;
      assert.equal(all.reduce((sum, player) => sum + player.stack + player.cashedOut, 0) + Object.values(room.mini.squid.reserves).reduce((sum, amount) => sum + amount, 0) + pot,
        all.reduce((sum, player) => sum + player.totalBuyIn, 0));
    },
  };
}

for (const mode of ['holdem', 'normal', 'unlimited']) for (const bomb of [false, true]) {
  test(`nine-seat ${mode}${bomb ? ' + bomb' : ''}: buying in seats immediately; mode switches expose the next legal deal without charges`, t => {
    const f = fixture(t, { squid: mode !== 'holdem', mode, bomb }), originalHand = structuredClone(f.room.hand);
    const mini = structuredClone(f.room.mini), sitCommands = [];
    for (const i of [1, 3, 5, 7]) {
      const command = { seat: i, amountBB: 200, entryMode: i === 3 ? 'post' : 'wait', commandId: randomUUID() };
      f.cmd(i, 'sit', command); sitCommands.push([i, command]);
      const view = f.state(i);
      assert.equal(view.player.seat, i, 'the command response already has the seat, even during a live hand');
      assert.equal(view.player.stack, 2000); assert.equal(view.player.totalBuyIn, 2000);
      assert.equal(view.player.inHand, false); assert.equal(view.player.cards.length, 0);
      assert.equal(view.player.entryBlind.mode, command.entryMode);
      assert.match(buyinTiming(view.room, true, view.player), /立即入座/);
      f.cmd(i, 'sit', command);
      assert.equal(f.member(i).totalBuyIn, 2000, 'repeat submission cannot purchase twice');
    }
    assert.deepEqual(f.room.hand, originalHand, 'mid-hand seating may not modify dealt cards, actions or existing stacks');
    assert.deepEqual(f.room.mini, mini, 'waiting newcomers do not yet enlarge or pay for the squid round');
    assert.equal(f.state(1).room.players.filter(player => player.seat !== null).length, 9);
    const funded = f.member(3).stack;
    for (const choice of ['wait', 'post', 'wait', 'post']) {
      const id = randomUUID(); f.cmd(3, 'entryBlind', { mode: choice, commandId: id });
      const beforeRetry = structuredClone(f.room); f.cmd(3, 'entryBlind', { mode: choice, commandId: id });
      assert.deepEqual(f.room, beforeRetry, 'retry cannot silently apply the same choice twice');
      const { room, player } = f.state(3), view = entryBlindView(room, player);
      assert.equal(view.mode, choice); assert.equal(player.seat, 3); assert.equal(player.stack, funded);
      assert.equal(player.entryBlind.waitingFor, choice === 'wait' ? 'bigBlind' : 'button');
      assert.match(entryChoiceFeedback(room, player), choice === 'wait' ? /已保存：等大盲/ : /已保存：补盲/);
      assert.match(view.note, choice === 'post' ? /庄位或小盲保护区/ : /不发牌、不扣盲/);
    }
    // Seat 5 is the next natural BB; choosing post must not add a second BB.
    for (const choice of ['post', 'wait']) {
      f.cmd(5, 'entryBlind', { mode: choice });
      const { room, player } = f.state(5);
      assert.equal(player.entryBlind.naturalBigBlind, true); assert.match(entryBlindView(room, player).label, /下一手大盲/);
    }
    f.cmd(1, 'entryBlind', { mode: 'post' });
    const beforeReads = structuredClone(f.store.data);
    for (let n = 0; n < 3; n++) for (const i of [1, 3, 5, 7]) f.state(i);
    assert.deepEqual(f.store.data, beforeReads, 'UI status projections are read-only');
    f.finish(); if (bomb) f.advance(60000);
    const protectedView = f.state(3);
    assert.equal(protectedView.player.entryBlind.waitingFor, 'button');
    assert.match(entryBlindView(protectedView.room, protectedView.player).label, /等待过庄/);
    f.start();
    assert.equal(f.room.hand.bombPot, false, 'a due bomb cannot bypass newcomer blind obligations');
    const forced = id => f.room.hand.log.filter(row => row.playerId === id && ['smallBlind', 'bigBlind', 'entryBlind', 'deadBlind'].includes(row.type));
    assert.deepEqual(forced(f.users[1].id).map(row => [row.type, row.amount]), [['entryBlind', 10]]);
    assert.deepEqual(forced(f.users[5].id).map(row => [row.type, row.amount]), [['bigBlind', 10]]);
    assert.equal(f.room.hand.players.some(player => player.id === f.users[3].id), false);
    assert.equal(f.room.hand.players.some(player => player.id === f.users[7].id), false);
    assert.equal(f.member(3).stack, 2000); assert.equal(f.member(7).stack, 2000);
    if (mode !== 'holdem') {
      assert.equal(f.room.mini.squid.participants.length, 7);
      assert.equal(f.room.mini.squid.counts[f.users[1].id], 0); assert.equal(f.room.mini.squid.counts[f.users[5].id], 0);
      assert.equal(f.room.mini.squid.tokenBudget, mode === 'unlimited' ? 10 : 6);
    }
    f.conserved();
    // A still-waiting user may stand and re-seat. An earlier successful buy-in
    // retry cannot move them back, buy again, change mode or discard new funds.
    f.cmd(3, 'stand'); f.cmd(3, 'sit', { seat: 3, amountBB: 100, entryMode: 'post' });
    const reseated = structuredClone(f.room);
    f.cmd(3, 'sit', sitCommands.find(([i]) => i === 3)[1]); assert.deepEqual(f.room, reseated);
    assert.equal(f.member(3).seat, 3); assert.equal(f.member(3).totalBuyIn, 3000); assert.equal(f.member(3).stack, 1000);
    // Once the protected arc moves on, both waiters get dealt within one orbit.
    const seen = new Set();
    for (let n = 0; n < 10 && seen.size < 2; n++) {
      f.finish(); f.start();
      for (const i of [3, 7]) if (f.room.hand.players.some(player => player.id === f.users[i].id)) seen.add(i);
      for (const i of [3, 7]) {
        assert.ok(forced(f.users[i].id).filter(row => row.type === 'entryBlind').length <= 1);
        assert.ok(!forced(f.users[i].id).some(row => row.type === 'bigBlind') || !forced(f.users[i].id).some(row => row.type === 'entryBlind'));
      }
      f.conserved();
    }
    assert.deepEqual([...seen].sort(), [3, 7], 'waiting is bounded after player positions stabilize');
    if (mode !== 'holdem') {
      assert.equal(f.room.mini.squid.participants.length, 9);
      assert.equal(f.room.mini.squid.tokenBudget, mode === 'unlimited' ? 12 : 8);
    }
    if (bomb) {
      f.finish(); f.start(); assert.equal(f.room.hand.bombPot, true);
      assert.equal(f.room.hand.players.length, 9);
      assert.equal(f.room.hand.log.filter(row => row.type === 'ante').length, 9);
      assert.equal(f.room.hand.log.some(row => ['smallBlind', 'bigBlind', 'entryBlind', 'deadBlind'].includes(row.type)), false);
      f.conserved();
    }
  });
}

test('read-only entry feedback describes offline and paused seating, and does not hide saved choice', t => {
  const f = fixture(t); f.cmd(3, 'sit', { seat: 3, amountBB: 100, entryMode: 'post' });
  f.service.connections.set(`${f.room.code}:${f.users[3].id}`, 0);
  let current = f.state(3); assert.equal(current.player.seat, 3);
  assert.equal(current.player.entryBlind.waitingFor, 'offline'); assert.match(entryChoiceFeedback(current.room, current.player), /已保存：补盲.*连接恢复/);
  f.service.connections.set(`${f.room.code}:${f.users[3].id}`, 1);
  f.cmd(3, 'sitout', { value: true }); current = f.state(3);
  assert.equal(current.player.entryBlind.waitingFor, 'sittingOut'); assert.equal(entryBlindView(current.room, current.player).canChoose, false);
  f.cmd(3, 'sitout', { value: false, entryMode: 'wait' }); current = f.state(3);
  assert.equal(current.player.entryBlind.mode, 'wait'); assert.equal(entryBlindView(current.room, current.player).canChoose, true);
  f.conserved();
});
