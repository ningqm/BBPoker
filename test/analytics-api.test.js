import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { readyRoomAction } from './helpers/room-clock.js';

test('authenticated statistics share a settled cohort across rooms, dates, latest-hand caps and all-in side-pot expectations', async t => {
  const today = Date.parse('2026-10-13T10:00:00.000Z'), day = 86400000;
  let timestamp = today - 4 * day; t.mock.method(Date, 'now', () => timestamp);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-analytics-api-'));
  const app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 1000000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, token, data) => {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (path, token, data) => { const response = await request(path, token, data); assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response)); return response.body; };
  const users = [];
  for (const name of ['统计验收一', '统计验收二', '统计验收三', '统计观众', '统计外人']) users.push(await ok('/api/session', null, { name }));
  const me = users[0].user.id;
  const created = (await ok('/api/rooms', users[0].token, {})).room, code = created.code;
  for (let i = 1; i <= 3; i++) await ok(`/api/rooms/${code}/join`, users[i].token, { invite: created.invite });
  let roomCode = code;
  const room = () => app.store.data.rooms[roomCode];
  const ready=()=>{readyRoomAction(app.service,room(),value=>{timestamp=value;});app.store.save();};
  const command = (i, type, extra = {}) => ok(`/api/rooms/${roomCode}/action`, users[i].token, { type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra });
  for (let i = 0; i < 3; i++) await command(i, 'sit', { seat: i, amountBB: [100, 200, 400][i] });

  await t.test('self-only endpoint rejects anonymous and unrelated-room reads; userId cannot select another player', async () => {
    assert.equal((await request('/api/stats')).status, 401);
    assert.equal((await request(`/api/stats?room=${code}`, users[4].token)).status, 403);
    const own = await ok('/api/stats', users[0].token);
    assert.equal(own.hands, 0); assert.equal(own.net, 0); assert.equal(own.totalBuyIn, 1000);
    const outsider = await ok(`/api/stats?userId=${me}&playerId=${me}`, users[4].token);
    assert.equal(outsider.hands, 0); assert.equal(outsider.totalBuyIn, 0);
  });

  for (const member of Object.values(room().members).filter(m => m.seat !== null)) app.service.connections.set(`${roomCode}:${member.id}`, 1);
  await command(0, 'start');ready();
  while (room().hand.actingId) {
    const actor = users.findIndex(u => u.user.id === room().hand.actingId);
    const actions = app.service.state(room(), users[actor].user.id).actions;
    await command(actor, actions.canAllIn ? 'allin' : actions.canCheck ? 'check' : 'call');
  }
  const lock = structuredClone(room().hand.allInEquity);
  assert.equal(room().hand.allInLock.pots.length, 2);
  await t.test('pending all-in wagers and runout frames do not enter completed statistics early', async () => {
    for (const board of [0, 3, 4, 5]) {
      assert.equal(room().hand.board.length, board);
      const stats = await ok('/api/stats', users[0].token);
      assert.equal(stats.hands, 0); assert.equal(stats.net, 0); assert.equal(stats.allIn.count, 0); assert.equal(stats.allIn.expectedNet, null);
      assert.equal(app.store.data.hands.length, 0, 'public runout cards do not commit a completed statistics record');
      if (board < 5) {
        timestamp = room().hand.runout.nextAt;
        assert.equal(app.service.tick(room(), timestamp), true); app.store.save();
      }
    }
  });
  assert.equal(room().hand.transition?.kind,'showdown');
  assert.equal((await ok('/api/stats',users[0].token)).hands,0,'Final river reveal is not a completed result');
  ready();
  const oldHand = structuredClone(app.store.data.hands[0]);
  await t.test('settled actual and saved per-side-pot expected profit use the same players and cost basis', async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      const stats = await ok(`/api/stats?room=${code}`, users[i].token), player = oldHand.players.find(p => p.id === users[i].user.id);
      results.push(stats);
      assert.equal(stats.hands, 1); assert.equal(stats.allIn.count, 1); assert.equal(stats.allIn.eligibleCount, 1);
      assert.equal(stats.allIn.actualNet, player.stack - player.startingStack);
      assert.ok(Math.abs(stats.allIn.expectedNet - lock.players.find(p => p.id === player.id).expectedNet) <= 0.0051);
      assert.equal(stats.allIn.hands[0].id, oldHand.id);
      assert.deepEqual(stats.allIn.hands[0].board, []);
      const hands = await ok(`/api/hands?room=${code}`, users[i].token);
      assert.equal(stats.net, hands.totals.net); assert.equal(stats.hands, hands.totals.count);
      for (const key of ['allInLock', 'deck', 'cards', 'proofs', 'log', 'invite', 'token', 'passwordHash']) assert.equal(JSON.stringify(stats).includes(`"${key}":`), false, key);
    }
    assert.equal(results.reduce((sum, s) => sum + s.allIn.actualNet, 0), 0);
    assert.ok(Math.abs(results.reduce((sum, s) => sum + s.allIn.expectedNet, 0)) <= 0.02);
    const observed = await ok(`/api/stats?room=${code}`, users[3].token);
    assert.equal(observed.hands, 0); assert.equal(observed.allIn.count, 0);
    const forged = await ok(`/api/stats?userId=${me}`, users[4].token);
    assert.equal(forged.hands, 0); assert.equal(forged.allIn.count, 0);
  });

  await command(0, 'close'); timestamp = today;
  const fresh = (await ok('/api/rooms', users[0].token, {})).room; roomCode = fresh.code;
  await ok(`/api/rooms/${roomCode}/join`, users[1].token, { invite: fresh.invite });
  for (let i = 0; i < 2; i++) await command(i, 'sit', { seat: i, amountBB: 100 });
  for (const member of Object.values(room().members).filter(m => m.seat !== null)) app.service.connections.set(`${roomCode}:${member.id}`, 1);
  await command(0, 'start');ready(); await command(users.findIndex(u => u.user.id === room().hand.actingId), 'fold');ready();
  const latest = structuredClone(app.store.data.hands[1]);
  await t.test('periods, custom dates, room scope and latest-hand limits consistently filter profits and all-in coverage', async () => {
    const recent = latest.players.find(p => p.id === me), recentNet = recent.stack - recent.startingStack;
    for (const period of ['1', '3']) {
      const stats = await ok(`/api/stats?period=${period}`, users[0].token);
      assert.equal(stats.hands, 1); assert.equal(stats.net, recentNet); assert.equal(stats.allIn.count, 0);
    }
    for (const period of ['7', '30', 'all']) {
      const stats = await ok(`/api/stats?period=${period}`, users[0].token);
      assert.equal(stats.hands, 2); assert.equal(stats.allIn.count, 1);
    }
    const capped = await ok('/api/stats?period=7&maxHands=1', users[0].token);
    assert.equal(capped.hands, 1); assert.equal(capped.matchedHands, 2); assert.equal(capped.net, recentNet); assert.equal(capped.allIn.count, 0);
    const from = encodeURIComponent(oldHand.at), to = encodeURIComponent(oldHand.at);
    const exact = await ok(`/api/stats?from=${from}&to=${to}`, users[0].token);
    const hands = await ok(`/api/hands?from=${from}&to=${to}`, users[0].token);
    assert.equal(exact.hands, 1); assert.equal(exact.net, hands.totals.net); assert.equal(exact.allIn.count, 1);
    assert.deepEqual(exact.curve.map(p => p.handId), [oldHand.id]);
    const pastRoom = await ok(`/api/stats?room=${code}&maxHands=1`, users[0].token);
    assert.equal(pastRoom.hands, 1); assert.equal(pastRoom.allIn.count, 1); assert.equal(pastRoom.curve[0].handId, oldHand.id);
    const empty = await ok('/api/stats?from=2026-11-01&to=2026-11-02', users[0].token);
    assert.equal(empty.hands, 0); assert.equal(empty.allIn.expectedNet, null); assert.equal(empty.metrics.threeBet.percent, null);
  });

  await t.test('invalid filters return 400 without silently widening statistics', async () => {
    for (const query of ['from=2026-02-30', 'from=2026-10-14&to=2026-10-13', 'period=5', 'maxHands=0', 'maxHands=-1', 'maxHands=1.5', 'maxHands=100001', 'period=7&from=2026-10-01']) {
      assert.equal((await request(`/api/stats?${query}`, users[0].token)).status, 400, query);
    }
  });
});
