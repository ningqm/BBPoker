import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { createApp } from '../server.js';

function fixture(t, settings = {}, count = 3) {
  let timestamp = 1800000000000;
  t.mock.method(Date, 'now', () => timestamp);
  const users = Array.from({ length: 4 }, (_, i) => ({ id: `auto-${i}`, name: `朋友${i}`, avatar: i }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], { settings });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) { cmd(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  // These tests isolate automatic dealing after the optional supplemental-card
  // animation. Its real deadlines, restart and privacy are covered separately.
  const finish = () => { for (let n = 0; room.hand.status === 'playing'; n++) { assert.ok(n < 20); cmd(users.findIndex(u => u.id === room.hand.actingId), 'fold'); } service.completeRabbit(room, timestamp); };
  const connect = (i, online, reconnected = false) => { service.connections.set(`${room.code}:${users[i].id}`, online ? 1 : 0); return service.connectionChanged(room, timestamp, { reconnected }); };
  return { users, store, service, room, cmd, finish, connect, advance(ms) { timestamp += ms; }, get time() { return timestamp; } };
}

test('only the first hand needs host start; a completed hand deals exactly once after five seconds', t => {
  const f = fixture(t), { room, service } = f;
  assert.equal(service.needsTick(room, f.time + 100000), false);
  f.cmd(0, 'start'); const first = room.hand.id; f.finish();
  assert.equal(room.nextHandAt, f.time + 5000);
  assert.deepEqual(service.state(room, f.users[1].id).autoDeal, { paused: false, nextHandAt: f.time + 5000, waitReason: null, delaySeconds: 5 });
  f.advance(4999); assert.equal(service.tick(room), false);
  assert.throws(() => f.cmd(0, 'start'), e => e.status === 409);
  assert.equal(room.hand.id, first); f.advance(1); assert.equal(service.tick(room), true);
  assert.notEqual(room.hand.id, first); assert.equal(room.handNumber, 2); assert.equal(room.nextHandAt, null);
  assert.equal(f.store.data.hands.length, 1); assert.equal(service.tick(room), false);
  assert.equal(f.store.data.ledger.filter(row => row.type === 'holdem').length, 3);
});

test('host pause works during a hand; resume and command retries preserve a full countdown', t => {
  const f = fixture(t); f.cmd(0, 'start');
  assert.throws(() => f.cmd(1, 'autoDeal', { paused: true }), e => e.status === 403);
  assert.throws(() => f.cmd(0, 'autoDeal', { paused: 'false' }), /格式/);
  f.cmd(0, 'autoDeal', { paused: true }); assert.equal(f.room.hand.status, 'playing'); f.finish();
  assert.equal(f.room.nextHandAt, null); assert.match(f.service.state(f.room, f.users[0].id).autoDeal.waitReason, /暂停/);
  f.advance(60000); assert.equal(f.service.tick(f.room), false);
  const commandId = randomUUID(); f.cmd(0, 'autoDeal', { paused: false, commandId }); const due = f.room.nextHandAt;
  f.advance(1000); f.cmd(0, 'autoDeal', { paused: false, commandId }); assert.equal(f.room.nextHandAt, due);
  f.cmd(0, 'show', { indices: [0] }); assert.equal(f.room.nextHandAt, due);
  f.advance(4000); assert.equal(f.service.tick(f.room), true); assert.equal(f.room.handNumber, 2);
});

test('not enough seated players cancels automatic dealing and reseating restarts its delay', t => {
  const f = fixture(t, {}, 2); f.cmd(0, 'start'); f.finish();
  f.cmd(1, 'stand'); assert.equal(f.room.nextHandAt, null); assert.match(f.room.autoWaitReason, /至少需要两位/);
  const saved = structuredClone(f.room); f.advance(10000);
  for (let i = 0; i < 20; i++) assert.equal(f.service.tick(f.room), false);
  assert.deepEqual(f.room, saved);
  f.cmd(1, 'sit', { seat: 1, amountBB: 100 }); assert.equal(f.room.nextHandAt, f.time + 5000);
  f.cmd(1, 'sitout', { value: true }); assert.equal(f.room.nextHandAt, null);
  f.cmd(1, 'sitout', { value: false }); assert.equal(f.room.nextHandAt, f.time + 5000);
});

test('all players offline waits, a spectator cannot trigger dealing, and reconnect has five seconds', t => {
  const f = fixture(t, {}, 2); f.cmd(0, 'start'); f.finish();
  f.connect(0, false); f.connect(1, false); assert.equal(f.room.nextHandAt, null); assert.match(f.room.autoWaitReason, /回到牌桌/);
  f.connect(3, true); f.advance(20000); assert.equal(f.service.tick(f.room), false);
  f.connect(1, true, true); assert.equal(f.room.nextHandAt, null); assert.match(f.room.autoWaitReason, /至少需要两位/);
  f.connect(0, true, true); assert.equal(f.room.nextHandAt, f.time + 5000);
  f.advance(4999); assert.equal(f.service.tick(f.room), false);
  f.advance(1); assert.equal(f.service.tick(f.room), true);
});

test('saved countdown survives restart without a new deck; overdue first reconnect resets the countdown', t => {
  const f = fixture(t, {}, 2); f.cmd(0, 'start'); f.finish();
  const persisted = structuredClone(f.store.data), savedRoom = persisted.rooms[f.room.code], deadline = savedRoom.nextHandAt;
  const recovered = new RoomService({ data: persisted });
  assert.deepEqual(persisted, f.store.data); assert.equal(recovered.connections.size, 0);
  f.advance(1000); for (const user of f.users.slice(0, 2)) recovered.connections.set(`${savedRoom.code}:${user.id}`, 1);
  assert.equal(recovered.connectionChanged(savedRoom, f.time, { reconnected: true }), false);
  assert.equal(savedRoom.nextHandAt, deadline);
  recovered.connections.clear(); f.advance(10000);
  // Simulate a restart whose first SSE reconnect arrives before the timer tick.
  for (const user of f.users.slice(0, 2)) recovered.connections.set(`${savedRoom.code}:${user.id}`, 1);
  assert.equal(recovered.connectionChanged(savedRoom, f.time, { reconnected: true }), true);
  assert.equal(savedRoom.nextHandAt, f.time + 5000); assert.equal(savedRoom.handNumber, 1);
  f.advance(5000); assert.equal(recovered.tick(savedRoom, f.time), true); assert.equal(savedRoom.handNumber, 2);
  assert.equal(recovered.tick(savedRoom, f.time), false); assert.equal(persisted.hands.length, 1);
});

test('an unfinished squid continues with two ready players and preserves the busted participant reserve', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start'); f.finish();
  assert.equal(f.room.mini.squid.active, true); const round = f.room.mini.squid.round, reserve = structuredClone(f.room.mini.squid.reserves);
  const busted = f.room.mini.squid.participants[0]; f.room.members[busted].stack = 0;
  f.advance(5000); f.service.tick(f.room); assert.equal(f.room.handNumber, 2);
  assert.equal(f.room.mini.squid.round, round); assert.deepEqual(f.room.mini.squid.reserves, reserve);
  assert.equal(f.room.hand.players.length, 2); assert.ok(!f.room.hand.players.some(p => p.id === busted));
  assert.throws(() => f.cmd(0, 'buyin', { amountBB: 20 }), /本手结束/);
  assert.equal(f.room.hand.players.length, 2, 'top-up cannot insert a player into a live hand');
  assert.equal(f.room.mini.squid.participants.includes(busted), true);
});

