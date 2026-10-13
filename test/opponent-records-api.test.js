import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';

// Real betting/settlement engine, disposable users and a loopback-only HTTP app.
// No production tokens, archives or network services are used by this fixture.
test('personal opponent history keeps an authorized, filtered cohort across reports and pagination', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-opponent-api-'));
  const app = createApp({ dataDir: directory, allowGuestSessions: true, actionTickMs: 1000000 });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, user, data, expected = 200) => {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: {
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}), 'Content-Type': 'application/json',
    }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
  };
  const users = [];
  for (const name of ['本人验收', '旧昵称对手', '另一个对手', '只旁观', '未交手外人']) users.push(await request('/api/session', null, { name }, 201));
  const [hero, opponentA, opponentB, observer, outsider] = users, me = hero.user.id, aid = opponentA.user.id, bid = opponentB.user.id;
  const room = (await request('/api/rooms', hero, {}, 201)).room;
  for (const user of [opponentA, opponentB, observer]) await request(`/api/rooms/${room.code}/join`, user, { invite: room.invite });
  const otherRoom = (await request('/api/rooms', opponentA, {}, 201)).room;
  await request(`/api/rooms/${otherRoom.code}/join`, outsider, { invite: otherRoom.invite });

  function archive(id, { players = [hero, opponentA], buttonIndex = 0, roomData = room, at, bigBlind = 10, preflopFold = null, endPreflop = false } = {}) {
    const seats = [0, 4, 8], p = players.map((user, i) => ({ ...user.user, seat: seats[i], stack: 1000 }));
    const hand = createHand({ id, players: p, buttonSeat: seats[buttonIndex], smallBlind: bigBlind / 2, bigBlind });
    Object.assign(hand, { at, number: app.store.data.hands.length + 1, roomCode: roomData.code, roomName: roomData.name,
      settings: { ...app.store.data.rooms[roomData.code].settings, bigBlind, smallBlind: bigBlind / 2 }, shown: {},
      miniChanges: {}, miniBefore: {}, miniAfter: {}, timeBankUses: [] });
    hand.audit = commitDeck(hand);
    let actions = 0;
    while (hand.status === 'playing') {
      assert.ok(actions++ < 50, 'fixture must terminate');
      const actor = hand.actingId, available = availableActions(hand, actor);
      const fold = endPreflop || hand.street === 'preflop' && actor === preflopFold || hand.street !== 'preflop' && actor !== me;
      applyAction(hand, actor, fold ? 'fold' : available.canCheck ? 'check' : 'call');
    }
    hand.endingStacks = Object.fromEntries(hand.players.map(player => [player.id, player.stack]));
    app.store.data.hands.push(hand); return hand;
  }
  const h1 = archive('opponent-api-preflop', { at: '2026-10-10T01:00:00.000Z', endPreflop: true });
  const h2 = archive('opponent-api-hu', { at: '2026-10-11T01:00:00.000Z' });
  const h3 = archive('opponent-api-multi', { players: [hero, opponentA, opponentB], at: '2026-10-12T01:00:00.000Z' });
  const h4 = archive('opponent-api-three-dealt-two-flop', { players: [hero, opponentB, opponentA], buttonIndex: 1, preflopFold: bid, at: '2026-10-12T02:00:00.000Z' });
  const h5 = archive('opponent-api-different-blind', { players: [hero, opponentB], bigBlind: 20, at: '2026-10-13T01:00:00.000Z' });
  archive('opponent-api-private-other-room', { players: [opponentA, outsider], roomData: otherRoom, at: '2026-10-13T02:00:00.000Z', endPreflop: true });
  const uncompleted = structuredClone(h2); uncompleted.id = 'opponent-api-unsettled'; uncompleted.status = 'playing'; app.store.data.hands.push(uncompleted);
  // Mini-game profit must not be attributed to a single poker opponent.
  h2.miniChanges[me] = 17;
  app.store.save();
  const net = hand => { const player = hand.players.find(p => p.id === me); return player.stack - player.startingStack; };
  const heroHands = [h1, h2, h3, h4, h5];
  const query = params => new URLSearchParams(params).toString();
  const get = params => request(`/api/hands?${query(params)}`, hero);

  await t.test('anonymous and unrelated-room reads are denied, and userId cannot impersonate another player', async () => {
    await request('/api/hands', null, undefined, 401);
    await request(`/api/hands?room=${room.code}`, outsider, undefined, 403);
    const forged = await request(`/api/hands?userId=${me}&playerId=${me}`, outsider);
    assert.equal(forged.hands.length, 1); assert.equal(forged.hands[0].id, 'opponent-api-private-other-room');
    assert.deepEqual(forged.opponentOptions.map(row => row.id), [aid]);
    assert.equal(forged.opponents.uniqueHands, 1);
  });

  await t.test('observer table access does not become personal hand or opponent statistics', async () => {
    const own = await request('/api/hands', observer);
    assert.deepEqual(own.hands, []); assert.deepEqual(own.opponentOptions, []); assert.deepEqual(own.opponents.rows, []);
    const observed = await request(`/api/rooms/${room.code}/history?limit=20`, observer);
    assert.equal(observed.hands.length, 5); assert.ok(observed.hands.every(hand => hand.participated === false));
    assert.deepEqual(observed.opponentOptions, []); assert.deepEqual(observed.opponents.rows, []);
    assert.equal(observed.opponents.uniqueHands, 0); assert.equal(observed.opponents.net, 0);
  });

  await t.test('reports aggregate self-only net in BB without assigning mini-games or double-counting unique hands', async () => {
    const all = await get({});
    assert.equal(all.hands.length, 5); assert.equal(all.opponents.uniqueHands, 5);
    assert.equal(all.opponents.net, heroHands.reduce((sum, hand) => sum + net(hand), 0));
    assert.equal(all.opponents.netBB, heroHands.reduce((sum, hand) => sum + net(hand) / hand.bigBlind, 0));
    assert.equal(all.opponents.bbHands, 5);
    assert.deepEqual(new Set(all.opponentOptions.map(row => row.id)), new Set([aid, bid]));
    const a = all.opponents.rows.find(row => row.id === aid), b = all.opponents.rows.find(row => row.id === bid);
    assert.equal(a.hands, 4); assert.equal(a.net, [h1, h2, h3, h4].reduce((sum, hand) => sum + net(hand), 0));
    assert.equal(a.headsUpHands, 2); assert.equal(a.headsUpNet, net(h2) + net(h4));
    assert.equal(b.hands, 3); assert.equal(b.headsUpHands, 1); assert.equal(b.headsUpNet, net(h5));
    assert.ok(a.hands + b.hands > all.opponents.uniqueHands, 'co-occurring opponent rows overlap intentionally');
    assert.equal(all.totals.net, all.opponents.net + 17);
    const rows = Object.fromEntries(all.hands.map(row => [row.id, row]));
    assert.equal(rows[h1.id].position, 'BTN/SB'); assert.equal(rows[h1.id].potType, 'noFlop');
    assert.equal(rows[h2.id].flopPlayers, 2); assert.equal(rows[h2.id].potType, 'headsUp');
    assert.equal(rows[h3.id].flopPlayers, 3); assert.equal(rows[h3.id].potType, 'multiway');
    assert.equal(rows[h4.id].position, 'BB'); assert.equal(rows[h4.id].tableSize, 3); assert.equal(rows[h4.id].flopPlayers, 2);
  });

  await t.test('opponent ID remains stable after a profile rename and unknown IDs do not expose unrelated users', async () => {
    await request('/api/profile', opponentA, { name: '改名后的同一人' });
    const renamed = await get({ opponent: aid });
    assert.equal(renamed.hands.length, 4);
    assert.equal(renamed.opponents.rows.filter(row => row.id === aid).length, 1);
    assert.equal(renamed.opponents.rows.find(row => row.id === aid).name, '改名后的同一人');
    assert.equal(renamed.opponentOptions.find(row => row.id === aid).name, '改名后的同一人');
    for (const opponent of [outsider.user.id, 'nonexistent-opponent-id']) {
      const missing = await get({ opponent }); assert.deepEqual(missing.hands, []); assert.deepEqual(missing.opponents.rows, []);
      assert.equal(missing.opponents.uniqueHands, 0);
      assert.ok(missing.opponentOptions.every(row => [aid, bid].includes(row.id)));
      assert.equal(JSON.stringify(missing).includes(outsider.user.name), false);
    }
  });

  await t.test('combined opponent, position, postflop, table-size, date and card filters agree with pagination totals', async () => {
    const filters = { opponent: aid, potType: 'headsUp', from: '2026-10-11', to: '2026-10-12', limit: '1' };
    const first = await get(filters); assert.equal(first.hands[0].id, h4.id); assert.ok(first.nextCursor);
    const second = await get({ ...filters, before: first.nextCursor }); assert.deepEqual(second.hands.map(row => row.id), [h2.id]);
    assert.equal(second.nextCursor, null); assert.deepEqual(second.totals, first.totals); assert.deepEqual(second.opponents, first.opponents);
    assert.equal(first.totals.count, 2); assert.equal(first.opponents.uniqueHands, 2);
    const button = await get({ ...filters, position: 'BTN', tableSize: 'headsUp' }); assert.deepEqual(button.hands.map(row => row.id), [h2.id]);
    const smallBlind = await get({ ...filters, position: 'SB', tableSize: 'headsUp' }); assert.deepEqual(smallBlind.hands.map(row => row.id), [h2.id]);
    const bigBlind = await get({ ...filters, position: 'BB', tableSize: 'short' }); assert.deepEqual(bigBlind.hands.map(row => row.id), [h4.id]);
    const cards = h2.players.find(player => player.id === me).cards, ranks = cards.map(card => card[0]).join('');
    const ownCards = await get({ ...filters, position: 'BTN', holeRanks: ranks, result: 'win' }); assert.equal(ownCards.hands[0].id, h2.id);
    const capped = await get({ opponent: aid, maxHands: '2', limit: '1' });
    assert.deepEqual(capped.hands.map(row => row.id), [h4.id]); assert.equal(capped.totals.count, 2);
    assert.equal(capped.opponents.uniqueHands, 2); assert.equal(capped.opponents.net, net(h3) + net(h4));
    const cappedNext = await get({ opponent: aid, maxHands: '2', limit: '1', before: capped.nextCursor });
    assert.deepEqual(cappedNext.hands.map(row => row.id), [h3.id]); assert.equal(cappedNext.nextCursor, null);
    assert.deepEqual(cappedNext.opponents, capped.opponents);
  });

  await t.test('filtered reports preserve folded-card privacy and reject malformed filters', async () => {
    const result = await get({ opponent: aid });
    const forbidden = new Set(['deck', 'audit', 'proofs', 'salt', 'invite', 'token', 'passwordHash', 'recoveryHash', 'log', 'chat', 'allInLock']);
    const visit = value => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.has(key), key); visit(child); } };
    visit(result);
    assert.equal(JSON.stringify(result.opponents).includes('"cards"'), false);
    for (const row of result.hands) {
      const internal = heroHands.find(hand => hand.id === row.id);
      assert.deepEqual(row.cards, internal.players.find(player => player.id === me).cards);
      assert.equal(row.players, undefined);
    }
    const detail = await request(`/api/rooms/${room.code}/hands/${h2.id}`, hero);
    assert.deepEqual(detail.players.find(player => player.id === aid).cards, [null, null]);
    for (const params of [{ opponent: me }, { opponent: '<bad>' }, { position: 'BTN/SB' }, { potType: 'invalid' }, { tableSize: '0' }, { maxHands: '0' }, { maxHands: '1.5' }, { maxHands: '100001' }]) {
      await request(`/api/hands?${query(params)}`, hero, undefined, 400);
    }
  });
});
