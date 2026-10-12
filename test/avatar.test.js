import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.js';
import { normalizeAvatarUpload, avatarImageId, AvatarStore, AVATAR_UPLOAD_BYTES } from '../src/avatar.js';
import { EncryptedStore } from '../src/store.js';
import { profilePatch } from '../src/profile.js';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), tail = Buffer.alloc(4);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, tail]);
}
function fixturePng({ width = 256, height = 256, color = 6, depth = 8, interlace = 0, pixels, before = [], after = [], compressed, split = false } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color; header[12] = interlace;
  const row = 256 * (color === 2 ? 3 : 4) + 1;
  const data = pixels ?? Buffer.alloc(256 * row, 70);
  if (!pixels) for (let y = 0; y < 256; y++) data[y * row] = 0;
  const zipped = compressed ?? deflateSync(data), mid = Math.floor(zipped.length / 2);
  const chunks = split ? [pngChunk('IDAT', zipped.subarray(0, mid)), pngChunk('IDAT', zipped.subarray(mid))] : [pngChunk('IDAT', zipped)];
  return Buffer.concat([SIGNATURE, pngChunk('IHDR', header), ...before, ...chunks, ...after, pngChunk('IEND', Buffer.alloc(0))]);
}
const upload = bytes => 'data:image/png;base64,' + bytes.toString('base64');
function chunks(bytes) {
  const result = []; let offset = 8;
  while (offset < bytes.length) { const n = bytes.readUInt32BE(offset); result.push({ type: bytes.subarray(offset + 4, offset + 8).toString(), data: bytes.subarray(offset + 8, offset + 8 + n) }); offset += n + 12; }
  return result;
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-avatar-'));
  let app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 60000 });
  const listen = () => new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await listen();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, body, token, status = 200) {
    const response = await fetch(base() + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  async function image(id, token, status = 200) {
    const response = await fetch(base() + '/api/avatars/' + id, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, status);
    const data = Buffer.from(await response.arrayBuffer());
    if (status === 200) { assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); }
    return data;
  }
  return { directory, base, api, image, get app() { return app; }, guest: name => api('/api/session', { name }, null, 201), async restart() { await app.close(); app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 60000 }); await listen(); } };
}

test('avatar normalization strips every metadata chunk while preserving bounded RGB/RGBA pixel streams', () => {
  for (const color of [2, 6]) {
    const original = fixturePng({ color, split: true, before: [pngChunk('tEXt', Buffer.from('Location\0private-avatar-metadata')), pngChunk('eXIf', Buffer.from('private-avatar-metadata'))], after: [pngChunk('iTXt', Buffer.from('private-avatar-metadata'))] });
    const clean = normalizeAvatarUpload(upload(original));
    assert.deepEqual(chunks(clean).map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND']);
    assert.equal(clean.includes(Buffer.from('private-avatar-metadata')), false);
    assert.deepEqual(inflateSync(chunks(clean)[1].data), inflateSync(Buffer.concat(chunks(original).filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data))));
    assert.deepEqual(normalizeAvatarUpload(upload(clean)), clean, 'normalization must be stable');
  }
});

test('avatar normalization rejects malformed, animated, oversized and decompression-bomb files', () => {
  const damaged = fixturePng(); damaged[damaged.length - 1] ^= 1;
  const badFilter = Buffer.alloc(256 * 1025); badFilter[0] = 5;
  const bad = [damaged, fixturePng().subarray(0, -1), Buffer.concat([fixturePng(), Buffer.from('trailing')]),
    fixturePng({ width: 65535 }), fixturePng({ height: 1 }), fixturePng({ color: 3 }), fixturePng({ depth: 16 }), fixturePng({ interlace: 1 }),
    fixturePng({ pixels: badFilter }), fixturePng({ pixels: Buffer.alloc(256 * 1025 + 1) }), fixturePng({ pixels: Buffer.alloc(256 * 1025 - 1) }),
    fixturePng({ compressed: Buffer.concat([deflateSync(Buffer.alloc(256 * 1025)), Buffer.from('trailing')]) }),
    fixturePng({ pixels: Buffer.alloc(8 * 1024 * 1024) }), fixturePng({ before: [pngChunk('acTL', Buffer.alloc(8))] }),
    fixturePng({ after: [pngChunk('fcTL', Buffer.alloc(26))] }), fixturePng({ before: [pngChunk('PLTE', Buffer.alloc(3))] }),
    fixturePng({ before: [pngChunk('ABCD', Buffer.alloc(0))] }), fixturePng({ after: [pngChunk('IDAT', Buffer.alloc(0)), pngChunk('tEXt', Buffer.alloc(0)), pngChunk('IDAT', Buffer.alloc(0))] }),
    fixturePng({ before: Array.from({ length: 130 }, () => pngChunk('tEXt', Buffer.alloc(0))) })];
  for (const bytes of bad) assert.throws(() => normalizeAvatarUpload(upload(bytes)), /头像图片无效/);
  for (const value of [null, {}, 'https://example.com/image.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAAA====', upload(Buffer.alloc(AVATAR_UPLOAD_BYTES + 1)), upload(fixturePng()) + '\n']) assert.throws(() => normalizeAvatarUpload(value), /头像图片无效/);
});

