import { seedLegacyAccount } from './helpers/accounts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { aggregateAnalytics } from '../src/analytics.js';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-player-stats-'));
  const app = createApp({ dataDir: directory, actionTickMs: 60000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, token, body, status = 200) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const people = [];
  for (const name of ['本人', '对手', '观战者', '局外人']) people.push(seedLegacyAccount(app, { name }));
  const room = (await api('/api/rooms', people[0].token, {}, 201)).room;
  for (const person of people.slice(1, 3)) await api(`/api/rooms/${room.code}/join`, person.token, { invite: room.invite });
  const [me, target, observer, stranger] = people;
  const endpoint = (scope = '') => `/api/rooms/${room.code}/players/${target.user.id}/stats${scope ? '?scope=' + scope : ''}`;
  function hand(id, code, players, { fold = false, bomb = false, live = false } = {}) {
    const h = createHand({ id, players: players.map((p, seat) => ({ id: p.user.id, name: p.user.name, seat, stack: 1000 })),
      buttonSeat: 0, smallBlind: 5, bigBlind: 10, bombPot: bomb, ante: bomb ? 20 : 0 });
    while (h.status === 'playing' && !live) applyAction(h, h.actingId, fold ? 'fold' : availableActions(h, h.actingId).canCheck ? 'check' : 'call');
    Object.assign(h, { roomCode: code, number: 1, at: new Date().toISOString(), miniChanges: {}, settings: { smallBlind: 5, bigBlind: 10 } });
    app.store.data.hands.push(h); return h;
  }
  return { api, app, room, people, me, target, observer, stranger, endpoint, hand };
}
function noPrivateFields(value) {
  const allowedRoot = ['hands', 'metrics', 'player', 'preflopHands', 'roomCode', 'scope', 'versus'];
  assert.deepEqual(Object.keys(value).sort(), allowedRoot);
  assert.deepEqual(Object.keys(value.player).sort(), ['avatar', 'avatarImage', 'id', 'name']);
  assert.deepEqual(Object.keys(value.metrics).sort(), ['fiveBet', 'fourBet', 'pfr', 'rfi', 'threeBet', 'vpip', 'winRate', 'wsd', 'wtsd']);
  for (const metric of Object.values(value.metrics)) assert.deepEqual(Object.keys(metric).sort(), ['count', 'opportunities', 'percent']);
}

test('opponent stats require authentication and current-room membership for both caller and target', async t => {
  const f = await fixture(t);
  for (const scope of ['table', 'career']) {
    await f.api(f.endpoint(scope), null, undefined, 401);
    await f.api(f.endpoint(scope), f.stranger.token, undefined, 403);
    await f.api(`/api/rooms/${f.room.code}/players/${f.stranger.user.id}/stats?scope=${scope}`, f.me.token, undefined, 403);
  }
  await f.api(f.endpoint('everyone'), f.me.token, undefined, 400);
  await f.api(f.endpoint('shared'), f.me.token, undefined, 400);
  await f.api(f.endpoint() + '?from=2020-01-01', f.me.token, undefined, 400);
  await f.api(f.endpoint() + '?room=123456', f.me.token, undefined, 400);
  const empty = await f.api(f.endpoint(), f.me.token);
  assert.equal(empty.hands, 0); assert.equal(empty.metrics.vpip.percent, null); noPrivateFields(empty);
});

test('table stats include only settled target hands in the requested table and are visible to its observer', async t => {
  const f = await fixture(t), { target, me, observer, stranger } = f;
  f.hand('same-table', f.room.code, [me, target]);
  f.hand('same-table-no-viewer', f.room.code, [target, observer], { fold: true });
  f.hand('same-table-bomb', f.room.code, [target, me], { bomb: true });
  f.hand('unrelated-secret', '111111', [target, stranger]);
  f.hand('live-secret', f.room.code, [target, me], { live: true });
  f.app.service.user(target.user.id).username = 'PRIVATE_LOGIN_FIELD';
  f.app.service.user(target.user.id).passwordHash = 'PRIVATE_PASSWORD_FIELD';
  const data = await f.api(f.endpoint(), observer.token);
  assert.equal(data.hands, 3); assert.equal(data.preflopHands, 2); assert.equal(data.scope, 'table'); noPrivateFields(data);
  const expected = aggregateAnalytics(f.app.store.data, target.user.id, { room: f.room.code });
  for (const [key, value] of Object.entries(data.metrics)) assert.deepEqual(value, expected.metrics[key], key);
  const serialized = JSON.stringify(data);
  for (const forbidden of ['PRIVATE_LOGIN_FIELD', 'PRIVATE_PASSWORD_FIELD', 'unrelated-secret', 'live-secret', '111111', 'cards', 'log', 'curve']) assert.ok(!serialized.includes(forbidden), forbidden);
});

