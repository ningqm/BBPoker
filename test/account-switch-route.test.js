import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequestGuard } from '../public/platform.js';
import { createRoomClock } from '../public/room-clock.js';
import * as statsUI from '../public/stats.js';
import * as records from '../public/records.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
}
const clientSource = [
  'const requests=createRequestGuard();',
  section('const state=', 'const num='),
  section('async function api(', 'function captureRoomChanges('),
  section('function stopStream(', 'async function connectStream('),
  section('async function loadMe(', 'function navigate('),
  section('async function acceptAccount(', 'function roomMenu('),
  section('function resetPrivateView(', "window.addEventListener('hashchange'"),
  section("document.addEventListener('click',event=>{\n  const button", "document.addEventListener('compositionstart'"),
  section("document.addEventListener('submit',async event=>{", 'function resetPrivateView('),
  'globalThis.client={state,requests,api,route,logout,adoptIdentity,expireIdentity,acceptAccount,submitAccount,resumeTable};',
].join('\n');
const oldUser = { id: 'old-user', username: 'old_user', name: '旧账号' };
const newUser = { id: 'new-user', username: 'new_user', name: '新账号' };
const invitation = '#/room/123456/old-invite';
const freshInvitation = '#/room/654321/fresh-invite';
const room = (user, code = '123456') => ({ code, status: 'waiting', meId: user.id, players: [user], settings: {} });
const fd = data => ({ get: key => data[key] ?? null });
const settle = () => new Promise(resolve => setImmediate(resolve));
const assertLobbyRoute = (hash, message = 'the URL must describe the lobby') => assert.match(hash, /^(?:#\/?)?$/, message);

function harness({ joinStatus = 400, passwordStatus = 200 } = {}) {
  const calls = [], toasts = [], streams = [], replacements = [], notices = [], listeners = {}, timers = new Map();
  let client, timerId = 0, actionHandler = async () => {};
  const location = { origin: 'https://poker.test', pathname: '/', search: '', hash: '' };
  Object.defineProperty(location, 'href', {
    get: () => `${location.origin}${location.pathname}${location.search}${location.hash}`,
    set: value => { const parsed = new URL(value, location.href); Object.assign(location, { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash }); },
  });
  const history = { state: null, replaceState(value, title, url) { this.state = value; replacements.push(url); location.href = url; } };
  const context = vm.createContext({
    createRequestGuard, createRoomClock, statsUI, records, AbortController, URL, URLSearchParams,
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } },
    location, history, window: { history, location }, navigator: { onLine: true },
    document: { visibilityState: 'visible', activeElement: null, querySelectorAll: () => notices.filter(n => !n.removed),
      addEventListener(type, callback) { (listeners[type] ??= []).push(callback); } },
    tableSounds: { restore() {}, stopPlayback() {} }, turnCountdown: { reset() {} },
    feedback: { reset() {} }, funTracker: { reset() {} }, avatarCache: { clear() {} },
    apiUrl: value => `https://poker.test${value}`,
    async fetch(url, options) {
      calls.push({ url, options });
      const path = new URL(url).pathname;
      let data, status = 200;
      if (path === '/api/account/logout') data = { ok: true };
      else if (path === '/api/account/login') data = { token: 'new-session', user: newUser };
      else if (path === '/api/account/password') { status = passwordStatus; data = status === 200 ? { token: 'rotated-session', user: oldUser, recoveryCode: 'new-recovery' } : { error: '密码不正确' }; }
      else if (path === '/api/me') data = { user: client.state.user, stats: {}, rooms: [] };
      else if (path === '/api/lobby') data = { rooms: [], limit: 10 };
      else if (/^\/api\/rooms\/\d{6}\/join$/.test(path)) { status = joinStatus; data = status === 200 ? { room: room(client.state.user, path.split('/')[3]) } : { error: '本场已结束，牌谱仍可查看' }; }
      else throw new Error(`Unexpected request: ${path}`);
      return { status, ok: status >= 200 && status < 300, json: async () => data };
    },
    clearIdentity: async () => {}, writeIdentity: async () => {}, render() {},
    closeModal() { client.state.modal = null; },
    toast: (...args) => toasts.push(args),
    normalizeState(value) { client.state.room = value; },
    connectStream(code) { streams.push(code); },
    handleAction(button) { return actionHandler(button); },
    finishComposition() {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(clientSource, context);
  client = context.client;
  return { ...client, calls, toasts, streams, replacements, notices, location,
    setActionHandler(handler) { actionHandler = handler; },
    click() { const button = { classList: { contains: () => false } }; for (const listener of listeners.click ?? []) listener({ target: { closest: () => button } }); },
    async submit(id, values) { const button = { disabled: false, isConnected: true }; for (const listener of listeners.submit ?? []) await listener({ target: { id, values, querySelector: () => button }, preventDefault() {} }); },
    joins: () => calls.filter(call => call.url.endsWith('/join')),
  };
}

test('explicit logout clears the prior table route before a new account enters the lobby', async () => {
  const c = harness();
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'room', room: room(oldUser) });
  c.location.hash = invitation;
  await c.logout();
  assert.equal(c.state.page, 'welcome');
  assertLobbyRoute(c.location.hash, 'the previous account invitation must not survive an explicit logout');
  await c.adoptIdentity({ token: 'new-session', user: newUser });
  await c.route();
  assert.equal(c.state.page, 'lobby');
  assert.equal(c.state.user.id, newUser.id);
  assert.equal(c.state.room, null);
  assert.equal(c.joins().length, 0);
  assert.equal(c.streams.length, 0);
  assert.equal(c.toasts.length, 0);
});

test('failed table entry replaces the URL so rerouting and foreground resumes cannot retry it', async () => {
  const c = harness();
  Object.assign(c.state, { token: 'new-session', user: newUser, page: 'lobby' });
  c.location.hash = invitation;
  await c.route();
  assert.equal(c.state.page, 'lobby');
  assertLobbyRoute(c.location.hash);
  assert.equal(c.replacements.length, 1);
  await c.route();
  c.resumeTable(); await settle();
  assert.equal(c.joins().length, 1, 'only the original explicit invitation attempts a join');
  assert.equal(c.toasts.filter(([message]) => message === '本场已结束，牌谱仍可查看').length, 1);
  assert.equal(c.streams.length, 0);
});

test('an initial unauthenticated invitation survives login and joins the intended table', async () => {
  const c = harness({ joinStatus: 200 });
  c.location.hash = invitation;
  await c.route();
  assert.equal(c.state.page, 'welcome');
  assert.equal(c.location.hash, invitation);
  await c.submitAccount('login', fd({ username: 'new_user', password: 'test-password' }));
  assert.equal(c.state.page, 'room');
  assert.equal(c.location.hash, invitation);
  assert.equal(c.joins().length, 1);
  assert.equal(JSON.parse(c.joins()[0].options.body).invite, 'old-invite');
  assert.deepEqual(c.streams, ['123456']);
});

test('changing the same account password retains its table route without a recovery-code detour', async () => {
  const c = harness({ joinStatus: 200 });
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'room', room: room(oldUser) });
  c.location.hash = invitation;
  await c.submitAccount('password', fd({ currentPassword: 'old-password', newPassword: 'new-password' }));
  assert.equal(c.state.pendingRecovery,null);
  assert.equal(c.location.hash, invitation);
  assert.equal(c.state.page, 'room');
  assert.equal(c.state.token, 'rotated-session');
  assert.equal(c.joins().length, 1);
});

