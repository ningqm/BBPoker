import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomService } from '../src/room.js';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { recordFilters } from '../src/records.js';

function fixture() {
  const users = ['me', 'alice', 'bob', 'observer', 'stranger'].map(id => ({ id, name: id, avatar: 0 }));
  const db = { version: 1, users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data: db }), room = service.create(users[0], { name: '战绩朋友局' });
  for (const user of users.slice(1, 4)) service.join(user, room.code, room.invite);
  function add(id, { ids = ['me', 'alice'], fold = [], net = 100, mini = 0, bb = 10,
    at = '2026-10-13T10:00:00.000Z', cards = ['As', 'Ks'], bomb = false } = {}) {
    const h = createHand({ id, players: ids.map((id, i) => ({ id, name: id, seat: i * 2, stack: 1000 })),
      buttonSeat: 0, smallBlind: 5, bigBlind: 10, bombPot: bomb, ante: bomb ? 20 : 0 });
    while (h.status === 'playing') {
      const a = availableActions(h, h.actingId);
      applyAction(h, h.actingId, h.street === 'preflop' && fold.includes(h.actingId) ? 'fold' : a.canCheck ? 'check' : 'call');
    }
    Object.assign(h, { roomCode: room.code, roomName: room.name, at, number: db.hands.length + 1,
      settings: { bigBlind: bb }, miniChanges: { me: mini } });
    if (bb === null) { delete h.settings; delete h.bigBlind; }
    for (const p of h.players) {
      p.startingStack = 1000; p.stack = 1000 + (p.id === 'me' ? net : p.id === ids.find(id => id !== 'me') ? -net : 0);
      if (p.id === 'me') p.cards = cards;
    }
    db.hands.push(h); return h;
  }
  return { db, service, room, users, add };
}
const ids = result => result.hands.map(h => h.id);
const rowFor = (result, id) => result.opponents.rows.find(row => row.id === id);

test('co-dealt opponent results overlap, count unique own hands once and exclude mini-game settlement', () => {
  const f = fixture(); f.add('multi', { ids: ['me', 'alice', 'bob'], net: 90, mini: 900 });
  f.add('alice', { net: -20, mini: 300 }); f.add('bob', { ids: ['me', 'bob'], net: 30, bb: 20 });
  const result = f.service.handLibrary('me');
  assert.equal(result.totals.net, 1300); assert.equal(result.opponents.uniqueHands, 3); assert.equal(result.opponents.net, 100);
  assert.equal(result.opponents.netBB, 8.5); assert.equal(result.opponents.bbHands, 3);
  const alice = rowFor(result, 'alice'), bob = rowFor(result, 'bob');
  assert.deepEqual([alice.hands, alice.net, alice.netBB, alice.wins, alice.losses, alice.even], [2, 70, 7, 1, 1, 0]);
  assert.deepEqual([bob.hands, bob.net, bob.netBB], [2, 120, 10.5]);
  assert.equal(alice.headsUpHands, 1); assert.equal(alice.headsUpNet, -20); assert.equal(alice.headsUpNetBB, -2);
  assert.equal(bob.headsUpHands, 1); assert.equal(bob.headsUpNet, 30);
  assert.notEqual(alice.net + bob.net, result.opponents.net);
});

test('opponent plus postflop filters require both players at the initial flop, not merely in the same dealt hand', () => {
  const f = fixture();
  f.add('alice-folded', { ids: ['me', 'alice', 'bob'], fold: ['alice'], net: 50 });
  f.add('three-flop', { ids: ['me', 'alice', 'bob'], net: 60 });
  f.add('hero-folded', { ids: ['me', 'alice', 'bob'], fold: ['me'], net: -10 });
  f.add('no-flop', { fold: ['me'], net: -5 });
  assert.equal(f.service.handLibrary('me', { opponent: 'alice' }).totals.count, 4);
  assert.deepEqual(ids(f.service.handLibrary('me', { opponent: 'alice', potType: 'headsUp' })), []);
  const headsUp = f.service.handLibrary('me', { potType: 'headsUp' });
  assert.deepEqual(ids(headsUp), ['alice-folded']); assert.deepEqual(headsUp.opponents.rows.map(row => row.id), ['bob']);
  const multiway = f.service.handLibrary('me', { opponent: 'alice', potType: 'multiway' });
  assert.deepEqual(ids(multiway), ['three-flop']); assert.deepEqual(multiway.opponents.rows.map(row => row.id), ['alice']);
  assert.deepEqual(new Set(ids(f.service.handLibrary('me', { potType: 'noFlop' }))), new Set(['hero-folded', 'no-flop']));
  assert.equal(rowFor(f.service.handLibrary('me'), 'alice').headsUpHands, 0);
});