test('profile accepts only owned uploads or explicit resets and rejects image-ID impersonation', () => {
  assert.deepEqual(profilePatch({ name: '名字', avatarImage: null }), { name: '名字', avatarImage: null });
  assert.deepEqual(profilePatch({ avatarUpload: 'pending-validation' }), { avatarUpload: 'pending-validation' });
  for (const input of [{ avatarImage: 'a'.repeat(32) }, { avatarImage: '../key' }, { avatarUpload: '', avatarImage: null }, { avatarUpload: '', avatar: 3 }, { avatarUrl: 'https://example.com' }]) assert.throws(() => profilePatch(input));
  for (const bad of ['', '../../key', 'A'.repeat(32), 'a'.repeat(31), null, {}]) assert.equal(avatarImageId(bad), null);
});

test('custom avatars persist separately encrypted, round-trip after restart, and do not migrate existing accounts', async t => {
  const f = await fixture(t), owner = await f.guest('原名字');
  const originalUsers = structuredClone(f.app.store.data.users);
  await f.restart(); assert.deepEqual(f.app.store.data.users, originalUsers);
  assert.equal(existsSync(join(f.directory, 'avatars')), false);
  const original = fixturePng({ before: [pngChunk('tEXt', Buffer.from('secret-exif-location'))] }), clean = normalizeAvatarUpload(upload(original));
  const result = await f.api('/api/profile', { name: '新名字', avatarUpload: upload(original) }, owner.token);
  assert.match(result.user.avatarImage, /^[a-f0-9]{32}$/); assert.equal(result.user.name, '新名字');
  assert.equal(f.app.service.user(owner.user.id).avatarUpload, undefined);
  assert.equal(JSON.stringify(f.app.store.data).includes('data:image'), false);
  const file = join(f.directory, 'avatars', result.user.avatarImage + '.enc');
  assert.equal(readFileSync(file).includes(SIGNATURE), false); assert.equal(readFileSync(file).includes(Buffer.from('secret-exif-location')), false);
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(join(f.directory, 'avatars')).mode & 0o777, 0o700);
  assert.deepEqual(await f.image(result.user.avatarImage, owner.token), clean);
  const beforeRestart = structuredClone(f.app.store.data.users);
  await f.restart(); assert.deepEqual(f.app.store.data.users, beforeRestart);
  assert.deepEqual((await f.api('/api/me', undefined, owner.token)).user, result.user);
  assert.deepEqual(await f.image(result.user.avatarImage, owner.token), clean);
});

test('only authenticated owners and people sharing their table can retrieve the current custom avatar', async t => {
  const f = await fixture(t), owner = await f.guest('自己'), peer = await f.guest('同桌'), outsider = await f.guest('陌生人');
  const { user } = await f.api('/api/profile', { avatarUpload: upload(fixturePng()) }, owner.token);
  await f.image(user.avatarImage, undefined, 401);
  const missing = await f.image('f'.repeat(32), outsider.token, 404);
  assert.deepEqual(await f.image(user.avatarImage, outsider.token, 404), missing);
  assert.deepEqual(await f.image(user.avatarImage, peer.token, 404), missing);
  const room = (await f.api('/api/rooms', {}, owner.token, 201)).room;
  await f.api(`/api/rooms/${room.code}/join`, { invite: room.invite }, peer.token);
  assert.deepEqual(await f.image(user.avatarImage, peer.token), normalizeAvatarUpload(upload(fixturePng())));
  for (const id of ['bad-id', 'A'.repeat(32), '%2e%2e%2fkey', 'a'.repeat(32) + '.enc']) await f.image(id, owner.token, 404);
  await f.api('/api/profile', { avatarImage: user.avatarImage }, outsider.token, 400);
  const privatePath = await fetch(f.base() + '/data/avatars/' + user.avatarImage + '.enc'); assert.equal(privatePath.status, 404);
});

