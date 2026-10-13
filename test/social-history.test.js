import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { createApp } from '../server.js';

function fixture(count = 4) {
  const store = { data: { version: 1, users: {}, rooms: {}, hands: [], ledger: [] } };
  const users = Array.from({ length: count }, (_, i) => ({ id: `social${i}`, name: `朋友${i}`, avatar: 0 }));
  for (const user of users) store.data.users[user.id] = user;
  const service = new RoomService(store), room = service.create(users[0], { name: '朋友桌', settings: { approvalRequired: false } });
  users.slice(1, -1).forEach(u => service.join(u, room.code, room.invite));
  const command = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  const chat = (i, input = {}, timestamp = 100000) => service.chat(users[i], room.code, { messageId: randomUUID(), kind: 'text', text: '好牌', ...input }, { timestamp, ip: 'shared-wifi' });
  const play = () => {
    service.start(room);
    while (room.hand.status === 'playing') command(users.findIndex(u => u.id === room.hand.actingId), 'fold');
    return store.data.hands.at(-1);
  };
  const seat = () => { command(0, 'sit', { seat: 0, amount: 1000 }); command(1, 'sit', { seat: 1, amount: 1000 }); };
  return { store, service, room, users, chat, command, play, seat };
}

test('chat authenticates membership, sanitizes Unicode controls and cannot affect a hand or forge authors', () => {
  const f = fixture(); f.seat(); f.command(0, 'start');
  const before = structuredClone(f.room.hand), ledger = structuredClone(f.store.data.ledger);
  assert.throws(() => f.chat(3), e => e.status === 403);
  const message = f.chat(0, { text: ' \u202e你好\u0000 <img src=x onerror=alert(1)> ', playerId: f.users[1].id, name: '伪造', at: '2099-01-01' });
  assert.equal(message.text, '你好 <img src=x onerror=alert(1)>');
  assert.equal(message.playerId, f.users[0].id); assert.equal(message.name, f.users[0].name);
  assert.equal(message.at, new Date(100000).toISOString());
  assert.deepEqual(f.room.hand, before); assert.deepEqual(f.store.data.ledger, ledger);
  const state = f.service.state(f.room, f.users[1].id);
  assert.deepEqual(state.chat, [message]); assert.equal(state.hand.actionSeq, before.log.length);
  assert.equal(state.chatIds, undefined); assert.equal(state.chat[0].messageId, undefined);
  state.chat[0].text = '篡改'; assert.equal(f.room.chat[0].text, message.text);
  f.command(f.users.findIndex(u => u.id === f.room.hand.actingId), 'fold', { actionSeq: before.log.length });
});

test('chat retries are idempotent before throttling; users have cooldown and rolling limits', () => {
  const f = fixture(), messageId = randomUUID(), first = f.chat(0, { messageId });
  const revision = f.room.revision;
  assert.deepEqual(f.chat(0, { messageId, text: '不应覆盖' }, 100001), first);
  assert.equal(f.room.revision, revision); assert.equal(f.room.chat.length, 1);
  assert.throws(() => f.chat(0, {}, 100500), e => e.status === 429);
  f.chat(1, {}, 100500); // Another friend sharing Wi-Fi remains able to speak.
  for (let i = 1; i < 20; i++) f.chat(0, {}, 100000 + i * 1100);
  assert.throws(() => f.chat(0, {}, 123000), e => e.status === 429);
  f.chat(0, {}, 161000);
});

test('chat has a separate bounded shared-IP limit and validates content by Unicode characters', () => {
  const f = fixture(9);
  for (let i = 0; i < 120; i++) f.chat(i % 8, {}, 100000 + Math.floor(i / 8) * 1100);
  assert.throws(() => f.chat(0, {}, 120000), e => e.status === 429);
  const g = fixture();
  assert.equal([...g.chat(0, { text: '🂡'.repeat(160) }).text].length, 160);
  for (const input of [{ text: '🂡'.repeat(161) }, { text: '\n\u202e\u0000' }, { text: {} }, { kind: 'emote', emote: 'script' }, { kind: 'unknown' }, { messageId: 'x' }]) {
    assert.throws(() => g.chat(1, input), e => e.status === 400);
  }
  assert.equal(g.chat(1, { kind: 'emote', emote: 'gg', text: 'ignored' }).emote, 'gg');
  assert.equal(g.room.chat.at(-1).text, undefined);
});

