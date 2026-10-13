import test from 'node:test';
import assert from 'node:assert/strict';
const pointTotals = ({ bb, ...points }) => points;
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { recordFilters, resultMatches, handBigBlind } from '../src/records.js';
import { createApp } from '../server.js';

const AT = '2026-10-13T10:00:00.000Z';
function fixture() {
  const users = ['me', 'friend', 'observer', 'stranger'].map(id => ({ id, name: id, avatar: 0 }));
  const store = { data: { version: 1, users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], { name: '筛选朋友局' });
  for (const user of users.slice(1, 3)) service.join(user, room.code, room.invite);
  const hand = (id, options = {}) => addHand(store.data, room, users, id, options);
  return { store, users, service, room, hand };
}
function addHand(db, room, users, id, { net = 100, mini = 0, bb = 10, cards = ['As', 'Ks'], peerCards = ['Qh', 'Qd'],
  board = ['2c', '3h', '4d'], at = AT, bomb = false, status = 'complete', absent = false, observerMini = 0 } = {}) {
  const [me, friend, observer] = users;
  const h = { id, roomCode: room.code, roomName: room.name, status, at, number: db.hands.length + 1,
    settings: { ...room.settings, bigBlind: bb }, board, bombPot: bomb,
    players: [{ id: friend.id, name: friend.name, startingStack: 2000, stack: 2000 - net, cards: peerCards }],
    miniChanges: { [me.id]: mini, [friend.id]: -mini - observerMini, [observer.id]: observerMini },
    result: { pots: [{ amount: 200 }], mainWinnerIds: [net >= 0 ? me.id : friend.id], payouts: {} },
    // Deliberately private sentinels; list responses must never project them.
    deck: ['Ah', 'Ad'], audit: { salt: 'private-test-salt' }, log: [{ private: 'private-test-log' }] };
  if (!absent) h.players.push({ id: me.id, name: me.name, startingStack: 2000, stack: 2000 + net, cards });
  db.hands.push(h); return h;
}
const ids = result => result.hands.map(h => h.id).sort();
const badFilters = [
  { result: 'winOver' }, { result: 'lossOver', minBB: '' }, { result: 'winOver', minBB: null },
  ...['-1', '1000000000.01', '1.001', '1e2', 'Infinity', 'NaN', ' 1 ', '.5', '1.', '+1', '0x10'].map(minBB => ({ result: 'winOver', minBB })),
  ...[true, {}, [], NaN, Infinity, -1, 1.001].map(minBB => ({ minBB })),
  ...['AAA', 'AKs', 'As', '10', 'A K', 'Z', '   ', 12, {}, ['A']].map(holeRanks => ({ holeRanks })),
  ...['suited OR pair', 'offSuit', {}, true].map(holeType => ({ holeType })),
];

test('record filter validation canonicalizes ranks and accepts only bounded two-decimal BB thresholds', () => {
  assert.equal(recordFilters({ holeRanks: 'ka' }).holeRanks, 'AK');
  assert.equal(recordFilters({ holeRanks: ' aa ' }).holeRanks, 'AA');
  assert.equal(recordFilters({ holeRanks: 'a' }).holeRanks, 'A');
  assert.equal(recordFilters({ holeRanks: '2t', holeType: 'offsuit' }).holeRanks, 'T2');
  for (const value of ['0', '0.01', '1.10', '1000000000', 0, 0.29, 1000000000]) {
    assert.equal(recordFilters({ result: 'winOver', minBB: value }).minBB, Number(value));
  }
  assert.equal(recordFilters().minBB, null);
  for (const query of badFilters) assert.throws(() => recordFilters(query), e => e.status === 400, JSON.stringify(query));
});

test('mixed-stakes hand thresholds use each historical BB, preserve mini totals, and exclude equality', () => {
  const f = fixture(); f.room.settings.bigBlind = 999;
  f.hand('win-20bb', { bb: 5 }); f.hand('equal-10bb', { bb: 10 }); f.hand('win-5bb', { bb: 20 });
  f.hand('loss-20bb', { net: -100, bb: 5 }); f.hand('loss-equal-10bb', { net: -100, bb: 10 });
  f.hand('mini-winner', { net: -100, mini: 201, bb: 10 });
  f.hand('mini-loser', { net: 100, mini: -201, bb: 10 }); f.hand('even', { net: 10, mini: -10 });
  const wins = f.service.handLibrary('me', { result: 'winOver', minBB: '10' });
  assert.deepEqual(ids(wins), ['mini-winner', 'win-20bb']);
  assert.deepEqual(pointTotals(wins.totals), { count: 2, net: 201, holdemNet: 0, miniNet: 201, wins: 2, losses: 0, even: 0 });
  assert.deepEqual(ids(f.service.handLibrary('me', { result: 'lossOver', minBB: '10' })), ['loss-20bb', 'mini-loser']);
  assert.equal(f.service.handLibrary('me', { result: 'winOver', minBB: '0' }).totals.count, 4);
  assert.equal(f.service.handLibrary('me', { result: 'lossOver', minBB: '0' }).totals.count, 3);
  assert.deepEqual(ids(f.service.handLibrary('me', { result: 'even' })), ['even']);
  assert.equal(wins.hands.find(h => h.id === 'win-20bb').bigBlind, 5);
});

