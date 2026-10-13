import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { EncryptedStore } from '../src/store.js';
import { verifyProof } from '../src/fairness.js';
import { calculateEquity } from '../src/equity.js';
import { replaySnapshot } from '../public/replay.js';
import { exportPhh } from '../src/phh.js';
import { createApp } from '../server.js';

function fixture(t, count = 3, store = { data: { version: 1, users: {}, rooms: {}, hands: [], ledger: [] } }) {
  let timestamp = 1800000000000;
  t.mock.method(Date, 'now', () => timestamp);
  const users = Array.from({ length: count + 1 }, (_, i) => ({ id: `runout-friend-${i}`, name: `跑牌朋友${i}`, avatar: i }));
  for (const user of users) store.data.users[user.id] = user;
  const service = new RoomService(store), room = service.create(users[0], {});
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) { cmd(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  const act = type => cmd(users.findIndex(u => u.id === room.hand.actingId), type);
  const advance = ms => { timestamp += ms; };
  const nextCard = () => { timestamp = room.hand.runout.nextAt; assert.equal(service.tick(room), true); };
  const finish = () => { for (let i = 0; room.hand.runout?.active; i++) { assert.ok(i < 5); nextCard(); } };
  return { users, store, service, room, cmd, act, advance, nextCard, finish, get time() { return timestamp; } };
}

function assertPrivateState(f, state, viewerId) {
  const h = f.room.hand;
  for (const key of ['deck', 'deckCursor', 'audit', 'allInLock', 'allInEquity', 'equityFrames', 'burnIndices']) assert.equal(Object.hasOwn(state.hand, key), false, key);
  const allowed = [...h.boardIndices];
  for (const p of h.players) for (const [i, position] of p.cardIndices.entries()) if (p.id === viewerId || h.shown[p.id]?.includes(i)) allowed.push(position);
  assert.deepEqual(state.hand.proofs.map(p => p.position).sort((a, b) => a - b), allowed.sort((a, b) => a - b));
  assert.ok(state.hand.proofs.every(p => verifyProof(h.id, h.audit.root, p)));
  for (const p of h.players) if (p.id !== viewerId && !h.shown[p.id]?.length) assert.deepEqual(state.players.find(u => u.id === p.id).cards, [null, null]);
  assert.deepEqual(state.hand.board, h.board);
  if (state.hand.equity) assert.deepEqual(state.hand.equity.board, h.board);
}

test('room only exposes all-in contenders once betting closes; folded cards and future proofs stay private on every reveal', t => {
  const f = fixture(t, 4); f.cmd(0, 'start');
  const folder = f.room.hand.actingId; f.act('fold');
  f.act('allin');
  assert.equal(f.room.hand.allInLock, null);
  let state = f.service.state(f.room, f.users[4].id);
  assert.equal(state.hand.equity, null); assertPrivateState(f, state, f.users[4].id);
  f.act('call');
  assert.equal(f.room.hand.allInLock, null, 'last opponent still has a choice');
  f.act('call');
  const h = f.room.hand, anchor = structuredClone(h.allInLock), root = h.audit.root;
  assert.equal(h.actingId, null); assert.equal(f.room.deadline, null); assert.equal(h.runout.nextAt, f.time + 1800);
  assert.equal(h.equityFrames.length, 1); assert.deepEqual(h.allInEquity, calculateEquity(anchor));
  assert.equal(h.allInLock.players.some(p => p.id === folder), false);
  for (let boardCount = 0; boardCount <= 5; boardCount++) {
    if (boardCount) f.nextCard();
    state = f.service.state(f.room, f.users[4].id);
    assert.equal(state.hand.board.length, boardCount);
    assertPrivateState(f, state, f.users[4].id);
    assert.deepEqual(state.players.find(p => p.id === folder).cards, [null, null]);
    assert.equal(state.players.filter(p => p.cards.length === 2 && p.cards.every(Boolean)).length, 3);
    assert.equal(h.equityFrames.length, boardCount + 1); assert.equal(h.audit.root, root); assert.deepEqual(h.allInLock, anchor);
    assert.deepEqual(state.hand.equity, calculateEquity({ ...anchor, board: h.board }));
    if (boardCount < 5) { assert.equal(f.store.data.hands.length, 0); assert.equal(state.actions.canAct, false); }
  }
  assert.equal(f.store.data.hands.length, 1); assert.equal(f.store.data.ledger.filter(l => l.type === 'holdem').length, 4);
  assert.equal(f.room.nextHandAt, f.time + 5000);
  assert.equal(f.service.tick(f.room), false);
  assert.deepEqual(f.store.data.hands[0].allInEquity, calculateEquity(anchor));
});

test('runout clocks wait for each deadline, ignore action/time-card attempts, and survive table expiry until settlement', t => {
  const f = fixture(t, 2); f.cmd(0, 'start'); f.act('allin'); f.act('call');
  const frozen = structuredClone(f.room.hand), clock = f.room.hand.runout.nextAt;
  for (const type of ['call', 'allin', 'check', 'fold', 'timebank']) assert.throws(() => f.cmd(0, type));
  assert.deepEqual(f.room.hand, frozen);
  f.advance(1799); assert.equal(f.service.tick(f.room), false); assert.equal(f.room.hand.board.length, 0);
  f.advance(1); assert.equal(f.service.tick(f.room), true); assert.equal(f.room.hand.board.length, 1);
  assert.equal(f.room.hand.runout.nextAt, clock + 1500);
  f.room.endsAt = f.time;
  f.advance(1499); assert.equal(f.service.tick(f.room), false); assert.equal(f.room.status, 'playing');
  f.finish();
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.deadline, null); assert.equal(f.room.nextHandAt, null);
  assert.equal(f.store.data.hands.length, 1);
  assert.equal(Object.values(f.room.members).reduce((sum, p) => sum + p.cashedOut, 0), 2000);
});

