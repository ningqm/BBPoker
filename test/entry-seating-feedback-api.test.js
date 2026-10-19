import { seedLegacyAccount } from './helpers/accounts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

for (const mode of ['holdem', 'normal', 'unlimited']) test(`HTTP nine-seat ${mode} + bomb: accepted seating and entry choices are immediately observable and persist atomically`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-entry-seat-api-'));
  const app = createApp({ dataDir: directory, actionTickMs: 1000000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, user, body, expected = 200) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const users = [];
  for (let i = 0; i < 9; i++) users.push(seedLegacyAccount(app, { name: `Seat API ${i}` }));
  const created = (await api('/api/rooms', users[0], { settings: { maxPlayers: 9, squid: mode !== 'holdem', squidMode: mode === 'unlimited' ? 'unlimited' : 'normal', bombPot: true } }, 201)).room;
  const code = created.code, room = () => app.store.data.rooms[code];
  const command = (i, type, body = {}, status = 200) => api(`/api/rooms/${code}/action`, users[i], { commandId: randomUUID(), type, ...body }, status);
  for (let i = 0; i < 9; i++) {
    if (i) await api(`/api/rooms/${code}/join`, users[i], { invite: created.invite });
    app.service.connections.set(`${code}:${users[i].user.id}`, 1);
  }
  for (const i of [0, 2, 4, 6, 8]) await command(i, 'sit', { seat: i, amountBB: 200 });
  await command(0, 'start'); await command(0, 'autoDeal', { paused: true });
  const hand = structuredClone(room().hand), mini = structuredClone(room().mini), beforeFailure = structuredClone(app.store.data), save = app.store.save;
  const failedCommandId = randomUUID();
  app.store.save = () => { throw new Error('synthetic initial buy-in disk failure'); };
  const error = await command(3, 'sit', { seat: 3, amountBB: 200, entryMode: 'post', commandId: failedCommandId }, 400);
  assert.equal(error.error, 'synthetic initial buy-in disk failure'); app.store.save = save;
  assert.deepEqual(app.store.data, beforeFailure, 'a rejected persistence transaction must not leave a funded but invisible seat');
  const seated = await Promise.all([1, 3, 5, 7].map(async i => {
    const data = { seat: i, amountBB: 200, entryMode: i === 3 ? 'post' : 'wait', commandId: i === 3 ? failedCommandId : randomUUID() };
    const responses = await Promise.all([command(i, 'sit', data), command(i, 'sit', data)]);
    for (const response of responses) {
      const me = response.room.players.find(player => player.id === users[i].user.id);
      assert.equal(me.seat, i); assert.equal(me.stack, 2000); assert.equal(me.inHand, false);
      assert.equal(me.entryBlind.mode, data.entryMode);
      assert.equal(me.cards.length, 0, 'a newly seated spectator must not receive undealt cards');
    }
    return users[i].user.id;
  }));
  const view = await api(`/api/rooms/${code}`, users[0]);
  assert.equal(view.players.filter(player => player.seat !== null).length, 9);
  for (const id of seated) assert.equal(app.store.data.ledger.filter(row => row.playerId === id && row.type === 'buyin').length, 1);
  assert.deepEqual(room().hand, hand); assert.deepEqual(room().mini, mini);
  for (const mode of ['wait', 'post', 'wait', 'post']) {
    const response = await command(3, 'entryBlind', { mode });
    const me = response.room.players.find(player => player.id === users[3].user.id);
    assert.equal(me.entryBlind.mode, mode); assert.equal(me.entryBlind.waitingFor, mode === 'post' ? 'button' : 'bigBlind');
    assert.equal(me.stack, 2000); assert.equal(me.seat, 3);
    const persisted = app.store.read().rooms[code].members[me.id];
    assert.equal(persisted.blindEntry.mode, mode); assert.equal(persisted.stack, 2000);
  }
  const response = await command(5, 'entryBlind', { mode: 'post' });
  const me = response.room.players.find(player => player.id === users[5].user.id);
  assert.equal(me.entryBlind.naturalBigBlind, true); assert.equal(me.entryBlind.nextHandEligible, true);
  // Changing a preference cannot retrospectively remove a currently dealt SB/BB.
  const beforeInHandChange = structuredClone(app.store.data);
  const rejected = await command(4, 'entryBlind', { mode: 'wait' }, 400);
  assert.match(rejected.error, /本手已发牌/); assert.deepEqual(app.store.data, beforeInHandChange);
  assert.deepEqual(room().hand, hand); assert.deepEqual(room().mini, mini);
});
