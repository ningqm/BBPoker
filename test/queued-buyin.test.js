import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions, createHand } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';
import { aggregateAnalytics } from '../src/analytics.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore } from '../src/store.js';
import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';

function fixture(t, { count = 3, settings = {}, start = true, encrypted = false } = {}) {
  let time = 1800000000000; t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: count + 1 }, (_, i) => ({ id: `queued-${i}`, name: `朋友${i}`, avatar: 0 }));
  let store;
  if (encrypted) { const directory = mkdtempSync(join(tmpdir(), 'bbpoker-queued-buyin-')); t.after(() => rmSync(directory, { recursive: true, force: true })); store = new EncryptedStore(directory); }
  else store = { data: { users: {}, rooms: {}, hands: [], ledger: [] } };
  for (const user of users) store.data.users[user.id] = user;
  const service = new RoomService(store), room = service.create(users[0], { settings });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) { cmd(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  if (start) cmd(0, 'start');
  const ready = () => readyRoomAction(service, room, value => { time = value; });
  if (start) ready();
  const act = type => { assert.ok(ready()); return cmd(users.findIndex(user => user.id === room.hand.actingId), type); };
  const finish = () => { while (room.hand.status === 'playing') { if (room.hand.runout?.active || room.hand.transition) advanceRoomEvent(service, room, value => { time = value; }); else act('fold'); } };
  const state = i => service.state(room, users[i].id);
  return { users, store, service, room, cmd, act, finish, state, advance(ms) { time += ms; }, at(value) { time = value; }, get time() { return time; } };
}
function conserved(f) {
  const r = f.room;
  const held = Object.values(r.members).reduce((sum, m) => sum + m.stack + m.cashedOut, 0)
    + Object.values(r.mini.squid.reserves).reduce((a, b) => a + b, 0)
    + (r.hand?.status === 'playing' ? r.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0);
  assert.equal(held, Object.values(r.members).reduce((sum, m) => sum + m.totalBuyIn, 0));
}
function evictGeneralCommands(f) {
  for (let i = 0; i < 2001; i++) f.cmd(0, 'cancelDeparture');
  assert.equal(Object.keys(f.room.commandIds).length, 2000);
}

for (const phase of ['immediate', 'queued', 'applied', 'cancelled']) test(`durable top-up receipt prevents replay after cache eviction and encrypted restart (${phase})`, t => {
  const f = fixture(t, { count: 2, encrypted: true, start: phase !== 'immediate', settings: { maxTotalBuyInBB: 200 } });
  const id = f.users[1].id, commandId = randomUUID();
  f.cmd(1, 'buyin', { amountBB: 100, commandId });
  if (phase === 'cancelled') f.cmd(1, 'stand');
  if (['applied', 'cancelled'].includes(phase)) f.finish();
  const expectedStatus = phase === 'immediate' ? 'applied' : phase;
  assert.equal(f.room.members[id].buyinReceipts[`command:${commandId}`].status, expectedStatus);
  evictGeneralCommands(f);
  assert.equal(Object.hasOwn(f.room.commandIds, `${id}:${commandId}`), false);
  // Even changing the body cannot turn an accepted ID into a new transaction;
  // this check must precede the cumulative limit and absent-seat validators.
  const before = structuredClone(f.store.data);
  f.cmd(1, 'buyin', { amountBB: 1000, commandId });
  assert.deepEqual(f.store.data, before);
  assert.equal(JSON.stringify(f.state(0)).includes('buyinReceipts'), false);
  assert.equal(JSON.stringify(f.state(1)).includes('buyinReceipts'), false);
  f.store.save();
  const restored = new EncryptedStore(f.store.directory), service = new RoomService(restored), room = service.room(f.room.code);
  const persisted = structuredClone(restored.data);
  service.command(f.users[1], room.code, { type: 'buyin', amountBB: 150, commandId });
  assert.deepEqual(restored.data, persisted);
  // Cancelled requests cannot revive after the player buys back into the seat.
  if (phase === 'cancelled') {
    f.cmd(1, 'sit', { seat: 1, amountBB: 100 });
    const reseated = structuredClone(f.store.data);
    f.cmd(1, 'buyin', { amountBB: 100, commandId });
    assert.deepEqual(f.store.data, reseated);
  }
  // A queued receipt must still protect the same ID after delivery empties the queue.
  if (phase === 'queued') f.finish();
  if (f.room.hand?.status !== 'playing') {
    f.cmd(0, 'close'); const closed = structuredClone(f.store.data);
    f.cmd(1, 'buyin', { amountBB: 100, commandId }); assert.deepEqual(f.store.data, closed);
  }
  conserved(f);
});

test('top-up receipt IDs are member-specific, prototype-safe, and recorded only after acceptance', t => {
  const f = fixture(t, { start: false }), commandId = '__proto__';
  assert.throws(() => f.cmd(0, 'buyin', { amountBB: 10, commandId }), /单次带入/);
  assert.equal(f.room.members[f.users[0].id].buyinReceipts, undefined);
  for (const i of [0, 1]) f.cmd(i, 'buyin', { amountBB: 100, commandId });
  for (const i of [0, 1]) {
    const m = f.room.members[f.users[i].id];
    assert.equal(m.totalBuyIn, 2000);
    assert.deepEqual(Object.keys(m.buyinReceipts), ['command:__proto__']);
    assert.equal(Object.getPrototypeOf(m.buyinReceipts), Object.prototype);
  }
  evictGeneralCommands(f); const before = structuredClone(f.store.data);
  for (const i of [0, 1]) f.cmd(i, 'buyin', { amountBB: 150, commandId });
  assert.deepEqual(f.store.data, before); conserved(f);
});

for (const squid of [false, true]) test(`mid-hand queue stays outside poker and financial results until settlement (squid=${squid})`, t => {
  const f = fixture(t, { settings: { squid, squidMode: 'unlimited' } }), id = f.users[0].id;
  const frozen = structuredClone(f.room.hand), mini = structuredClone(f.room.mini), stack = f.room.members[id].stack, net = f.state(0).players.find(p => p.id === id).sessionProfit;
  const commandId = randomUUID(); f.cmd(0, 'buyin', { amountBB: 100, commandId });
  assert.equal(f.state(0).players.find(p => p.id === id).pendingBuyIn, 1000);
  assert.equal(f.room.members[id].stack, stack); assert.equal(f.room.members[id].totalBuyIn, 1000);
  assert.equal(f.state(0).players.find(p => p.id === id).sessionProfit, net);
  assert.deepEqual(f.room.hand, frozen); assert.deepEqual(f.room.mini, mini); conserved(f);
  f.cmd(0, 'buyin', { amountBB: 100, commandId }); assert.equal(f.service.pendingBuyIn(f.room.members[id]), 1000);
  f.finish(); const h = f.room.hand, p = h.players.find(p => p.id === id);
  assert.equal(f.room.members[id].totalBuyIn, 2000); assert.equal(f.service.pendingBuyIn(f.room.members[id]), 0);
  assert.equal(f.room.members[id].stack, h.endingStacks[id] + 1000);
  assert.equal(aggregateAnalytics(f.store.data, id).holdemNet, p.stack - p.startingStack);
  assert.equal(f.store.data.ledger.filter(row => row.type === 'buyin' && row.playerId === id).length, 2);
  assert.deepEqual(f.store.data.hands[0].endingStacks, h.endingStacks); conserved(f);
  const before = structuredClone(f.store.data); f.cmd(0, 'buyin', { amountBB: 100, commandId }); assert.deepEqual(f.store.data, before);
});

test('all-in queued chips cannot re-open action or change pot caps and arrive before the rebuy decision', t => {
  const f = fixture(t, { count: 2 }), h = f.room.hand;
  const deck = Array(52), holes = [['As', 'Ah'], ['Ks', 'Kh']];
  for (const p of h.players) for (const [i, index] of p.cardIndices.entries()) deck[index] = holes[p.seat][i];
  for (const [offset, card] of [[1, '2c'], [2, '7d'], [3, '9s'], [5, 'Jd'], [7, '3c']]) deck[4 + offset] = card;
  const rest = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s)).filter(c => !deck.includes(c));
  for (let i = 0; i < 52; i++) if (!deck[i]) deck[i] = rest.shift();
  Object.assign(h, createHand({ id: h.id, players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, stack: p.startingStack })), buttonSeat: h.buttonSeat, smallBlind: 5, bigBlind: 10, deck, deferredRunout: true, deferredTransitions: true })); h.audit = commitDeck(h);
  f.act('allin'); f.act('allin'); const frozen = structuredClone(h), reserve = structuredClone(h.allInLock);
  f.cmd(1, 'buyin', { amountBB: 150 });
  assert.deepEqual(h, frozen); assert.deepEqual(h.allInLock, reserve); assert.equal(h.players[1].stack, 0); assert.equal(f.room.members[f.users[1].id].stack, 0);
  f.finish(); assert.equal(h.result.payouts[f.users[0].id], 2000); assert.equal(h.result.payouts[f.users[1].id], 0);
  assert.equal(h.endingStacks[f.users[1].id], 0); assert.equal(f.room.members[f.users[1].id].stack, 1500);
  assert.equal(f.room.rebuyGrace, null); assert.equal(f.room.nextHandAt, f.time + 5000); conserved(f);
});

