import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { EncryptedStore } from '../src/store.js';
import { availableActions } from '../src/poker.js';
import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';

function fixture(t) {
  let time = 1800000000000;
  t.mock.method(Date, 'now', () => time);
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-two-table-financial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EncryptedStore(dir);
  const users = Array.from({ length: 18 }, (_, i) => ({ id: `financial-${i}`, name: `Synthetic ${i}` }));
  for (const u of users) store.data.users[u.id] = u;
  const service = new RoomService(store);
  const f = { store, users, service, dir, get time() { return time; }, at(value) { assert.ok(value >= time); time = value; } };
  f.cmd = (room, index, type, extra = {}) => service.command(users[index], room.code, {
    type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra,
  });
  f.online = (room, index, value) => {
    const key = `${room.code}:${users[index].id}`;
    if (value) service.connections.set(key, 1); else service.connections.delete(key);
    service.connectionChanged(room, time, { reconnected: value });
  };
  f.seat = (room, index, seat, extra = {}) => {
    service.join(users[index], room.code, room.invite);
    f.cmd(room, index, 'sit', { seat, amountBB: 100, ...extra });
    f.online(room, index, true);
  };
  f.start = room => { service.start(room, time, { automatic: true }); f.cmd(room, users.findIndex(u => u.id === room.hostId), 'autoDeal', { paused: true }); };
  f.win = (room, winnerIndex) => {
    for (let n = 0; room.hand.status === 'playing'; n++) {
      assert.ok(n < 100, 'bounded fold-down must finish');
      if (room.hand.transition || room.hand.runout?.active) {
        assert.ok(advanceRoomEvent(service, room, value => f.at(value))); continue;
      }
      assert.ok(readyRoomAction(service, room, value => f.at(value)));
      const actor = users.findIndex(u => u.id === room.hand.actingId), a = availableActions(room.hand, room.hand.actingId);
      f.cmd(room, actor, actor === winnerIndex ? a.canCheck ? 'check' : 'call' : 'fold');
    }
    assert.deepEqual(room.hand.result.mainWinnerIds, [users[winnerIndex].id]);
    service.completeRabbit(room, time);
  };
  return f;
}
function conserved(room) {
  const members = Object.values(room.members);
  const chips = members.reduce((sum, m) => sum + m.stack + m.cashedOut, 0)
    + Object.values(room.mini.squid.reserves).reduce((a, b) => a + b, 0)
    + (room.hand?.status === 'playing' ? room.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0);
  assert.equal(chips, members.reduce((sum, m) => sum + m.totalBuyIn, 0));
}

// Initial seating is a financial request too. A delayed retry must not become
// a second buy-in after the short command cache expires and the player leaves.
test('initial sit receipt survives command eviction, departure, encrypted restart and table closure', t => {
  const f = fixture(t), room = f.service.create(f.users[0], {}), commandId = 'durable-initial-sit';
  f.seat(room, 0, 0, { commandId });
  f.cmd(room, 0, 'stand');
  for (let i = 0; i < 2001; i++) f.cmd(room, 0, 'cancelDeparture');
  assert.equal(Object.hasOwn(room.commandIds, `${f.users[0].id}:${commandId}`), false);
  const before = structuredClone(f.store.data);
  f.cmd(room, 0, 'sit', { seat: 1, amountBB: 1000, commandId });
  assert.deepEqual(f.store.data, before, 'replaying the accepted sit cannot re-seat or charge again, even with a changed body');
  f.store.save();
  const restored = new EncryptedStore(f.dir), service = new RoomService(restored), saved = service.room(room.code);
  service.command(f.users[0], room.code, { type: 'close', commandId: randomUUID() });
  const closed = structuredClone(restored.data);
  service.command(f.users[0], room.code, { type: 'sit', seat: 0, amountBB: 100, commandId });
  assert.deepEqual(restored.data, closed, 'an old accepted seating retry remains harmless on a closed table');
  assert.equal(saved.members[f.users[0].id].totalBuyIn, 1000);
  assert.equal(saved.members[f.users[0].id].cashedOut, 1000);
  conserved(saved);
});