test('avatar replacement or default selection removes the previous file only after successful persistence', async t => {
  const f = await fixture(t), owner = await f.guest('玩家');
  const first = (await f.api('/api/profile', { avatarUpload: upload(fixturePng()) }, owner.token)).user;
  const renamed = (await f.api('/api/profile', { name: '只改昵称' }, owner.token)).user;
  assert.equal(renamed.avatarImage, first.avatarImage);
  const second = (await f.api('/api/profile', { avatarUpload: upload(fixturePng({ color: 2 })) }, owner.token)).user;
  assert.notEqual(second.avatarImage, first.avatarImage);
  await f.image(first.avatarImage, owner.token, 404);
  assert.deepEqual(readdirSync(join(f.directory, 'avatars')), [second.avatarImage + '.enc']);
  const selected = (await f.api('/api/profile', { avatar: 9 }, owner.token)).user;
  assert.equal(selected.avatarImage, null); assert.equal(selected.avatar, 9);
  assert.deepEqual(readdirSync(join(f.directory, 'avatars')), []);
  await f.image(second.avatarImage, owner.token, 404);
  const third = (await f.api('/api/profile', { avatarUpload: upload(fixturePng()) }, owner.token)).user;
  const reset = (await f.api('/api/profile', { avatarImage: null }, owner.token)).user;
  assert.equal(reset.avatarImage, null); assert.equal(reset.avatar, 9);
  await f.image(third.avatarImage, owner.token, 404);
});

test('profile persistence failure retains the old image and removes the uncommitted new blob', async t => {
  const f = await fixture(t), owner = await f.guest('原名字');
  const first = (await f.api('/api/profile', { avatarUpload: upload(fixturePng()) }, owner.token)).user;
  await f.api('/api/rooms', {}, owner.token, 201);
  const before = structuredClone(f.app.store.data), original = readFileSync(f.app.store.file), save = f.app.store.save.bind(f.app.store);
  f.app.store.save = () => { const error = new Error('avatar simulated disk full'); error.code = 'ENOSPC'; throw error; };
  await f.api('/api/profile', { name: '失败改名', avatarUpload: upload(fixturePng({ color: 2 })) }, owner.token, 500);
  f.app.store.save = save;
  assert.deepEqual(f.app.store.data, before); assert.deepEqual(readFileSync(f.app.store.file), original);
  assert.deepEqual(readdirSync(join(f.directory, 'avatars')), [first.avatarImage + '.enc']);
  assert.deepEqual(await f.image(first.avatarImage, owner.token), normalizeAvatarUpload(upload(fixturePng())));
  const after = (await f.api('/api/profile', { name: '成功改名' }, owner.token)).user;
  assert.equal(after.avatarImage, first.avatarImage);
});

test('avatar metadata broadcasts without image bytes and malformed uploads do not change table state', async t => {
  const f = await fixture(t), owner = await f.guest('玩家甲'), peer = await f.guest('玩家乙');
  const room = (await f.api('/api/rooms', {}, owner.token, 201)).room;
  await f.api(`/api/rooms/${room.code}/join`, { invite: room.invite }, peer.token);
  const response = await fetch(f.base() + '/api/events?room=' + room.code, { headers: { Authorization: `Bearer ${peer.token}` } });
  const reader = response.body.getReader(); await reader.read(); t.after(() => reader.cancel().catch(() => {}));
  const before = structuredClone(f.app.store.data);
  await f.api('/api/profile', { name: '失败', avatarUpload: 'data:image/png;base64,AAAA' }, owner.token, 400);
  assert.deepEqual(f.app.store.data, before);
  const changed = (await f.api('/api/profile', { avatarUpload: upload(fixturePng()) }, owner.token)).user;
  let timeout;
  try {
    const update = await Promise.race([reader.read(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('avatar SSE timed out')), 3000); })]);
    const text = Buffer.from(update.value).toString();
    assert.equal(text.includes('data:image'), false); assert.equal(text.includes('avatarUpload'), false);
    const data = JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6));
    assert.equal(data.players.find(player => player.id === owner.user.id).avatarImage, changed.avatarImage);
    assert.equal(data.players.find(player => player.id === peer.user.id).avatarImage, null);
  } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); }
});

test('profile accepts a full-size noisy thumbnail while retaining smaller limits for other API requests', async t => {
  const f = await fixture(t), owner = await f.guest('玩家');
  const pixels = randomBytes(256 * 1025); for (let y = 0; y < 256; y++) pixels[y * 1025] = 0;
  const data = upload(fixturePng({ pixels })); assert.ok(data.length > 300000);
  const result = await f.api('/api/profile', { avatarUpload: data }, owner.token);
  assert.deepEqual(inflateSync(chunks(await f.image(result.user.avatarImage, owner.token))[1].data), pixels);
  await f.api('/api/profile', { avatarUpload: 'a'.repeat(410 * 1024) }, owner.token, 413);
  await f.api('/api/rooms', { name: 'a'.repeat(20000) }, owner.token, 413);
});

