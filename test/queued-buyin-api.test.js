import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { readyRoomAction } from './helpers/room-clock.js';

async function fixture(t) {
  let time = 1800000000000; t.mock.method(Date, 'now', () => time);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-queue-api-'));
  const app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 10 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, user, body, expected = 200) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  const users = [];
  for (const name of ['queue-api-a', 'queue-api-b']) users.push(await api('/api/session', null, { name }, 201));
  const created = (await api('/api/rooms', users[0], { settings: { maxTotalBuyInBB: 300 } }, 201)).room, code = created.code;
  await api(`/api/rooms/${code}/join`, users[1], { invite: created.invite });
  const room = () => app.store.data.rooms[code];
  const command = (i, body, expected) => api(`/api/rooms/${code}/action`, users[i], { commandId: randomUUID(), ...body }, expected);
  for (let i = 0; i < 2; i++) { await command(i, { type: 'sit', seat: i, amountBB: 100 }); app.service.connections.set(`${code}:${users[i].user.id}`, 1); }
  await command(0, { type: 'start' });
  const ready = () => { const available = readyRoomAction(app.service, room(), value => { time = value; }); app.store.save(); return available; };
  ready();
  return { app, users, api, command, room, code, ready, at(value) { time = value; } };
}

test('queue and settlement writes roll back atomically; concurrent duplicate/retried requests credit exactly once', async t => {
  const f = await fixture(t), id = f.users[1].user.id, path = `/api/rooms/${f.code}/action`;
  const first = { commandId: randomUUID(), type: 'buyin', amountBB: 100 }, frozenHand = structuredClone(f.room().hand);
  await Promise.all([f.api(path, f.users[1], first), f.api(path, f.users[1], first)]);
  assert.equal(f.app.service.pendingBuyIn(f.room().members[id]), 1000); assert.equal(f.room().members[id].totalBuyIn, 1000);
  assert.deepEqual(f.room().hand, frozenHand);
  const second = { commandId: randomUUID(), type: 'buyin', amountBB: 100 }, beforeQueue = structuredClone(f.app.store.data), save = f.app.store.save;
  f.app.store.save = () => { throw new Error('synthetic queued write failure'); };
  await f.api(path, f.users[1], second, 400); f.app.store.save = save;
  assert.deepEqual(f.app.store.data, beforeQueue); assert.deepEqual(f.app.store.read(), beforeQueue);
  await f.api(path, f.users[1], second); assert.equal(f.app.service.pendingBuyIn(f.room().members[id]), 2000);
  const capped = structuredClone(f.app.store.data); await f.command(1, { type: 'buyin', amountBB: 100 }, 400); assert.deepEqual(f.app.store.data, capped);
  const h = f.room().hand, actor = f.users.find(user => user.user.id === h.actingId), fold = { commandId: randomUUID(), type: 'fold', handId: h.id, actionSeq: h.log.length };
  await f.api(path, actor, fold);
  const beforeFinish = structuredClone(f.app.store.data);
  assert.equal(f.room().hand.transition.kind, 'award');
  const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args));
  f.app.store.save = () => { throw new Error('synthetic payout plus topup write failure'); };
  f.at(f.room().hand.transition.nextAt); await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok(errors.length > 0); f.app.store.save = save;
  assert.deepEqual(f.app.store.data, beforeFinish); assert.deepEqual(f.app.store.read(), beforeFinish);
  for (let i = 0; i < 100 && f.room().hand.status !== 'complete'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.room().hand.status, 'complete');
  const delivered = structuredClone(f.app.store.data);
  await f.api(path, actor, fold); assert.deepEqual(f.app.store.data, delivered);
  // General cache churn must not make delivered financial requests new again.
  for (let i = 0; i < 2001; i++) f.app.service.command(f.users[0].user, f.code, { type: 'cancelDeparture', commandId: randomUUID() });
  assert.equal(Object.hasOwn(f.room().commandIds, `${id}:${first.commandId}`), false);
  assert.equal(Object.hasOwn(f.room().commandIds, `${id}:${second.commandId}`), false);
  f.app.store.save();
  const completed = structuredClone(f.app.store.data), room = f.room();
  assert.equal(room.hand.status, 'complete'); assert.equal(room.members[id].totalBuyIn, 3000); assert.equal(f.app.service.pendingBuyIn(room.members[id]), 0);
  assert.equal(room.members[id].stack, room.hand.endingStacks[id] + 2000);
  assert.equal(completed.ledger.filter(row => row.type === 'buyin' && row.playerId === id).length, 3);
  // The hand-action ID is intentionally in the bounded cache; only money IDs
  // are retained permanently. The old top-ups still return successfully at cap.
  await f.api(path, f.users[1], first); await f.api(path, f.users[1], { ...second, amountBB: 1000 });
  assert.deepEqual(f.app.store.data, completed); assert.deepEqual(f.app.store.read(), completed);
});

test('an arrival racing the next deal is assigned by actual server phase and cannot join an already dealt stack', async t => {
  const f = await fixture(t), h = f.room().hand;
  await f.command(f.users.findIndex(user => user.user.id === h.actingId), { type: 'fold', handId: h.id, actionSeq: h.log.length });
  assert.equal(f.ready(), false);
  // First arrival occurs before the next deal and immediately becomes usable.
  await f.command(0, { type: 'buyin', amountBB: 100 });
  const beforeDeal = f.room().members[f.users[0].user.id].stack;
  f.app.service.completeRabbit(f.room()); f.app.service.start(f.room(), Date.now() + 5000); f.app.store.save();
  const dealt = structuredClone(f.room().hand);
  assert.equal(dealt.players.find(player => player.id === f.users[0].user.id).startingStack, beforeDeal);
  // Identical UI intention arrives after the deal: queue it for this hand end.
  await f.command(0, { type: 'buyin', amountBB: 100 });
  assert.deepEqual(f.room().hand, dealt); assert.equal(f.app.service.pendingBuyIn(f.room().members[f.users[0].user.id]), 1000);
  const queued = f.room().members[f.users[0].user.id].queuedBuyins;
  assert.equal(queued[0].handId, dealt.id); assert.notEqual(queued[0].handId, h.id);
});