test('history and replay preserve each public equity frame and lock timing without exposing folded cards', t => {
  const f = fixture(t, 3); f.cmd(0, 'start'); const folder = f.room.hand.actingId; f.act('fold'); f.act('allin'); f.act('call'); f.finish();
  const h = f.room.hand, viewerId = f.users[3].id, history = f.service.handFor(viewerId, f.room.code, h.id);
  assert.deepEqual(history.allIn, { logSeq: h.allInLock.logSeq, playerIds: h.allInLock.players.map(p => p.id) });
  for (const key of ['allInLock', 'deck', 'audit', 'burnIndices']) assert.equal(Object.hasOwn(history, key), false);
  assert.deepEqual(history.players.find(p => p.id === folder).cards, [null, null]);
  const before = replaySnapshot(history, history.allIn.logSeq - 1, viewerId);
  assert.equal(before.equity, null); assert.ok(before.players.every(p => p.cards.every(c => c === null)));
  for (const frame of history.equityFrames) {
    const replay = replaySnapshot(history, frame.logSeq, viewerId);
    assert.deepEqual(replay.board, frame.board); assert.deepEqual(replay.equity, frame.equity);
    if (frame.boardCount > 0) assert.ok(replay.players.every(p => p.bet === 0), 'preflop wagers are collected before the first visible flop card');
    assert.deepEqual(replay.players.find(p => p.id === folder).cards, [null, null]);
    assert.equal(replay.players.filter(p => p.cards.every(Boolean)).length, 2);
  }
  const phh = exportPhh([history]);
  assert.equal((phh.match(/d db /g) ?? []).length, 3, 'partial flop reveals must not break the PHH three-street sequence');
  const final = replaySnapshot(history, history.log.length, viewerId);
  assert.equal(final.pot, 0); assert.deepEqual(final.players.map(p => p.stack), h.players.map(p => p.stack));
});

test('river all-in shows exact final equity but is excluded from runout-luck samples; ordinary check-down has no all-in badge', t => {
  const f = fixture(t, 2); f.cmd(0, 'start');
  const checkOrCall = () => {
    const a = f.service.state(f.room, f.room.hand.actingId).actions;
    f.act(a.canCheck ? 'check' : 'call');
  };
  while (f.room.hand.street !== 'river') checkOrCall();
  f.act('allin'); f.act('call');
  const h = f.room.hand, state = f.service.state(f.room, f.users[2].id);
  assert.equal(h.status, 'complete'); assert.equal(state.hand.runout, null);
  assert.equal(state.hand.equity.method, 'exact'); assert.equal(state.hand.equity.samples, 1);
  assert.deepEqual(state.hand.equity.board, h.board);
  for (const p of state.hand.equity.players) {
    assert.equal(p.expectedPayout, h.result.payouts[p.id]);
    assert.equal(f.service.stats(p.id).allIn.eligibleCount, 0);
    assert.equal(f.service.stats(p.id).allIn.count, 0);
  }
  f.cmd(0, 'close');
  const next = f.service.create(f.users[0], {});
  f.service.join(f.users[1], next.code, next.invite);
  const cmd = (i, type, extra = {}) => f.service.command(f.users[i], next.code, { type, commandId: randomUUID(), handId: next.hand?.id, actionSeq: next.hand?.log.length, ...extra });
  for (let i = 0; i < 2; i++) cmd(i, 'sit', { seat: i, amountBB: 100 });
  for (const user of f.users.slice(0, 2)) f.service.connections.set(`${next.code}:${user.id}`, 1);
  cmd(0, 'start');
  while (next.hand.status === 'playing') {
    const actor = f.users.findIndex(u => u.id === next.hand.actingId), actions = f.service.state(next, next.hand.actingId).actions;
    cmd(actor, actions.canCheck ? 'check' : 'call');
  }
  assert.equal(next.hand.allInLock, null); assert.equal(f.service.state(next, f.users[0].id).hand.equity, null);
});

