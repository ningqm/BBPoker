import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { EncryptedStore } from '../src/store.js';
import { digest, secret, password, hashPassword, verifyPassword } from '../src/auth.js';

const PASSWORD = 'test-only-password-1', NEW_PASSWORD = 'test-only-password-2';
async function setup(t, seed) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-account-'));
  if (seed) { const store = new EncryptedStore(directory); seed(store); store.save(); }
  let app = createApp({ dataDir: directory, trustProxy: 'loopback' });
  const listen = () => new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await listen();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, data, token, expected = 200, extra = {}) {
    const response = await fetch(base() + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await response.json();
    assert.equal(response.status, expected, value.error ?? `unexpected status at ${path}`);
    return value;
  }
  async function stream(token, code) {
    const response = await fetch(base() + '/api/events?room=' + code, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    return reader;
  }
  return { api, base, stream, directory, get app() { return app; }, async register(name = 'player_one') {
    // Existing-account fixture: production has no public registration endpoint.
    const token = secret(), recoveryCode = secret(), id = randomUUID();
    const u = { id, username: name.trim().toLowerCase(), name: '朋友', avatar: 0, passwordHash: await hashPassword(PASSWORD), recoveryHash: digest(recoveryCode), credentialVersion: 1 };
    app.store.data.users[id] = u;
    app.store.data.sessions[digest(token)] = { userId: id, version: 1, createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
    app.store.save();
    return { token, user: { id, username: u.username, name: u.name }, recoveryCode };
  }, async restart() { await app.close(); app = createApp({ dataDir: directory, trustProxy: 'loopback' }); await listen(); } };
}

async function revoked(reader) {
  let timeout;
  try {
    const text = await Promise.race([(async () => {
      let text = '';
      for (;;) { const part = await reader.read(); if (part.done) return text; text += new TextDecoder().decode(part.value); }
    })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('revoked stream stayed open')), 3000); })]);
    assert.match(text, /event: session-expired/);
  } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); }
}

test('password hashing uses unique salts, rejects malformed values and verifies without plaintext storage', async () => {
  const a = await hashPassword(PASSWORD), b = await hashPassword(PASSWORD);
  assert.notEqual(a, b); assert.match(a, /^scrypt-v1\$/);
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(NEW_PASSWORD, a), false);
  assert.equal(await verifyPassword(PASSWORD, undefined), false);
  assert.equal(await verifyPassword({ password: PASSWORD }, a), false);
  await assert.rejects(hashPassword('short'), /6–128/);
});

test('password policy accepts 6 through 128 characters without trimming and rejects invalid boundaries', async () => {
  for (const value of [undefined, null, 123456, {}, '', 'five!', 'x'.repeat(129)]) {
    assert.throws(() => password(value), /6–128/);
  }
  for (const value of ['abc123', 'eight123', PASSWORD, 'x'.repeat(128), ' abc12']) {
    assert.equal(password(value), value);
    const hash = await hashPassword(value);
    assert.equal(await verifyPassword(value, hash), true);
    assert.equal(await verifyPassword(value + 'x', hash), false);
  }
  assert.equal(await verifyPassword('five!', await hashPassword('abc123')), false);
});

test('six and eight character passwords work for login, password changes and recovery while shorter requests leave credentials intact', async t => {
  const f = await setup(t), original = await f.register('boundary_player');
  // Existing long credentials remain valid after lowering the minimum.
  await f.api('/api/account/login', { username: 'boundary_player', password: PASSWORD });
  const before = structuredClone(f.app.store.data);
  const rejectedChange = await f.api('/api/account/password', { currentPassword: PASSWORD, newPassword: 'five!' }, original.token, 400);
  assert.match(rejectedChange.error, /6–128/);
  assert.deepEqual(f.app.store.data, before);

  const six = await f.api('/api/account/password', { currentPassword: PASSWORD, newPassword: 'abc123' }, original.token);
  await f.api('/api/me', undefined, original.token, 401);
  await f.api('/api/account/login', { username: 'boundary_player', password: 'abc123' });
  await f.api('/api/account/login', { username: 'boundary_player', password: 'abc12' }, null, 401);

  const beforeRecovery = structuredClone(f.app.store.data);
  const rejectedRecovery = await f.api('/api/account/recover', { username: 'boundary_player', recoveryCode: six.recoveryCode, newPassword: 'five!' }, null, 400);
  assert.match(rejectedRecovery.error, /6–128/);
  assert.deepEqual(f.app.store.data, beforeRecovery);
  const eight = await f.api('/api/account/recover', { username: 'boundary_player', recoveryCode: six.recoveryCode, newPassword: 'eight123' });
  await f.api('/api/me', undefined, six.token, 401);
  await f.api('/api/account/login', { username: 'boundary_player', password: 'eight123' });
  await f.api('/api/account/login', { username: 'boundary_player', password: 'abc123' }, null, 401);
  assert.equal(eight.user.id, original.user.id);
});