test('strict BB comparisons are exact at fractional and maximum-size integer boundaries', () => {
  const f = fixture(); f.hand('equal', { net: 29, bb: 100 }); f.hand('above', { net: 30, bb: 100 });
  f.hand('negative-equal', { net: -29, bb: 100 }); f.hand('negative-above', { net: -30, bb: 100 });
  assert.deepEqual(ids(f.service.handLibrary('me', { result: 'winOver', minBB: '0.29' })), ['above']);
  assert.deepEqual(ids(f.service.handLibrary('me', { result: 'lossOver', minBB: '0.29' })), ['negative-above']);
  const threshold = 999999999.99, bb = 1000000, equal = 999999999990000;
  assert.equal(resultMatches(equal, 'winOver', threshold, bb), false);
  assert.equal(resultMatches(equal + 1, 'winOver', threshold, bb), true);
  assert.equal(resultMatches(-equal, 'lossOver', threshold, bb), false);
  assert.equal(resultMatches(-equal - 1, 'lossOver', threshold, bb), true);
});

test('starting rank and type filters use unordered own cards and mutually exclusive pair/suited/offsuit', () => {
  const f = fixture();
  f.hand('ak-suited', { cards: ['Ks', 'As'] }); f.hand('ak-off', { cards: ['Ah', 'Kc'] });
  f.hand('aa', { cards: ['Ah', 'Ad'] }); f.hand('a2', { cards: ['2c', 'Ad'] }); f.hand('tt', { cards: ['Ts', 'Th'] });
  const find = query => ids(f.service.handLibrary('me', query));
  assert.deepEqual(find({ holeRanks: 'AK' }), ['ak-off', 'ak-suited']);
  assert.deepEqual(find({ holeRanks: 'ka' }), find({ holeRanks: 'AK' }));
  assert.deepEqual(find({ holeRanks: 'A' }), ['a2', 'aa', 'ak-off', 'ak-suited']);
  assert.deepEqual(find({ holeRanks: 'aa' }), ['aa']);
  assert.deepEqual(find({ holeType: 'pair' }), ['aa', 'tt']);
  assert.deepEqual(find({ holeType: 'suited' }), ['ak-suited']);
  assert.deepEqual(find({ holeType: 'offsuit' }), ['a2', 'ak-off']);
  assert.deepEqual(find({ holeRanks: 'AK', holeType: 'suited' }), ['ak-suited']);
  assert.deepEqual(find({ holeRanks: 'AA', holeType: 'offsuit' }), []);
  assert.deepEqual(find({ holeRanks: 'AA', holeType: 'suited' }), []);
  assert.deepEqual(find({ holeRanks: 'AK', holeType: 'pair' }), []);
});

test('own-card filters never match an opponent, shown cards, board, or malformed/missing private cards', () => {
  const f = fixture();
  const h = f.hand('peer-and-board', { cards: ['2c', '3d'], peerCards: ['As', 'Ah'], board: ['Ad', 'Kh', 'Qh'] });
  h.shown = { friend: [0, 1] };
  for (const [id, cards] of [['missing', undefined], ['hidden', [null, null]], ['duplicate', ['As', 'As']], ['bad', ['A♠', 'K♠']]]) {
    const hand = f.hand(id); hand.players.find(p => p.id === 'me').cards = cards;
  }
  for (const query of [{ holeRanks: 'A' }, { holeRanks: 'AA' }, { holeType: 'pair' }, { holeType: 'suited' }]) {
    assert.deepEqual(ids(f.service.handLibrary('me', query)), []);
    assert.deepEqual(ids(f.service.history('observer', f.room.code, query)), []);
  }
  assert.deepEqual(ids(f.service.handLibrary('stranger', {}, true)), []);
});