test('multiple queued requests count against cumulative cap without crediting the current hand', t => {
  const f = fixture(t, { settings: { maxTotalBuyInBB: 350 } }), id = f.users[1].id;
  f.cmd(1, 'buyin', { amountBB: 100 }); f.cmd(1, 'buyin', { amountBB: 150 });
  assert.equal(f.room.members[id].totalBuyIn, 1000); assert.equal(f.service.pendingBuyIn(f.room.members[id]), 2500);
  const frozen = structuredClone(f.store.data);
  assert.throws(() => f.cmd(1, 'buyin', { amountBB: 100 }), /累计带入/); assert.deepEqual(f.store.data, frozen);
  f.finish(); assert.equal(f.room.members[id].totalBuyIn, 3500); assert.equal(f.service.pendingBuyIn(f.room.members[id]), 0); conserved(f);
});

test('a queued request survives encrypted restart and reconnect, and applies exactly once', t => {
  const f = fixture(t, { encrypted: true }), id = f.users[1].id, commandId = randomUUID();
  f.cmd(1, 'buyin', { amountBB: 100, commandId }); f.store.save();
  const restoredStore = new EncryptedStore(f.store.directory), service = new RoomService(restoredStore), room = service.room(f.room.code);
  assert.deepEqual(restoredStore.data, f.store.data);
  service.connections.set(`${room.code}:${id}`, 1); service.connectionChanged(room, f.time, { reconnected: true });
  while (readyRoomAction(service, room, value => f.at(value))) service.command(f.users.find(u => u.id === room.hand.actingId), room.code, { type: 'fold', commandId: randomUUID(), handId: room.hand.id, actionSeq: room.hand.log.length });
  assert.equal(room.members[id].totalBuyIn, 2000); assert.equal(service.pendingBuyIn(room.members[id]), 0);
  const before = structuredClone(restoredStore.data); service.command(f.users[1], room.code, { type: 'buyin', amountBB: 100, commandId }); assert.deepEqual(restoredStore.data, before);
});