test('chat keeps 100 recent messages, rejects old retries and makes closed tables read-only', () => {
  const f = fixture(), firstId = randomUUID();
  f.chat(0, { messageId: firstId });
  for (let i = 1; i <= 105; i++) f.chat(0, {}, 100000 + i * 61000);
  assert.equal(f.room.chat.length, 100); assert.equal(f.service.state(f.room, f.users[0].id).chat.length, 100);
  assert.throws(() => f.chat(0, { messageId: firstId }, 9000000), e => e.status === 409);
  f.command(0, 'close'); const before = structuredClone(f.room);
  assert.throws(() => f.chat(0, {}, 9000000), /本场已结束/);
  assert.deepEqual(f.room, before);
});

test('personal hand pages exclude spectators and live hands, keep folded privacy and paginate without repeats', () => {
  const f = fixture(); f.seat();
  const hands = [f.play(), f.play(), f.play()];
  for (const h of hands) h.at = '2026-10-12T01:00:00.000Z';
  f.service.start(f.room);
  const first = f.service.handLibrary(f.users[0].id, { limit: '2' });
  assert.equal(first.hands.length, 2); assert.ok(first.nextCursor);
  assert.deepEqual(f.service.handLibrary(f.users[2].id).hands, []);
  assert.deepEqual(f.service.handLibrary(f.users[3].id).hands, []);
  for (const item of first.hands) {
    const internal = hands.find(h => h.id === item.id);
    assert.deepEqual(item.cards, internal.players[0].cards);
    assert.equal(item.players, undefined); assert.equal(item.deck, undefined); assert.equal(item.log, undefined);
    const detail = f.service.handFor(f.users[0].id, f.room.code, item.id);
    assert.deepEqual(detail.players[1].cards, [null, null]);
  }
  const newer = structuredClone(hands[0]); newer.id = randomUUID(); newer.at = '2026-10-12T02:00:00.000Z'; f.store.data.hands.push(newer);
  const second = f.service.handLibrary(f.users[0].id, { limit: '2', before: first.nextCursor });
  assert.equal(second.hands.length, 1); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.hands, ...second.hands].map(h => h.id)).size, 3);
  assert.throws(() => f.service.handLibrary(f.users[3].id, { room: f.room.code }), e => e.status === 403);
  for (const before of ['@', 'abc', Buffer.from('{"at":"bad","id":"x"}').toString('base64url')]) assert.throws(() => f.service.handLibrary(f.users[0].id, { before }), /分页/);
  for (const limit of ['0', '51', '1e1', '-1', '2.5']) assert.throws(() => f.service.handLibrary(f.users[0].id, { limit }), /数量/);
});

test('favorites are personal, bounded and available only for completed participated hands', () => {
  const f = fixture(); f.seat(); const hand = f.play(), user = f.users[0];
  assert.deepEqual(f.service.favoriteHand(user.id, hand.id, true), { favorite: true });
  assert.deepEqual(f.service.favoriteHand(user.id, hand.id, true), { favorite: true });
  assert.equal(user.favoriteHands.length, 1);
  assert.equal(f.service.handLibrary(user.id, { favorites: '1', room: f.room.code }).hands[0].favorite, true);
  assert.equal(f.service.handLibrary(f.users[1].id, { favorites: '1' }).hands.length, 0);
  assert.equal(f.service.handFor(user.id, f.room.code, hand.id).favorite, true);
  assert.equal(f.service.handFor(f.users[1].id, f.room.code, hand.id).favorite, false);
  assert.equal(f.service.handFor(f.users[2].id, f.room.code, hand.id).favorite, false);
  f.service.favoriteHand(user.id, hand.id, false);
  assert.equal(f.service.handFor(user.id, f.room.code, hand.id).favorite, false);
  assert.throws(() => f.service.favoriteHand(f.users[2].id, hand.id, true), e => e.status === 404);
  assert.throws(() => f.service.favoriteHand(f.users[3].id, hand.id, true), e => e.status === 404);
  assert.throws(() => f.service.favoriteHand(user.id, hand.id, 'yes'), e => e.status === 400);
  f.service.start(f.room); assert.throws(() => f.service.favoriteHand(user.id, f.room.hand.id, true), e => e.status === 404);
  user.favoriteHands = Array.from({ length: 1000 }, (_, i) => `older${i}`);
  assert.throws(() => f.service.favoriteHand(user.id, hand.id, true), /最多收藏/);
  f.service.favoriteHand(user.id, hand.id, false); assert.equal(user.favoriteHands.length, 1000);
});

