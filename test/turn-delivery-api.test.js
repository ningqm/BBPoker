import { seedLegacyAccount } from './helpers/accounts.js';
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
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-delivery-api-'));
  let app = createApp({ dataDir: directory, actionTickMs: 100000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  let base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, user, body, expected = 200) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  const users = [];
  for (const name of ['delivery-a', 'delivery-b', 'delivery-outsider']) users.push(seedLegacyAccount(app, { name }));
  const created = (await api('/api/rooms', users[0], {}, 201)).room, code = created.code;
  await api(`/api/rooms/${code}/join`, users[1], { invite: created.invite });
  const room = () => app.store.data.rooms[code];
  const command = (i, body, expected) => api(`/api/rooms/${code}/action`, users[i], { commandId: randomUUID(), ...body }, expected);
  for (let i = 0; i < 2; i++) { await command(i, { type: 'sit', seat: i, amountBB: 100 }); app.service.connections.set(`${code}:${users[i].user.id}`, 1); }
  await command(0, { type: 'start' });
  const ready = () => { readyRoomAction(app.service, room(), value => { time = value; }); app.store.save(); };
  ready();
  const actor = users.find(user => user.user.id === room().hand.actingId);
  return { get app() { return app; }, users, actor, api, command, room, code, ready, at(value) { time = value; },
    async restart() {
      await app.close(); app = createApp({ dataDir: directory, actionTickMs: 100000 });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`;
    } };
}

test('freshness probe stays small while unchanged, recovers an early missing action with private-safe state', async t => {
  const f = await fixture(t), actorIndex = f.users.indexOf(f.actor), other = f.users[1 - actorIndex];
  const old = await f.api(`/api/rooms/${f.code}`, other);
  const unchanged = await f.api(`/api/rooms/${f.code}/sync?revision=${old.revision}&canAct=0`, other);
  assert.equal(unchanged.unchanged, true); assert.equal(unchanged.room, undefined);
  assert.ok(JSON.stringify(unchanged).length < 200);
  const h = f.room().hand;
  await f.command(actorIndex, { type: 'call', handId: h.id, actionSeq: h.log.length });
  const updated = await f.api(`/api/rooms/${f.code}/sync?revision=${old.revision}&canAct=0`, other);
  assert.equal(updated.room.hand.actingId, other.user.id); assert.equal(updated.room.actions.canAct, true);
  const hidden = updated.room.players.find(p => p.id === f.actor.user.id);
  assert.deepEqual(hidden.cards, [null, null]);
  await f.api(`/api/rooms/${f.code}/sync?revision=${old.revision}&canAct=0`, f.users[2], undefined, 403);
  await f.api(`/api/rooms/${f.code}/sync`, undefined, undefined, 401);
});

test('late render acknowledgement extends the server deadline once and survives durable reload', async t => {
  const f = await fixture(t), hand = f.room().hand, oldDeadline = f.room().deadline;
  const receipt = { handId: hand.id, actionSeq: hand.log.length };
  f.at(f.room().presentation.actionReadyAt + 6000);
  const [first, retry] = await Promise.all([f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, receipt), f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, receipt)]);
  assert.equal(first.accepted, true); assert.equal(retry.accepted, true);
  assert.equal(f.room().deadline, oldDeadline + 6000);
  assert.equal(first.room.hand.deliveryGrace.seconds, 6);
  assert.equal(f.app.store.read().rooms[f.code].deadline, oldDeadline + 6000);
  f.at(oldDeadline + 1000);
  const action = await f.api(`/api/rooms/${f.code}/action`, f.actor, { type: 'call', handId: hand.id, actionSeq: hand.log.length, commandId: randomUUID() });
  assert.notEqual(action.room.hand.actingId, f.actor.user.id, 'actual betting remains accepted past the original cutoff');
  const nextDeadline = f.room().deadline;
  const stale = await f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, receipt);
  assert.equal(stale.accepted, false); assert.equal(f.room().deadline, nextDeadline);
});

test('outsiders, other players and expired turns cannot get added time', async t => {
  const f = await fixture(t), hand = f.room().hand, before = f.room().deadline;
  const receipt = { handId: hand.id, actionSeq: hand.log.length }, other = f.users.find(user => user !== f.actor && user !== f.users[2]);
  f.at(f.room().presentation.actionReadyAt + 5000);
  assert.equal((await f.api(`/api/rooms/${f.code}/turn-seen`, other, receipt)).accepted, false);
  await f.api(`/api/rooms/${f.code}/turn-seen`, f.users[2], receipt, 403);
  f.at(before); assert.equal((await f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, receipt)).accepted, false);
  assert.equal(f.room().deadline, before);
  f.app.service.tick(f.room(), before); assert.notEqual(f.room().hand.actingId, f.actor.user.id, 'old clients still time out normally without receipts');
});

test('failed persistence cannot promise or leak uncommitted grace', async t => {
  const f = await fixture(t), h = f.room().hand, before = structuredClone(f.app.store.data);
  const save = f.app.store.save; f.at(f.room().presentation.actionReadyAt + 6000);
  f.app.store.save = () => { throw new Error('synthetic write failure'); };
  await f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, { handId: h.id, actionSeq: h.log.length }, 400);
  f.app.store.save = save;
  assert.deepEqual(f.app.store.data, before); assert.deepEqual(f.app.store.read(), before);
});

test('timely confirmation is tiny and duplicate confirmations do not write or change the table revision', async t => {
  const f = await fixture(t), h = f.room().hand, revision = f.room().revision, deadline = f.room().deadline;
  let writes = 0; const save = f.app.store.save.bind(f.app.store);
  f.app.store.save = () => { writes++; return save(); };
  f.at(f.room().presentation.actionReadyAt + 500);
  const receipt = { handId: h.id, actionSeq: h.log.length };
  const first = await f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, receipt);
  const duplicate = await f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, receipt);
  assert.deepEqual(first, { accepted: true }); assert.deepEqual(duplicate, first);
  assert.equal(writes, 0); assert.equal(f.room().revision, revision); assert.equal(f.room().deadline, deadline);
  assert.ok(f.room().presentation.deliveryReceipt);
  assert.equal(f.app.store.read().rooms[f.code].presentation.deliveryReceipt, undefined,
    'timely receipts do not add synchronous whole-database writes on the betting path');
});

test('restart cannot recover a fresh grace allowance from a not-yet-saved timely receipt', async t => {
  const f = await fixture(t), h = f.room().hand, deadline = f.room().deadline, ready = f.room().presentation.actionReadyAt;
  const receipt = { handId: h.id, actionSeq: h.log.length };
  f.at(ready + 500); await f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, receipt);
  f.at(ready + 10000); await f.restart();
  const response = await f.api(`/api/rooms/${f.code}/turn-seen`, f.actor, receipt);
  assert.equal(response.accepted, true); assert.equal(f.room().deadline, deadline);
  assert.equal(f.room().deliveryBudgets?.[f.actor.user.id], undefined);
});