test('direct identity replacement clears the old table route and outstanding account notices', async () => {
  const c = harness();
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'room', room: room(oldUser) });
  c.location.hash = invitation;
  const oldNotice = { noticeTimer: 5, removed: false, remove() { this.removed = true; } };
  c.notices.push(oldNotice);
  await c.adoptIdentity({ token: 'new-session', user: newUser });
  assertLobbyRoute(c.location.hash);
  assert.equal(oldNotice.removed, true);
  await c.route();
  assert.equal(c.state.page, 'lobby');
  assert.equal(c.joins().length, 0);
});

for (const stale of [false, true]) test(`late action errors from an old identity stay silent (stale=${stale})`, async () => {
  const c = harness();
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'lobby' });
  let reject;
  c.setActionHandler(() => new Promise((_, fail) => { reject = fail; }));
  c.click();
  await c.adoptIdentity({ token: 'new-session', user: newUser });
  reject(Object.assign(new Error(stale ? '页面或身份已更新' : '旧账号操作失败'), { stale }));
  await settle();
  assert.equal(c.toasts.length, 0);
  assert.equal(c.state.user.id, newUser.id);
});

test('the current account still sees an incorrect-password error after password submission invalidates prior requests', async () => {
  const c = harness({ passwordStatus: 400 });
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'lobby' });
  await c.submit('password-form', { currentPassword: 'incorrect', newPassword: 'new-password' });
  assert.equal(c.state.user.id, oldUser.id);
  assert.equal(c.state.token, 'old-session');
  assert.equal(c.toasts.filter(([message]) => message === '密码不正确').length, 1);
});