test('HTTP chat/SSE and personal favorites survive encrypted restart without exposing another player cards', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-social-'));
  let app = createApp({ dataDir: directory, allowGuestSessions: true });
  const start = () => new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); await start();
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  const api = async (user, path, body, expected = 200) => {
    const response = await fetch(base() + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const users = [];
  for (const name of ['甲', '乙', '旁观', '局外']) users.push(await api(null, '/api/session', { name }, 201));
  const room = (await api(users[0], '/api/rooms', { settings: { approvalRequired: false } }, 201)).room;
  for (const user of users.slice(1, 3)) await api(user, `/api/rooms/${room.code}/join`, { invite: room.invite });
  const messageId = randomUUID(), chatPath = `/api/rooms/${room.code}/chat`;
  await api(null, chatPath, { messageId, kind: 'text', text: '无身份' }, 401);
  await api(users[3], chatPath, { messageId, kind: 'text', text: '局外不可见' }, 403);
  const message = (await api(users[0], chatPath, { messageId, kind: 'text', text: '私有房间聊天测试', playerId: users[1].user.id })).message;
  assert.equal(message.playerId, users[0].user.id);
  await api(users[0], chatPath, { messageId: randomUUID(), kind: 'emote', emote: 'gg' }, 429);
  assert.deepEqual((await api(users[0], chatPath, { messageId, kind: 'text', text: '重试' })).message, message);
  const controller = new AbortController();
  const response = await fetch(base() + `/api/events?room=${room.code}`, { headers: { Authorization: `Bearer ${users[1].token}` }, signal: controller.signal });
  const reader = response.body.getReader(), initial = new TextDecoder().decode((await reader.read()).value);
  assert.deepEqual(JSON.parse(initial.split('data: ')[1].split('\n\n')[0]).chat, [message]);
  const emoji = (await api(users[1], chatPath, { messageId: randomUUID(), kind: 'emote', emote: 'thanks' })).message;
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.deepEqual(JSON.parse(update.split('data: ')[1].split('\n\n')[0]).chat.at(-1), emoji);
  controller.abort(); await reader.cancel().catch(() => {});
  const command = async (i, type, extra = {}) => api(users[i], `/api/rooms/${room.code}/action`, { type, commandId: randomUUID(), handId: app.store.data.rooms[room.code].hand?.id, actionSeq: app.store.data.rooms[room.code].hand?.log.length, ...extra });
  await command(0, 'sit', { seat: 0, amount: 1000 }); await command(1, 'sit', { seat: 1, amount: 1000 }); await command(0, 'start');
  const actor = users.findIndex(u => u.user.id === app.store.data.rooms[room.code].hand.actingId); await command(actor, 'fold');
  const library = await api(users[0], '/api/hands?limit=20'); assert.equal(library.hands.length, 1);
  const id = library.hands[0].id;
  await api(users[2], `/api/hands/${id}/favorite`, { favorite: true }, 404);
  await api(users[0], `/api/hands/${id}/favorite`, { favorite: true });
  await api(users[0], '/api/hands?before=bad', undefined, 400);
  const beforeFailure = structuredClone(app.store.data), originalSave = app.store.save;
  app.store.save = () => { const error = new Error('simulated social save failure'); error.code = 'EIO'; throw error; };
  try {
    await api(users[2], chatPath, { messageId: randomUUID(), kind: 'text', text: '保存失败不能广播或保留' }, 500);
    assert.deepEqual(app.store.data, beforeFailure);
    await api(users[0], `/api/hands/${id}/favorite`, { favorite: false }, 500);
    assert.deepEqual(app.store.data, beforeFailure);
  } finally { app.store.save = originalSave; }
  const bytes = readFileSync(join(directory, 'table.enc'));
  assert.equal(bytes.subarray(0, 4).toString(), 'TZ01'); assert.equal(bytes.includes(Buffer.from('私有房间聊天测试')), false); assert.equal(bytes.includes(Buffer.from('favoriteHands')), false);
  const key = readFileSync(join(directory, 'key'));
  await app.close(); app = createApp({ dataDir: directory, allowGuestSessions: true }); await start();
  assert.deepEqual(readFileSync(join(directory, 'key')), key);
  assert.deepEqual((await api(users[0], `/api/rooms/${room.code}`)).chat, [message, emoji]);
  assert.equal((await api(users[0], '/api/hands?favorites=1')).hands[0].id, id);
  assert.deepEqual((await api(users[1], '/api/hands?favorites=1')).hands, []);
  assert.deepEqual((await api(users[0], chatPath, { messageId, kind: 'text', text: '重启重试' })).message, message);
  const detail = await api(users[0], `/api/rooms/${room.code}/hands/${id}`);
  assert.deepEqual(detail.players.find(p => p.id === users[1].user.id).cards, [null, null]);
  await command(0, 'close'); await api(users[1], chatPath, { messageId: randomUUID(), kind: 'text', text: '结束后禁言' }, 400);
  assert.equal((await api(null, '/api/health')).app, 'BBPoker');
});