test('career stats aggregate all completed dealt target hands regardless of viewer participation without exposing their records', async t => {
  const f = await fixture(t), { target, me, observer, stranger } = f;
  f.hand('together-here', f.room.code, [me, target]);
  f.hand('together-elsewhere', '222222', [target, me], { fold: true });
  f.hand('viewer-not-dealt', f.room.code, [target, observer]);
  f.hand('target-private-game', '333333', [target, stranger]);
  f.hand('target-only-observing', f.room.code, [me, observer]);
  f.hand('unfinished-target-game', '444444', [target, stranger], { live: true });
  const profile = f.app.service.user(target.user.id);
  Object.assign(profile, { username: 'PRIVATE_LOGIN_FIELD', passwordHash: 'PRIVATE_PASSWORD_FIELD', favoriteHands: ['target-private-game'] });
  const data = await f.api(f.endpoint('career'), me.token);
  assert.equal(data.hands, 4); assert.equal(data.scope, 'career'); noPrivateFields(data);
  const expected = aggregateAnalytics(f.app.store.data, target.user.id);
  for (const [key, value] of Object.entries(data.metrics)) assert.deepEqual(value, expected.metrics[key], key);
  const observers = await f.api(f.endpoint('career'), observer.token);
  assert.deepEqual({ ...observers, versus: null }, { ...data, versus: null });
  assert.equal(data.versus.sharedHands, 2); assert.equal(observers.versus.sharedHands, 1);
  const serialized = JSON.stringify(data);
  for (const forbidden of ['PRIVATE_LOGIN_FIELD', 'PRIVATE_PASSWORD_FIELD', 'target-private-game', '333333', '444444', 'cards', 'log', 'curve', 'favoriteHands']) assert.ok(!serialized.includes(forbidden), forbidden);
  const before = structuredClone(f.app.store.data);
  await f.api(f.endpoint('career'), me.token); assert.deepEqual(f.app.store.data, before);
});

test('neither scope counts a target player row without two dealt cards', async t => {
  const f = await fixture(t), { target, me } = f;
  f.hand('valid-target-hand', f.room.code, [me, target]);
  const undealt = f.hand('undealt-target-row', f.room.code, [me, target]);
  undealt.players.find(p => p.id === target.user.id).cards = [];
  for (const scope of ['table', 'career']) {
    const data = await f.api(f.endpoint(scope), me.token);
    assert.equal(data.hands, 1); assert.equal(data.preflopHands, 1); noPrivateFields(data);
  }
});


test('versus scope is both dealt finished hands, independent of target career totals and observer access', async t => {
  const f = await fixture(t), { me, target, observer, stranger } = f;
  f.hand('encounter-here', f.room.code, [me, target]);
  f.hand('encounter-elsewhere', '222222', [me, target]);
  f.hand('target-with-other', '333333', [target, stranger]);
  f.hand('target-observed-only', f.room.code, [me, observer]);
  f.hand('encounter-live', f.room.code, [me, target], { live: true });
  const table = await f.api(f.endpoint('table'), me.token), career = await f.api(f.endpoint('career'), me.token);
  assert.equal(table.hands, 1); assert.equal(table.versus.sharedHands, 1);
  assert.equal(career.hands, 3); assert.equal(career.versus.sharedHands, 2);
  const watching = await f.api(f.endpoint('career'), observer.token);
  assert.equal(watching.hands, 3); assert.equal(watching.versus.sharedHands, 0); assert.equal(watching.versus.allIn.expectedNetBB, null);
  const self = await f.api(`/api/rooms/${f.room.code}/players/${me.user.id}/stats?scope=career`, me.token);
  assert.equal(self.versus, null);
  for (const value of [table, career, watching, self]) {
    noPrivateFields(value);
    const encoded = JSON.stringify(value);
    for (const secret of ['encounter-', 'target-with-other', '222222', '333333', 'cards', 'playerIds', 'payouts', 'logSeq']) assert.ok(!encoded.includes(secret), secret);
  }
});
