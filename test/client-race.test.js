import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { apiUrl, createRequestGuard, clearIdentity, readIdentity, writeIdentity } from '../public/platform.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `app.js section is missing: ${start}`);
  return source.slice(first, last);
}

// Execute the application's real request and caller code. Only browser rendering,
// storage and transport are replaced; no copy of its race protection lives here.
const clientSource = [
  'const requests=createRequestGuard();',
  section('const state=', 'const esc='),
  section('async function api(', 'async function connectStream('),
  section('async function loadMe(', 'function navigate('),
  section('function resetPrivateView(', 'function resumeTable('),
  section('function resumeTable(', "window.addEventListener('hashchange'"),
  section('async function boot(', '\nboot();'),
  'globalThis.client={state,api,command,normalizeState,loadMe,route,adoptIdentity,resumeTable,boot};',
].join('\n');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

function room(meId, code = '123456', revision = 1) {
  return {
    code, revision, meId, hand: { id: `hand-${code}`, actionSeq: 1 }, actions: {},
    players: [
      { id: 'old-user', cards: meId === 'old-user' ? ['As', 'Ah'] : [null, null] },
      { id: 'new-user', cards: meId === 'new-user' ? ['Ks', 'Kh'] : [null, null] },
    ],
  };
}

function clientHarness({ writeIdentity = async () => {}, clearIdentity = async () => {} } = {}) {
  const pending = [], renders = [], toasts = [], streams = [];
  const timers = new Map();
  let timerId = 0, clock = 0;
  let client;
  const context = vm.createContext({
    createRequestGuard,
    apiUrl: path => apiUrl(path, { apiBase: 'https://table.example' }),
    fetch(url, options) {
      const result = deferred();
      pending.push({ url, options, ...result });
      const abort = () => result.reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      return result.promise;
    },
    AbortController,
    writeIdentity,
    clearIdentity,
    readIdentity: async () => '',
    clientConfig: () => ({ native: true }),
    navigator: { onLine: true },
    document: { visibilityState: 'visible' },
    commandId: () => 'test-command',
    rememberCommitment: () => false,
    render() {
      renders.push(JSON.parse(JSON.stringify({
        user: client.state.user, room: client.state.room, page: client.state.page,
      })));
    },
    closeModal() { client.state.modal = null; },
    toast(...args) { toasts.push(args); },
    connectStream(code) { client.state.connected = false; streams.push(code); },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: clock + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    location: { hash: '' },
  });
  vm.runInContext(clientSource, context, { filename: 'public/app.js (request lifecycle)' });
  client = context.client;
  Object.assign(client.state, {
    token: 'old-token', user: { id: 'old-user', name: 'Old' },
    room: room('old-user'), page: 'room',
  });
  return {
    ...client, pending, renders, toasts, streams, location: context.location, document: context.document,
    advanceTime(milliseconds) {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test('a current command still applies its response', async () => {
  const client = clientHarness();
  const result = client.command('check');
  assert.equal(client.pending[0].options.headers.Authorization, 'Bearer old-token');
  const updated = room('old-user', '123456', 2);
  client.pending[0].resolve(response({ room: updated }));
  assert.equal(await result, true);
  assert.equal(client.state.room, updated);
  assert.equal(client.state.busy, false);
});

test('a hanging table action times out, releases its controls and resynchronizes without resubmitting', async () => {
  const client = clientHarness();
  client.state.connected = true;
  const result = client.command('call');
  const action = client.pending[0];
  assert.equal(action.options.method, 'POST');
  assert.equal(JSON.parse(action.options.body).type, 'call');
  assert.equal(client.state.busy, true);

  client.advanceTime(14999);
  assert.equal(action.options.signal.aborted, false);
  assert.equal(client.state.busy, true);
  client.advanceTime(1);
  assert.equal(action.options.signal.aborted, true);
  assert.equal(await result, false);
  assert.equal(client.state.busy, false);
  assert.equal(client.state.connected, false);
  assert.deepEqual(client.streams, ['123456']);
  assert.equal(client.pending.length, 1, 'the unconfirmed action must not be submitted again');

  const current = room('old-user', '123456', 2);
  current.hand.actionSeq = 2; // The server may have accepted the unconfirmed action.
  client.normalizeState(current);
  assert.equal(client.state.room, current);
  assert.equal(client.state.room.hand.actionSeq, 2);
  assert.equal(client.pending.length, 1);
});

test('returning to the table aborts an unfinished action and reconnects to the same room', async () => {
  const client = clientHarness();
  client.state.connected = true;
  const result = client.command('raise', { amount: 40 });
  const action = client.pending[0];

  client.resumeTable();
  assert.equal(action.options.signal.aborted, true);
  assert.equal(await result, false);
  assert.equal(client.state.busy, false);
  assert.equal(client.state.connected, false);
  assert.ok(client.streams.length > 0);
  assert.ok(client.streams.every(code => code === '123456'));
  assert.equal(client.pending.length, 1, 'resuming must never repeat the raise');

  const current = room('old-user', '123456', 3);
  client.normalizeState(current);
  action.resolve(response({ room: room('old-user', '123456', 2) }));
  await Promise.resolve();
  assert.equal(client.state.room, current);
  assert.equal(client.pending.length, 1);
});

test('a background action timeout waits for the visible page before reconnecting', async () => {
  const client = clientHarness();
  const result = client.command('call');
  client.document.visibilityState = 'hidden';
  client.advanceTime(15000);

  assert.equal(await result, false);
  assert.equal(client.state.busy, false);
  assert.deepEqual(client.streams, []);
  assert.equal(client.pending.length, 1);
  client.resumeTable(); // An online event can also happen while another app is open.
  assert.deepEqual(client.streams, []);

  client.document.visibilityState = 'visible';
  client.resumeTable();
  assert.deepEqual(client.streams, ['123456']);
  assert.equal(client.pending.length, 1, 'returning must not resubmit the timed-out action');
});

test('a late command cannot restore another identity’s hole cards or clear its busy state', async () => {
  const client = clientHarness();
  const result = client.command('check');
  assert.equal(client.pending[0].options.headers.Authorization, 'Bearer old-token');

  await client.adoptIdentity({ token: 'new-token', user: { id: 'new-user' } });
  const current = room('new-user', '123456', 2);
  client.state.page = 'room';
  client.normalizeState(current);
  client.state.busy = true; // A newer action owns the busy state.
  const renderCount = client.renders.length;

  client.pending[0].resolve(response({ room: room('old-user', '123456', 99) }));
  assert.equal(await result, false);
  assert.equal(client.state.token, 'new-token');
  assert.equal(client.state.room, current);
  assert.deepEqual(client.state.room.players[0].cards, [null, null]);
  assert.equal(client.state.busy, true);
  assert.equal(client.renders.length, renderCount);
  assert.deepEqual(client.toasts, []);
});

test('loadMe discards an old identity response even when JSON parsing was already in progress', async () => {
  const client = clientHarness();
  const jsonStarted = deferred(), json = deferred();
  const loading = client.loadMe();
  client.pending[0].resolve({
    ok: true, status: 200,
    json() { jsonStarted.resolve(); return json.promise; },
  });
  await jsonStarted.promise;

  await client.adoptIdentity({ token: 'new-token', user: { id: 'new-user' } });
  const stats = { hands: 3 }, rooms = [{ code: '654321' }];
  client.state.stats = stats;
  client.state.rooms = rooms;
  const rejected = assert.rejects(loading, error => error.stale === true);
  json.resolve({ user: { id: 'old-user' }, stats: { hands: 99 }, rooms: [{ code: '123456' }] });
  await rejected;
  assert.equal(client.state.user.id, 'new-user');
  assert.equal(client.state.stats, stats);
  assert.equal(client.state.rooms, rooms);
});

for (const outcome of ['response', 'network error']) {
  test(`an older room route's late ${outcome} cannot replace the newer room`, async () => {
    const client = clientHarness();
    client.location.hash = '#/room/123456';
    const older = client.route();
    client.location.hash = '#/room/654321';
    const newer = client.route();
    const current = room('old-user', '654321', 1);
    client.pending[1].resolve(response(current));
    await newer;
    assert.deepEqual(client.streams, ['654321']);
    const renderCount = client.renders.length;

    if (outcome === 'response') client.pending[0].resolve(response(room('old-user', '123456', 99)));
    else client.pending[0].reject(new Error('old connection failed'));
    await older;
    assert.equal(client.state.room, current);
    assert.equal(client.state.page, 'room');
    assert.deepEqual(client.streams, ['654321']);
    assert.deepEqual(client.toasts, []);
    assert.equal(client.renders.length, renderCount);
  });
}

test('identity adoption removes private state and aborts its stream before storage completes', async () => {
  const storage = deferred(), written = [];
  const client = clientHarness({ writeIdentity(token) { written.push(token); return storage.promise; } });
  let aborted = false;
  client.state.stream = { abort() { aborted = true; } };
  client.state.connected = true;
  client.state.stats = { hands: 9 };
  client.state.rooms = [{ code: '123456' }];
  client.state.replay = { hand: { private: true } };
  client.state.modal = { kind: 'show' };
  client.state.revealed.add(0);

  const adoption = client.adoptIdentity({ token: 'new-token', user: { id: 'new-user' } });
  assert.equal(aborted, true);
  assert.equal(client.state.stream, null);
  assert.equal(client.state.connected, false);
  assert.equal(client.state.room, null);
  assert.equal(client.state.stats, null);
  assert.equal(client.state.rooms.length, 0);
  assert.equal(client.state.replay, null);
  assert.equal(client.state.modal, null);
  assert.equal(client.state.revealed.size, 0);
  assert.equal(client.state.page, 'loading');
  assert.equal(client.renders.at(-1).room, null);
  assert.deepEqual(written, ['new-token']);
  storage.resolve();
  await adoption;
});

test('normalization independently rejects a room filtered for a different identity', async () => {
  const client = clientHarness();
  await client.adoptIdentity({ token: 'new-token', user: { id: 'new-user' } });
  const current = room('new-user', '123456', 2);
  client.normalizeState(current);
  const renderCount = client.renders.length;
  client.normalizeState(room('old-user', '123456', 99));
  assert.equal(client.state.room, current);
  assert.equal(client.renders.length, renderCount);
});

test('an old boot 401 cannot erase a newer identity after asynchronous credential clearing', async () => {
  const clearing = deferred(), clearStarted = deferred();
  const client = clientHarness({ clearIdentity() { clearStarted.resolve(); return clearing.promise; } });
  const booting = client.boot();
  client.pending[0].resolve({ ok: false, status: 401, json: async () => ({ error: 'expired identity' }) });
  await clearStarted.promise;

  await client.adoptIdentity({ token: 'new-token', user: { id: 'new-user' } });
  const current = room('new-user');
  client.state.page = 'room';
  client.normalizeState(current);
  const renderCount = client.renders.length;
  clearing.resolve();
  await booting;

  assert.equal(client.state.token, 'new-token');
  assert.equal(client.state.user.id, 'new-user');
  assert.equal(client.state.room, current);
  assert.equal(client.state.page, 'room');
  assert.equal(client.renders.length, renderCount);
  assert.deepEqual(client.toasts, []);
});

test('real platform credential operations finish an older disk clear before a newer write', async () => {
  const priorBridge = Object.getOwnPropertyDescriptor(globalThis, 'tongzhuoDesktop');
  const clearing = deferred(), clearStarted = deferred(), events = [];
  let diskToken = 'old-token', clear, write;
  Object.defineProperty(globalThis, 'tongzhuoDesktop', {
    configurable: true,
    value: {
      async identityClear() {
        events.push('clear:start');
        clearStarted.resolve();
        await clearing.promise;
        diskToken = '';
        events.push('clear:done');
      },
      async identityWrite(token) { diskToken = token; events.push('write'); },
      async identityRead() { events.push('read'); return diskToken; },
    },
  });
  try {
    clear = clearIdentity();
    await clearStarted.promise;
    write = writeIdentity('new-token');
    await Promise.resolve();
    assert.deepEqual(events, ['clear:start']);
    clearing.resolve();
    await Promise.all([clear, write]);
    assert.equal(await readIdentity(), 'new-token');
    assert.deepEqual(events, ['clear:start', 'clear:done', 'write', 'read']);
  } finally {
    clearing.resolve();
    await Promise.allSettled([clear, write]);
    if (priorBridge) Object.defineProperty(globalThis, 'tongzhuoDesktop', priorBridge);
    else delete globalThis.tongzhuoDesktop;
  }
});


test('time bank commands bind to the current hand and action sequence like gameplay actions',async()=>{
  const c=clientHarness();const pending=c.command('timebank');
  const body=JSON.parse(c.pending[0].options.body);
  assert.equal(body.type,'timebank');assert.equal(body.handId,'hand-123456');assert.equal(body.actionSeq,1);
  assert.equal(body.commandId,'test-command');
  c.pending[0].resolve(response({room:room('old-user','123456',2)}));assert.equal(await pending,true);
});