test('new squid waits for three players/reserves and the final five-minute cutoff lifts only the new-round requirement', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start'); f.finish();
  // A prior round completed, with two players deciding to remain for ordinary Holdem.
  f.room.mini.squid.active = false; f.room.mini.squid.reserves = {};
  f.cmd(2, 'stand'); assert.match(f.room.autoWaitReason, /至少需要三人/); assert.equal(f.room.nextHandAt, null);
  f.advance(f.room.endsAt - 300000 - f.time); assert.equal(f.service.tick(f.room), true);
  assert.equal(f.room.nextHandAt, f.time + 5000); f.advance(5000); f.service.tick(f.room);
  assert.equal(f.room.handNumber, 2); assert.equal(f.room.mini.squid.active, false);
});

test('expiry grants offline squid one bounded recovery window even when automatic dealing is paused', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start'); f.finish();
  f.cmd(0, 'autoDeal', { paused: true });
  for (const id of f.room.mini.squid.participants) f.service.connections.set(`${f.room.code}:${id}`, 0);
  f.service.connectionChanged(f.room, f.time);
  f.room.endsAt = f.time + 5000; f.advance(5000); assert.equal(f.service.tick(f.room), true);
  assert.equal(f.room.status, 'waiting'); assert.equal(f.room.handNumber, 1); assert.equal(f.room.nextHandAt, null);
  const deadline = f.service.state(f.room, f.users[0].id).mini.squid.expiryGraceEndsAt;
  assert.equal(deadline, f.time + 90000);
  f.advance(89999); f.service.tick(f.room); assert.equal(f.room.status, 'waiting');
  f.advance(1); f.service.tick(f.room);
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.handNumber, 1); assert.equal(f.room.nextHandAt, null);
  assert.deepEqual(f.room.mini.squid.reserves, {});
  assert.equal(Object.values(f.room.members).reduce((n, p) => n + p.stack + p.cashedOut, 0), 3000);
  const ledger = structuredClone(f.store.data.ledger); assert.equal(f.service.tick(f.room), false); assert.deepEqual(f.store.data.ledger, ledger);
});