test('encrypted avatar authentication binds each file to its identifier and corruption is not exposed', async t => {
  const f = await fixture(t), owner = await f.guest('玩家');
  const user = (await f.api('/api/profile', { avatarUpload: upload(fixturePng()) }, owner.token)).user;
  const file = join(f.directory, 'avatars', user.avatarImage + '.enc'), bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 1; writeFileSync(file, bytes);
  await f.image(user.avatarImage, owner.token, 404);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-avatar-cipher-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new EncryptedStore(directory), avatars = new AvatarStore(store), id = avatars.write(fixturePng());
  writeFileSync(avatars.path('b'.repeat(32)), readFileSync(avatars.path(id)));
  assert.throws(() => avatars.read('b'.repeat(32)));
  assert.throws(() => avatars.path('../../key'), /Invalid avatar identifier/);
});

test('an upload paused while reading its body rechecks credentials before storing any blob', async t => {
  const f = await fixture(t), owner = await f.api('/api/account/register', { username: 'avatar_session', password: 'avatar-test-only-password', name: '玩家' }, null, 201);
  let arrived; const received = new Promise(resolve => { arrived = resolve; });
  f.app.server.prependOnceListener('request', arrived);
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = http.request(f.base() + '/api/profile', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    pending.on('error', reject); pending.write('{"avatarUpload":');
  });
  await received;
  await f.api('/api/account/logout', {}, owner.token);
  const before = structuredClone(f.app.store.data.users);
  pending.end(JSON.stringify(upload(fixturePng())) + '}');
  assert.equal(await response, 401);
  assert.deepEqual(f.app.store.data.users, before); assert.equal(existsSync(join(f.directory, 'avatars')), false);
});

test('uncertain directory durability retains both avatar files without exposing the old identifier', async t => {
  const f = await fixture(t), owner = await f.guest('玩家');
  const first = (await f.api('/api/profile', { avatarUpload: upload(fixturePng()) }, owner.token)).user;
  const save = f.app.store.save.bind(f.app.store);
  f.app.store.save = () => { save(); f.app.store.lastSaveDurable = false; };
  const second = (await f.api('/api/profile', { avatarUpload: upload(fixturePng({ color: 2 })) }, owner.token)).user;
  f.app.store.save = save;
  assert.deepEqual(readdirSync(join(f.directory, 'avatars')).sort(), [first.avatarImage + '.enc', second.avatarImage + '.enc'].sort());
  await f.image(first.avatarImage, owner.token, 404);
  assert.deepEqual(await f.image(second.avatarImage, owner.token), normalizeAvatarUpload(upload(fixturePng({ color: 2 }))));
  await f.restart(); assert.equal((await f.api('/api/me', undefined, owner.token)).user.avatarImage, second.avatarImage);
});

test('store file-permission failures occur before commit and directory-sync failures never undo a committed snapshot', t => {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-avatar-commit-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { EncryptedStore } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    const directory = process.argv[1], store = new EncryptedStore(directory);
    store.data.users.owner = { name: 'before' }; store.save();
    const original = { chmodSync: fs.chmodSync, openSync: fs.openSync, fsyncSync: fs.fsyncSync };
    fs.chmodSync = (path, mode) => { if (path.endsWith('table.enc.tmp')) { const error = new Error('synthetic chmod failure'); error.code = 'EACCES'; throw error; } return original.chmodSync(path, mode); };
    syncBuiltinESMExports(); store.data.users.owner.name = 'not-committed';
    assert.throws(() => store.save(), /synthetic chmod failure/); assert.equal(store.read().users.owner.name, 'before');
    Object.assign(fs, original); syncBuiltinESMExports();
    let directoryFd;
    fs.openSync = (path, ...args) => { const fd = original.openSync(path, ...args); if (path === directory) directoryFd = fd; return fd; };
    fs.fsyncSync = fd => { if (fd === directoryFd) { const error = new Error('synthetic directory sync failure'); error.code = 'EIO'; throw error; } return original.fsyncSync(fd); };
    fs.chmodSync = (path, mode) => { assert.notEqual(path, store.file, 'chmod must not throw after commit'); return original.chmodSync(path, mode); };
    syncBuiltinESMExports(); store.data.users.owner.name = 'committed';
    assert.doesNotThrow(() => store.save()); assert.equal(store.lastSaveDurable, false); assert.equal(store.read().users.owner.name, 'committed');
    Object.assign(fs, original); syncBuiltinESMExports(); store.save(); assert.equal(store.lastSaveDurable, true);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