test('existing assigned accounts login/logout use private revocable session tokens', async t => {
  const f = await setup(t);
  await f.api('/api/session', { name: 'guest' }, null, 403);
  await f.api('/api/account/register', { username: 'x', password: PASSWORD }, null, 403);
  await f.api('/api/account/register', { username: 'valid_name', password: 'short' }, null, 403);
  const registered = await f.register('Player_One');
  assert.equal(registered.user.username, 'player_one');
  assert.equal(registered.token.length, 43); assert.equal(registered.recoveryCode.length, 43);
  assert.notEqual(registered.token, registered.recoveryCode);
  const encoded = JSON.stringify(f.app.store.data);
  for (const clear of [PASSWORD, registered.token, registered.recoveryCode]) assert.equal(encoded.includes(clear), false);
  assert.equal(readFileSync(f.app.store.file).includes(Buffer.from('player_one')), false);
  const me = await f.api('/api/me', undefined, registered.token);
  assert.deepEqual(Object.keys(me.user).sort(), ['avatar', 'avatarImage', 'id', 'name', 'username']);
  await f.api('/api/account/register', { username: 'PLAYER_ONE', password: PASSWORD }, null, 403);
  const login = await f.api('/api/account/login', { username: ' PLAYER_ONE ', password: PASSWORD });
  assert.equal(login.user.id, registered.user.id); assert.notEqual(login.token, registered.token); assert.equal(login.recoveryCode, undefined);
  const wrong = await f.api('/api/account/login', { username: 'player_one', password: NEW_PASSWORD }, null, 401);
  const unknown = await f.api('/api/account/login', { username: 'missing_one', password: NEW_PASSWORD }, null, 401);
  assert.deepEqual(wrong, unknown);
  await f.api('/api/account/logout', {}, login.token);
  await f.api('/api/me', undefined, login.token, 401);
  await f.api('/api/me', undefined, registered.token);
});

test('existing legacy identities retain ownership but cannot self-register or bind a new account', async t => {
  const legacyToken = secret(), legacy = { id: 'legacy-owner', name: '原来的朋友', avatar: 2 };
  const f = await setup(t, store => { store.data.users[digest(legacyToken)] = legacy; });
  const before = structuredClone(f.app.store.data);
  assert.equal((await f.api('/api/session/restore', { token: legacyToken })).user.username, null);
  await f.api('/api/account/bind', { username: 'old_friend', password: PASSWORD }, legacyToken, 403);
  assert.deepEqual(f.app.store.data, before);
  assert.equal((await f.api('/api/me', undefined, legacyToken)).user.id, legacy.id);
});

