import * as records from '../public/records.js';
import {createTableFunTracker} from '../public/table-fun.js';
import * as statsUI from '../public/stats.js';
import {createTableFeedback,createTurnCountdown} from '../public/table-feedback.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { createRequestGuard, readIdentity, writeIdentity, clearIdentity } from '../public/platform.js';

const oldToken = 'a'.repeat(43), newToken = 'b'.repeat(43);
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../apps/desktop/src/main.cjs', import.meta.url), 'utf8');
const { validateIdentity } = createRequire(import.meta.url)('../apps/desktop/src/security.cjs');
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
function globals(t, values) {
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}
function browserStorage(t) {
  const entries = new Map();
  globals(t, {
    location: { href: 'https://poker.example.test/' }, TONGZHUO_CONFIG: undefined, tongzhuoDesktop: undefined,
    localStorage: { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) },
  });
}
function tab() {
  const calls = [];
  const context = vm.createContext({clearTimeout,statsUI,records,funTracker:createTableFunTracker(),
    feedback:createTableFeedback(),turnCountdown:createTurnCountdown(),
    createRequestGuard, readIdentity, writeIdentity, clearIdentity,
    avatarCache: { clear() {} },
    stopStream() {}, closeModal() {}, render() {}, toast() {}, resumeTable() {},
    api(endpoint) { calls.push({ endpoint, token: context.client.state.token }); return Promise.resolve({ ok: true }); },
  });
  vm.runInContext([
    'const requests=createRequestGuard();',
    section(appSource, 'const state=', 'const num='),
    section(appSource, 'function resetPrivateView(', 'function resumeTable('),
    section(appSource, 'async function logout(', 'function roomMenu('),
    'globalThis.client={state,adoptIdentity,expireIdentity,logout};',
  ].join('\n'), context);
  return { ...context.client, calls };
}
const account = id => ({ id, username: `account_${id}`, name: id });

test('an expired tab clears its private view without deleting another tab newer login', async t => {
  browserStorage(t);
  const a = tab(), b = tab();
  await a.adoptIdentity({ token: oldToken, user: account('a') });
  a.state.room = { privateCards: ['As', 'Ah'] };
  a.state.replay = { privateCards: ['As', 'Ah'] };
  await b.adoptIdentity({ token: newToken, user: account('b') });
  await a.expireIdentity(oldToken);
  assert.equal(await readIdentity(), newToken);
  assert.equal(a.state.token, ''); assert.equal(a.state.user, null);
  assert.equal(a.state.room, null); assert.equal(a.state.replay, null);
  assert.equal(b.state.token, newToken); assert.equal(b.state.user.id, 'b');
});

test('logout revokes the original account and preserves a newer tab login; current login can still logout', async t => {
  browserStorage(t);
  const a = tab(), b = tab();
  await a.adoptIdentity({ token: oldToken, user: account('a') });
  await b.adoptIdentity({ token: newToken, user: account('b') });
  await a.logout();
  assert.deepEqual(a.calls, [{ endpoint: '/api/account/logout', token: oldToken }]);
  assert.equal(await readIdentity(), newToken);
  assert.equal(a.state.page, 'welcome'); assert.equal(b.state.user.id, 'b');
  await b.logout();
  assert.deepEqual(b.calls, [{ endpoint: '/api/account/logout', token: newToken }]);
  assert.equal(await readIdentity(), ''); assert.equal(b.state.page, 'welcome');
});

test('expiry removes the saved login when it still matches the expired session', async t => {
  browserStorage(t);
  const a = tab(); await a.adoptIdentity({ token: oldToken, user: account('a') });
  await a.expireIdentity(oldToken);
  assert.equal(await readIdentity(), ''); assert.equal(a.state.page, 'welcome');
  assert.equal(await clearIdentity(oldToken), false);
});

test('conditional clearing checks older desktop bridges before invoking their unconditional method', async t => {
  let saved = newToken, cleared = 0;
  globals(t, { tongzhuoDesktop: {
    identityRead: async () => saved,
    async identityClear() { cleared++; saved = ''; },
  } });
  assert.equal(await clearIdentity(oldToken), false);
  assert.equal(saved, newToken); assert.equal(cleared, 0);
  await clearIdentity(newToken);
  assert.equal(saved, ''); assert.equal(cleared, 1);
});

test('desktop storage read failure cannot trigger unconditional clearing', async t => {
  let cleared = false;
  globals(t, { tongzhuoDesktop: {
    identityRead: async () => { throw new Error('keychain unavailable'); },
    identityClear: async () => { cleared = true; },
  } });
  await assert.rejects(clearIdentity(oldToken), /keychain unavailable/);
  assert.equal(cleared, false);
});

function desktopHandlers() {
  const files = new Map(), handlers = new Map(), allowedOrigin = 'https://poker.example.test';
  const file = '/profile/identity.enc';
  const context = vm.createContext({
    path, Promise, JSON, validateIdentity, allowedOrigin,
    app: { getPath: () => '/profile' }, trusted() {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => value, decryptString: value => value },
    async readFile(name) { if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(name); },
    async writeFile(name, value) { files.set(name, value); }, async mkdir() {},
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async unlink(name) { if (!files.delete(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  vm.runInContext(section(mainSource, '  const identityPath =', '  app.setAboutPanelOptions('), context);
  return {
    call: (action, value) => handlers.get(`tongzhuo:identity-${action}`)({}, value),
    replace: record => files.set(file, JSON.stringify(record)), allowedOrigin,
  };
}

test('desktop main process compares and removes within its serialized identity queue', async () => {
  const desktop = desktopHandlers();
  await desktop.call('write', oldToken);
  const writing = desktop.call('write', newToken), staleClear = desktop.call('clear', oldToken);
  await writing; assert.equal(await staleClear, false);
  assert.equal(await desktop.call('read'), newToken);
  assert.equal(await desktop.call('clear', newToken), true);
  assert.equal(await desktop.call('read'), null);
  assert.equal(await desktop.call('clear', newToken), false);
  desktop.replace({ apiBase: 'https://another.example.test', token: oldToken });
  assert.equal(await desktop.call('clear', oldToken), false);
  desktop.replace({ apiBase: desktop.allowedOrigin, token: oldToken });
  assert.equal(await desktop.call('clear'), true, 'older renderers retain the original clear operation');
});

test('desktop preload forwards the expected session to the main process', () => {
  const calls = []; let bridge;
  const context = vm.createContext({ require: () => ({
    contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } },
    ipcRenderer: { invoke(...args) { calls.push(args); } },
  }) });
  vm.runInContext(readFileSync(new URL('../apps/desktop/src/preload.cjs', import.meta.url), 'utf8'), context);
  bridge.identityClear(oldToken);
  assert.deepEqual(calls, [['tongzhuo:identity-clear', oldToken]]);
});