test('rank/result/date/type/favorite/text filters combine before pagination and retain full-match totals', () => {
  const f = fixture();
  for (let i = 0; i < 57; i++) f.hand(`selected-${String(i).padStart(2, '0')}`, { net: 111, mini: 1, bomb: true });
  f.hand('wrong-cards', { cards: ['Qs', 'Js'], bomb: true }); f.hand('wrong-date', { at: '2026-10-12T12:00:00.000Z', bomb: true });
  f.hand('wrong-type'); f.hand('wrong-result', { net: 1, bomb: true }); f.hand('not-favorite', { bomb: true });
  f.hand('live', { bomb: true, status: 'playing' });
  f.users[0].favoriteHands = f.store.data.hands.filter(h => h.id !== 'not-favorite').map(h => h.id);
  const query = { result: 'winOver', minBB: '10', holeRanks: 'ka', holeType: 'suited', from: '2026-10-13', to: '2026-10-13', type: 'bomb', favorites: '1', q: '筛选', limit: '50' };
  const first = f.service.handLibrary('me', query), second = f.service.handLibrary('me', { ...query, before: first.nextCursor });
  assert.equal(first.hands.length, 50); assert.equal(second.hands.length, 7); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.hands, ...second.hands].map(h => h.id)).size, 57);
  assert.deepEqual(pointTotals(first.totals), { count: 57, net: 57 * 112, holdemNet: 57 * 111, miniNet: 57, wins: 57, losses: 0, even: 0 });
  assert.deepEqual(first.totals, second.totals);
  for (const row of first.hands) {
    assert.deepEqual(row.cards, ['As', 'Ks']); assert.equal(row.bigBlind, 10);
    for (const key of ['players', 'deck', 'audit', 'log', 'shown', 'proofs', 'invite']) assert.equal(row[key], undefined);
  }
});

test('absent squid beneficiary keeps genuine per-hand profit but can never match a starting hand', () => {
  const f = fixture(); f.hand('squid-payout', { observerMini: 40, bb: 10 });
  const query = { result: 'winOver', minBB: '3' }, found = f.service.history('observer', f.room.code, query);
  assert.deepEqual(ids(found), ['squid-payout']); assert.equal(found.hands[0].participated, false);
  assert.deepEqual(found.hands[0].cards, [null, null]); assert.equal(found.hands[0].net, 0);
  assert.equal(found.hands[0].miniNet, 40); assert.equal(found.hands[0].totalNet, 40);
  assert.deepEqual(pointTotals(found.totals), { count: 1, net: 40, holdemNet: 0, miniNet: 40, wins: 1, losses: 0, even: 0 });
  assert.deepEqual(ids(f.service.history('observer', f.room.code, { ...query, holeRanks: 'A' })), []);
  assert.deepEqual(ids(f.service.history('observer', f.room.code, { ...query, holeType: 'pair' })), []);
  assert.deepEqual(ids(f.service.handLibrary('observer', query)), []);
});

test('missing historical BB never falls back to current room stakes and legacy hand snapshots remain usable', () => {
  const f = fixture(); f.room.settings.bigBlind = 2;
  const missing = f.hand('unknown'); delete missing.settings; delete missing.bigBlind;
  const legacy = f.hand('legacy'); delete legacy.settings; legacy.bigBlind = 5;
  const broken = f.hand('broken'); broken.settings.bigBlind = 0; broken.bigBlind = 1;
  assert.equal(handBigBlind(missing), null); assert.equal(handBigBlind(broken), null); assert.equal(handBigBlind(legacy), 5);
  assert.deepEqual(ids(f.service.handLibrary('me', { result: 'winOver', minBB: '10' })), ['legacy']);
  const plain = f.service.handLibrary('me'); assert.equal(plain.hands.find(h => h.id === 'unknown').bigBlind, null);
  assert.equal(f.service.history('me', f.room.code).hands.find(h => h.id === 'legacy').bigBlind, 5);
});

