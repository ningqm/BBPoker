import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { availableActions } from '../src/poker.js';

for (const mode of ['normal', 'unlimited']) test(`${mode} midround admission: HTTP persistence rollback and request retries never double-reserve`, async t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-midround-api-'));
  const app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 1000000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, user, body, status = 200) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  const people = [];
  for (const name of ['Host', 'Existing A', 'Existing B', 'Newcomer']) people.push(await request('/api/session', null, { name }, 201));
  const created = (await request('/api/rooms', people[0], { settings: { squid: true, squidMode: mode, maxPlayers: 9 } }, 201)).room;
  const code = created.code, room = () => app.store.data.rooms[code], newcomer = people[3].user.id;
  const action = async (who, type, extra = {}, status = 200)  => {
    const pokerAction = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (pokerAction && room().hand?.actingId) readyRoomAction(app.service, room(), value => { clock = value; });
    const result = await request(`/api/rooms/${code}/action`, people[who], { commandId: randomUUID(), type, ...extra }, status);
    if (pokerAction) while (room().hand?.transition) { assert.ok(advanceRoomEvent(app.service, room(), value => { clock = value; })); app.store.save(); }
    return result;
  };
  for (let i = 0; i < 4; i++) {
    if (i) await request(`/api/rooms/${code}/join`, people[i], { invite: created.invite });
    app.service.connections.set(`${code}:${people[i].user.id}`, 1);
    if (i < 3) await action(i, 'sit', { seat: i, amountBB: 200 });
  }
  await action(0, 'start'); await action(0, 'autoDeal', { paused: true });
  const frozen = structuredClone(room().hand), initialBudget = mode === 'unlimited' ? 6 : 2;
  const sit = { commandId: randomUUID(), type: 'sit', seat: 3, amountBB: 200, entryMode: 'post' };
  await Promise.all([request(`/api/rooms/${code}/action`, people[3], sit), request(`/api/rooms/${code}/action`, people[3], sit)]);
  assert.equal(room().members[newcomer].totalBuyIn, 2000);
  assert.equal(room().mini.squid.tokenBudget, initialBudget);
  assert.deepEqual(room().hand, frozen, 'joining mid-hand does not rewrite the dealt hand');
  while (room().hand.status === 'playing') {
    const h = room().hand, who = people.findIndex(p => p.user.id === h.actingId), legal = availableActions(h, h.actingId);
    await action(who, who === 0 ? legal.canCheck ? 'check' : 'call' : 'fold', { handId: h.id, actionSeq: h.log.length });
  }
  if (room().hand.rabbit?.active) { clock += 1000; app.service.revealRabbit(room(), clock); }
  // A real completed result must be visible for five seconds. Advancing the
  // test clock (rather than forging old grace timestamps) preserves that guard.
  clock += 5000;
  assert.ok(clock >= room().resultReadyAt + 5000);
  // Model a paused, already-refilled rebuy window. Resuming this valid saved
  // state deals immediately through command -> reconcileAutoDeal, so the HTTP
  // write below contains the admission itself, rather than just a countdown.
  room().rebuyGrace = { handId: room().hand.id, eligibleIds: [people[1].user.id],
    startsAt: Date.now() - 1000, endsAt: Date.now() + 10000, phase: 'grace' };
  app.store.save();
  const before = structuredClone(app.store.data), save = app.store.save;
  const start = { commandId: randomUUID(), type: 'start' };
  app.store.save = () => { throw new Error('Synthetic disk write failure'); };
  const failed = await request(`/api/rooms/${code}/action`, people[0], start, 400);
  assert.equal(failed.error, 'Synthetic disk write failure');
  app.store.save = save;
  assert.deepEqual(app.store.data, before, 'failed persistence must roll back admission, fish, chips, and blind orbit together');
  await request(`/api/rooms/${code}/action`, people[0], start);
  const after = structuredClone(room());
  assert.equal(after.mini.squid.participants.length, 4);
  assert.equal(after.mini.squid.counts[newcomer], 0);
  assert.equal(after.mini.squid.tokenBudget, initialBudget + 1);
  assert.equal(after.mini.squid.reserves[newcomer], (initialBudget + 1) * 20);
  assert.equal(after.hand.players.filter(p => p.id === newcomer).length, 1);
  assert.equal(after.hand.players.find(p => p.id === newcomer).contributed, 10, 'natural BB must not also post an extra entry BB');
  await request(`/api/rooms/${code}/action`, people[0], start);
  assert.deepEqual(room(), after, 'same successful command does not deal again or charge admission twice');
  assert.equal(app.store.data.hands.length, 1);
  assert.deepEqual(app.store.data.hands[0], before.hands[0], 'old archive remains frozen');
  const state = await request(`/api/rooms/${code}`, people[3]);
  assert.equal(state.mini.squid.tokenBudget, initialBudget + 1);
  assert.equal(state.players.find(p => p.id === newcomer).squidCount, 0);
});