test('password changes revoke every prior session and their already-open private SSE streams', async t => {
  const f = await setup(t), original = await f.register();
  const second = await f.api('/api/account/login', { username: 'player_one', password: PASSWORD });
  const room = (await f.api('/api/rooms', {}, original.token, 201)).room;
  const readers = await Promise.all([f.stream(original.token, room.code), f.stream(second.token, room.code)]);
  await f.api('/api/account/password', { currentPassword: 'incorrect-password', newPassword: NEW_PASSWORD }, original.token, 400);
  await f.api('/api/me', undefined, original.token);
  const changed = await f.api('/api/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, original.token);
  assert.notEqual(changed.recoveryCode, original.recoveryCode);
  await Promise.all(readers.map(revoked));
  for (const old of [original, second]) await f.api('/api/me', undefined, old.token, 401);
  await f.api('/api/me', undefined, changed.token);
  await f.api('/api/account/login', { username: 'player_one', password: PASSWORD }, null, 401);
  await f.api('/api/account/login', { username: 'player_one', password: NEW_PASSWORD });
  await f.api('/api/account/recover', { username: 'player_one', recoveryCode: original.recoveryCode, newPassword: PASSWORD }, null, 401);
});

test('recovery code is single-use, sessions persist through restart and expiry is enforced', async t => {
  const f = await setup(t), original = await f.register();
  const recovered = await f.api('/api/account/recover', { username: 'PLAYER_ONE', recoveryCode: original.recoveryCode, newPassword: NEW_PASSWORD });
  assert.equal(recovered.user.id, original.user.id); assert.notEqual(recovered.recoveryCode, original.recoveryCode);
  await f.api('/api/me', undefined, original.token, 401);
  await f.api('/api/account/recover', { username: 'player_one', recoveryCode: original.recoveryCode, newPassword: PASSWORD }, null, 401);
  const invalid = await f.api('/api/account/recover', { username: 'player_one', recoveryCode: 'invalid', newPassword: PASSWORD }, null, 401);
  const absent = await f.api('/api/account/recover', { username: 'absent_user', recoveryCode: 'invalid', newPassword: PASSWORD }, null, 401);
  assert.deepEqual(invalid, absent);
  await f.restart();
  await f.api('/api/me', undefined, recovered.token);
  const login = await f.api('/api/account/login', { username: 'player_one', password: NEW_PASSWORD });
  assert.equal(login.user.id, original.user.id);
  f.app.store.data.sessions[digest(recovered.token)].expiresAt = Date.now() - 1;
  await f.api('/api/me', undefined, recovered.token, 401);
  await f.api('/api/me', undefined, login.token);
});

test('concurrent recovery cannot reuse the same recovery code', async t => {
  const f = await setup(t), original = await f.register('same_user');
  const recover = () => fetch(f.base() + '/api/account/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'same_user', recoveryCode: original.recoveryCode, newPassword: NEW_PASSWORD }) });
  const resets = await Promise.all([recover(), recover()]);
  assert.deepEqual(resets.map(r => r.status).sort(), [200, 401]);
  const current = await resets.find(r => r.status === 200).json();
  await f.api('/api/me', undefined, current.token);
  assert.equal(Object.values(f.app.store.data.sessions).length, 1);
});

test('logout revokes existing SSE and authenticated requests paused while reading their body', async t => {
  const f = await setup(t), user = await f.register();
  const room = (await f.api('/api/rooms', {}, user.token, 201)).room;
  const reader = await f.stream(user.token, room.code);
  let started;
  const received = new Promise(resolve => { started = resolve; });
  f.app.server.prependOnceListener('request', started);
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = http.request(f.base() + `/api/rooms/${room.code}/action`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    pending.on('error', reject); pending.write('{"type":');
  });
  await received;
  await f.api('/api/account/logout', {}, user.token);
  await revoked(reader);
  // Logout legitimately starts the empty-room clock after its SSE closes.
  // The already-authenticated but unfinished request still must not close it.
  assert.equal(f.app.store.data.rooms[room.code].status, 'waiting');
  const before = structuredClone(f.app.store.data.rooms);
  pending.end(JSON.stringify('close') + ',"commandId":' + JSON.stringify(randomUUID()) + '}');
  assert.equal(await response, 401);
  assert.deepEqual(f.app.store.data.rooms, before);
});

test('failed credential persistence preserves old credentials, recovery code and sessions', async t => {
  const f = await setup(t), original = await f.register();
  const before = structuredClone(f.app.store.data), bytes = readFileSync(f.app.store.file);
  const save = f.app.store.save.bind(f.app.store);
  f.app.store.save = () => { const error = new Error('simulated auth disk full'); error.code = 'ENOSPC'; throw error; };
  await f.api('/api/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, original.token, 500);
  f.app.store.save = save;
  assert.deepEqual(f.app.store.data, before); assert.deepEqual(readFileSync(f.app.store.file), bytes);
  await f.api('/api/me', undefined, original.token);
  await f.api('/api/account/login', { username: 'player_one', password: PASSWORD });
});

test('login attempts are limited per normalized username across client IPs', async t => {
  const f = await setup(t);
  for (let i = 0; i < 15; i++) await f.api('/api/account/login', { username: i % 2 ? 'UNKNOWN_USER' : 'unknown_user', password: PASSWORD }, null, 401, { 'X-BBPoker-Client-IP': `192.0.2.${i + 1}` });
  await f.api('/api/account/login', { username: 'unknown_user', password: PASSWORD }, null, 429, { 'X-BBPoker-Client-IP': '192.0.2.100' });
});