test('opponent identity stays stable across renamed accounts, includes only met players and excludes observer hands', () => {
  const f = fixture(); f.add('own'); f.add('observed', { ids: ['alice', 'bob'] });
  f.users[1].name = '改过的新昵称'; delete f.db.users.alice; f.db.users['legacy-token'] = f.users[1];
  const result = f.service.handLibrary('me');
  assert.deepEqual(result.opponentOptions, [{ id: 'alice', name: '改过的新昵称' }]);
  assert.equal(rowFor(result, 'alice').name, '改过的新昵称');
  assert.deepEqual(ids(f.service.handLibrary('me', { opponent: 'alice' })), ['own']);
  assert.equal(f.service.handLibrary('observer').opponents.uniqueHands, 0);
  const observed = f.service.history('observer', f.room.code, { limit: '20' });
  assert.equal(observed.hands.length, 2); assert.deepEqual(observed.opponentOptions, []);
  assert.deepEqual(observed.opponents, { rows: [], uniqueHands: 0, net: 0, netBB: 0, bbHands: 0 });
  assert.deepEqual(f.service.handLibrary('stranger', { opponent: 'alice' }).hands, []);
  assert.deepEqual(f.service.handLibrary('me', { opponent: 'never-met-id' }).opponents.rows, []);
  assert.throws(() => f.service.handLibrary('me', { opponent: 'me' }), error => error.status === 400);
});

test('BB aggregates use each historical stake, expose coverage and do not round individual fractions', () => {
  const f = fixture(); f.room.settings.bigBlind = 200;
  f.add('third1', { net: 1, bb: 3 }); f.add('third2', { net: 1, bb: 3 }); f.add('third3', { net: 1, bb: 3 });
  f.add('fifth', { net: -1, bb: 5 }); f.add('missing-bb', { net: 20, bb: null });
  const result = f.service.handLibrary('me'), alice = rowFor(result, 'alice');
  assert.equal(result.opponents.netBB, 0.8); assert.equal(result.opponents.bbHands, 4); assert.equal(result.opponents.uniqueHands, 5);
  assert.equal(alice.net, 22); assert.equal(alice.netBB, 0.8); assert.equal(alice.bbHands, 4);
  assert.equal(alice.headsUpHands, 5); assert.equal(alice.headsUpBBHands, 4); assert.equal(alice.headsUpNetBB, 0.8);
});

test('combined opponent/position/flop/table/rank/date/result filters run before latest N and pagination totals', () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) f.add(`selected-${i}`, { net: 110 + i, at: `2026-10-13T10:00:0${i}.000Z` });
  f.add('wrong-cards', { cards: ['Qs', 'Js'], at: '2026-10-13T11:00:00.000Z' });
  f.add('wrong-date', { at: '2026-10-12T10:00:00.000Z' }); f.add('wrong-opponent', { ids: ['me', 'bob'] });
  f.add('wrong-size', { ids: ['me', 'alice', 'bob'] }); f.add('loss', { net: -110 });
  const query = { opponent: 'alice', position: 'SB', potType: 'headsUp', tableSize: 'headsUp', holeRanks: 'AK', holeType: 'suited',
    from: '2026-10-13', to: '2026-10-13', result: 'winOver', minBB: '10', maxHands: '5', limit: '2' };
  const first = f.service.handLibrary('me', query), second = f.service.handLibrary('me', { ...query, before: first.nextCursor }),
    third = f.service.handLibrary('me', { ...query, before: second.nextCursor });
  assert.deepEqual([...first.hands, ...second.hands, ...third.hands].map(h => h.id), ['selected-6', 'selected-5', 'selected-4', 'selected-3', 'selected-2']);
  assert.equal(first.totals.count, 5); assert.equal(first.totals.holdemNet, 570); assert.equal(first.opponents.net, 570);
  assert.deepEqual(first.totals, third.totals); assert.deepEqual(first.opponents, second.opponents); assert.equal(third.nextCursor, null);
  assert.equal(first.hands[0].position, 'BTN/SB'); assert.equal(first.hands[0].tableSize, 2); assert.equal(first.hands[0].flopPlayers, 2);
});

