import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { seedAssignedAccount } from './helpers/accounts.js';

const pageId = 'a'.repeat(32), streamId = 'b'.repeat(32), userAgent = 'Mozilla Chrome/144 Quark/10.19';
const query = `pageId=${pageId}&streamId=${streamId}`;
const report = (seq = 1, room) => ({ v: 1, pageId, events: [{ seq, at: Date.now(), type: 'watchdog', reason: 'watchdog_timeout', streamId, room, lastByteAgeMs: 9000, visible: true }] });
async function waitFor(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(predicate(), 'expected diagnostic evidence'); }
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-connection-diag-')), logs = [];
  const app = createApp({ dataDir: directory, actionTickMs: 1000000, diagnosticsSink: line => logs.push(JSON.parse(line)) });
  const identity = await seedAssignedAccount(app, { username: 'testplayer' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  async function close() { if (!closed) { closed = true; await app.close(); } }
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, body, options = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${identity.token}`, 'User-Agent': userAgent, 'Content-Type': 'application/json', ...options.headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: options.signal });
  const response = await request('/api/rooms', { name: 'diagnostics test' }); assert.equal(response.status, 201);
  const code = (await response.json()).room.code;
  const stream = async (extra = '') => {
    const controller = new AbortController(), response = await request(`/api/events?room=${code}&${query}${extra}`, undefined, { signal: controller.signal });
    assert.equal(response.status, 200); const reader = response.body.getReader(); await reader.read();
    return { reader, controller, async cancel() { controller.abort(); await reader.cancel().catch(() => {}); } };
  };
  return { app, logs, request, code, identity, stream, close, directory };
}

test('authenticated diagnostic upload is bounded, origin checked, secret stripped and never persists or changes presence', async t => {
  const f = await fixture(t), before = structuredClone(f.app.store.data), bytes = readFileSync(f.app.store.file);
  const denied = await f.request('/api/diagnostics/connection', report(1, f.code), { headers: { Authorization: '' } }); assert.equal(denied.status, 401);
  const foreign = await f.request('/api/diagnostics/connection', report(1, f.code), { headers: { Origin: 'https://evil.example' } }); assert.equal(foreign.status, 403);
  const oversized = await f.request('/api/diagnostics/connection', { ...report(1), secret: 'x'.repeat(17000) }); assert.equal(oversized.status, 413);
  const tooMany = await f.request('/api/diagnostics/connection', { v: 1, pageId, events: Array.from({ length: 21 }, (_, i) => report(i + 1).events[0]) }); assert.equal(tooMany.status, 400);
  const value = report(1, f.code); Object.assign(value.events[0], { token: f.identity.token, username: 'another', userId: 'another', cards: ['As', 'Ah'], error: 'private text', source: 'server' });
  const response = await f.request('/api/diagnostics/connection', value); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, accepted: 1, duplicates: 0 });
  assert.equal((await f.request('/api/diagnostics/connection', value)).status, 200);
  await waitFor(() => f.logs.some(row => row.source === 'client_report'));
  const rows = f.logs.filter(row => row.source === 'client_report'); assert.equal(rows.length, 1);
  assert.equal(rows[0].username, 'testplayer'); assert.equal(rows[0].userId, f.identity.user.id); assert.equal(rows[0].room, f.code); assert.equal(rows[0].browser, 'Quark');
  assert.doesNotMatch(JSON.stringify(f.logs), new RegExp(`${f.identity.token}|private text|another|cards`));
  assert.deepEqual(f.app.store.data, before); assert.deepEqual(readFileSync(f.app.store.file), bytes); assert.equal(f.app.service.connections.size, 0);
});

test('telemetry flood cannot consume game action quota or publish an unrelated room label', async t => {
  const f = await fixture(t);
  for (let seq = 1; seq <= 30; seq++) assert.equal((await f.request('/api/diagnostics/connection', report(seq, '000000'))).status, 200);
  assert.equal((await f.request('/api/diagnostics/connection', report(31, f.code))).status, 429);
  const response = await f.request(`/api/rooms/${f.code}/action`, { type: 'sit', seat: 0, amountBB: 100, commandId: 'diagnostic-rate-check' });
  assert.equal(response.status, 200); assert.equal(f.app.store.data.rooms[f.code].members[f.identity.user.id].stack, 1000);
  await waitFor(() => f.logs.filter(row => row.source === 'client_report').length === 30);
  assert.ok(f.logs.filter(row => row.source === 'client_report').every(row => row.room === undefined));
});

test('real SSE lifetime, normal-sync aggregation and reconnect correlation use authenticated identity', async t => {
  const f = await fixture(t), stream = await f.stream('&reason=visible');
  await new Promise(resolve => setTimeout(resolve, 30));
  const revision = f.app.store.data.rooms[f.code].revision;
  const sync = await f.request(`/api/rooms/${f.code}/sync?${query}&revision=${revision}&canAct=0`); assert.equal(sync.status, 200); assert.equal((await sync.json()).unchanged, true);
  await stream.cancel(); await waitFor(() => f.logs.some(row => row.type === 'stream_close'));
  const opened = f.logs.find(row => row.type === 'stream_open'), closed = f.logs.find(row => row.type === 'stream_close');
  for (const row of [opened, closed]) { assert.equal(row.userId, f.identity.user.id); assert.equal(row.pageId, pageId); assert.equal(row.streamId, streamId); assert.equal(row.room, f.code); }
  assert.equal(opened.reason, 'visible'); assert.equal(closed.reason, 'network_close'); assert.ok(closed.durationMs >= 30);
  assert.ok(closed.bytesWritten > 0); assert.ok(closed.snapshots >= 1); assert.ok(closed.lastSnapshotAgeMs >= 30); assert.equal(closed.activeStreams, 0);
  assert.equal(closed.syncRequests, 1); assert.equal(closed.syncUnchanged, 1);
  assert.equal(f.logs.filter(row => row.route === 'sync').length, 0, 'normal sync requests must not produce a per-poll log');
});

test('session expiry and server shutdown are distinct from unexplained peer close', async t => {
  const f = await fixture(t), stream = await f.stream();
  assert.equal((await f.request('/api/account/logout', {})).status, 200);
  while (!(await stream.reader.read()).done) { /* drain final session-expired event */ }
  await waitFor(() => f.logs.some(row => row.type === 'stream_close' && row.reason === 'session_expired'));
  const other = await seedAssignedAccount(f.app, { username: 'another' });
  f.app.service.join(other.user, f.code, f.app.store.data.rooms[f.code].invite);
  const controller = new AbortController();
  const response = await f.request(`/api/events?room=${f.code}&${query}`, undefined, { headers: { Authorization: `Bearer ${other.token}` }, signal: controller.signal });
  const reader = response.body.getReader(); await reader.read(); await f.close(); controller.abort(); await reader.cancel().catch(() => {});
  assert.ok(f.logs.some(row => row.type === 'stream_close' && row.reason === 'server_shutdown' && row.userId === other.user.id));
});

test('SSE per-room cap reports exact 429 reason and user without exposing authorization', async t => {
  const f = await fixture(t), streams = [];
  for (let i = 0; i < 5; i++) streams.push(await f.stream());
  const response = await f.request(`/api/events?room=${f.code}&${query}`); assert.equal(response.status, 429); await response.json();
  await waitFor(() => f.logs.some(row => row.type === 'request_rejected'));
  const row = f.logs.find(row => row.type === 'request_rejected'); assert.equal(row.reason, 'room_stream_limit'); assert.equal(row.status, 429); assert.equal(row.username, 'testplayer');
  await Promise.all(streams.map(stream => stream.cancel()));
});

test('sync rate rejection has its own scope and does not prevent the next legal action', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 90; n++) { const response = await f.request(`/api/rooms/${f.code}/sync?${query}`); assert.equal(response.status, 200); await response.json(); }
  const denied = await f.request(`/api/rooms/${f.code}/sync?${query}`); assert.equal(denied.status, 429); await denied.json();
  await waitFor(() => f.logs.some(row => row.route === 'sync'));
  const row = f.logs.find(row => row.route === 'sync'); assert.equal(row.reason, 'rate_limited'); assert.equal(row.rateScope, 'table-sync'); assert.equal(row.userId, f.identity.user.id);
  assert.equal((await f.request(`/api/rooms/${f.code}/action`, { type: 'sit', seat: 0, amountBB: 100, commandId: 'sync-rate-action' })).status, 200);
});

test('server backpressure closes are distinguished from client network close with queue counters', async t => {
  const f = await fixture(t); let response;
  f.app.server.on('request', (req, res) => { if (req.url.startsWith('/api/events?')) response = res; });
  const stream = await f.stream();
  Object.defineProperty(response, 'writableLength', { configurable: true, get: () => 512 * 1024 + 1 });
  f.app.broadcast(f.code);
  await waitFor(() => f.logs.some(row => row.type === 'stream_close'));
  const row = f.logs.find(row => row.type === 'stream_close'); assert.equal(row.reason, 'backpressure'); assert.equal(row.maxBufferedBytes, 512 * 1024 + 1);
  await stream.cancel();
});

test('presence persistence failure reports its own cause and restores room state', async t => {
  const f = await fixture(t), before = structuredClone(f.app.store.data.rooms[f.code]), originalSave = f.app.store.save;
  t.mock.method(console, 'error', () => {});
  f.app.store.save = () => { throw Object.assign(new Error('private storage path must not leak'), { code: 'EIO' }); };
  const controller = new AbortController();
  try {
    const response = await f.request(`/api/events?room=${f.code}&${query}`, undefined, { signal: controller.signal });
    await response.text().catch(() => {});
  } catch { /* A socket destroyed immediately after headers may reject fetch. */ }
  await waitFor(() => f.logs.some(row => row.type === 'stream_close'));
  f.app.store.save = originalSave; controller.abort();
  const row = f.logs.find(row => row.type === 'stream_close'); assert.equal(row.reason, 'persistence_failure'); assert.equal(row.presenceSyncOk, false);
  assert.deepEqual(f.app.store.data.rooms[f.code], before); assert.doesNotMatch(JSON.stringify(f.logs), /private storage/);
});
