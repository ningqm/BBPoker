import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestTiming } from '../src/request-timing.js';
import { createApp } from '../server.js';
import { seedLegacyAccount } from './helpers/accounts.js';

const names = ['app', 'clone', 'command', 'persist', 'broadcast', 'state', 'serialize'];
function readTiming(response) {
  const header = response.headers.get('server-timing');
  assert.ok(header, 'action responses expose numeric request-local timings');
  const result = {};
  for (const part of header.split(', ')) {
    const match = /^([a-z]+);dur=(\d+\.\d{2})$/.exec(part);
    assert.ok(match, `unexpected timing field: ${part}`);
    assert.ok(names.includes(match[1]));
    result[match[1]] = Number(match[2]);
  }
  return result;
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-request-timing-'));
  const app = createApp({ dataDir: directory, actionTickMs: 100000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const actor = seedLegacyAccount(app, { name: 'private-name-not-in-timing' });
  const room = app.service.create(app.store.data.users[Object.keys(app.store.data.users)[0]], {});
  app.store.save();
  async function request(path, body, authenticated = true) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${actor.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, value: await response.json() };
  }
  return { app, actor, room, request, action: body => request(`/api/rooms/${room.code}/action`, { commandId: randomUUID(), ...body }) };
}

test('request timing uses injected monotonic clock and includes thrown phase time', () => {
  let time = 10;
  const timing = createRequestTiming({ now: () => time });
  assert.equal(timing.measure('clone', () => { time = 15; return 23; }), 23);
  const error = new Error('not a timing label');
  assert.throws(() => timing.measure('command', () => { time = 19; throw error; }), value => value === error);
  timing.measure('clone', () => { time = 21; });
  assert.equal(timing.header(), 'app;dur=11.00, clone;dur=7.00, command;dur=4.00');
  assert.throws(() => timing.measure('player-secret', () => assert.fail('must not execute')), /Unknown/);
  assert.equal(timing.header().includes('player-secret'), false);
});

test('action timings include persistence and projection without changing the response or exposing private values', async t => {
  const f = await fixture(t);
  const { response, value } = await f.action({ type: 'sit', seat: 0, amountBB: 100 });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(value), ['room']);
  assert.equal(value.room.players[0].stack, 1000);
  assert.equal(f.app.store.read().rooms[f.room.code].members[f.actor.user.id].stack, 1000);
  const metrics = readTiming(response);
  assert.deepEqual(Object.keys(metrics), names);
  for (const [name, value] of Object.entries(metrics)) if (name !== 'app') assert.ok(value <= metrics.app + 0.01);
  const header = response.headers.get('server-timing');
  for (const privateValue of [f.actor.token, f.actor.user.id, f.actor.user.name, f.room.code, f.room.invite]) assert.equal(header.includes(privateValue), false);
  const ordinary = await f.request(`/api/rooms/${f.room.code}`);
  assert.equal(ordinary.response.headers.get('server-timing'), null);
  const sync = await f.request(`/api/rooms/${f.room.code}/sync`);
  assert.equal(sync.response.headers.get('server-timing'), null);
});

test('invalid action preserves original error and rollback while exposing only stages executed', async t => {
  const f = await fixture(t), before = structuredClone(f.app.store.data);
  const { response, value } = await f.action({ type: 'raise', amount: 300 });
  assert.equal(response.status, 400);
  assert.deepEqual(Object.keys(value), ['error']);
  assert.deepEqual(f.app.store.data, before);
  assert.deepEqual(f.app.store.read(), before);
  assert.deepEqual(Object.keys(readTiming(response)), ['app', 'clone', 'command', 'serialize']);
});

test('failed durable write rolls back memory and never broadcasts the uncommitted action', async t => {
  const f = await fixture(t), before = structuredClone(f.app.store.data), save = f.app.store.save;
  f.app.store.save = () => { throw new Error('synthetic-disk-failure'); };
  t.after(() => { f.app.store.save = save; });
  const { response, value } = await f.action({ type: 'sit', seat: 0, amountBB: 100 });
  assert.equal(response.status, 400);
  assert.equal(value.error, 'synthetic-disk-failure');
  assert.deepEqual(f.app.store.data, before);
  assert.deepEqual(f.app.service.db, before);
  assert.deepEqual(f.app.store.read(), before);
  assert.deepEqual(Object.keys(readTiming(response)), ['app', 'clone', 'command', 'persist', 'serialize']);
});

test('unauthenticated action timing does not reveal game or authentication data', async t => {
  const f = await fixture(t);
  const { response, value } = await f.request(`/api/rooms/${f.room.code}/action`, { type: 'sit' }, false);
  assert.equal(response.status, 401);
  assert.equal(typeof value.error, 'string');
  assert.deepEqual(Object.keys(readTiming(response)), ['app', 'serialize']);
  const nonAction = await f.request('/api/rooms', {}, false);
  assert.equal(nonAction.response.headers.get('server-timing'), null);
});
