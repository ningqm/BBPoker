import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { createHand, applyAction, availableActions } from '../src/poker.js';

test('direct opponent API isolates identities, conserves real multiway results and dates fish by settlement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-direct-api-'));
  const app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 1000000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, user, body, status = 200) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  const people = [];
  for (const name of ['自己', '小雨', '阿海', '旁观者', '未加入的人']) people.push(await request('/api/session', null, { name }, 201));
  const [hero, a, b, observer, outsider] = people, ids = [hero, a, b].map(u => u.user.id);
  const room = (await request('/api/rooms', hero, {}, 201)).room;
  for (const user of [a, b, observer]) await request(`/api/rooms/${room.code}/join`, user, { invite: room.invite });
  const hand = createHand({ id: 'direct-real-hand', players: ids.map((id, seat) => ({ id, seat, stack: 1000 })), buttonSeat: 0, smallBlind: 5, bigBlind: 10 });
  while (hand.status === 'playing') {
    const action = availableActions(hand, hand.actingId);
    applyAction(hand, hand.actingId, hand.street === 'preflop' ? action.canCheck ? 'check' : 'call' : hand.actingId === ids[0] ? 'check' : 'fold');
  }
  Object.assign(hand, { at: '2026-10-13T08:00:00.000Z', roomCode: room.code, roomName: room.name, settings: { bigBlind: 10 },
    miniChanges: {}, miniBefore: { squid: { round: 1, active: true, participants: ids, unit: 20, mode: 'normal', won: [] } },
    miniAfter: { squid: { round: 1, active: true, participants: ids, unit: 20, mode: 'normal', won: [ids[0]] } } });
  app.store.data.hands.push(hand);
  for (const [index, playerId] of ids.entries()) app.store.data.ledger.push({ type: 'squidSettlement', id: `round-${index}`, roundSettlementId: 'round-1',
    roomCode: room.code, round: 1, playerId, at: '2026-10-14T08:00:00.000Z', amount: index === 2 ? -40 : 20,
    squidMode: 'normal', squidCount: index === 2 ? 0 : 1, tokensAwarded: 2, tokenBudget: 2, bigBlind: 10 });
  // Final counts above deliberately differ from the last archived hand: a
  // between-hand settlement may include a formerly disconnected fish holder.
  await t.test('only participants can access their own direct aggregates and explicit room access is guarded', async () => {
    await request('/api/opponents', null, null, 401);
    await request(`/api/opponents?room=${room.code}`, outsider, null, 403);
    assert.deepEqual((await request('/api/opponents', observer)).opponents.rows, []);
    assert.deepEqual((await request('/api/opponents', outsider)).opponents.rows, []);
    for (const query of [`userId=${ids[0]}`, 'position=BTN', 'type=bomb', `opponent=${ids[0]}`]) await request(`/api/opponents?${query}`, hero, null, 400);
  });
  await t.test('a three-way ten-point pot counts each loser ten, never the hero twenty against both', async () => {
    const result = (await request('/api/opponents?from=2026-10-13&to=2026-10-13', hero)).opponents;
    assert.equal(result.summary.holdem.net, 20);
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows.map(row => row.holdem.net), [10, 10]);
    assert.equal(result.summary.squid.events, 0);
    assert.equal(result.rows.reduce((sum, row) => sum + row.total.net, 0), result.summary.total.net);
  });
  await t.test('fish-only day is independent of final-hand players and does not invent poker hands', async () => {
    const result = (await request('/api/opponents?from=2026-10-14&to=2026-10-14', hero)).opponents;
    assert.equal(result.summary.hands, 0);
    assert.equal(result.summary.squid.net, 20);
    assert.equal(result.rows.find(row => row.id === ids[1]).total.net, 0);
    assert.equal(result.rows.find(row => row.id === ids[2]).squid.net, 20);
    const inverse = (await request(`/api/opponents?opponent=${ids[0]}`, b)).opponents;
    assert.equal(inverse.summary.total.net, -30);
    assert.equal(inverse.rows.length, 1);
  });
  await t.test('renamed profiles are stable; cards and account secrets never appear; missing evidence is unavailable', async () => {
    const internal = Object.values(app.store.data.users).find(u => u.id === ids[1]); internal.name = '新昵称'; internal.passwordHash = 'PRIVATE';
    const body = await request('/api/opponents', hero), text = JSON.stringify(body);
    assert.equal(body.opponentOptions.find(row => row.id === ids[1]).name, '新昵称');
    for (const key of ['cards', 'deck', 'audit', 'invite', 'passwordHash', 'PRIVATE', 'token', 'recoveryHash']) assert.equal(text.includes(`"${key}"`), false);
    delete hand.result.pots;
    const incomplete = (await request('/api/opponents', hero)).opponents;
    assert.equal(incomplete.summary.total.net, null);
    assert.equal(incomplete.summary.holdem.unknownEvents, 1);
    assert.equal(incomplete.summary.squid.net, 20);
  });
});
