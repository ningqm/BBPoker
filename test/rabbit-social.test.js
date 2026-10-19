import { seedLegacyAccount } from './helpers/accounts.js';
import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { verifyProof } from '../src/fairness.js';
import { createApp } from '../server.js';

function fixture(t, seated = 3) {
  let timestamp = 1800000000000; t.mock.method(Date, 'now', () => timestamp);
  const users = Array.from({ length: 5 }, (_, i) => ({ id: `rabbit-user-${i}`, name: `朋友${i}`, avatar: i }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], {});
  for (const u of users.slice(1, 4)) service.join(u, room.code, room.invite);
  const command = (index, type, extra = {}) => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && room.hand?.actingId) readyRoomAction(service, room, value => { timestamp = value; });
    const result = service.command(users[index], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
    if (action) while (room.hand?.transition) assert.ok(advanceRoomEvent(service, room, value => { timestamp = value; }));
    return result;
  };
  for (let i = 0; i < seated; i++) { command(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  const act = type => command(users.findIndex(u => u.id === room.hand.actingId), type);
  const foldFinish = () => { while (room.hand.status === 'playing') act('fold'); };
  const next = () => { timestamp = room.hand.rabbit.nextAt; assert.equal(service.tick(room), true); };
  const chat = (index, data = {}, time = timestamp) => service.chat(users[index], room.code, { messageId: randomUUID(), kind: 'throw', emote: 'water', targetId: users[1].id, ...data }, { timestamp: time, ip: 'shared' });
  return { users, store, service, room, command, act, foldFinish, next, chat, advance(ms) { timestamp += ms; }, get time() { return timestamp; } };
}

test('targeted interactions require seated members, allowlisted emotes, and server-owned names and time', t => {
  const f = fixture(t); f.command(0, 'start'); const hand = structuredClone(f.room.hand), ledger = structuredClone(f.store.data.ledger);
  for (const payload of [{ targetId: f.users[0].id }, { targetId: f.users[3].id }, { targetId: f.users[4].id }, { targetId: '__proto__' }, { emote: 'script' }, { auto: true }, { system: false }, { kind: 'system' }]) assert.throws(() => f.chat(0, payload), e => e.status === 400);
  assert.throws(() => f.chat(3), e => e.status === 400); assert.throws(() => f.chat(4), e => e.status === 403);
  const message = f.chat(0, { playerId: f.users[2].id, name: 'forged', at: '2099-01-01', targetName: 'forged' });
  assert.equal(message.playerId, f.users[0].id); assert.equal(message.name, f.users[0].name); assert.equal(message.targetName, f.users[1].name);
  assert.equal(message.targetId, f.users[1].id); assert.equal(message.at, new Date(f.time).toISOString());
  assert.deepEqual(f.service.state(f.room, f.users[3].id).chat, [message]); assert.deepEqual(f.room.hand, hand); assert.deepEqual(f.store.data.ledger, ledger);
});

test('throw retry precedes throttles; three-second/twelve-per-minute limits also retain original chat limits', t => {
  const f = fixture(t), id = randomUUID(), first = f.chat(0, { messageId: id });
  assert.deepEqual(f.chat(0, { messageId: id, targetId: f.users[2].id }, f.time + 1), first);
  assert.equal(f.room.chat.length, 1); assert.throws(() => f.chat(0, {}, f.time + 2999), e => e.status === 429);
  f.chat(0, { emote: 'tomato' }, f.time + 3000); f.chat(2, { emote: 'pat' }, f.time + 3000);
  for (let i = 2; i < 12; i++) f.chat(0, { emote: ['water', 'tomato', 'pat', 'cheers'][i % 4] }, f.time + i * 4000);
  assert.throws(() => f.chat(0, {}, f.time + 49000), e => e.status === 429); f.chat(0, {}, f.time + 60001);
  const other = fixture(t);
  for (let i = 0; i < 19; i++) other.chat(0, { kind: 'text', text: '好牌' }, other.time + i * 1200);
  other.chat(0, {}, other.time + 24000); assert.throws(() => other.chat(0, {}, other.time + 28000), e => e.status === 429);
});

test('fold-win rabbit reveals every remaining card together while real settlement and proof privacy stay unchanged', t => {
  const f = fixture(t); f.command(0, 'start'); f.foldFinish();
  const h = f.room.hand, immutable = value => { const { rabbit, ...real } = value; return real; };
  const actual = structuredClone(immutable(h)), ledger = structuredClone(f.store.data.ledger), stats = f.service.stats(f.users[0].id), initial = f.time;
  assert.equal(h.rabbit.originalCount, 0); assert.equal(h.rabbit.nextAt, initial + 1000);
  assert.deepEqual(f.service.state(f.room, f.users[3].id).hand.rabbit.board, []);
  assert.deepEqual(f.service.handFor(f.users[3].id, f.room.code, h.id).rabbit.proofs, []);
  assert.equal(f.service.history(f.users[3].id, f.room.code).hands[0].rabbit, null);
  f.advance(999); assert.equal(f.service.tick(f.room), false);
  f.next(); const view = f.service.state(f.room, f.users[3].id), replay = f.service.handFor(f.users[3].id, f.room.code, h.id);
  assert.equal(view.hand.rabbit.board.length, 5); assert.deepEqual(view.hand.rabbit, replay.rabbit);
  assert.equal(view.hand.rabbit.proofs.length, 5); assert.equal(view.hand.rabbit.indices, undefined);
  assert.ok(view.hand.rabbit.proofs.every(p => verifyProof(h.id, h.audit.root, p)));
  assert.ok(view.hand.rabbit.proofs.every(p => !h.players.some(player => player.cardIndices.includes(p.position)) && !h.burnIndices.includes(p.position)));
  assert.deepEqual(view.hand.board, []); assert.ok(view.players.every(player => player.cards.every(card => card === null)));
  assert.deepEqual(immutable(h), actual); assert.deepEqual(f.store.data.ledger, ledger); assert.deepEqual(f.service.stats(f.users[0].id), stats);
  assert.equal(h.rabbit.active, false); assert.equal(h.rabbit.finishedAt, initial + 1000); assert.equal(f.room.nextHandAt, initial + 6000);
  assert.deepEqual(f.service.history(f.users[3].id, f.room.code).hands[0].rabbit.board, h.rabbit.board);
  assert.equal(f.service.handLibrary(f.users[0].id).hands[0].rabbit.board.length, 5);
  const id = h.id; f.advance(f.room.nextHandAt - f.time - 1); assert.equal(f.service.tick(f.room), false);
  f.advance(1); assert.equal(f.service.tick(f.room), true); assert.notEqual(f.room.hand.id, id); assert.equal(f.store.data.hands.length, 1);
});

test('slow clocks reveal rabbit then preserve a five-second result hold; pause/offline only stop dealing', t => {
  const f = fixture(t); f.command(0, 'start'); f.foldFinish(); const h = f.room.hand;
  f.advance(6000); f.service.tick(f.room);
  assert.equal(h.rabbit.board.length, 5); assert.equal(h.rabbit.active, false); assert.equal(f.room.handNumber, 1);
  assert.equal(f.room.nextHandAt, f.time + 5000); f.advance(4999); f.service.tick(f.room); assert.equal(f.room.handNumber, 1);
  f.advance(1); f.service.tick(f.room); assert.equal(f.room.handNumber, 2);
  assert.notEqual(f.room.hand.id, h.id); assert.equal(f.room.hand.rabbit, undefined); assert.deepEqual(f.room.hand.board, []);
  f.command(0, 'autoDeal', { paused: true }); f.foldFinish();
  for (const user of f.users) f.service.connections.delete(`${f.room.code}:${user.id}`);
  while (f.room.hand.rabbit.active) f.next(); assert.equal(f.room.nextHandAt, null); assert.equal(f.room.handNumber, 2);
});

test('manual resume, direct start, close and expiry can skip animation without losing the saved supplemental board', t => {
  for (const operation of ['resume', 'direct', 'close', 'expiry']) {
    const f = fixture(t); f.command(0, 'start'); f.foldFinish(); const id = f.room.hand.id, ledger = f.store.data.ledger.length;
    if (operation === 'resume') f.command(0, 'start'); if (operation === 'direct') f.service.start(f.room);
    if (operation === 'close') f.command(0, 'close'); if (operation === 'expiry') { f.room.endsAt = f.time; f.service.tick(f.room); }
    const saved = f.store.data.hands.find(h => h.id === id);
    assert.equal(saved.rabbit.active, false); assert.equal(saved.rabbit.board.length, 5); assert.deepEqual(saved.board, []);
    assert.equal(f.store.data.hands.length, 1); assert.equal(saved.log.filter(event => event.type === 'payout').length, 1);
    if (operation === 'resume') { assert.equal(f.room.handNumber, 1); assert.equal(f.room.nextHandAt, f.time + 5000); assert.equal(f.store.data.ledger.length, ledger); }
    if (operation === 'direct') assert.equal(f.room.handNumber, 2);
    if (operation === 'close' || operation === 'expiry') { assert.equal(f.room.status, 'closed'); assert.equal(f.room.nextHandAt, null); }
  }
});

test('HTTP failure rolls back throw cooldown/dedup; rabbit persists before SSE and restarts without reshuffling', async t => {
  let timestamp = 1800000000000; t.mock.method(Date, 'now', () => timestamp);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-rabbit-http-')); let app = createApp({ dataDir: directory, actionTickMs: 20 });
  const listen = () => new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); await listen();
  const controllers = []; t.after(async () => { controllers.forEach(c => c.abort()); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = async (token, path, body, expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const users = []; for (const name of ['互动甲', '互动乙', '旁观']) users.push(seedLegacyAccount(app, { name }));
  const created = (await api(users[0].token, '/api/rooms', {}, 201)).room, code = created.code;
  for (const u of users.slice(1)) await api(u.token, `/api/rooms/${code}/join`, { invite: created.invite });
  const room = () => app.store.data.rooms[code];
  const command = async (i, type, more = {})  => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && room().hand?.actingId) readyRoomAction(app.service, room(), value => { timestamp = value; });
    const result = await api(users[i].token, `/api/rooms/${code}/action`, { type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...more });
    // Let the app's real timer commit and publish the delayed settlement.
    for (let guard = 0; action && room().hand?.transition; guard++) {
      assert.ok(guard < 100, 'live timer must publish the scheduled transition');
      timestamp = Math.max(timestamp, room().hand.transition.nextAt);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return result;
  };
  for (let i = 0; i < 2; i++) { await command(i, 'sit', { seat: i, amountBB: 100 }); app.service.connections.set(`${code}:${users[i].user.id}`, 1); }
  const throwBody = { messageId: randomUUID(), kind: 'throw', emote: 'cheers', targetId: users[1].user.id };
  const originalSave = app.store.save.bind(app.store), before = structuredClone(app.store.data);
  app.store.save = () => { throw Object.assign(new Error('rabbit throw write failure'), { code: 'EIO' }); };
  await api(users[0].token, `/api/rooms/${code}/chat`, throwBody, 500); assert.deepEqual(app.store.data, before); assert.equal(app.service.chatRates.size, 0);
  app.store.save = originalSave; const message = (await api(users[0].token, `/api/rooms/${code}/chat`, throwBody)).message;
  assert.deepEqual((await api(users[0].token, `/api/rooms/${code}/chat`, throwBody)).message, message);
  await command(0, 'start'); await command(users.findIndex(u => u.user.id === room().hand.actingId), 'fold');
  async function stream() {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/events?room=${code}`, { headers: { authorization: `Bearer ${users[2].token}` }, signal: controller.signal });
    const reader = response.body.getReader(); let buffer = '';
    return { async until(predicate) { const timeout = setTimeout(() => controller.abort(), 3000); try { for (;;) {
      const end = buffer.indexOf('\n\n'); if (end >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (block.startsWith('data: ')) { const state = JSON.parse(block.slice(6)); if (predicate(state)) return state; } continue; }
      const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += new TextDecoder().decode(chunk.value);
    } } finally { clearTimeout(timeout); } } };
  }
  const first = await stream(); await first.until(state => state.hand?.rabbit?.board.length === 0);
  const frozen = structuredClone(app.store.data); let failed; const failedSave = new Promise(resolve => { failed = resolve; });
  app.store.save = () => { failed(); throw new Error('rabbit reveal write failure'); };
  timestamp = room().hand.rabbit.nextAt; await failedSave; assert.deepEqual(app.store.data, frozen);
  app.store.save = originalSave; const revealed = await first.until(state => state.hand?.rabbit?.board.length === 5);
  assert.equal(app.store.read().hands[0].rabbit.board.length, 5); assert.equal(revealed.hand.rabbit.proofs.length, 5);
  assert.deepEqual(revealed.players.flatMap(p => p.cards), [null, null, null, null]);
  const save = structuredClone(app.store.data), key = readFileSync(join(directory, 'key')); await app.close();
  app = createApp({ dataDir: directory, actionTickMs: 1000000 }); await listen();
  assert.deepEqual(app.store.data, save); assert.deepEqual(readFileSync(join(directory, 'key')), key);
  const refreshed = await api(users[2].token, `/api/rooms/${code}`); assert.deepEqual(refreshed.hand.rabbit, revealed.hand.rabbit); assert.deepEqual(refreshed.hand.board, []);
  assert.deepEqual((await api(users[0].token, `/api/rooms/${code}/chat`, throwBody)).message, message);
  const archived = await api(users[2].token, `/api/rooms/${code}/hands/${room().hand.id}`);
  assert.equal(archived.rabbit.board.length, 5); assert.equal(archived.rabbit.proofs.length, 5);
  assert.equal((await api(users[2].token, `/api/rooms/${code}/history`)).hands[0].rabbit.board.length, 5);
  assert.equal((await api(users[0].token, '/api/stats')).hands, 1);
  timestamp += 1000; app.service.tick(room(), timestamp); app.store.save();
  assert.equal(app.store.read().hands[0].rabbit.board.length, 5);
  assert.equal((await api(users[2].token, `/api/rooms/${code}/hands/${room().hand.id}`)).rabbit.board.length, 5);
});
