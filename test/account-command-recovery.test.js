import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequestGuard } from '../public/platform.js';
import * as money from '../public/money.js';
import * as tableScene from '../public/table-scene.js';
import * as tableControls from '../public/table-controls.js';
import * as statsUI from '../public/stats.js';
import * as records from '../public/records.js';
import { updateHandCategoryMotion } from '../public/hand-category.js';
import { createTableFunTracker } from '../public/table-fun.js';
import { createTableFeedback, createTurnCountdown } from '../public/table-feedback.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first); return source.slice(first, last);
}
function oneLine(name) {
  const value = source.split('\n').find(line => line.startsWith(`async function ${name}(`));
  assert.ok(value); return value;
}
const code = [
  'const requests=createRequestGuard();', section('const state=', 'const esc='),
  section('async function api(', 'async function connectStream('),
  section('async function loadMe(', 'function navigate('),
  section('function resetPrivateView(', 'function resumeTable('),
  section('function resumeTable(', "window.addEventListener('hashchange'"),
  oneLine('acceptAccount'), oneLine('submitAccount'),
  'globalThis.client={state,command,submitAccount,resumeTable};',
].join('\n');
function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const room = revision => ({ code: '123456', revision, meId: 'old-user', hand: { id: 'original-hand', actionSeq: revision },
  actions: {}, players: [{ id: 'old-user', name: 'Synthetic player', cards: ['As','Ah'] }] });

// Execute the real account, command, request-guard, identity-reset and route
// functions. Only browser presentation, persistence and fetch are substitutes.
function harness() {
  const pending = [], streams = [], identities = [], notices = [];
  let client, id = 0;
  const context = vm.createContext({createRoomClock,isOlderRoomSnapshot, ...money, ...tableScene, ...tableControls, statsUI, records, updateHandCategoryMotion,
    createRequestGuard, feedback: createTableFeedback(), turnCountdown: createTurnCountdown(), funTracker: createTableFunTracker(),
    tableSounds: { play() {}, playFeedback() {}, suspend() {}, stopPlayback() {} }, avatarCache: { clear() {} },
    AbortController, apiUrl: path => path,
    fetch(url, options) {
      const request = { url, options, ...deferred() }; pending.push(request);
      const abort = () => request.reject(new Error('request aborted'));
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
      return request.promise;
    },
    navigator: { onLine: true }, document: { visibilityState: 'visible' }, location: { hash: '#/room/123456' },
    render() {}, closeModal() { client.state.modal = null; }, toast(...args) { notices.push(args); },
    connectStream(code) { client.state.connected = false; client.state.feedbackResync = true; streams.push(code); },
    finishComposition() {}, rememberCommitment: () => false, commandId: () => `request-${++id}`,
    writeIdentity: async token => { identities.push(token); }, clearIdentity: async () => {},
    setTimeout: () => ++id, clearTimeout() {},
  });
  vm.runInContext(code, context, { filename: 'public/app.js (account-command recovery)' }); client = context.client;
  Object.assign(client.state, { token: 'old-session', user: { id: 'old-user', name: 'Synthetic player', username: 'synthetic_user' },
    room: room(1), page: 'room', connected: true, feedbackResync: false });
  const form = { get: key => ({ username: 'synthetic_user', password: 'synthetic-password', currentPassword: 'wrong-password', newPassword: 'new-synthetic-password' })[key] };
  return { ...client, pending, streams, identities, notices, form };
}

for (const kind of ['password', 'bind']) test(`failed account ${kind} releases an interrupted betting request and only resynchronizes`, async () => {
  const h = harness(), original = h.command('raise', { amount: 40 });
  assert.equal(h.state.busy, true); const action = h.pending[0];
  const change = h.submitAccount(kind, h.form);
  assert.equal(action.options.signal.aborted, true);
  assert.equal(h.state.busy, false, 'the account request owns and releases the invalidated command lock');
  const failed = assert.rejects(change, error => error.status === 400 && error.message === 'Synthetic account failure');
  h.pending.find(request => request.url === `/api/account/${kind}`).resolve(response({ error: 'Synthetic account failure' }, 400));
  await failed; assert.equal(await original, false);
  assert.equal(h.state.busy, false); assert.equal(h.state.token, 'old-session');
  assert.deepEqual(h.streams, ['123456']);
  assert.equal(h.pending.filter(request => request.url.endsWith('/action')).length, 1, 'failed account changes never retry the old raise');
  assert.equal(h.state.connected, false, 'betting remains connection-gated until an authoritative snapshot arrives');
  const next = h.command('check'); assert.equal(h.state.busy, true);
  h.pending.at(-1).resolve(response({ room: room(2) })); assert.equal(await next, true); assert.equal(h.state.busy, false);
});

test('late old response cannot release a newer command after the account failure hands control back', async () => {
  const h = harness(), original = h.command('raise', { amount: 40 });
  const json = deferred(), started = deferred();
  h.pending[0].resolve({ ok: true, status: 200, json() { started.resolve(); return json.promise; } });
  await started.promise;
  const change = h.submitAccount('password', h.form), failed = assert.rejects(change, error => error.status === 400);
  h.pending[1].resolve(response({ error: 'Synthetic account failure' }, 400)); await failed;
  assert.equal(h.state.busy, false);
  const next = h.command('check'); assert.equal(h.state.busy, true);
  json.resolve({ room: room(99) }); assert.equal(await original, false);
  assert.equal(h.state.busy, true, 'the old invalidated request does not own the new command lock');
  assert.equal(h.state.room.revision, 1);
  h.pending[2].resolve(response({ room: room(2) })); assert.equal(await next, true);
  assert.equal(h.state.room.revision, 2); assert.equal(h.state.busy, false);
  assert.equal(h.pending.filter(request => request.url.endsWith('/action')).length, 2, 'only the two explicit player commands were sent');
});

test('successful credential rotation clears the old command and private room before showing the new recovery code', async () => {
  const h = harness(), original = h.command('call'), action = h.pending[0];
  const change = h.submitAccount('password', h.form);
  h.pending[1].resolve(response({ token: 'new-session', user: { id: 'old-user', name: 'Synthetic player', username: 'synthetic_user' }, recoveryCode: 'synthetic-recovery-code' }));
  await change; assert.equal(await original, false);
  assert.equal(action.options.signal.aborted, true); assert.equal(h.state.busy, false);
  assert.equal(h.state.token, 'new-session'); assert.deepEqual(h.identities, ['new-session']);
  assert.equal(h.state.room, null); assert.equal(h.state.stats, null); assert.equal(h.state.page, 'recovery');
  assert.equal(h.state.pendingRecovery.code, 'synthetic-recovery-code');
  assert.equal(h.pending.filter(request => request.url.endsWith('/action')).length, 1);
  assert.deepEqual(h.streams, [], 'successful credential rotation must not reopen a stream with the revoked session');
});