test('legacy unknown context can be filtered explicitly without guessing final states, and private peer cards are not read', () => {
  const f = fixture(); f.add('known'); const legacy = f.add('legacy'); delete legacy.buttonSeat; delete legacy.log;
  for (const h of f.db.hands) for (const p of h.players) if (p.id !== 'me') {
    Object.defineProperty(p, 'cards', { get() { throw new Error('opponent private cards were read'); } });
  }
  const result = f.service.handLibrary('me', { opponent: 'alice', position: 'unknown', potType: 'unknown' });
  assert.deepEqual(ids(result), ['legacy']); assert.equal(result.hands[0].flopPlayers, null);
  assert.equal(result.opponents.uniqueHands, 1); assert.equal(rowFor(result, 'alice').headsUpHands, 0);
  assert.deepEqual(result.hands[0].cards, ['As', 'Ks']);
  const reports = JSON.stringify({ options: result.opponentOptions, report: result.opponents });
  for (const secret of ['cards', 'deck', 'audit', 'invite', 'passwordHash', 'log']) assert.equal(reports.includes(`"${secret}"`), false);
});

test('advanced filters reject malformed inputs rather than silently widening their scope', () => {
  for (const query of [
    { opponent: {} }, { opponent: ['alice'] }, { opponent: true }, { opponent: ' alice ' }, { opponent: 'a'.repeat(129) },
    { position: 'BTN/SB' }, { position: 'btn' }, { potType: 'multi' }, { tableSize: '10' },
    ...['0', '-1', '1.2', '1e3', ' 100 ', '100001', {}, [], true, Infinity].map(maxHands => ({ maxHands })),
  ]) assert.throws(() => recordFilters(query), error => error.status === 400, JSON.stringify(query));
  for (const maxHands of ['all', '1', '100000', 7]) assert.ok(recordFilters({ maxHands }));
});

test('opponent appearance uses current profiles by stable ID and projects only the public whitelist', () => {
  const f = fixture(), hand = f.add('own'), peer = f.users[1];
  Object.assign(peer, { name: '新的昵称', avatar: 8, avatarImage: 'a'.repeat(32) });
  delete f.db.users.alice; f.db.users['legacy-private-token-key'] = peer;
  for (const key of ['username', 'passwordHash', 'recoveryHash', 'token', 'sessions', 'avatarUpload']) {
    Object.defineProperty(peer, key, { enumerable: true, get() { throw new Error(`must not read private profile ${key}`); } });
  }
  Object.defineProperty(hand.players.find(p => p.id === 'alice'), 'cards', { get() { throw new Error('must not inspect opponent cards'); } });
  const result = f.service.handLibrary('me'), row = rowFor(result, 'alice');
  assert.deepEqual([row.id, row.name, row.avatar, row.avatarImage], ['alice', '新的昵称', 8, 'a'.repeat(32)]);
  assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'avatar', 'avatarImage', 'hands', 'net', 'netBB', 'bbHands', 'wins', 'losses', 'even', 'headsUpHands', 'headsUpNet', 'headsUpNetBB', 'headsUpBBHands', 'lastAt'].sort());
  assert.deepEqual(result.opponentOptions, [{ id: 'alice', name: '新的昵称' }]);
  Object.assign(peer, { avatar: 3, avatarImage: 'b'.repeat(32) });
  const updated = rowFor(f.service.handLibrary('me'), 'alice');
  assert.deepEqual([updated.avatar, updated.avatarImage], [3, 'b'.repeat(32)]);
  assert.deepEqual([updated.hands, updated.net, updated.netBB], [row.hands, row.net, row.netBB]);
  assert.deepEqual(f.service.handLibrary('observer').opponents.rows, []);
});

test('opponent appearance sanitizes invalid or missing metadata and never lists unmet accounts', () => {
  const f = fixture(); f.add('own'); const peer = f.users[1];
  Object.assign(f.users[4], { avatar: 11, avatarImage: 'f'.repeat(32) });
  const bad = { toString() { throw new Error('avatar values must not be coerced'); } };
  for (const [avatar, avatarImage] of [[-1, '../private'], [12, 'A'.repeat(32)], ['2', ['a'.repeat(32)]], [1.5, 'data:image/png;base64,private'], [bad, bad], [undefined, undefined]]) {
    Object.assign(peer, { avatar, avatarImage });
    const result = f.service.handLibrary('me'), row = rowFor(result, 'alice');
    assert.equal(row.avatar, 0); assert.equal(row.avatarImage, null);
    assert.deepEqual(result.opponents.rows.map(row => row.id), ['alice']);
    assert.equal(JSON.stringify(result.opponents).includes('f'.repeat(32)), false);
  }
  delete f.db.users.alice;
  const missing = rowFor(f.service.handLibrary('me'), 'alice');
  assert.deepEqual([missing.name, missing.avatar, missing.avatarImage], ['alice', 0, null]);
});