test('stand cancels an unpaid queue with explicit audit note while sit-out keeps the queued top-up without resuming', t => {
  const f = fixture(t, { count: 4 });
  for (const i of [1, 2]) f.cmd(i, 'buyin', { amountBB: 100 });
  f.cmd(1, 'stand'); f.cmd(2, 'sitout', { value: true });
  assert.throws(() => f.cmd(1, 'buyin', { amountBB: 100 }), /已安排离座/);
  f.finish(); const stand = f.room.members[f.users[1].id], sitout = f.room.members[f.users[2].id];
  assert.equal(stand.seat, null); assert.equal(stand.totalBuyIn, 1000); assert.equal(f.service.pendingBuyIn(stand), 0);
  const cancelled = f.store.data.ledger.find(row => row.type === 'buyinCancelled'); assert.equal(cancelled.cancelledAmount, 1000); assert.equal(cancelled.amount, 0); assert.match(cancelled.note, /取消.*不计入/);
  assert.equal(sitout.sittingOut, true); assert.equal(sitout.totalBuyIn, 2000); assert.equal(f.service.pendingBuyIn(sitout), 0);
  f.cmd(2, 'buyin', { amountBB: 100 }); assert.equal(sitout.sittingOut, true); assert.equal(sitout.totalBuyIn, 3000); conserved(f);
});