test('blind-only or bomb all-ins run out before receiving the next-hand decision exactly once', t => {
  for (const settings of [{}, { bombPot: true, bombEveryHands: 1, bombAnteBB: 100 }]) {
    const f = fixture(t, settings, 2);
    if (!settings.bombPot) { f.room.members[f.users[0].id].stack = 5; f.room.members[f.users[1].id].stack = 3; }
    f.cmd(0, 'start'); assert.equal(f.room.hand.runout.active, true); assert.equal(f.store.data.hands.length, 0);
    while (f.room.hand.runout.active) { f.advance(f.room.hand.runout.nextAt - f.time); assert.equal(f.service.tick(f.room), true); }
    assert.equal(f.room.hand.status, 'complete'); assert.equal(f.store.data.hands.length, 1);
    assert.equal(f.store.data.ledger.filter(row => row.type === 'holdem').length, 2);
    assert.equal(f.room.nextHandAt !== null || f.room.autoWaitReason !== null, true);
    if (f.room.nextHandAt) assert.equal(f.room.nextHandAt, f.time + 5000);
  }
});

test('legacy completed rooms remain unchanged until the host resumes; active legacy rooms enter auto-deal on completion', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.finish();
  delete f.room.autoDealPaused; delete f.room.nextHandAt; delete f.room.autoWaitReason;
  const before = structuredClone(f.room); f.advance(20000);
  assert.equal(f.service.tick(f.room), false); assert.deepEqual(f.room, before);
  assert.equal(f.service.state(f.room, f.users[0].id).autoDeal.paused, true);
  f.cmd(0, 'start'); assert.equal(f.room.handNumber, 1); assert.equal(f.room.nextHandAt, f.time + 5000);
  f.advance(5000); f.service.tick(f.room); delete f.room.autoDealPaused; delete f.room.nextHandAt; delete f.room.autoWaitReason;
  f.finish(); assert.equal(f.room.autoDealPaused, false); assert.equal(f.room.nextHandAt, f.time + 5000);
});

test('authenticated room creation ignores an obsolete deployed room key while retaining invitations and one room per host', async t => {
  const previousKey = process.env.CREATE_ROOM_KEY; process.env.CREATE_ROOM_KEY = 'obsolete-test-value';
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-create-no-key-'));
  const app = createApp({ dataDir: dir, allowGuestSessions: true, actionTickMs: 1000000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); if (previousKey === undefined) delete process.env.CREATE_ROOM_KEY; else process.env.CREATE_ROOM_KEY = previousKey; });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, data, token) => { const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await api('/api/rooms', {})).status, 401);
  const host = (await api('/api/session', { name: '测试房主' })).body, outsider = (await api('/api/session', { name: '测试访客' })).body;
  assert.equal((await api('/api/me', undefined, host.token)).body.createKeyRequired, false);
  const created = await api('/api/rooms', { createKey: 'wrong-ignored' }, host.token); assert.equal(created.status, 201);
  assert.equal((await api(`/api/rooms/${created.body.room.code}`, undefined, outsider.token)).status, 403);
  assert.equal((await api('/api/rooms', {}, host.token)).status, 409);
  assert.equal((await api('/api/rooms', {}, outsider.token)).status, 201);
});

