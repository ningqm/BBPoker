import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { verifyProof } from '../src/fairness.js';
import { verifyExport } from '../scripts/verify-export.mjs';
import { readyRoomAction } from './helpers/room-clock.js';

async function setup(t) {
  let timestamp=Date.now();t.mock.method(Date,'now',()=>timestamp);
  const setTime=value=>{timestamp=value;};
  const dir = mkdtempSync(join(tmpdir(), 'tongzhuo-test-'));
  let app = createApp({ dataDir: dir, allowGuestSessions: true, actionTickMs: 1000000 });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  async function api(user, path, data, expected = 200) {
    const res = await fetch(base() + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = (res.headers.get('content-type') || '').includes('application/json') ? await res.json() : await res.text();
    assert.equal(res.status, expected, JSON.stringify(value)); return value;
  }
  const users = [];
  for (const name of ['雨后','山川','南风','旁观']) users.push(await api(null, '/api/session', { name }, 201));
  const room = (await api(users[0], '/api/rooms', { name: '测试朋友局', settings: {} }, 201)).room;
  for (const u of users.slice(1)) await api(u, `/api/rooms/${room.code}/join`, { invite: room.invite });
  const ready=()=>{readyRoomAction(app.service,app.store.data.rooms[room.code],setTime);app.store.save();};
  const cmd = async (user, type, body = {}, expected = 200) => {
    const result=await api(user, `/api/rooms/${room.code}/action`, { type, commandId: randomUUID(), actionSeq: app.store.data.rooms[room.code].hand?.log.length, ...body }, expected);
    if(type==='start'&&expected===200)ready();
    return result;
  };
  const state = user => api(user, `/api/rooms/${room.code}`);
  async function seat(count = 3, amount = 1000) {
    for (let seat = 0; seat < count; seat++) {
      const { room: s } = await cmd(users[seat], 'sit', { seat, amount });
      const pending = s.pending.find(p => p.playerId === users[seat].user.id);
      if (pending) await cmd(users[0], 'approve', { requestId: pending.id });
      app.service.connections.set(`${room.code}:${users[seat].user.id}`, 1);
    }
  }
  async function win(targetId) {
    let s = await state(users[0]), safety = 0;
    while (s.hand.status === 'playing') {
      assert.ok(++safety < 60);
      ready();s=await state(users[0]);if(s.hand.status!=='playing')break;
      const actor = users.find(u => u.user.id === s.hand.actingId);
      const self = await state(actor);
      const type = actor.user.id === targetId ? self.actions.canCheck ? 'check' : 'call' : 'fold';
      s = (await cmd(actor, type, { handId: s.hand.id })).room;
    }
    return s;
  }
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  return { api, users, room, cmd, state, seat, win, dir, base, get app() { return app; }, async restart() { await app.close(); app = createApp({ dataDir: dir, allowGuestSessions: true, actionTickMs: 1000000 }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); } };
}

test('invite, instant seating, game, selective proofs, voluntary show and all export formats work end to end', async t => {
  const f = await setup(t); await f.seat();
  const host = f.users[0], observer = f.users[3];
  const start = (await f.cmd(host, 'start')).room;
  assert.equal(start.hand.status, 'playing');
  const internal = f.app.store.data.rooms[f.room.code].hand;
  for (const u of f.users) {
    const state = await f.state(u);
    for (const p of state.players.filter(p => p.inHand)) assert.equal(p.cards.filter(Boolean).length, p.id === u.user.id ? 2 : 0);
    for (const proof of state.hand.proofs) assert.ok(verifyProof(state.hand.id, state.hand.commitment, proof));
    assert.equal(state.hand.proofs.length, u === observer ? 0 : 2);
    assert.equal(state.hand.deck, undefined); assert.equal(state.hand.audit, undefined);
  }
  const winner = f.users[1]; await f.win(winner.user.id);
  const history = await f.api(observer, `/api/rooms/${f.room.code}/hands/${internal.id}`);
  for (const p of history.players) assert.deepEqual(p.cards, [null, null]);
  assert.deepEqual(history.result.handNames, {});
  await f.cmd(winner, 'show', { handId: internal.id, indices: [0] });
  const shown = await f.api(observer, `/api/rooms/${f.room.code}/hands/${internal.id}`);
  assert.equal(shown.players.find(p => p.id === winner.user.id).cards.filter(Boolean).length, 1);
  assert.equal(shown.proofs.length, 1); assert.ok(verifyProof(shown.id, shown.commitment, shown.proofs[0]));
  const exp = await f.api(host, `/api/export?room=${f.room.code}&format=json`);
  assert.equal(exp.hands.length, 1);
  assert.equal(exp.app, 'BBPoker');
  assert.equal(verifyExport(exp).hands, 1);
  for (const p of exp.hands[0].players) if (p.id !== host.user.id && p.id !== winner.user.id) assert.deepEqual(p.cards, [null, null]);
  assert.ok((await f.api(host, `/api/export?room=${f.room.code}&format=txt`)).includes('Privacy:'));
  assert.ok((await f.api(host, `/api/export?room=${f.room.code}&format=csv`)).includes('小游戏盈亏'));
  const phh = await f.api(host, `/api/export?room=${f.room.code}&format=phh`);
  assert.match(phh, /variant = "NT"/); assert.match(phh, /\?\?/);
  // Inspect actual PHH card-bearing actions: UUIDs or commitment hashes can
  // coincidentally contain two-character card codes such as 8c.
  const exportedCards = new Set([...phh.matchAll(/^  "(?:d dh p\d+|d db|p\d+ sm) ([^"]+)",?$/gm)]
    .flatMap(match => match[1].match(/[2-9TJQKA][cdhs]/g) || []));
  assert.ok(exportedCards.size >= 2);
  for (const p of internal.players) if (p.id !== host.user.id) {
    for (let i = 0; i < 2; i++) if (p.id !== winner.user.id || i !== 0) assert.ok(!exportedCards.has(p.cards[i]), 'PHH actions must never contain another player hidden card');
  }
  assert.equal((await f.api(observer, `/api/export?room=${f.room.code}&format=json`)).hands.length, 0);
  const total = (await f.state(host)).players.reduce((n, p) => n + p.stack, 0); assert.equal(total, 3000);
  const stats = await f.api(host, '/api/stats'); assert.equal(stats.hands, 1); assert.equal(stats.totalBuyIn, 1000);
});

test('illegal actions, duplicate commands and unauthorized users cannot mutate points', async t => {
  const f = await setup(t); await f.seat(2);
  const outsider = await f.api(null, '/api/session', { name: '陌生人' }, 201);
  await f.api(outsider, `/api/rooms/${f.room.code}`, undefined, 403);
  await f.api(outsider, `/api/rooms/${f.room.code}/join`, { invite: 'wrong' }, 403);
  await f.api(outsider, `/api/export?room=${f.room.code}`, undefined, 403);
  await f.cmd(f.users[1], 'close', {}, 403);
  const commandId = randomUUID();
  const before = (await f.state(f.users[0])).players.find(p => p.id === f.users[0].user.id).stack;
  await f.api(f.users[0], `/api/rooms/${f.room.code}/action`, { type: 'buyin', amount: 1000, commandId });
  await f.api(f.users[0], `/api/rooms/${f.room.code}/action`, { type: 'buyin', amount: 1000, commandId });
  assert.equal((await f.state(f.users[0])).players.find(p => p.id === f.users[0].user.id).stack, before + 1000);
  await f.cmd(f.users[0], 'start');
  const snapshot = structuredClone(f.app.store.data);
  const current = await f.state(f.users[0]), actor = f.users.find(u => u.user.id === current.hand.actingId);
  await f.cmd(actor, 'raise', { handId: current.hand.id, amount: -100 }, 400);
  assert.deepEqual(f.app.store.data, snapshot);
  await f.cmd(actor, 'fold', { handId: 'stale-hand' }, 409);
});

test('squid conserves points, legacy mushroom pool refunds remain included on close', async t => {
  const f = await setup(t); await f.seat(3);
  await f.cmd(f.users[0], 'settings', { settings: { squid: true, squidUnitBB: 2 } });
  await f.cmd(f.users[0], 'start');
  // Simulate a persisted old-version hand: only legacy histories/pools retain
  // mushroom bookkeeping, while no subsequent new hand charges mushroom fees.
  const legacy = f.app.store.data.rooms[f.room.code], h = legacy.hand, pool = legacy.mini.mushroom;
  h.settings.mushroom = true; pool.smallBlindId = h.players.find(p => p.seat === h.smallBlindSeat).id;
  for (const p of h.players) {
    const amount = pool.unit * (p.id === pool.smallBlindId ? 2 : 1);
    p.startingStack -= amount; p.stack -= amount; legacy.members[p.id].stack -= amount;
    h.miniChanges[p.id] -= amount; pool.pool += amount; pool.contributions[p.id] = amount;
  }
  h.miniBefore = structuredClone(legacy.mini); f.app.store.save();
  let s = await f.state(f.users[0]);
  const account = st => st.players.reduce((n, p) => n + p.stack + p.squidReserve, 0) + st.mini.mushroom.pool + (st.hand?.status === 'playing' ? st.hand.pot : 0);
  assert.equal(account(s), 3000); assert.equal(s.mini.mushroom.pool, 20);
  await f.cmd(f.users[0], 'stand', {}, 409);
  s = await f.win(f.users[0].user.id); assert.equal(account(s), 3000); assert.ok(s.mini.squid.active);
  // The auto-deal timer is covered independently; advance this settlement fixture to its next hand.
  f.app.service.start(f.app.store.data.rooms[f.room.code]); f.app.store.save();
  s = await f.win(f.users[1].user.id);
  assert.equal(account(s), 3000); assert.equal(s.mini.squid.active, false);
  assert.equal(s.mini.squid.lastResult.loserId, f.users[2].user.id);
  assert.equal(s.mini.squid.lastResult.amount, 40);
  const closed = (await f.cmd(f.users[0], 'close')).room; assert.equal(closed.status, 'closed');
  const internal = f.app.store.data.rooms[f.room.code];
  assert.equal(Object.values(internal.members).reduce((n, m) => n + m.cashedOut, 0), 3000);
  const allStats = await Promise.all(f.users.slice(0,3).map(u => f.api(u, '/api/stats')));
  assert.equal(allStats.reduce((n, s) => n + s.net, 0), 0);
  for (const stat of allStats) assert.equal(stat.curve.at(-1).net, stat.net);
});

test('encrypted save, identity restore and process restart keep the exact active hand', async t => {
  const f = await setup(t); await f.seat(2); await f.cmd(f.users[0], 'start');
  const before = structuredClone(f.app.store.data.rooms[f.room.code].hand);
  const saved = readFileSync(join(f.dir, 'table.enc'));
  assert.equal(saved.subarray(0,4).toString(), 'TZ01'); assert.ok(!saved.includes(Buffer.from('雨后'))); assert.ok(!saved.includes(Buffer.from('"cards"')));
  assert.equal(statSync(join(f.dir, 'key')).mode & 0o777, 0o600);
  await f.restart();
  const after = f.app.store.data.rooms[f.room.code].hand;
  assert.deepEqual(after.deck, before.deck); assert.equal(after.audit.root, before.audit.root); assert.equal(after.id, before.id);
  assert.deepEqual(after.players, before.players);
  assert.equal((await f.api(null, '/api/session/restore', { token: f.users[0].token })).user.id, f.users[0].user.id);
  await f.win(f.users[0].user.id);
});

test('real SSE streams send each player only their own cards and reconnect snapshot', async t => {
  const f = await setup(t); await f.seat(2); await f.cmd(f.users[0], 'start');
  for (const u of [f.users[0],f.users[1],f.users[3]]) {
    const controller = new AbortController();
    const res = await fetch(`${f.base()}/api/events?room=${f.room.code}`, { headers: { Authorization: `Bearer ${u.token}` }, signal: controller.signal });
    const reader = res.body.getReader(); const chunk = new TextDecoder().decode((await reader.read()).value);
    const state = JSON.parse(chunk.split('data: ')[1].split('\n\n')[0]);
    assert.equal(state.meId, u.user.id);
    for (const p of state.players.filter(p => p.inHand)) assert.equal(p.cards.filter(Boolean).length, p.id === u.user.id ? 2 : 0);
    controller.abort(); await reader.cancel().catch(() => {});
  }
});