test('before first deal and between hands top-ups arrive immediately, without shortening the visible result wait', t => {
  const f = fixture(t, { start: false }); f.cmd(0, 'buyin', { amountBB: 100 }); assert.equal(f.room.members[f.users[0].id].stack, 2000);
  f.cmd(0, 'start'); assert.equal(f.room.hand.players.find(p => p.id === f.users[0].id).startingStack, 2000);
  f.finish(); const due = f.room.nextHandAt; f.cmd(1, 'buyin', { amountBB: 100 });
  assert.equal(f.room.handNumber, 1); assert.equal(f.room.nextHandAt, due); assert.equal(f.service.pendingBuyIn(f.room.members[f.users[1].id]), 0); conserved(f);
});

test('a queued observer does not join the live hand or squid and a returned participant keeps the original entry debt', t => {
  const f = fixture(t, { settings: { squid: true, squidMode: 'unlimited' } }), newcomer = 3;
  f.cmd(newcomer, 'sit', { seat: 3, amountBB: 100, entryMode: 'post' });
  const h = structuredClone(f.room.hand), round = structuredClone(f.room.mini.squid), entry = structuredClone(f.room.members[f.users[newcomer].id].entry);
  f.cmd(newcomer, 'buyin', { amountBB: 100 });
  assert.deepEqual(f.room.hand, h); assert.deepEqual(f.room.mini.squid, round);
  f.finish(); assert.equal(f.room.members[f.users[newcomer].id].totalBuyIn, 2000);
  assert.equal(f.room.hand.players.some(p => p.id === f.users[newcomer].id), false);
  assert.deepEqual(f.room.members[f.users[newcomer].id].entry, entry); assert.equal(f.room.mini.squid.participants.length, 3); conserved(f);
});

test('newly seated observers can cancel a queued top-up by standing without changing the hand or fish roster', t => {
  const f = fixture(t, { settings: { squid: true } }), newcomer = 3;
  f.cmd(newcomer, 'sit', { seat: 3, amountBB: 100 }); f.cmd(newcomer, 'buyin', { amountBB: 100 });
  const before = structuredClone(f.room.hand), mini = structuredClone(f.room.mini);
  f.cmd(newcomer, 'stand'); const m = f.room.members[f.users[newcomer].id];
  assert.equal(m.seat, null); assert.equal(m.cashedOut, 1000); assert.equal(m.totalBuyIn, 1000); assert.equal(f.service.pendingBuyIn(m), 0);
  assert.deepEqual(f.room.hand, before); assert.deepEqual(f.room.mini, mini);
  const row = f.store.data.ledger.find(row => row.type === 'buyinCancelled' && row.playerId === m.id); assert.equal(row.cancelledAmount, 1000); conserved(f);
});

test('canceling a planned departure keeps the accepted queue, while closing after delivery cashes out exactly the funded stack', t => {
  const f = fixture(t), id = f.users[1].id;
  f.cmd(1, 'buyin', { amountBB: 100 }); f.cmd(1, 'stand'); f.cmd(1, 'cancelDeparture');
  const before = structuredClone(f.store.data); assert.throws(() => f.cmd(0, 'close'), /本手结束/); assert.deepEqual(f.store.data, before);
  f.finish(); assert.equal(f.room.members[id].totalBuyIn, 2000); assert.equal(f.store.data.ledger.filter(row => row.type === 'buyinCancelled').length, 0);
  const net = f.state(1).players.find(p => p.id === id).sessionProfit, stack = f.room.members[id].stack;
  f.cmd(0, 'close'); assert.equal(f.room.members[id].cashedOut, stack); assert.equal(f.room.members[id].stack, 0);
  assert.equal(f.state(1).players.find(p => p.id === id).sessionProfit, net); conserved(f);
});