test('real server clock persists before SSE, retries a failed save without duplicate settlement, and reconnects safely after restart', async t => {
  let timestamp = 1800000000000; t.mock.method(Date, 'now', () => timestamp);
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-auto-sse-'));
  let app = createApp({ dataDir: dir, allowGuestSessions: true, actionTickMs: 20 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const controllers = [];
  t.after(async () => { for (const c of controllers) c.abort(); await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, data, token) => { const response = await fetch(base() + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body; };
  const users = [];
  for (const name of ['自动续局房主', '自动续局朋友']) users.push(await api('/api/session', { name }));
  const created = (await api('/api/rooms', {}, users[0].token)).room, code = created.code;
  await api(`/api/rooms/${code}/join`, { invite: created.invite }, users[1].token);
  const room = () => app.store.data.rooms[code];
  const command = (i, type, extra = {}) => api(`/api/rooms/${code}/action`, { type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra }, users[i].token);
  for (let i = 0; i < 2; i++) await command(i, 'sit', { seat: i, amountBB: 100 });
  async function stream(i = 0) {
    const controller = new AbortController(); controllers.push(controller);
    const res = await fetch(`${base()}/api/events?room=${code}`, { headers: { Authorization: `Bearer ${users[i].token}` }, signal: controller.signal });
    assert.equal(res.status, 200); const reader = res.body.getReader(); let buffer = '';
    return { controller, async until(predicate) {
      const deadline = setTimeout(() => controller.abort(), 3000);
      try {
        for (;;) {
          const split = buffer.indexOf('\n\n');
          if (split >= 0) { const event = buffer.slice(0, split); buffer = buffer.slice(split + 2); if (event.startsWith('data: ')) { const state = JSON.parse(event.slice(6)); if (predicate(state)) return state; } continue; }
          const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += new TextDecoder().decode(chunk.value);
        }
      } finally { clearTimeout(deadline); }
    } };
  }
  const firstStream = await stream(); await firstStream.until(s => s.hand === null);
  const friendStream = await stream(1); await friendStream.until(s => s.hand === null);
  await command(0, 'start'); await command(users.findIndex(u => u.user.id === room().hand.actingId), 'fold');
  await command(0, 'start'); // Explicit host resume skips rabbit; ordinary auto-deal countdown remains.
  const settled = await firstStream.until(s => s.hand?.status === 'complete'); assert.equal(settled.autoDeal.nextHandAt, timestamp + 5000);
  const saved = structuredClone(app.store.data), originalSave = app.store.save.bind(app.store);
  let observedFailure; const failed = new Promise(resolve => { observedFailure = resolve; });
  app.store.save = () => { observedFailure(); throw new Error('simulated automatic-deal disk failure'); };
  timestamp += 5000;
  let failedTimer;
  try { await Promise.race([failed, new Promise((_, reject) => { failedTimer = setTimeout(() => reject(new Error('automatic-deal save was never attempted')), 3000); })]); }
  finally { clearTimeout(failedTimer); }
  assert.deepEqual(app.store.data, saved); app.store.save = originalSave;
  const next = await firstStream.until(s => s.hand?.number === 2);
  assert.equal(next.hand.status, 'playing'); assert.equal(app.store.data.hands.length, 1);
  assert.equal(app.store.data.ledger.filter(row => row.type === 'holdem').length, 2);
  assert.equal(next.hand.deck, undefined); assert.equal(next.players.find(p => p.id === users[1].user.id).cards.filter(Boolean).length, 0);
  await command(users.findIndex(u => u.user.id === room().hand.actingId), 'fold');
  await firstStream.until(s => s.hand?.number === 2 && s.hand.status === 'complete');
  const beforeRestart = structuredClone(app.store.data); await app.close(); firstStream.controller.abort();
  timestamp += 10000;
  app = createApp({ dataDir: dir, allowGuestSessions: true, actionTickMs: 1000000 });
  assert.deepEqual(app.store.data.rooms, beforeRestart.rooms); assert.deepEqual(app.store.data.hands, beforeRestart.hands);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const resumed = await stream(); const resumedFriend = await stream(1); await resumedFriend.until(s => s.hand?.number === 2);
  const snapshot = await resumed.until(s => s.hand?.number === 2 && s.autoDeal.nextHandAt !== null);
  assert.equal(snapshot.hand.status, 'complete'); assert.equal(snapshot.autoDeal.nextHandAt, timestamp + 5000);
  assert.equal(app.store.data.hands.length, 2);
});
