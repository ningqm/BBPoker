import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { EncryptedStore } from '../src/store.js';
import { digest, secret, hashPassword, verifyPassword } from '../src/auth.js';

const PASSWORD = 'private-fixture-password';
const fixtureHash = await hashPassword(PASSWORD);
async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-admin-account-'));
  const seeded = new EncryptedStore(directory), identities = {};
  seeded.data.sessions ??= {};
  for (const id of ['admin-one', 'admin-two', 'friend-one']) {
    const token = secret(), recoveryCode = secret();
    const user = { id, username: id.replaceAll('-', '_'), name: id, avatar: 0, passwordHash: fixtureHash, recoveryHash: digest(recoveryCode), credentialVersion: 1, createdAt: Date.now() };
    seeded.data.users[id] = user;
    seeded.data.sessions[digest(token)] = { userId: id, version: 1, createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
    identities[id] = { user, token, recoveryCode };
  }
  const legacyToken = secret();
  seeded.data.users[digest(legacyToken)] = { id: 'legacy-one', name: '老朋友', avatar: 1 };
  seeded.save();
  const app = createApp({ dataDir: directory, adminUserIds: 'admin-one, admin-two', actionTickMs: 1000000, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, data, token = identities['admin-one'].token, expected = 200) {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json();
    assert.equal(response.status, expected, `${path}: ${result.error ?? 'unexpected status'}`);
    return result;
  }
  async function stream(token, room) {
    const response = await fetch(base + '/api/events?room=' + room, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); await reader.read(); return reader;
  }
  return { app, api, base, identities, legacyToken, stream };
}
async function expectRevoked(reader) {
  let timer;
  try {
    const text = await Promise.race([(async () => { let result = ''; for (;;) { const p = await reader.read(); if (p.done) return result; result += new TextDecoder().decode(p.value); } })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE not revoked')), 2000); })]);
    assert.match(text, /session-expired/);
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}

test('all public identity creation routes are forbidden without touching data, including retired guest option', async t => {
  const f = await setup(t, { allowGuestSessions: true }), before = structuredClone(f.app.store.data);
  for (const path of ['/api/session', '/api/account/register', '/api/auth/register', '/api/account/bind']) {
    for (const token of [null, f.identities['friend-one'].token, f.legacyToken]) await f.api(path, { username: 'open_registration', password: PASSWORD, name: '外人', isAdmin: true }, token, 403);
  }
  assert.deepEqual(f.app.store.data, before);
});

test('administrator capability comes only from configured stable IDs, never username, stored flags or first account', async t => {
  const f = await setup(t, { adminUserIds: '' });
  f.app.store.data.users['admin-one'].isAdmin = true;
  const me = await f.api('/api/me', undefined);
  assert.equal(me.isAdmin, false);
  for (const [path, data] of [['/api/admin/accounts', undefined], ['/api/admin/accounts', { username: 'friend_new', isAdmin: true }], ['/api/admin/accounts/friend-one/status', { disabled: true }]]) await f.api(path, data, undefined, 403);
  await f.api('/api/admin/accounts', undefined, null, 401);
});

test('only admins can create assigned accounts; listing and persistence never disclose credentials', async t => {
  const f = await setup(t), nonadmin = f.identities['friend-one'];
  assert.equal((await f.api('/api/me', undefined)).isAdmin, true);
  assert.equal((await f.api('/api/me', undefined, nonadmin.token)).isAdmin, false);
  await f.api('/api/admin/accounts', undefined, nonadmin.token, 403);
  await f.api('/api/admin/accounts', { username: 'new_friend' }, nonadmin.token, 403);
  const created = await f.api('/api/admin/accounts', { username: ' New_Friend ', name: '新朋友', password: PASSWORD, isAdmin: true }, undefined, 201);
  assert.equal(created.account.username, 'new_friend');
  assert.equal(created.account.isAdmin, false);
  assert.equal(created.credentials.username, 'new_friend');
  assert.match(created.credentials.password, /^(?=.*[a-z])(?=.*[2-9])[a-hj-km-np-z2-9]{12}$/);
  assert.notEqual(created.credentials.password, PASSWORD);
  const record = f.app.store.data.users[created.account.id];
  assert.equal(await verifyPassword(created.credentials.password, record.passwordHash), true);
  assert.equal(record.recoveryHash, undefined);
  assert.equal(Object.values(f.app.store.data.sessions).some(s => s.userId === record.id), false);
  const list = await f.api('/api/admin/accounts', undefined);
  const encoded = JSON.stringify(list), persisted = JSON.stringify(f.app.store.data);
  for (const secretValue of [record.passwordHash, created.credentials.password, f.identities['friend-one'].recoveryCode, f.identities['friend-one'].token]) assert.equal(encoded.includes(secretValue), false);
  assert.equal(persisted.includes(created.credentials.password), false);
  assert.equal(readFileSync(f.app.store.file).includes(Buffer.from(created.credentials.password)), false);
  const login = await f.api('/api/account/login', { username: 'NEW_FRIEND', password: created.credentials.password }, null);
  assert.equal(login.user.id, record.id);
});

test('concurrent assignment cannot double-claim a username and failed persistence creates no account or session', async t => {
  const f = await setup(t), token = f.identities['admin-one'].token;
  const create = () => fetch(f.base + '/api/admin/accounts', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'concurrent_friend' }) });
  const results = await Promise.all([create(), create()]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(Object.values(f.app.store.data.users).filter(u => u.username === 'concurrent_friend').length, 1);
  const before = structuredClone(f.app.store.data), bytes = readFileSync(f.app.store.file), save = f.app.store.save;
  f.app.store.save = () => { const e = new Error('fake full disk'); e.code = 'ENOSPC'; throw e; };
  await f.api('/api/admin/accounts', { username: 'not_committed' }, token, 500);
  f.app.store.save = save;
  assert.deepEqual(f.app.store.data, before); assert.deepEqual(readFileSync(f.app.store.file), bytes);
});

test('disabling revokes sessions and SSE; login, recovery and restore cannot reactivate an account', async t => {
  const f = await setup(t), friend = f.identities['friend-one'];
  const second = await f.api('/api/account/login', { username: friend.user.username, password: PASSWORD }, null);
  const room = (await f.api('/api/rooms', {}, friend.token, 201)).room;
  const readers = await Promise.all([f.stream(friend.token, room.code), f.stream(second.token, room.code)]);
  const moneyBefore = structuredClone({ hands: f.app.store.data.hands, ledger: f.app.store.data.ledger, members: f.app.store.data.rooms[room.code].members });
  const status = await f.api('/api/admin/accounts/friend-one/status', { disabled: true });
  assert.equal(status.account.disabled, true);
  await Promise.all(readers.map(expectRevoked));
  await f.api('/api/me', undefined, friend.token, 401);
  await f.api('/api/me', undefined, second.token, 401);
  await f.api('/api/account/login', { username: friend.user.username, password: PASSWORD }, null, 401);
  await f.api('/api/account/recover', { username: friend.user.username, recoveryCode: friend.recoveryCode, newPassword: 'unused-new-password' }, null, 401);
  await f.api('/api/account/bind', { username: 'bypass_friend', password: PASSWORD }, friend.token, 403);
  await f.api('/api/session/restore', { token: friend.token }, null, 401);
  assert.deepEqual({ hands: f.app.store.data.hands, ledger: f.app.store.data.ledger, members: f.app.store.data.rooms[room.code].members }, moneyBefore);
  await f.api('/api/admin/accounts/friend-one/status', { disabled: false });
  await f.api('/api/me', undefined, friend.token, 401);
  await f.api('/api/account/login', { username: friend.user.username, password: PASSWORD }, null);
});

test('password reset revokes prior sessions, recovery and SSE without automatically enabling a disabled account', async t => {
  const f = await setup(t), friend = f.identities['friend-one'];
  const room = (await f.api('/api/rooms', {}, friend.token, 201)).room, reader = await f.stream(friend.token, room.code);
  const reset = await f.api('/api/admin/accounts/friend-one/reset-password', {});
  assert.equal(reset.token, undefined); assert.equal(reset.recoveryCode, undefined);
  await expectRevoked(reader);
  await f.api('/api/me', undefined, friend.token, 401);
  await f.api('/api/account/login', { username: friend.user.username, password: PASSWORD }, null, 401);
  await f.api('/api/account/recover', { username: friend.user.username, recoveryCode: friend.recoveryCode, newPassword: PASSWORD }, null, 401);
  await f.api('/api/account/login', reset.credentials, null);
  await f.api('/api/admin/accounts/friend-one/status', { disabled: true });
  const resetDisabled = await f.api('/api/admin/accounts/friend-one/reset-password', {});
  assert.equal(resetDisabled.account.disabled, true);
  await f.api('/api/account/login', resetDisabled.credentials, null, 401);
});

test('failed reset or disable persistence preserves credentials, status and live sessions', async t => {
  const f = await setup(t), before = structuredClone(f.app.store.data), bytes = readFileSync(f.app.store.file), save = f.app.store.save;
  f.app.store.save = () => { const e = new Error('fake full disk'); e.code = 'ENOSPC'; throw e; };
  await f.api('/api/admin/accounts/friend-one/reset-password', {}, undefined, 500);
  await f.api('/api/admin/accounts/friend-one/status', { disabled: true }, undefined, 500);
  f.app.store.save = save;
  assert.deepEqual(f.app.store.data, before); assert.deepEqual(readFileSync(f.app.store.file), bytes);
  await f.api('/api/me', undefined, f.identities['friend-one'].token);
});

test('cannot disable a configured administrator or elevate through account fields', async t => {
  const f = await setup(t), before = structuredClone(f.app.store.data);
  await f.api('/api/admin/accounts/admin-one/status', { disabled: true }, undefined, 409);
  await f.api('/api/admin/accounts/admin-two/status', { disabled: true }, undefined, 409);
  await f.api('/api/admin/accounts/friend-one/status', { disabled: 'false' }, undefined, 400);
  assert.deepEqual(f.app.store.data, before);
  await f.api('/api/admin/accounts/friend-one/status', { disabled: false, isAdmin: true });
  assert.equal((await f.api('/api/me', undefined, f.identities['friend-one'].token)).isAdmin, false);
});

test('admin authorization is checked again after asynchronous password hashing', async t => {
  const f = await setup(t), token = f.identities['admin-one'].token;
  let seen; const requestStarted = new Promise(resolve => { seen = resolve; });
  f.app.server.prependOnceListener('request', seen);
  const pending = fetch(f.base + '/api/admin/accounts', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"username":"late_assignment"}' });
  await requestStarted;
  // Let the body finish so the expensive hash starts; revoke during the yield.
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.api('/api/account/logout', {}, token);
  assert.equal((await pending).status, 401);
  assert.equal(Object.values(f.app.store.data.users).some(u => u.username === 'late_assignment'), false);
});

test('legacy identity migration retains stable ownership and permanently retires its old recovery token', async t => {
  const f = await setup(t);
  const room = (await f.api('/api/rooms', {}, f.legacyToken, 201)).room;
  const before = structuredClone({ rooms: f.app.store.data.rooms, hands: f.app.store.data.hands, ledger: f.app.store.data.ledger });
  await f.api('/api/admin/accounts/legacy-one/reset-password', {}, undefined, 400);
  await f.api('/api/admin/accounts/legacy-one/reset-password', { username: 'friend_one' }, undefined, 409);
  const migrated = await f.api('/api/admin/accounts/legacy-one/reset-password', { username: 'legacy_assigned' });
  assert.equal(migrated.account.id, 'legacy-one');
  assert.equal(migrated.account.name, '老朋友');
  assert.deepEqual({ rooms: f.app.store.data.rooms, hands: f.app.store.data.hands, ledger: f.app.store.data.ledger }, before);
  assert.equal(f.app.store.data.users[digest(f.legacyToken)], undefined);
  await f.api('/api/me', undefined, f.legacyToken, 401);
  await f.api('/api/session/restore', { token: f.legacyToken }, null, 401);
  const login = await f.api('/api/account/login', migrated.credentials, null);
  const me = await f.api('/api/me', undefined, login.token);
  assert.equal(me.user.id, 'legacy-one'); assert.equal(me.rooms[0].code, room.code);
});

test('legacy disable and re-enable never revive old tokens and never delete player records', async t => {
  const f = await setup(t);
  await f.api('/api/admin/accounts/legacy-one/status', { disabled: true });
  assert.equal(f.app.store.data.users[digest(f.legacyToken)], undefined);
  assert.equal(f.app.store.data.users['legacy-one'].disabled, true);
  await f.api('/api/session/restore', { token: f.legacyToken }, null, 401);
  await f.api('/api/admin/accounts/legacy-one/status', { disabled: false });
  await f.api('/api/me', undefined, f.legacyToken, 401);
  await f.api('/api/session/restore', { token: f.legacyToken }, null, 401);
  const migrated = await f.api('/api/admin/accounts/legacy-one/reset-password', { username: 'old_player_assigned' });
  assert.equal((await f.api('/api/account/login', migrated.credentials, null)).user.id, 'legacy-one');
});

test('disable during password verification or recovery cannot issue a replacement session', async t => {
  const f = await setup(t), friend = f.identities['friend-one'];
  const pending = fetch(f.base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: friend.user.username, password: PASSWORD }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.api('/api/admin/accounts/friend-one/status', { disabled: true });
  assert.equal((await pending).status, 401);
  await f.api('/api/admin/accounts/friend-one/status', { disabled: false });
  const recovery = fetch(f.base + '/api/account/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: friend.user.username, recoveryCode: friend.recoveryCode, newPassword: 'brand-new-password' }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.api('/api/admin/accounts/friend-one/status', { disabled: true });
  assert.equal((await recovery).status, 401);
  assert.equal(Object.values(f.app.store.data.sessions).some(s => s.userId === friend.user.id), false);
});

test('disabling a seated player leaves live hand, chips and ledger unchanged', async t => {
  const f = await setup(t), player = f.identities['friend-one'].user, admin = f.identities['admin-one'].user;
  const service = f.app.service;
  const room = service.create(admin, {});
  service.join(player, room.code, room.invite);
  service.command(admin, room.code, { type: 'sit', seat: 0, amount: 2000, commandId: 'admin-seat' });
  service.command(player, room.code, { type: 'sit', seat: 1, amount: 2000, commandId: 'friend-seat' });
  service.connections.set(`${room.code}:${admin.id}`, 1); service.connections.set(`${room.code}:${player.id}`, 1);
  service.command(admin, room.code, { type: 'start', commandId: 'admin-start' });
  f.app.store.save();
  assert.equal(room.hand.status, 'playing');
  const before = structuredClone({ hand: room.hand, members: room.members, ledger: f.app.store.data.ledger });
  await f.api('/api/admin/accounts/friend-one/status', { disabled: true });
  assert.deepEqual({ hand: room.hand, members: room.members, ledger: f.app.store.data.ledger }, before);
  assert.equal(room.hand.status, 'playing');
});

test('administrator plays normally while all opponent cards and proofs retain player privacy', async t => {
  let timestamp = Date.now(); t.mock.method(Date, 'now', () => timestamp);
  const setTime = value => { timestamp = value; };
  const { readyRoomAction } = await import('./helpers/room-clock.js');
  const f = await setup(t), admin = f.identities['admin-one'], friend = f.identities['friend-one'];
  const room = (await f.api('/api/rooms', {}, admin.token, 201)).room;
  await f.api(`/api/rooms/${room.code}/join`, { invite: room.invite }, friend.token);
  for (const [index, person] of [admin, friend].entries()) {
    await f.api(`/api/rooms/${room.code}/action`, { type: 'sit', seat: index, amount: 2000, commandId: `admin-privacy-sit-${index}` }, person.token);
    f.app.service.connections.set(`${room.code}:${person.user.id}`, 1);
  }
  await f.api(`/api/rooms/${room.code}/action`, { type: 'start', commandId: 'start-admin-play' }, admin.token);
  const internal = f.app.store.data.rooms[room.code], handId = internal.hand.id;
  readyRoomAction(f.app.service, internal, setTime);
  const originalDeck = structuredClone(internal.hand.deck);
  for (const person of [admin, friend]) {
    const view = await f.api(`/api/rooms/${room.code}?viewerId=friend-one&isAdmin=true`, undefined, person.token);
    for (const player of view.players.filter(p => p.inHand)) assert.equal(player.cards.filter(Boolean).length, player.id === person.user.id ? 2 : 0);
    assert.equal(view.hand.proofs.length, 2);
    assert.equal(view.hand.deck, undefined); assert.equal(view.hand.audit, undefined);
  }
  let adminActed = false;
  for (let turns = 0; turns < 8 && internal.hand.status === 'playing'; turns++) {
    readyRoomAction(f.app.service, internal, setTime);
    if (internal.hand.status !== 'playing') break;
    const actor = internal.hand.actingId === admin.user.id ? admin : friend;
    const view = await f.api(`/api/rooms/${room.code}`, undefined, actor.token);
    const type = adminActed ? 'fold' : view.actions.canCheck ? 'check' : 'call';
    await f.api(`/api/rooms/${room.code}/action`, { type, handId, actionSeq: internal.hand.log.length, commandId: `admin-play-${turns}` }, actor.token);
    if (actor === admin) adminActed = true;
  }
  assert.equal(adminActed, true); assert.equal(internal.hand.status, 'complete');
  assert.deepEqual(internal.hand.deck, originalDeck);
  const history = await f.api(`/api/rooms/${room.code}/hands/${handId}`, undefined, admin.token);
  assert.deepEqual(history.players.find(p => p.id === friend.user.id).cards, [null, null]);
  const exported = await f.api(`/api/export?room=${room.code}&format=json`, undefined, admin.token);
  assert.deepEqual(exported.hands[0].players.find(p => p.id === friend.user.id).cards, [null, null]);
  assert.equal((await f.api('/api/me', undefined, admin.token)).isAdmin, true);
});

test('profile forgery and administrator username cannot grant admin capability', async t => {
  const f = await setup(t), token = f.identities['friend-one'].token;
  await f.api('/api/profile', { name: 'admin_one', isAdmin: true, username: 'admin_one', role: 'admin' }, token, 400);
  await f.api('/api/profile', { name: 'admin_one' }, token);
  const me = await f.api('/api/me', undefined, token);
  assert.equal(me.isAdmin, false); assert.equal(me.user.username, 'friend_one');
  await f.api('/api/admin/accounts?username=admin_one&isAdmin=true', undefined, token, 403);
  await f.api('/api/admin/accounts/admin-one/reset-password', { username: 'admin_one', isAdmin: true }, token, 403);
});

test('changing an administrator password revokes sessions but preserves its stable-ID admin capability', async t => {
  const f = await setup(t), admin = f.identities['admin-one'];
  const changed = await f.api('/api/account/password', { currentPassword: PASSWORD, newPassword: 'new-admin-private-password' }, admin.token);
  await f.api('/api/me', undefined, admin.token, 401);
  assert.equal(changed.user.id, admin.user.id);
  assert.equal((await f.api('/api/me', undefined, changed.token)).isAdmin, true);
  const accounts = await f.api('/api/admin/accounts', undefined, changed.token);
  assert.equal(accounts.accounts.find(a => a.id === admin.user.id).isAdmin, true);
});

test('disabled legacy account can be assigned then enabled without reviving its old token', async t => {
  const f = await setup(t);
  await f.api('/api/admin/accounts/legacy-one/status', { disabled: true });
  const reset = await f.api('/api/admin/accounts/legacy-one/reset-password', { username: 'retained_legacy' });
  assert.equal(reset.account.disabled, true);
  await f.api('/api/account/login', reset.credentials, null, 401);
  await f.api('/api/admin/accounts/legacy-one/status', { disabled: false });
  await f.api('/api/me', undefined, f.legacyToken, 401);
  await f.api('/api/session/restore', { token: f.legacyToken }, null, 401);
  assert.equal((await f.api('/api/account/login', reset.credentials, null)).user.id, 'legacy-one');
});


test('assigned account accepts an omitted or blank optional nickname but rejects a non-string nickname', async t => {
  const f = await setup(t);
  for (const [index, name] of ['', '   ', undefined].entries()) {
    const username = `blank_name_friend_${index}`;
    const created = await f.api('/api/admin/accounts', { username, ...(name === undefined ? {} : { name }) }, undefined, 201);
    assert.equal(created.account.name, username.slice(0, 18));
    const login = await f.api('/api/account/login', created.credentials, null);
    assert.equal(login.user.id, created.account.id);
    assert.equal(login.user.name, username.slice(0, 18));
  }
  for (const name of [null, 123, false, {}, []]) await f.api('/api/admin/accounts', { username: 'bad_optional_name', name }, undefined, 400);
  assert.equal(Object.values(f.app.store.data.users).some(u => u.username === 'bad_optional_name'), false);
});
