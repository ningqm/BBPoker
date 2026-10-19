import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createActionPerformance } from '../public/action-performance.js';
import { createRequestGuard } from '../public/platform.js';
import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import { sameRoomSnapshot } from '../public/room-snapshot.js';
import { syncBetControls } from '../public/table-controls.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing application section ${start}`);
  return source.slice(a, b);
}
const clientCode = [section('async function api(', 'function captureRoomChanges('),
  section('function normalizeState(', 'function updateConnection('), section('function render(){', 'function usernameField('),
  section('function performanceModal(){', 'function departureModal(')].join('\n');
const secret = { token: 'synthetic-private-token', user: 'synthetic-private-user', room: 'synthetic-private-room',
  hand: 'synthetic-private-hand', cards: ['As', 'Ah'], name: 'synthetic-private-name' };
function snapshot(revision = 1, acceptedCommandIds = []) {
  return { code: secret.room, meId: secret.user, revision, serverTime: 1800000000000 + revision,
    acceptedCommandIds, settings: { bigBlind: 10 },
    hand: { id: secret.hand, status: 'playing', actionSeq: revision, actingId: secret.user, currentBet: 10, board: ['9d', '2c', '7h'] },
    players: [{ id: secret.user, name: secret.name, cards: secret.cards, stack: 1980, streetBet: 10 }],
    actions: { canAct: true, canCheck: true, canRaise: true, minRaiseTo: 20, maxRaiseTo: 1990 } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function harness() {
  let time = 1000, id = 0, timerId = 0, frameId = 0;
  const calls = [], paints = [], toasts = [], files = [], timers = new Map(), frames = new Map(), reads = [], listeners = new Map();
  const document = { visibilityState: 'visible', activeElement: null, body: { classList: { toggle() {} } },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const actionPerformance = createActionPerformance({ now: () => time, document, PerformanceObserver: null,
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: key => frames.delete(key) });
  const state = { token: secret.token, user: { id: secret.user, name: secret.name }, room: snapshot(), page: 'room', busy: false, modal: null,
    clock: createRoomClock({ monotonicNow: () => time }), actionPerformance, connected: true, feedbackResync: false,
    lastActionInputAt: 997, raise: 20, raisePreset: null, raisePanelOpen: false, raiseTurnKey: null,
    statsView: {}, library: {}, sessions: {}, opponents: {}, animations: false };
  const requests = createRequestGuard();
  const app = { querySelector: () => null, contains: () => false, innerHTML: '' };
  const context = vm.createContext({ state, requests, document, app, performance: { now: () => time },
    API_TIMEOUT_MS: 12000, pendingTableRequests: new Set(), AbortController, TextDecoder,
    apiUrl: path => 'https://synthetic-private-host.invalid' + path,
    fetch(url, options) {
      const pending = deferred(); calls.push({ url, options, ...pending });
      options.signal?.addEventListener('abort', () => pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      return pending.promise;
    },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: key => timers.delete(key),
    setInterval(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearInterval: key => timers.delete(key),
    commandId: () => `synthetic-private-command-${++id}`, navigator: { onLine: true },
    isOlderRoomSnapshot, sameRoomSnapshot, syncBetControls,
    captureRoomChanges() { time += 2; state.feedbackResync = false; }, rememberCommitment: () => false,
    closeModal() { state.modal = null; }, toast: (...args) => toasts.push(args), expireIdentity: async () => { requests.invalidate(); },
    tableSounds: { stopPlayback() {} }, turnCountdown: { reset() {} }, updateConnection() {},
    flushTableFeedback() {}, statsUI: { captureStatsDraft() {}, restoreStatsDraft() {} },
    records: { captureRecordDraft() {}, restoreRecordDraft() {} }, recordFormSelector: kind => kind,
    header: () => '', welcome() {}, recoveryPage() {}, errorPage() {}, lobby() {}, roomView: () => '<div>synthetic</div>',
    career() {}, handLibrary() {}, sessionLibrary() {}, opponentLibrary() {},
    patchRoomView() { paints.push(state.room.revision); time += 6; return true; },
    avatarCache: { hydrate() { time += 1; } }, layoutTableBubbles() { time += 3; }, mountPotAwards() {}, mountFunEffects() {},
    tick() { time += 1; }, $: () => null,
    openModal(title, body, kind) { state.modal = { title, body, kind }; }, btn: label => label,
    saveExport: async file => files.push(file),
  });
  vm.runInContext(clientCode, context, { filename: 'public/app.js (action performance integration)' });
  const respond = (call, data, { status = 200, timing = 'app;dur=12, clone;dur=1, command;dur=3, persist;dur=5, broadcast;dur=2, state;dur=1, serialize;dur=0.5', parseMs = 4 } = {}) => {
    call.resolve({ ok: status < 400, status, headers: { get: name => name === 'Server-Timing' ? timing : null },
      async json() { time += parseMs; return data; } });
  };
  return { context, state, requests, calls, paints, toasts, files, actionPerformance, timers, frames,
    command: context.command, apply: context.normalizeState, export: context.exportPerformance, menu: context.performanceModal,
    tick: ms => { time += ms; }, respond,
    async startSSE() {
      const job = context.connectStream(secret.room), call = calls.at(-1);
      call.resolve({ ok: true, status: 200, body: { getReader: () => ({ read() { const read = deferred(); reads.push(read); return read.promise; } }) } });
      await flush();
      return { async push(room) { assert.ok(reads.length); reads.shift().resolve({ done: false, value: new TextEncoder().encode('data: ' + JSON.stringify(room) + '\n\n') }); await flush(); },
        async close() { context.stopStream(); for (const read of reads.splice(0)) read.resolve({ done: true }); await job; } };
    },
    frame() { for (const [key, fn] of [...frames]) { frames.delete(key); fn(); } },
    hide() { document.visibilityState = 'hidden'; listeners.get('visibilitychange')?.(); },
    show() { document.visibilityState = 'visible'; listeners.get('visibilitychange')?.(); },
  };
}

test('actual command -> api -> normalize -> render records phases without sending diagnostic trace', async () => {
  const h = harness(), job = h.command('raise', { amount: 40 }), call = h.calls[0];
  assert.equal(h.paints.length, 0, 'button press must not rebuild table');
  assert.equal(Object.hasOwn(call.options, 'performanceTrace'), false);
  assert.equal(Object.hasOwn(call.options, 'anonymous'), false);
  assert.deepEqual(JSON.parse(call.options.body), { type: 'raise', amount: 40, commandId: 'synthetic-private-command-1', handId: secret.hand, actionSeq: 1 });
  assert.equal(call.options.headers.Authorization, 'Bearer ' + secret.token);
  h.tick(40); h.respond(call, { room: snapshot(2, ['synthetic-private-command-1']) }); assert.equal(await job, true);
  h.tick(16); h.frame();
  const row = h.actionPerformance.exportData().actions[0];
  assert.equal(row.outcome, 'ok'); assert.equal(row.source, 'http'); assert.equal(row.stages.headers, 40); assert.equal(row.stages.parsed, 44);
  assert.equal(row.stages.confirmed, 44); assert.equal(row.metrics.renderMs, 11); assert.equal(row.metrics.layoutMs, 3);
  assert.equal(row.metrics.parseMs, 4);
  assert.equal(row.metrics.normalizeMs, 13); assert.equal(row.metrics.inputDelayMs, 3); assert.equal(row.frameWaitMs, 16);
  assert.deepEqual(row.serverMetrics, { app: 12, clone: 1, command: 3, persist: 5, broadcast: 2, state: 1, serialize: .5 });
  assert.equal(h.paints.length, 1); assert.equal(h.timers.size, 0);
});

test('actual SSE reader confirms first; duplicate HTTP does not render again or erase processing evidence', async () => {
  const h = harness(), stream = await h.startSSE();
  const job = h.command('check'), call = h.calls.at(-1), room = snapshot(2, ['synthetic-private-command-1']);
  h.tick(20); await stream.push(room);
  assert.equal(h.state.busy, false); assert.equal(h.paints.length, 1);
  const first = h.actionPerformance.exportData().actions[0];
  assert.equal(first.source, 'sse'); assert.equal(first.stages.confirmed, 20); assert.equal(first.metrics.normalizeMs, 13);
  h.tick(16); h.frame(); h.tick(100); h.respond(call, { room: structuredClone(room) }); assert.equal(await job, true);
  const row = h.actionPerformance.exportData().actions[0];
  assert.equal(row.source, 'sse'); assert.equal(row.stages.confirmed, 20); assert.equal(row.metrics.normalizeMs, 13);
  assert.equal(row.metrics.renderMs, 11); assert.equal(row.metrics.layoutMs, 3); assert.equal(row.serverMetrics.app, 12);
  assert.equal(h.paints.length, 1); await stream.close(); assert.equal(h.timers.size, 0);
});

test('late first HTTP cannot overwrite second action performance or release its controls', async () => {
  const h = harness(), stream = await h.startSSE(), first = h.command('check'), firstCall = h.calls.at(-1);
  h.tick(20); await stream.push(snapshot(2, ['synthetic-private-command-1']));
  const second = h.command('raise', { amount: 80 }), secondCall = h.calls.at(-1);
  h.tick(50); h.respond(firstCall, { room: snapshot(2, ['synthetic-private-command-1']) }, { timing: 'app;dur=7' }); assert.equal(await first, true);
  assert.equal(h.state.busy, true); assert.equal(h.state.pendingCommand.id, 'synthetic-private-command-2');
  assert.equal(h.actionPerformance.exportData().actions[1].stages.confirmed, undefined);
  h.tick(10); await stream.push(snapshot(3, ['synthetic-private-command-1', 'synthetic-private-command-2']));
  h.respond(secondCall, { room: snapshot(3, ['synthetic-private-command-1', 'synthetic-private-command-2']) }, { timing: 'app;dur=9' }); assert.equal(await second, true);
  const rows = h.actionPerformance.exportData().actions;
  assert.equal(rows[0].serverMetrics.app, 7); assert.equal(rows[1].serverMetrics.app, 9);
  assert.equal(rows[0].stages.confirmed, 20); assert.ok(rows[1].stages.confirmed > 50);
  assert.deepEqual(h.paints, [2, 3]); await stream.close();
});

test('confirmed SSE plus lost HTTP remains successful without a duplicate wager or error notice', async () => {
  const h = harness(), stream = await h.startSSE(), job = h.command('call'), call = h.calls.at(-1);
  h.tick(25); await stream.push(snapshot(2, ['synthetic-private-command-1'])); call.reject(new Error('synthetic network failure'));
  assert.equal(await job, true); assert.equal(h.actionPerformance.exportData().actions[0].outcome, 'ok');
  assert.equal(h.calls.filter(call => call.url.endsWith('/action')).length, 1); assert.equal(h.toasts.length, 0);
  await stream.close();
});

test('HTTP errors are failed samples, without invented confirmation or leaked server error text', async () => {
  const h = harness(), job = h.command('raise', { amount: 40 }); h.tick(30);
  h.respond(h.calls[0], { error: 'synthetic-secret-error-detail' }, { status: 422, timing: 'app;dur=8' });
  assert.equal(await job, false);
  const report = h.actionPerformance.exportData(), row = report.actions[0];
  assert.equal(row.outcome, 'error'); assert.equal(row.stages.confirmed, undefined); assert.equal(report.summary.confirmation.samples, 0);
  assert.ok(!JSON.stringify(report).includes('synthetic-secret-error-detail')); assert.equal(h.timers.size, 0);
});

test('expired identity produces cancelled sample and cannot mutate replacement user or paint old room', async () => {
  const h = harness(), job = h.command('fold'); h.requests.invalidate();
  h.state.user = { id: 'synthetic-replacement-user' }; h.state.pendingCommand = null; h.state.busy = false;
  h.tick(50); h.respond(h.calls[0], { room: snapshot(99, ['synthetic-private-command-1']) });
  assert.equal(await job, false); assert.equal(h.state.room.revision, 1); assert.equal(h.paints.length, 0);
  assert.equal(h.actionPerformance.exportData().actions[0].outcome, 'cancelled');
  assert.equal(h.actionPerformance.summary().confirmation.samples, 0);
});

test('background round trip excludes interrupted operation from confirmation statistics', async () => {
  const h = harness(), job = h.command('check'); h.hide(); h.tick(30000); h.show();
  h.respond(h.calls[0], { room: snapshot(2, ['synthetic-private-command-1']) }); await job;
  const report = h.actionPerformance.exportData(); assert.equal(report.actions[0].outcome, 'interrupted');
  assert.equal(report.summary.interruptedCount, 1); assert.equal(report.summary.confirmation.samples, 0);
});

test('diagnostic export uses only recorder output and never sends a request or serializes table state', async () => {
  const h = harness(), job = h.command('raise', { amount: 40 });
  h.respond(h.calls[0], { room: snapshot(2, ['synthetic-private-command-1']) }); await job;
  h.menu(); assert.equal(h.state.modal.kind, 'performance'); assert.match(h.state.modal.body, /不会自动上传/);
  const requestCount = h.calls.length; await h.export(); assert.equal(h.calls.length, requestCount);
  assert.equal(h.files.length, 1); assert.equal(h.files[0].mime, 'application/json');
  assert.deepEqual(JSON.parse(h.files[0].content), h.actionPerformance.exportData());
  for (const value of [...Object.values(secret).flat(), 'synthetic-private-command-1', 'amount', 'Authorization', 'acceptedCommandIds', '9d', '2c', '7h']) {
    assert.ok(!h.files[0].content.includes(value), `private value leaked: ${value}`);
  }
});

test('non-playing commands and unrelated reads do not become action diagnostic records', async () => {
  const h = harness(), job = h.command('sit', { seat: 2, amount: 2000 });
  h.respond(h.calls[0], { room: snapshot(2) }); await job;
  assert.equal(h.actionPerformance.summary().count, 0);
  const read = h.context.api('/api/me'); h.respond(h.calls[1], { user: { id: secret.user } }); await read;
  assert.equal(h.actionPerformance.summary().count, 0);
});

test('IME-deferred real render does not pretend the table was rendered or a frame scheduled', async () => {
  const h = harness(), editor = { id: 'synthetic-profile-name', isConnected: true };
  h.context.document.activeElement = editor; h.state.compositionTarget = editor; h.state.composing = true;
  const job = h.command('check'); h.tick(30);
  h.respond(h.calls[0], { room: snapshot(2, ['synthetic-private-command-1']) }); assert.equal(await job, true);
  const report = h.actionPerformance.exportData(), row = report.actions[0];
  assert.equal(h.state.renderDeferred, true); assert.equal(h.paints.length, 0); assert.equal(h.frames.size, 0);
  assert.equal(row.outcome, 'ok'); assert.equal(row.stages.confirmed, 34); assert.equal(row.metrics.normalizeMs, 2);
  assert.equal(row.metrics.renderMs, undefined); assert.equal(row.metrics.layoutMs, undefined);
  assert.equal(row.stages.rendered, undefined); assert.equal(row.stages.frame, undefined); assert.equal(row.frameWaitMs, undefined);
  assert.equal(row.metrics.parseMs, 4); assert.match(report.limits.parsing, /response-body reading and JSON decoding/);
  assert.match(report.limits.parsing, /not JSON parsing CPU time alone/);
});
