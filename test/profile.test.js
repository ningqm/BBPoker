import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { nickname, avatar, profilePatch, AVATAR_COUNT } from '../src/profile.js';

const PASSWORD = 'profile-test-only-password';
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-profile-'));
  let app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 60000, ...options });
  const listen = () => new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await listen();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, body, token, status = 200) {
    const response = await fetch(base() + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  async function stream(token, code) {
    const response = await fetch(base() + `/api/events?room=${code}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    t.after(() => reader.cancel().catch(() => {}));
    return reader;
  }
  return { api, stream, directory, get app() { return app; }, guest: (name, avatar = 0) => api('/api/session', { name, avatar }, null, 201), async restart() { await app.close(); app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 60000, ...options }); await listen(); } };
}

async function event(reader) {
  let timer;
  try {
    const part = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('profile broadcast did not arrive')), 3000); })]);
    assert.equal(part.done, false);
    const line = new TextDecoder().decode(part.value).split('\n').find(line => line.startsWith('data: '));
    return JSON.parse(line.slice(6));
  } finally { clearTimeout(timer); }
}

test('profile validation counts Unicode characters, normalizes controls and rejects extra identity fields', () => {
  assert.equal(nickname('  小\u202e明\u0000  '), '小明');
  assert.equal(nickname('e\u0301'), 'é');
  assert.equal(nickname('😀'.repeat(18)), '😀'.repeat(18));
  for (const bad of ['', ' \n\u200b ', '😀'.repeat(19), '\ud800', 7, {}, []]) assert.throws(() => nickname(bad), /昵称/);
  for (const bad of [-1, AVATAR_COUNT, 1.5, '1', null, {}, 'https://example.com/a.png']) assert.throws(() => avatar(bad), /头像/);
  for (const input of [{}, { id: 'someone-else', name: '新昵称' }, { passwordHash: 'attacker' }, JSON.parse('{"__proto__":{"admin":true},"name":"改名"}')]) assert.throws(() => profilePatch(input), /只能修改/);
  assert.deepEqual(profilePatch({ avatar: 11 }), { avatar: 11 });
  assert.deepEqual(profilePatch({ name: '<b>玩家</b>' }), { name: '<b>玩家</b>' });
  assert.equal({}.admin, undefined);
});

test('registered profiles keep account ownership, credentials and every session across restart', async t => {
  const f = await fixture(t);
  const first = await f.api('/api/account/register', { username: 'profile_owner', password: PASSWORD, name: '原昵称', avatar: 11 }, null, 201);
  const second = await f.api('/api/account/login', { username: 'profile_owner', password: PASSWORD });
  const before = structuredClone(f.app.service.user(first.user.id));
  const sessions = structuredClone(f.app.store.data.sessions);
  const changed = await f.api('/api/profile', { name: '  新昵称😀  ', avatar: 8 }, first.token);
  assert.deepEqual(changed.user, { id: first.user.id, username: 'profile_owner', name: '新昵称😀', avatar: 8, avatarImage: null });
  const expected = { ...before, name: '新昵称😀', avatar: 8 };
  assert.deepEqual(f.app.service.user(first.user.id), expected);
  assert.deepEqual(f.app.store.data.sessions, sessions);
  assert.deepEqual((await f.api('/api/me', undefined, second.token)).user, changed.user);
  assert.equal(readFileSync(f.app.store.file).includes(Buffer.from('新昵称')), false);
  await f.restart();
  for (const token of [first.token, second.token]) assert.deepEqual((await f.api('/api/me', undefined, token)).user, changed.user);
  const login = await f.api('/api/account/login', { username: 'profile_owner', password: PASSWORD });
  assert.deepEqual(login.user, changed.user);
});

test('profile writes require a valid session, cannot target another user and reject invalid avatars at registration', async t => {
  const f = await fixture(t), owner = await f.guest('甲'), other = await f.guest('乙');
  const before = structuredClone(f.app.store.data.users);
  await f.api('/api/profile', { name: '冒充' }, null, 401);
  await f.api('/api/profile', { name: '冒充', id: other.user.id }, owner.token, 400);
  await f.api('/api/profile', { avatar: 'https://example.com/tracker.svg' }, owner.token, 400);
  await f.api('/api/profile', { name: '\u202e\u0000' }, owner.token, 400);
  await f.api('/api/profile', JSON.parse('{"name":"坏字段","__proto__":{"admin":true}}'), owner.token, 400);
  assert.deepEqual(f.app.store.data.users, before);
  await f.api('/api/account/register', { username: 'invalid_avatar', password: PASSWORD, avatar: 12 }, null, 400);
  await f.api('/api/session', { name: '坏头像', avatar: -1 }, null, 400);
  assert.equal({}.admin, undefined);
});

test('profile changes broadcast to the table while chat and dealt-hand names remain snapshots', async t => {
  const f = await fixture(t), owner = await f.guest('旧昵称', 2), peer = await f.guest('旁观朋友', 3);
  const room = (await f.api('/api/rooms', { settings: { approvalRequired: false } }, owner.token, 201)).room;
  await f.api(`/api/rooms/${room.code}/join`, { invite: room.invite }, peer.token);
  for (const [seat, player] of [owner, peer].entries()) await f.api(`/api/rooms/${room.code}/action`, { type: 'sit', seat, amount: 1000, commandId: randomUUID() }, player.token);
  await f.api(`/api/rooms/${room.code}/chat`, { kind: 'text', text: '旧消息', messageId: randomUUID() }, owner.token);
  await f.api(`/api/rooms/${room.code}/action`, { type: 'start', commandId: randomUUID() }, owner.token);
  const oldHand = structuredClone(f.app.store.data.rooms[room.code].hand), oldChat = structuredClone(f.app.store.data.rooms[room.code].chat);
  const reader = await f.stream(peer.token, room.code);
  await f.api('/api/profile', { name: '新昵称', avatar: 10 }, owner.token);
  const update = await event(reader);
  assert.equal(update.players.find(player => player.id === owner.user.id).name, '新昵称');
  assert.equal(update.players.find(player => player.id === owner.user.id).avatar, 10);
  assert.deepEqual(f.app.store.data.rooms[room.code].hand, oldHand);
  assert.deepEqual(f.app.store.data.rooms[room.code].chat, oldChat);
  const active = f.app.store.data.rooms[room.code].hand;
  const actor = [owner, peer].find(user => user.user.id === active.actingId);
  await f.api(`/api/rooms/${room.code}/action`, { type: 'fold', commandId: randomUUID(), handId: active.id, actionSeq: active.log.length }, actor.token);
  const history = await f.api(`/api/rooms/${room.code}/hands/${active.id}`, undefined, owner.token);
  assert.equal(history.players.find(player => player.id === owner.user.id).name, '旧昵称');
  assert.equal(update.chat[0].name, '旧昵称');
});

test('failed profile persistence rolls back account and room revisions and never broadcasts the failed name', async t => {
  const f = await fixture(t), owner = await f.guest('旧名字');
  const room = (await f.api('/api/rooms', {}, owner.token, 201)).room;
  const reader = await f.stream(owner.token, room.code);
  const before = structuredClone(f.app.store.data), bytes = readFileSync(f.app.store.file);
  const save = f.app.store.save.bind(f.app.store);
  f.app.store.save = () => { const e = new Error('profile simulated disk full'); e.code = 'ENOSPC'; throw e; };
  await f.api('/api/profile', { name: '失败名字', avatar: 7 }, owner.token, 500);
  f.app.store.save = save;
  assert.deepEqual(f.app.store.data, before);
  assert.equal(f.app.service.db, f.app.store.data);
  assert.deepEqual(readFileSync(f.app.store.file), bytes);
  assert.equal((await f.api('/api/me', undefined, owner.token)).user.name, '旧名字');
  await f.api('/api/profile', { name: '成功名字', avatar: 9 }, owner.token);
  assert.equal((await event(reader)).players[0].name, '成功名字');
});

test('legacy identity updates preserve its recovery token and unspecified profile field; edits are rate limited', async t => {
  const f = await fixture(t), owner = await f.guest('旧身份', 11);
  const first = await f.api('/api/profile', { name: '旧身份改名' }, owner.token);
  assert.equal(first.user.avatar, 11);
  const restored = await f.api('/api/session/restore', { token: owner.token });
  assert.deepEqual(restored.user, first.user);
  for (let i = 1; i < 12; i++) await f.api('/api/profile', { avatar: i % AVATAR_COUNT }, owner.token);
  const before = structuredClone(f.app.store.data.users);
  await f.api('/api/profile', { name: '超过频率' }, owner.token, 429);
  assert.deepEqual(f.app.store.data.users, before);
});

async function seatedTable(f) {
  const players = [await f.guest('时钟甲'), await f.guest('时钟乙')];
  const room = (await f.api('/api/rooms', { settings: { durationMinutes: 60 } }, players[0].token, 201)).room;
  await f.api(`/api/rooms/${room.code}/join`, { invite: room.invite }, players[1].token);
  for (const [seat, player] of players.entries()) await f.api(`/api/rooms/${room.code}/action`, { type: 'sit', seat, amount: 1000, commandId: randomUUID() }, player.token);
  await f.api(`/api/rooms/${room.code}/action`, { type: 'start', commandId: randomUUID() }, players[0].token);
  const command = async (user, type) => {
    const hand = f.app.store.data.rooms[room.code].hand;
    return f.api(`/api/rooms/${room.code}/action`, { type, handId: hand.id, actionSeq: hand.log.length, commandId: randomUUID() }, user.token);
  };
  return { players, room, command, actor: () => players.find(player => player.user.id === f.app.store.data.rooms[room.code].hand.actingId) };
}

test('server restart preserves the dealt cards, table deadline and already-spent time cards', async t => {
  const f = await fixture(t), table = await seatedTable(f), actor = table.actor();
  const beforeUse = f.app.store.data.rooms[table.room.code].deadline;
  await table.command(actor, 'timebank');
  const beforeRestart = structuredClone(f.app.store.data.rooms[table.room.code]);
  assert.equal(beforeRestart.deadline, beforeUse + 30000);
  assert.equal(beforeRestart.members[actor.user.id].timeBank.remaining, 2);
  await f.restart();
  assert.deepEqual(f.app.store.data.rooms[table.room.code], beforeRestart);
  const state = await f.api(`/api/rooms/${table.room.code}`, undefined, actor.token);
  assert.equal(state.deadline, beforeRestart.deadline);
  assert.equal(state.endsAt, beforeRestart.endsAt);
  assert.equal(state.actions.timeBankCards, 2);
});

test('server timer closes an expired waiting table once and broadcasts the persisted result', async t => {
  const f = await fixture(t, { actionTickMs: 40 }), table = await seatedTable(f);
  await table.command(table.actor(), 'fold');
  const reader = await f.stream(table.players[0].token, table.room.code);
  const room = f.app.store.data.rooms[table.room.code];
  room.endsAt = Date.now() - 1;
  f.app.store.save();
  let saves = 0;
  const save = f.app.store.save.bind(f.app.store);
  f.app.store.save = () => { saves++; save(); };
  const closed = await event(reader);
  assert.equal(closed.status, 'closed');
  assert.equal(f.app.store.read().rooms[table.room.code].status, 'closed');
  assert.equal(closed.players.every(player => player.seat === null && player.stack === 0), true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(saves, 1, 'idle timer should not repeatedly persist an unchanged table');
});

test('server timer refreshes time cards from the table clock and persists before broadcasting', async t => {
  const f = await fixture(t, { actionTickMs: 40 }), table = await seatedTable(f);
  await table.command(table.actor(), 'fold');
  const reader = await f.stream(table.players[0].token, table.room.code);
  const room = f.app.store.data.rooms[table.room.code];
  room.startedAt = Date.now() - 30 * 60000 - 1000;
  room.endsAt = room.startedAt + 60 * 60000;
  for (const member of Object.values(room.members)) member.timeBank = { window: 0, remaining: 1 };
  f.app.store.save();
  const refreshed = await event(reader);
  assert.equal(refreshed.players.every(player => player.timeBankCardsRemaining === 3), true);
  for (const member of Object.values(f.app.store.read().rooms[table.room.code].members)) assert.deepEqual(member.timeBank, { window: 1, remaining: 3 });
});

test('an elapsed action clock resolves normally before automatic table expiry closes the room', async t => {
  const f = await fixture(t, { actionTickMs: 40 }), table = await seatedTable(f);
  const reader = await f.stream(table.players[0].token, table.room.code);
  const room = f.app.store.data.rooms[table.room.code], handId = room.hand.id;
  room.endsAt = Date.now() - 1; room.deadline = Date.now() - 1;
  f.app.store.save();
  const closed = await event(reader);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.hand.status, 'complete');
  assert.ok(closed.hand.log.some(action => action.type === 'timeout'));
  assert.equal(f.app.store.read().hands.filter(hand => hand.id === handId).length, 1);
});
