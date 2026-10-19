import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionDiagnostics, connectionBrowser, connectionCorrelation, validateConnectionReport } from '../src/connection-diagnostics.js';

const pageId = 'a'.repeat(32), streamId = 'b'.repeat(32);
const event = (seq = 1, extra = {}) => ({ seq, at: 12345, type: 'watchdog', reason: 'watchdog_timeout', room: '123456', streamId, ...extra });
const report = (events = [event()]) => ({ v: 1, pageId, events });

test('connection schema strips secrets, URLs, private state and spoofed authenticated identities', () => {
  const clean = validateConnectionReport(report([event(1, { token: 'private-token', url: 'https://secret.example', cards: ['As','Ah'], userId: 'other', username: 'admin', source: 'server', reason: 'watchdog_timeout',
    lastByteAgeMs: 8005.4, timerLagMs: 0, status: 599, version: '0.25.4-diag1', phase: 'idle', visible: true, connected: false })]));
  assert.deepEqual(clean.events[0], { seq: 1, clientAtMs: 12345, type: 'watchdog', reason: 'watchdog_timeout', room: '123456', streamId,
    version: '0.25.4-diag1', phase: 'idle', lastByteAgeMs: 8005, timerLagMs: 0, status: 599, visible: true, connected: false });
  assert.doesNotMatch(JSON.stringify(clean), /private-token|secret\.example|cards|admin/);
});

test('invalid report counts, IDs, event names and reasons are rejected; optional unsafe values are discarded', () => {
  for (const value of [{ ...report(), v: 2 }, { ...report(), pageId: 'secret?token=foo' }, report([]), report(Array.from({ length: 21 }, (_, n) => event(n + 1))), report([event(0)]), report([event(1, { type: 'arbitrary message' })]), report([event(1, { reason: 'token=private' })]), report([event(1, { at: Infinity })])]) {
    assert.throws(() => validateConnectionReport(value), error => error.status === 400);
  }
  const row = validateConnectionReport(report([event(1, { room: 'not-a-room', streamId: 'secret', durationMs: -3, status: 600, revision: NaN, phase: 'private', online: 'yes', version: 'token-value' })])).events[0];
  assert.deepEqual(row, { seq: 1, clientAtMs: 12345, type: 'watchdog', reason: 'watchdog_timeout' });
});

test('browser normalization and URL correlation never copy raw UA or unexpected strings', () => {
  assert.equal(connectionBrowser('Mozilla Chrome/144 Quark/10.19 private token'), 'Quark');
  assert.equal(connectionBrowser('Mozilla Chrome/144 MicroMessenger/8'), 'WeChat');
  assert.equal(connectionBrowser('Mozilla Safari/604.1'), 'Safari');
  assert.deepEqual(connectionCorrelation(new URLSearchParams({ pageId, streamId, reason: 'visible', token: 'private' })), { pageId, streamId, reason: 'visible' });
  assert.deepEqual(connectionCorrelation(new URLSearchParams({ pageId: 'token=secret', streamId: 'other', reason: 'private' })), {});
});

test('queue never writes synchronously, drops excessive records, and survives a broken sink', () => {
  const scheduled = [], output = [];
  const d = createConnectionDiagnostics({ version: 'test', maxQueue: 2, schedule: fn => scheduled.push(fn), sink: line => output.push(JSON.parse(line)), clock: () => 42 });
  d.emit('server', { type: 'stream_close' }); d.emit('server', { type: 'stream_close' }); d.emit('server', { type: 'stream_close' });
  assert.equal(output.length, 0); assert.equal(scheduled.length, 1);
  scheduled.shift()(); assert.equal(output.length, 2); assert.equal(output[0].droppedBefore, 1); assert.equal(output[0].at, 42);
  const broken = createConnectionDiagnostics({ schedule: fn => scheduled.push(fn), sink: () => { throw Error('sink full'); } });
  broken.emit('server', { type: 'stream_close' }); assert.doesNotThrow(() => scheduled.shift()());
  d.close(); broken.close();
});

test('client report deduplication is page and user scoped; room attribution requires membership', () => {
  const output = [], d = createConnectionDiagnostics({ sink: line => output.push(JSON.parse(line)) });
  const identity = { userId: 'u1', username: 'testplayer', browser: 'Quark' };
  assert.deepEqual(d.reports(validateConnectionReport(report()), identity, () => false), { accepted: 1, duplicates: 0 });
  assert.deepEqual(d.reports(validateConnectionReport(report()), identity, () => true), { accepted: 0, duplicates: 1 });
  d.reports(validateConnectionReport(report()), { ...identity, userId: 'u2' }, () => true); d.flush();
  assert.equal(output.length, 2); assert.equal(output[0].room, undefined); assert.equal(output[1].room, '123456');
  assert.equal(output[0].source, 'client_report'); assert.equal(output[0].username, 'testplayer'); d.close();
});

test('diagnostic rate budget resets without changing another namespace', () => {
  let clock = 0; const d = createConnectionDiagnostics({ clock: () => clock, sink() {} });
  assert.equal(d.allow('upload:user', 1), true); assert.equal(d.allow('upload:user', 1), false);
  assert.equal(d.allow('server:user', 1), true); clock = 60000; assert.equal(d.allow('upload:user', 1), true); d.close();
});