test('encrypted partial-runout restart preserves deck, commitment, equity anchor and timing without inventing an action deadline', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-runout-restart-'));
  const store = new EncryptedStore(dir), f = fixture(t, 2, store);
  f.cmd(0, 'start'); f.act('allin'); f.act('call'); f.nextCard(); store.save();
  const saved = structuredClone(store.data), raw = readFileSync(store.file);
  assert.equal(raw.includes(Buffer.from(JSON.stringify(f.room.hand.deck))), false);
  const recovered = new EncryptedStore(dir);
  assert.deepEqual(recovered.data, saved);
  const app = createApp({ dataDir: dir, actionTickMs: 1000000 });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const room = app.store.data.rooms[f.room.code];
  assert.equal(room.deadline, null); assert.deepEqual(room.hand, saved.rooms[f.room.code].hand);
  assert.equal(app.service.tick(room, room.hand.runout.nextAt - 1), false);
  while (room.hand.runout?.active) assert.equal(app.service.tick(room, room.hand.runout.nextAt), true);
  f.finish();
  assert.deepEqual(room.hand.board, f.room.hand.board); assert.deepEqual(room.hand.result, f.room.hand.result);
  assert.deepEqual(room.hand.allInEquity, f.room.hand.allInEquity); assert.deepEqual(room.hand.equityFrames, f.room.hand.equityFrames);
  assert.equal(room.hand.audit.root, f.room.hand.audit.root); assert.equal(app.store.data.hands.length, 1);
});

test('server persists each runout card before SSE, rolls back failed saves, and resumes without duplicate cards or settlement', async t => {
  let timestamp = 1800000000000; t.mock.method(Date, 'now', () => timestamp);
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-runout-sse-'));
  const app = createApp({ dataDir: dir, allowGuestSessions: true, actionTickMs: 20 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, data, token) => {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body;
  };
  const users = [];
  for (const name of ['跑牌验收一', '跑牌验收二']) users.push(await api('/api/session', { name }));
  const created = (await api('/api/rooms', {}, users[0].token)).room, code = created.code;
  await api(`/api/rooms/${code}/join`, { invite: created.invite }, users[1].token);
  const room = () => app.store.data.rooms[code];
  const command = (i, type, extra = {}) => api(`/api/rooms/${code}/action`, { type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra }, users[i].token);
  for (let i = 0; i < 2; i++) await command(i, 'sit', { seat: i, amountBB: 100 });
  const response = await fetch(`${base}/api/events?room=${code}`, { headers: { Authorization: `Bearer ${users[0].token}` }, signal: controller.signal });
  assert.equal(response.status, 200); const reader = response.body.getReader(); let buffer = '';
  const until = async predicate => {
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split >= 0) {
          const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          if (event.startsWith('data: ')) {
            const state = JSON.parse(event.slice(6));
            if (state.hand) assert.ok(state.hand.board.length <= app.store.read().rooms[code].hand.board.length, 'SSE cannot reveal an uncommitted card');
            if (predicate(state)) return state;
          }
          continue;
        }
        const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += new TextDecoder().decode(chunk.value);
      }
    } finally { clearTimeout(timeout); }
  };
  await until(s => s.hand === null);
  app.service.connections.set(`${code}:${users[1].user.id}`, 1);
  await command(0, 'start'); await command(users.findIndex(u => u.user.id === room().hand.actingId), 'allin'); await command(users.findIndex(u => u.user.id === room().hand.actingId), 'call');
  const locked = await until(s => s.hand?.runout?.active);
  assert.equal(locked.hand.board.length, 0);
  const saved = structuredClone(app.store.data), originalSave = app.store.save.bind(app.store);
  let observed; const failed = new Promise(resolve => { observed = resolve; });
  app.store.save = () => { observed(); throw new Error('simulated runout persistence failure'); };
  timestamp = room().hand.runout.nextAt;
  await Promise.race([failed, new Promise((_, reject) => setTimeout(() => reject(new Error('runout save attempt missing')), 3000))]);
  assert.deepEqual(app.store.data, saved); assert.deepEqual(app.store.read(), saved);
  app.store.save = originalSave;
  const first = await until(s => s.hand?.board.length === 1);
  assert.equal(first.hand.equity.board.length, 1); assert.equal(room().hand.equityFrames.length, 2);
  for (let count = 2; count <= 5; count++) {
    timestamp = room().hand.runout.nextAt;
    const state = await until(s => s.hand?.board.length === count);
    assert.equal(state.hand.equity.board.length, count);
    assert.equal(room().hand.equityFrames.length, count + 1);
  }
  assert.equal(app.store.data.hands.length, 1); assert.equal(app.store.data.ledger.filter(row => row.type === 'holdem').length, 2);
  assert.deepEqual(app.store.read(), app.store.data);
});
