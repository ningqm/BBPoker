import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { EncryptedStore } from '../src/store.js';
import { secret, digest, hashPassword } from '../src/auth.js';
import { accountOperation, replayAccountOperation, rememberAccountOperation, pruneAccountReceipts } from '../src/account-admin.js';

const fixtureHash = await hashPassword('only-test-password');
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-admin-retry-'));
  const store = new EncryptedStore(directory), tokens = {};
  store.data.sessions = {};
  for (const id of ['admin-one', 'admin-two', 'friend']) {
    const token = tokens[id] = secret();
    store.data.users[id] = { id, username: id.replaceAll('-', '_'), name: id, avatar: 0, passwordHash: fixtureHash, credentialVersion: 1 };
    store.data.sessions[digest(token)] = { userId: id, version: 1, createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
  }
  store.data.users['legacy'] = { id: 'legacy', name: '旧朋友', avatar: 1 };
  store.save();
  const f = { tokens, directory };
  f.start = async () => {
    f.app = createApp({ dataDir: directory, adminUserIds: 'admin-one,admin-two', actionTickMs: 1000000 });
    await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
    f.base = `http://127.0.0.1:${f.app.server.address().port}`;
  };
  await f.start();
  t.after(async () => { await f.app.close(); rmSync(directory, { recursive: true, force: true }); });
  f.api = async (path, body, { token = tokens['admin-one'], status = 200 } = {}) => {
    const res = await fetch(f.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json(); assert.equal(res.status, status, `${path}: ${data.error ?? 'status'}`); return data;
  };
  return f;
}
const createPath = '/api/admin/accounts';
const resetPath = '/api/admin/accounts/friend/reset-password';
const requestId = () => secret();

test('lost create response recovers the same credentials after a server restart without another account', async t => {
  const f = await fixture(t), body = { username: 'retry_friend', requestId: requestId() };
  // Interrupt the response after the account transaction has committed.
  f.app.server.prependOnceListener('request', (_req, res) => { res.end = () => { res.destroy(); }; });
  await assert.rejects(f.api(createPath, body, { status: 201 }));
  const original = Object.values(f.app.store.data.users).find(user => user.username === body.username);
  assert.ok(original); const version = original.credentialVersion, passwordHash = original.passwordHash;
  await f.app.close(); await f.start();
  const recovered = await f.api(createPath, body, { status: 201 });
  assert.equal(recovered.account.id, original.id);
  assert.equal(f.app.store.data.users[original.id].credentialVersion, version);
  assert.equal(f.app.store.data.users[original.id].passwordHash, passwordHash);
  assert.equal(Object.values(f.app.store.data.users).filter(user => user.username === body.username).length, 1);
  assert.equal((await f.api('/api/account/login', recovered.credentials, { token: null })).user.id, original.id);
  assert.deepEqual(await f.api(createPath, body, { status: 201 }), recovered);
  assert.equal(JSON.stringify(f.app.store.data).includes(recovered.credentials.password), false);
  assert.equal(readFileSync(f.app.store.file).includes(Buffer.from(recovered.credentials.password)), false);
  assert.equal(JSON.stringify(await f.api(createPath)).includes(recovered.credentials.password), false);
});

test('concurrent duplicate create requests return one identity and one password', async t => {
  const f = await fixture(t), body = { username: 'parallel_friend', name: '一起重试', requestId: requestId() };
  const responses = await Promise.all([f.api(createPath, body, { status: 201 }), f.api(createPath, body, { status: 201 })]);
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(Object.values(f.app.store.data.users).filter(user => user.username === body.username).length, 1);
  assert.equal(Object.keys(f.app.store.data.accountReceipts).length, 1);
});

test('same request ID with different form or operation is rejected without changing data', async t => {
  const f = await fixture(t), body = { username: 'unchanged_friend', name: '原昵称', requestId: requestId() };
  await f.api(createPath, body, { status: 201 }); const before = structuredClone(f.app.store.data);
  for (const patch of [{ username: 'different_friend' }, { name: '新昵称' }]) await f.api(createPath, { ...body, ...patch }, { status: 409 });
  await f.api(resetPath, { requestId: body.requestId }, { status: 409 });
  assert.deepEqual(f.app.store.data, before);
});

test('recovery is isolated to the issuing administrator and never exposed to an ordinary player', async t => {
  const f = await fixture(t), body = { username: 'protected_friend', requestId: requestId() };
  const result = await f.api(createPath, body, { status: 201 });
  await f.api(createPath, body, { token: f.tokens.friend, status: 403 });
  await f.api(createPath, body, { token: null, status: 401 });
  const other = await f.api(createPath, body, { token: f.tokens['admin-two'], status: 409 });
  assert.equal(JSON.stringify(other).includes(result.credentials.password), false);
  await f.api('/api/account/logout', {}, {});
  await f.api(createPath, body, { status: 401 });
});

test('reset retries rotate credentials once, including concurrent retries and lost response', async t => {
  const f = await fixture(t), body = { requestId: requestId() };
  f.app.server.prependOnceListener('request', (_req, res) => { res.end = () => { res.destroy(); }; });
  await assert.rejects(f.api(resetPath, body));
  assert.equal(f.app.store.data.users.friend.credentialVersion, 2);
  const results = await Promise.all([f.api(resetPath, body), f.api(resetPath, body)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.app.store.data.users.friend.credentialVersion, 2);
  assert.equal((await f.api('/api/account/login', results[0].credentials, { token: null })).user.id, 'friend');
  const freshBody = { requestId: requestId() };
  const concurrent = await Promise.all([f.api(resetPath, freshBody), f.api(resetPath, freshBody)]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(f.app.store.data.users.friend.credentialVersion, 3);
});

test('old receipt cannot disclose a password after user changes credentials or administrator disables account', async t => {
  const f = await fixture(t), body = { username: 'new_pass_friend', requestId: requestId() };
  const created = await f.api(createPath, body, { status: 201 });
  const login = await f.api('/api/account/login', created.credentials, { token: null });
  await f.api('/api/account/password', { currentPassword: created.credentials.password, newPassword: 'friend-new-private' }, { token: login.token });
  const invalid = await f.api(createPath, body, { status: 409 });
  assert.equal(invalid.credentials, undefined); assert.equal(invalid.code, 'ACCOUNT_OPERATION_CHANGED');
  const resetBody = { requestId: requestId() };
  await f.api(resetPath, resetBody);
  await f.api('/api/admin/accounts/friend/status', { disabled: true });
  const disabled = await f.api(resetPath, resetBody, { status: 409 });
  assert.equal(disabled.credentials, undefined);
});

test('legacy migration has a stable receipt even though the target now has a username', async t => {
  const f = await fixture(t), body = { username: 'legacy_recovered', requestId: requestId() }, path = '/api/admin/accounts/legacy/reset-password';
  const first = await f.api(path, body), second = await f.api(path, body);
  assert.deepEqual(second, first);
  assert.equal(f.app.store.data.users.legacy.credentialVersion, 1);
});

test('failed persistence rolls back the account and receipt together and allows safe retry', async t => {
  const f = await fixture(t), body = { username: 'disk_retry', requestId: requestId() }, before = structuredClone(f.app.store.data), save = f.app.store.save;
  f.app.store.save = () => { const error = new Error('simulated full disk'); error.code = 'ENOSPC'; throw error; };
  await f.api(createPath, body, { status: 500 });
  assert.deepEqual(f.app.store.data, before);
  f.app.store.save = save;
  await f.api(createPath, body, { status: 201 });
  const after = structuredClone(f.app.store.data), resetBody = { requestId: requestId() };
  f.app.store.save = () => { const error = new Error('simulated full disk'); error.code = 'ENOSPC'; throw error; };
  await f.api(resetPath, resetBody, { status: 500 });
  assert.deepEqual(f.app.store.data, after);
  f.app.store.save = save;
  await f.api(resetPath, resetBody);
  assert.equal(f.app.store.data.users.friend.credentialVersion, 2);
});

test('expired credential receipt refuses replay and its encrypted password is pruned while a tombstone remains', async t => {
  const f = await fixture(t), body = { requestId: requestId() };
  await f.api(resetPath, body);
  const entry = Object.values(f.app.store.data.accountReceipts)[0], until = entry.passwordUntil;
  t.mock.method(Date, 'now', () => until + 1);
  const hash = f.app.store.data.users.friend.passwordHash;
  const expired = await f.api(resetPath, body, { status: 409 });
  assert.match(expired.error, /操作已完成/); assert.equal(expired.code, 'ACCOUNT_OPERATION_EXPIRED');
  assert.equal(f.app.store.data.users.friend.passwordHash, hash);
  pruneAccountReceipts(f.app.store.data);
  assert.equal(entry.passwordCipher, undefined);
  assert.equal(Object.keys(f.app.store.data.accountReceipts).length, 1);
});

test('malformed request IDs never create accounts; credentials cannot be decrypted with another key', async t => {
  const f = await fixture(t), before = structuredClone(f.app.store.data);
  for (const id of ['', null, {}, 'short', 'x'.repeat(101)]) await f.api(createPath, { username: 'invalid_id', requestId: id }, { status: 400 });
  assert.deepEqual(f.app.store.data, before);
  const operation = accountOperation('admin-one', requestId(), { type: 'test' });
  rememberAccountOperation(f.app.store.data, f.app.store.key, operation, f.app.store.data.users.friend, 'secret-recovery-value');
  assert.throws(() => replayAccountOperation(f.app.store.data, Buffer.alloc(32), operation, new Set(['admin-one'])), /取回临时密码失败/);
});


test('an administrator cannot self-reset and lose the session needed to recover the result', async t => {
  const f = await fixture(t), before = structuredClone(f.app.store.data);
  await f.api('/api/admin/accounts/admin-one/reset-password', { requestId: requestId() }, { status: 409 });
  assert.deepEqual(f.app.store.data, before);
  assert.equal((await f.api('/api/me')).isAdmin, true);
});


test('revoking an administrator while a replay request body is streaming prevents credential disclosure', async t => {
  const f = await fixture(t), body = { username: 'streamed_replay', requestId: requestId() };
  const created = await f.api(createPath, body, { status: 201 });
  const serialized = JSON.stringify(body);
  let started; const received = new Promise(resolve => { started = resolve; });
  f.app.server.prependOnceListener('request', started);
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(f.base + createPath, { method: 'POST', headers: { Authorization: `Bearer ${f.tokens['admin-one']}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
    request.on('error', reject); request.write(serialized.slice(0, -1));
  });
  await received;
  await f.api('/api/account/logout', {});
  request.end(serialized.slice(-1));
  const result = await response;
  assert.equal(result.status, 401);
  assert.equal(result.data.credentials, undefined);
  assert.equal(JSON.stringify(result).includes(created.credentials.password), false);
});
