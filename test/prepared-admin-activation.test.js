import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EncryptedStore } from '../src/store.js';
import { hashPassword } from '../src/auth.js';
import { createApp } from '../server.js';
import { activatePreparedAdmin, validatePreparedAdmin, preparedAdminEnvironment } from '../deploy/activate-prepared-admin.mjs';
import { verifySaved, verifyEnvironment } from '../deploy/verify-snapshot.mjs';

const testPassword = 'fixture8';
const passwordHash = await hashPassword(testPassword);
const accountId = '0123456789abcdef01234567';
function fixture(t, env = '# operator settings\nHOST=127.0.0.1\nPUBLIC_ORIGIN=https://example.invalid\nADMIN_USER_IDS=\n') {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-activate-admin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new EncryptedStore(join(directory, 'data'));
  store.data = { version: 1, users: { legacy: { id: 'old-friend', name: 'PRIVATE-FRIEND', recoveryHash: 'PRIVATE-RECOVERY' } },
    rooms: {}, hands: [{ id: 'private-history', players: [{ id: 'old-friend', hole: ['As', 'Ah'] }] }],
    ledger: [{ playerId: 'old-friend', amount: 123 }], sessions: {}, futureField: { preserved: true } };
  store.save();
  const proposal = { format: 'bbpoker-new-admin-v1', account: { id: accountId, username: 'fixture_owner', name: 'fixture_owner',
    avatar: 1, passwordHash, credentialVersion: 1, disabled: false, createdAt: '2026-10-16T00:00:00.000Z' }, adminUserIds: [accountId] };
  const envFile = join(directory, 'app.env'), proposalFile = join(directory, 'private.json');
  writeFileSync(envFile, env, { mode: 0o640 }); writeFileSync(proposalFile, JSON.stringify(proposal), { mode: 0o600 });
  return { directory, store, proposal, envFile, proposalFile, options: { dataDir: store.directory, envFile, proposalFile },
    before: structuredClone(store.data), beforeBytes: readFileSync(store.file), beforeKey: readFileSync(join(store.directory, 'key')), beforeEnv: env };
}
const bounds = preparedAdmin => ({ observedAfter: Date.now() - 1000, observedBefore: Date.now() + 1000, preparedAdmin });
function unchanged(f) {
  assert.deepEqual(readFileSync(f.store.file), f.beforeBytes);
  assert.equal(readFileSync(f.envFile, 'utf8'), f.beforeEnv);
  assert.deepEqual(readFileSync(join(f.store.directory, 'key')), f.beforeKey);
}

test('activation adds exactly one hashed admin, normalizes only its timestamp, preserves every existing field and file owner/mode', t => {
  const f = fixture(t), dataStat = statSync(f.store.file), envStat = statSync(f.envFile);
  assert.deepEqual(activatePreparedAdmin(f.options), { activated: true, accountsAdded: 1 });
  const current = new EncryptedStore(f.store.directory).data;
  const expected = structuredClone(f.before); expected.users[accountId] = { ...f.proposal.account, createdAt: Date.parse(f.proposal.account.createdAt) };
  assert.deepEqual(current, expected);
  assert.deepEqual(readFileSync(join(f.store.directory, 'key')), f.beforeKey);
  assert.equal(statSync(f.store.file).uid, dataStat.uid); assert.equal(statSync(f.store.file).gid, dataStat.gid);
  assert.equal(statSync(f.envFile).uid, envStat.uid); assert.equal(statSync(f.envFile).gid, envStat.gid);
  assert.equal(statSync(f.envFile).mode & 0o777, 0o640);
  assert.equal(verifySaved(f.before, current, bounds(f.proposal)).accountsAdded, 1);
  assert.equal(verifyEnvironment(f.beforeEnv, readFileSync(f.envFile, 'utf8'), f.proposal).administratorConfigured, true);
  assert.throws(() => verifySaved(f.before, current, bounds()), /Saved records changed/);
  assert.throws(() => activatePreparedAdmin(f.options), /refused/);
  assert.deepEqual(new EncryptedStore(f.store.directory).data, expected, 'repeat activation cannot overwrite or create another account');
});

