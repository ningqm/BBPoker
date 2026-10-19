import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { EncryptedStore } from '../src/store.js';
import { RoomService } from '../src/room.js';
import { seedLegacyAccount } from './helpers/accounts.js';
import { readyRoomAction } from './helpers/room-clock.js';

test('release audit: failed leave atomically restores host, live hand and queued buy-in; retry and restart settle each once', async t => {
  let timestamp = 1800000000000;
  t.mock.method(Date, 'now', () => timestamp);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-host-release-'));
  const app = createApp({ dataDir: directory, actionTickMs: 1000000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const accounts = Array.from({ length: 4 }, (_, i) => seedLegacyAccount(app, { name: `交权事务${i}` }));
  const api = async (path, input, account = accounts[0]) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  const created = await api('/api/rooms', { settings: { squid: true, squidMode: 'unlimited' } });
  assert.equal(created.status, 201);
  const code = created.body.room.code, room = () => app.store.data.rooms[code];
  const command = (i, type, extra = {}) => api(`/api/rooms/${code}/action`, {
    type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra,
  }, accounts[i]);
  for (let i = 0; i < accounts.length; i++) {
    if (i) assert.equal((await api(`/api/rooms/${code}/join`, { invite: room().invite }, accounts[i])).status, 200);
    assert.equal((await command(i, 'sit', { seat: i, amountBB: 100 })).status, 200);
    // Keep the departed host's connection count alive, as a delayed SSE close can.
    app.service.connections.set(`${code}:${accounts[i].user.id}`, 1);
  }
  assert.equal((await command(0, 'start')).status, 200);
  const hostId = accounts[0].user.id, buyinId = randomUUID(), leaveId = randomUUID();
  assert.equal((await command(0, 'buyin', { amountBB: 100, commandId: buyinId })).status, 200);
  const quote = { expectedSquidRound: room().mini.squid.round, expectedSquidCost: room().mini.squid.tokenBudget * room().mini.squid.unit, commandId: leaveId };
  const before = structuredClone(app.store.data), originalSave = app.store.save.bind(app.store);
  app.store.save = () => { throw Object.assign(new Error('isolated leave commit failure'), { code: 'EIO' }); };
  try {
    const failed = await command(0, 'leave', quote);
    assert.equal(failed.status, 500);
    assert.deepEqual(app.store.data, before, 'failed leave must restore authority, membership, receipts, money and current hand together');
    assert.deepEqual(app.store.read(), before, 'failed leave cannot change the encrypted snapshot');
    assert.equal(app.service.db, app.store.data, 'retry must use the restored store rather than stale room references');
  } finally { app.store.save = originalSave; }

  assert.equal((await command(0, 'leave', quote)).status, 200);
  assert.notEqual(room().hostId, hostId);
  assert.equal(room().members[hostId].leftRoom, true);
  assert.equal(room().members[hostId].pendingDeparture, 'leave');
  assert.equal(app.service.connections.get(`${code}:${hostId}`), 1);
  assert.equal(app.service.online(room(), hostId), false, 'stale transport presence cannot undo personal departure');
  assert.deepEqual(room().hand, before.rooms[code].hand, 'hand ownership, blinds and cards survive management handover');
  const accepted = structuredClone(app.store.data);
  assert.equal((await command(0, 'leave', quote)).status, 200);
  assert.deepEqual(app.store.data, accepted, 'lost-response retry cannot transfer again or debit twice');

  for (let guard = 0; room().hand.status === 'playing'; guard++) {
    assert.ok(guard < 20);
    if (!readyRoomAction(app.service, room(), value => { timestamp = value; })) break;
    const actor = accounts.findIndex(account => account.user.id === room().hand.actingId);
    assert.equal((await command(actor, 'fold')).status, 200);
  }
  app.service.completeRabbit(room(), timestamp); app.store.save();
  assert.equal(room().members[hostId].seat, null);
  assert.equal(room().members[hostId].totalBuyIn, 1000);
  assert.equal(room().members[hostId].buyinReceipts[`command:${buyinId}`].status, 'cancelled');
  assert.equal(app.store.data.hands.length, 1);
  assert.equal(app.store.data.ledger.filter(row => row.type === 'holdem').length, 4);
  assert.equal(app.store.data.ledger.filter(row => row.playerId === hostId && row.type === 'cashout').length, 1);
  assert.equal(app.store.data.ledger.filter(row => row.playerId === hostId && row.type === 'buyinCancelled').length, 1);
  const money = () => Object.values(room().members).reduce((sum, m) => sum + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0);
  assert.equal(money(), 4000, 'cancelled queued chips are excluded from table funding');

  const restored = new EncryptedStore(directory), service = new RoomService(restored), persisted = structuredClone(restored.data);
  service.command(accounts[0].user, code, { type: 'leave', ...quote });
  service.command(accounts[0].user, code, { type: 'buyin', amountBB: 100, commandId: buyinId });
  assert.deepEqual(restored.data, persisted, 'encrypted restart preserves accepted leave and cancelled financial receipts');
  timestamp = room().nextHandAt;
  app.service.tick(room(), timestamp);
  assert.equal(room().handNumber, 2);
  assert.ok(!room().hand.players.some(p => p.id === hostId));
  assert.equal(room().hand.log.filter(row => ['smallBlind', 'bigBlind'].includes(row.type)).length, 2);
  const dealt = structuredClone(app.store.data);
  app.service.tick(room(), timestamp);
  assert.deepEqual(app.store.data, dealt, 'a repeated due tick must not deal or post blinds again');
});