test('late form errors from an old identity do not appear for the new account', async () => {
  const c = harness();
  let reject;
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'lobby',
    accountManager: { reset() {}, submit: () => new Promise((_, fail) => { reject = fail; }) } });
  const pending = c.submit('admin-account-create-form', {});
  await c.adoptIdentity({ token: 'new-session', user: newUser });
  reject(new Error('旧账号表单失败'));
  await pending;
  assert.equal(c.toasts.length, 0);
  assert.equal(c.state.user.id, newUser.id);
});

test('a new invitation opened after explicit logout is retained for a different account', async () => {
  const c = harness({ joinStatus: 200 });
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'room', room: room(oldUser) });
  c.location.hash = invitation;
  await c.logout();
  c.location.hash = freshInvitation;
  await c.route();
  assert.equal(c.state.page, 'welcome');
  await c.submitAccount('login', fd({ username: 'new_user', password: 'test-password' }));
  assert.equal(c.location.hash, freshInvitation);
  assert.equal(c.state.page, 'room');
  assert.equal(c.state.room.code, '654321');
  assert.equal(c.joins().length, 1);
  assert.equal(JSON.parse(c.joins()[0].options.body).invite, 'fresh-invite');
  assert.deepEqual(c.streams, ['654321']);
});

test('relogging into the same account after session expiry retains its table invitation', async () => {
  const c = harness({ joinStatus: 200 });
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'room', room: room(oldUser) });
  c.location.hash = invitation;
  await c.expireIdentity('old-session');
  assert.equal(c.state.page, 'welcome');
  assert.equal(c.location.hash, invitation);
  await c.adoptIdentity({ token: 'relogged-session', user: oldUser });
  await c.route();
  assert.equal(c.location.hash, invitation);
  assert.equal(c.state.page, 'room');
  assert.equal(c.state.user.id, oldUser.id);
  assert.equal(c.joins().length, 1);
  assert.deepEqual(c.streams, ['123456']);
});

test('logging into a different account after session expiry clears the expired account table invitation', async () => {
  const c = harness({ joinStatus: 200 });
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'room', room: room(oldUser) });
  c.location.hash = invitation;
  await c.expireIdentity('old-session');
  await c.submitAccount('login', fd({ username: 'new_user', password: 'test-password' }));
  assertLobbyRoute(c.location.hash);
  assert.equal(c.state.page, 'lobby');
  assert.equal(c.state.user.id, newUser.id);
  assert.equal(c.state.room, null);
  assert.equal(c.joins().length, 0);
  assert.equal(c.streams.length, 0);
});

test('a different invitation opened after session expiry is retained when logging into another account', async () => {
  const c = harness({ joinStatus: 200 });
  Object.assign(c.state, { token: 'old-session', user: oldUser, page: 'room', room: room(oldUser) });
  c.location.hash = invitation;
  await c.expireIdentity('old-session');
  c.location.hash = freshInvitation;
  await c.route();
  await c.submitAccount('login', fd({ username: 'new_user', password: 'test-password' }));
  assert.equal(c.location.hash, freshInvitation);
  assert.equal(c.state.page, 'room');
  assert.equal(c.state.room.code, '654321');
  assert.equal(c.state.user.id, newUser.id);
  assert.equal(c.joins().length, 1);
  assert.equal(JSON.parse(c.joins()[0].options.body).invite, 'fresh-invite');
  assert.deepEqual(c.streams, ['654321']);
});