test('validation-only activation performs no encrypted archive, configuration, or key writes', t => {
  const f = fixture(t);
  assert.deepEqual(activatePreparedAdmin({ ...f.options, validateOnly: true }), { validated: true, accountsAdded: 1 });
  unchanged(f);
});

test('fault between data and environment commits restores both exact original byte sequences', t => {
  const f = fixture(t);
  assert.throws(() => activatePreparedAdmin({ ...f.options, beforeEnvCommit() { throw new Error('fixture disk failure'); } }), /fixture disk failure/);
  unchanged(f);
});

test('id, alternate-key id, username, and differently cased username collisions all fail before writes', t => {
  for (const [key, account] of [
    [accountId, { id: 'another' }], ['other-key', { id: accountId }],
    ['existing', { id: 'existing', username: 'fixture_owner' }], ['existing', { id: 'existing', username: 'FIXTURE_OWNER' }],
  ]) {
    const f = fixture(t); f.store.data.users[key] = account; f.store.save(); f.beforeBytes = readFileSync(f.store.file);
    assert.throws(() => activatePreparedAdmin(f.options), /refused/); unchanged(f);
  }
});

for (const [name, alter] of Object.entries({
  'unexpected token': p => { p.token = 'private-extra'; },
  'plaintext password': p => { p.account.password = 'never-store'; },
  'additional administrator': p => { p.adminUserIds.push('another'); },
  'different administrator': p => { p.adminUserIds[0] = 'another'; },
  'disabled new account': p => { p.account.disabled = true; },
  'invalid password hash': p => { p.account.passwordHash = 'plaintext-looking-secret'; },
  'invalid date': p => { p.account.createdAt = 'not-a-date'; },
  'pre-normalized date': p => { p.account.createdAt = 1; },
  'unexpected profile field': p => { p.account.avatarImage = 'unexpected'; },
})) test(`activation and independent verifier reject ${name}`, t => {
  const f = fixture(t); alter(f.proposal); writeFileSync(f.proposalFile, JSON.stringify(f.proposal));
  assert.throws(() => validatePreparedAdmin(f.proposal)); assert.throws(() => activatePreparedAdmin(f.options));
  assert.throws(() => verifySaved(f.before, structuredClone(f.before), bounds(f.proposal))); unchanged(f);
});

test('conflicting admins and malformed env never allow account insertion', t => {
  for (const env of ['ADMIN_USER_IDS=someone-else\n', `ADMIN_USER_IDS=${accountId},extra\n`, 'ADMIN_USER_IDS=\nADMIN_USER_IDS=\n', 'BROKEN ENV\n', 'A=1\rB=2']) {
    const f = fixture(t, env); assert.throws(() => activatePreparedAdmin(f.options)); unchanged(f);
    assert.throws(() => verifyEnvironment(env, env, f.proposal));
  }
});

test('environment allows precisely the designated assignment and preserves comments, whitespace, CRLF, and unrelated settings', t => {
  const f = fixture(t);
  for (const env of ['', 'HOST=127.0.0.1', '# comment\r\nHOST=127.0.0.1\r\nADMIN_USER_IDS=""\r\n', `ADMIN_USER_IDS='${accountId}'\nOTHER=literal value\n`]) {
    const next = preparedAdminEnvironment(env, accountId);
    assert.equal(verifyEnvironment(env, next, f.proposal).preserved, true);
    assert.throws(() => verifyEnvironment(env, `${next}PUBLIC_ORIGIN=https://changed.invalid\n`, f.proposal));
    assert.throws(() => verifyEnvironment(env, next.replace(accountId, 'a'.repeat(24)), f.proposal));
  }
  assert.deepEqual(verifyEnvironment(f.beforeEnv, f.beforeEnv), { preserved: true, administratorConfigured: false });
});

test('private proposal rejects public-readable files and symbolic links', t => {
  const f = fixture(t);
  chmodSync(f.proposalFile, 0o644); assert.throws(() => activatePreparedAdmin(f.options)); unchanged(f);
  chmodSync(f.proposalFile, 0o600); const link = join(f.directory, 'proposal-link'); symlinkSync(f.proposalFile, link);
  assert.throws(() => activatePreparedAdmin({ ...f.options, proposalFile: link })); unchanged(f);
});