for (const mode of ['normal', 'unlimited']) for (const marked of [false, true]) {
  test(`cross-table ${mode}: departed ${marked ? 'fish holder' : 'unmarked player'} settles A while playing and queueing a buy-in in B`, t => {
    const f = fixture(t), hero = f.users[3], sharedId = 'same-id-different-table';
    const settings = { maxPlayers: 9, durationMinutes: 30, squid: true, squidMode: mode, squidUnitBB: 2, bombPot: true, bombIntervalMinutes: 1 };
    const a = f.service.create(f.users[0], { settings });
    const b = f.service.create(f.users[9], { settings: { ...settings, squidMode: mode === 'normal' ? 'unlimited' : 'normal' } });
    for (let i = 0; i < 9; i++) f.seat(a, i, i);
    f.start(a);
    assert.ok(readyRoomAction(f.service, a, value => f.at(value)));
    assert.equal(a.hand.actingId, hero.id);
    f.cmd(a, 3, 'timebank', { commandId: sharedId });
    f.win(a, marked ? 3 : 0);
    const reserve = a.mini.squid.reserves[hero.id];
    f.cmd(a, 3, 'stand', { expectedSquidRound: a.mini.squid.round, expectedSquidCost: marked ? 0 : reserve });
    f.online(a, 3, false);
    const oldCashout = a.members[hero.id].cashedOut;
    const seats = [0, 1, 2, 4, 5, 6, 7, 8];
    seats.forEach((seat, i) => f.seat(b, i + 9, seat));
    f.seat(b, 3, 3);
    f.start(b);
    assert.equal(b.hand.players.length, 9);
    assert.ok(readyRoomAction(f.service, b, value => f.at(value)));
    assert.equal(b.hand.actingId, hero.id);
    assert.equal(a.members[hero.id].timeBank.remaining, 2);
    assert.equal(b.members[hero.id].timeBank.remaining, 3, 'time cards belong to the table, not the shared account');
    const baseDeadline = b.deadline;
    f.cmd(b, 3, 'timebank', { commandId: sharedId });
    assert.equal(b.deadline, baseDeadline + 30000, 'an accepted A command ID is a fresh request in B');
    f.cmd(b, 3, 'buyin', { amountBB: 100, commandId: 'queued-second-table' });
    const frozenB = structuredClone(b);
    f.online(a, 3, true); f.online(a, 3, false);
    assert.deepEqual(b, frozenB, 'old-table presence cannot reset the new-table timer or mutate its queue');
    f.cmd(a, 0, 'close');
    assert.deepEqual(b, frozenB, 'old-room fish settlement cannot move a new-room live stack, pot, deck, deadline or top-up');
    const expectedFishNet = marked ? 8 * 20 : -20;
    assert.equal(a.members[hero.id].cashedOut, oldCashout + reserve + expectedFishNet);
    assert.equal(b.members[hero.id].totalBuyIn, 1000);
    assert.equal(f.service.pendingBuyIn(b.members[hero.id]), 1000);
    assert.deepEqual(f.store.data.ledger.filter(row => row.type === 'squidSettlement' && row.playerId === hero.id).map(row => [row.roomCode, row.amount]), [[a.code, expectedFishNet]]);
    assert.equal(f.service.online(b, hero.id), true);
    conserved(a); conserved(b);
    f.store.save();
    const restored = new EncryptedStore(f.dir), resumed = new RoomService(restored), restoredB = resumed.room(b.code);
    assert.deepEqual(restoredB, frozenB, 'encrypted reload preserves both room-specific money and exact deadline');
    const snapshot = structuredClone(restored.data);
    resumed.command(hero, b.code, { type: 'buyin', amountBB: 100, commandId: 'queued-second-table' });
    resumed.command(hero, b.code, { type: 'timebank', handId: b.hand.id, actionSeq: b.hand.log.length, commandId: sharedId });
    assert.deepEqual(restored.data, snapshot, 'repeated B commands after restart cannot duplicate queue or time extension');
    f.win(b, 9);
    assert.equal(b.members[hero.id].totalBuyIn, 2000);
    assert.equal(f.service.pendingBuyIn(b.members[hero.id]), 0);
    assert.equal(b.members[hero.id].stack, b.hand.endingStacks[hero.id] + 1000);
    assert.equal(f.store.data.ledger.filter(row => row.roomCode === b.code && row.type === 'buyin' && row.playerId === hero.id).length, 2);
    assert.equal(a.members[hero.id].cashedOut, oldCashout + reserve + expectedFishNet);
    conserved(a); conserved(b);
  });
}