test('session thresholds use each session BB and authoritative mini ledger exactly once before pagination', () => {
  const f = fixture(); f.room.settings.bigBlind = 5; f.room.startedAt = Date.parse(AT);
  f.hand('win20', { net: 100, bb: 999 });
  for (const [code, bb, net, mini] of [['100001', 10, 100, 0], ['100002', 20, 100, 0], ['100003', 10, -100, 201], ['100004', 10, 100, -201]]) {
    const room = structuredClone(f.room); room.code = code; room.settings.bigBlind = bb; f.store.data.rooms[code] = room;
    const h = addHand(f.store.data, room, f.users, 'hand-' + code, { net, mini, bb: 999 });
    if (mini) {
      h.squidSettlementId = 'squid-' + code; h.squidSettlementChanges = { me: mini };
      f.store.data.ledger.push({ roomCode: code, playerId: 'me', type: 'squidSettlement', roundSettlementId: h.squidSettlementId, amount: mini });
    }
  }
  const query = { result: 'winOver', minBB: '10', limit: '1' };
  const first = f.service.sessions('me', query), second = f.service.sessions('me', { ...query, before: first.nextCursor });
  assert.equal(first.sessions.length, 1); assert.equal(second.sessions.length, 1); assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.sessions, ...second.sessions].map(s => s.code)), new Set([f.room.code, '100003']));
  assert.deepEqual(pointTotals(first.totals), { count: 2, net: 201, holdemNet: 0, miniNet: 201, wins: 2, losses: 0, even: 0 });
  assert.deepEqual(second.totals, first.totals);
  assert.deepEqual(f.service.sessions('me', { result: 'lossOver', minBB: '10' }).sessions.map(s => s.code), ['100004']);
  assert.equal(f.service.sessions('me', { ...query, holeRanks: 'QQ', holeType: 'pair' }).totals.count, 2);
});

test('table history is locked to its authorized room even when another room is supplied as a filter', () => {
  const f = fixture(); f.hand('own-room');
  const other = structuredClone(f.room); other.code = '100001'; f.store.data.rooms[other.code] = other;
  addHand(f.store.data, other, f.users, 'other-room');
  assert.deepEqual(ids(f.service.history('me', f.room.code, { room: other.code, holeRanks: 'AK' })), ['own-room']);
  for (const query of [{}, { holeRanks: 'A' }, { result: 'winOver', minBB: '0' }]) {
    assert.throws(() => f.service.history('stranger', f.room.code, query), e => e.status === 403);
  }
});

test('HTTP hand/session filters enforce validation, own-card privacy, observer exclusion, and room membership', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-record-v014-')), app = createApp({ dataDir: directory, allowGuestSessions: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(user, path, body, expected = 200) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  const users = []; for (const name of ['本人', '朋友', '旁观', '局外']) users.push(await api(null, '/api/session', { name }, 201));
  const visibleRoom = (await api(users[0], '/api/rooms', { name: '筛选测试' }, 201)).room;
  for (const user of users.slice(1, 3)) await api(user, `/api/rooms/${visibleRoom.code}/join`, { invite: visibleRoom.invite });
  const room = app.store.data.rooms[visibleRoom.code];
  addHand(app.store.data, room, users.map(u => u.user), 'self-ak', { net: 101, observerMini: 40 });
  addHand(app.store.data, room, users.map(u => u.user), 'peer-aa', { net: 100, cards: ['2c', '3d'], peerCards: ['As', 'Ah'] });
  const filter = 'result=winOver&minBB=10&holeRanks=ka&holeType=suited';
  const personal = await api(users[0], '/api/hands?' + filter);
  assert.deepEqual(ids(personal), ['self-ak']); assert.equal(personal.hands[0].bigBlind, 10);
  assert.equal(JSON.stringify(personal).includes('private-test'), false);
  assert.deepEqual(ids(await api(users[0], '/api/hands?holeRanks=AA')), []);
  assert.deepEqual(ids(await api(users[2], '/api/hands?includeObserved=true&holeRanks=A')), []);
  const historyPath = `/api/rooms/${room.code}/history`;
  assert.deepEqual(ids(await api(users[2], historyPath + '?holeRanks=A')), []);
  const paid = await api(users[2], historyPath + '?result=winOver&minBB=3');
  assert.deepEqual(ids(paid), ['self-ak']); assert.deepEqual(paid.hands[0].cards, [null, null]);
  await api(users[3], historyPath + '?' + filter, undefined, 403);
  await api(users[3], `/api/hands?room=${room.code}&${filter}`, undefined, 403);
  await api(users[3], `/api/sessions?room=${room.code}&result=winOver&minBB=0`, undefined, 403);
  await api(null, '/api/hands?' + filter, undefined, 401);
  assert.equal((await api(users[0], '/api/sessions?result=winOver&minBB=20')).totals.count, 1);
  assert.equal((await api(users[0], '/api/sessions?result=winOver&minBB=20.10')).totals.count, 0);
  for (const path of ['/api/hands', '/api/sessions', historyPath]) {
    for (const query of ['result=winOver', 'result=lossOver&minBB=1.001', 'minBB=1000000000.01', 'holeRanks=AKs', 'holeType=unknown']) await api(users[0], `${path}?${query}`, undefined, 400);
  }
});