test('independent preservation verification rejects changes to original users, history, ledger, key fields, and extra new accounts', t => {
  const f = fixture(t); activatePreparedAdmin(f.options); const current = new EncryptedStore(f.store.directory).data;
  for (const alter of [
    data => { data.users.legacy.name = 'changed'; }, data => { delete data.users.legacy; },
    data => { data.users[accountId].passwordHash += 'x'; }, data => { data.users[accountId].createdAt++; },
    data => { data.users.extra = { id: 'extra' }; }, data => { data.hands[0].players[0].hole[0] = '2h'; },
    data => { data.ledger[0].amount++; }, data => { data.futureField.preserved = false; },
  ]) { const corrupt = structuredClone(current); alter(corrupt); assert.throws(() => verifySaved(f.before, corrupt, bounds(f.proposal))); }
});

test('CLI verifies private proposal plus exact env delta and exposes only aggregate counts', t => {
  const f = fixture(t), snapshot = join(f.directory, 'snapshot'), old = new EncryptedStore(snapshot);
  old.data = structuredClone(f.before); old.save(); writeFileSync(join(snapshot, 'app.env'), f.beforeEnv, { mode: 0o600 });
  writeFileSync(join(snapshot, 'previous-release.txt'), 'fixture-old\n'); activatePreparedAdmin(f.options);
  const args = [resolve('deploy/verify-snapshot.mjs'), snapshot, f.store.directory, f.proposalFile];
  const options = { encoding: 'utf8', env: { ...process.env, BBPOKER_VERIFY_ENV_FILE: f.envFile } };
  const result = spawnSync(process.execPath, args, options); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).accountsAdded, 1);
  for (const secret of [passwordHash, accountId, 'fixture_owner', 'PRIVATE-FRIEND', 'PRIVATE-RECOVERY']) assert.equal(result.stdout.includes(secret), false);
  writeFileSync(f.envFile, readFileSync(f.envFile, 'utf8') + 'UNAPPROVED_SETTING=yes\n');
  const failed = spawnSync(process.execPath, args, options); assert.equal(failed.status, 1); assert.equal(failed.stdout, ''); assert.equal(failed.stderr.includes(accountId), false);
});

test('activated administrator can log in, manage accounts, and participate in ordinary poker; existing legacy identity remains valid', async t => {
  const f = fixture(t); activatePreparedAdmin(f.options);
  const app = createApp({ dataDir: f.store.directory, adminUserIds: accountId, actionTickMs: 100000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(origin + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'fixture_owner', password: testPassword }) });
  assert.equal(login.status, 200); const identity = await login.json(), headers = { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(origin + '/api/me', { headers })).json()).isAdmin, true);
  assert.equal((await fetch(origin + '/api/admin/accounts', { headers })).status, 200);
  const roomResponse = await fetch(origin + '/api/rooms', { method: 'POST', headers, body: '{}' }); assert.equal(roomResponse.status, 201);
  const { room } = await roomResponse.json(); assert.equal(room.hostId, accountId);
  assert.deepEqual(app.store.data.users.legacy, f.before.users.legacy);
});

test('updater activates only after protected snapshot and restores configuration/data before reopening on failure', () => {
  const source = readFileSync(new URL('../deploy/update-app.sh', import.meta.url), 'utf8');
  const activation = source.indexOf('--proposal "$snapshot/prepared-admin.json"');
  assert.ok(activation > source.indexOf('restore_needed=1\n'));
  assert.ok(activation < source.indexOf('systemctl start bbpoker.service\napp_stopped=0'));
  const verify = source.indexOf('BBPOKER_VERIFY_ENV_FILE=/etc/bbpoker/app.env');
  assert.ok(verify > activation && verify < source.indexOf('committed=1\nsystemctl start caddy.service'));
  assert.ok(source.includes('cp -a -- "$snapshot/table.enc" /var/lib/bbpoker/table.enc'));
  assert.ok(source.includes('cp -a -- "$snapshot/app.env" /etc/bbpoker/app.env'));
});
