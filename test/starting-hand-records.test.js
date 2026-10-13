import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomService } from '../src/room.js';
import { recordFilters } from '../src/records.js';

const AT = '2026-10-14T08:00:00.000Z';
function fixture() {
  const users = Object.fromEntries(['me', 'a', 'b', 'observer', 'outsider'].map(id => [id, { id, name: id, avatar: 0 }]));
  const store = { data: { version: 1, users, rooms: {}, hands: [], ledger: [] } }, service = new RoomService(store);
  const rooms = [service.create(users.me, { name: '第一桌' }), service.create(users.b, { name: '第二桌' })];
  for (const room of rooms) for (const id of ['me', 'a', 'b', 'observer']) if (!room.members[id]) service.join(users[id], room.code, room.invite);
  function add(id, { room = rooms[0], number = 12, cards = ['As', 'Ks'], peer = 'a', net = 100, bb = 10, at = AT, status = 'complete', hero = true } = {}) {
    const hand = { id, number, roomCode: room.code, roomName: room.name, status, at, settings: { ...room.settings, bigBlind: bb }, board: [],
      button: 0, smallBlindSeat: 0, bigBlindSeat: 1,
      players: [{ id: peer, name: peer, seat: 1, startingStack: 2000, stack: 2000 - net, cards: ['Qh', 'Qd'] }],
      log: [], miniChanges: {}, result: { pots: [{ amount: 200 }], payouts: {}, mainWinnerIds: [] } };
    if (hero) hand.players.unshift({ id: 'me', name: 'me', seat: 0, startingStack: 2000, stack: 2000 + net, cards });
    store.data.hands.push(hand); return hand;
  }
  return { service, users, rooms, add, db: store.data };
}
const ids = result => result.hands.map(h => h.id).sort();

test('hand number uses a positive safe integer with strict input types and exact matching', () => {
  for (const input of ['', null, undefined]) assert.equal(recordFilters({ handNumber: input }).handNumber, null);
  for (const input of ['12', '00012', 12, Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) assert.equal(recordFilters({ handNumber: input }).handNumber, Number(input));
  for (const input of ['0', '000', 0, -1, '1.0', '1e2', '+12', ' 12', '12 ', '12x', true, {}, [], ['12'], NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => recordFilters({ handNumber: input }), e => e.status === 400, String(input));
  }
  const f = fixture(); f.add('exact'); f.add('other-number', { number: 112 }); f.add('live', { status: 'playing' }); f.add('not-my-hand', { hero: false });
  assert.deepEqual(ids(f.service.handLibrary('me', { handNumber: '0012' })), ['exact']);
  assert.equal(f.service.handLibrary('me', { handNumber: '2' }).totals.count, 0);
});

test('exact number across rooms filters list, mixed-blind totals and opponent cohort consistently', () => {
  const f = fixture();
  f.add('twelve-first', { net: 120 });
  f.add('twelve-second', { room: f.rooms[1], peer: 'b', net: -60, bb: 20, cards: ['Ah', 'Kh'] });
  f.add('not-twelve', { number: 112, net: 999 }); f.add('peer-only', { hero: false });
  const result = f.service.handLibrary('me', { handNumber: '12' });
  assert.deepEqual(ids(result), ['twelve-first', 'twelve-second']); assert.equal(result.totals.net, 60); assert.equal(result.totals.bb.net, 9);
  assert.equal(result.opponents.uniqueHands, 2); assert.equal(result.opponents.net, 60); assert.equal(result.opponents.netBB, 9);
  assert.deepEqual(result.opponents.rows.map(row => [row.id, row.net]).sort(), [['a', 120], ['b', -60]]);
  assert.deepEqual(ids(f.service.handLibrary('me', { handNumber: '12', room: f.rooms[0].code })), ['twelve-first']);
  assert.deepEqual(ids(f.service.handLibrary('me', { handNumber: '12', holePreset: 'suitedAce', opponent: 'a', result: 'winOver', minBB: '10', from: '2026-10-14', to: '2026-10-14' })), ['twelve-first']);
});

test('presets and per-card color/rank filters select only own two cards in either order', () => {
  const f = fixture();
  f.add('aa', { cards: ['Ah', 'Ad'] }); f.add('aks', { cards: ['Ks', 'As'] }); f.add('ako', { cards: ['Ah', 'Kc'] });
  f.add('76s', { cards: ['7h', '6h'] }); f.add('75s', { cards: ['7s', '5s'] }); f.add('a2s', { cards: ['Ad', '2d'] }); f.add('22', { cards: ['2h', '2d'] });
  const find = query => ids(f.service.handLibrary('me', query));
  assert.deepEqual(find({ holePreset: 'pair' }), ['22', 'aa']); assert.deepEqual(find({ holePreset: 'bigPair' }), ['aa']);
  assert.deepEqual(find({ holePreset: 'suitedConnector' }), ['76s', 'aks']); assert.deepEqual(find({ holePreset: 'suitedGapper' }), ['75s']);
  assert.deepEqual(find({ holePreset: 'suitedAce' }), ['a2s', 'aks']); assert.deepEqual(find({ holePreset: 'broadway' }), ['ako', 'aks']);
  assert.deepEqual(find({ holePreset: 'premium' }), ['aa', 'ako', 'aks']);
  assert.deepEqual(find({ holeSuit1: 'red', holeSuit2: 'red' }), ['22', '76s', 'a2s', 'aa']);
  assert.deepEqual(find({ holeRank1: 'A', holeSuit1: 'h', holeRank2: 'K', holeSuit2: 'black' }), ['ako']);
  assert.deepEqual(find({ holeRank1: 'K', holeSuit1: 'black', holeRank2: 'A', holeSuit2: 'h' }), ['ako']);
  assert.deepEqual(find({ holeRank1: 'A', holeSuit2: 'black' }), ['ako', 'aks']);
});

test('legacy rank clients remain compatible while new custom fields replace stale preset/legacy fields', () => {
  const f = fixture(); f.add('aa', { cards: ['Ah', 'Ad'] }); f.add('aks'); f.add('76s', { cards: ['7h', '6h'] });
  const find = query => ids(f.service.handLibrary('me', query));
  assert.deepEqual(find({ holeRanks: 'ka', holeType: 'suited' }), ['aks']);
  assert.deepEqual(find({ holeRanks: 'AA', holeType: 'suited' }), []); assert.deepEqual(find({ holeRanks: 'AK', holeType: 'pair' }), []);
  assert.deepEqual(find({ holePreset: 'pair', holeRank1: '7', holeType: 'suited' }), ['76s']);
  assert.deepEqual(find({ holeRanks: 'AK', holeRank1: '7', holeRank2: '', holeType: 'suited' }), ['76s']);
  assert.deepEqual(find({ holePreset: 'pair', holeType: 'suited' }), ['76s', 'aks']);
  assert.throws(() => f.service.handLibrary('me', { holeRank1: 'A', holeSuit1: 'h', holeRank2: 'A', holeSuit2: 'h' }), e => e.status === 400);
});

test('private peer cards are never read and observer records only survive unrestricted starting-hand queries', () => {
  const f = fixture();
  const h = f.add('own-low', { cards: ['2s', '3d'] });
  Object.defineProperty(h.players.find(p => p.id === 'a'), 'cards', { get() { throw new Error('must never inspect peer cards'); } });
  assert.deepEqual(ids(f.service.handLibrary('me', { holePreset: 'premium' })), []);
  assert.deepEqual(ids(f.service.handLibrary('me', { holeSuit1: 's', holeSuit2: 'red' })), ['own-low']);
  assert.deepEqual(ids(f.service.history('observer', f.rooms[0].code, { handNumber: '12' })), ['own-low']);
  for (const query of [{ holePreset: 'pair' }, { holeSuit1: 'red' }, { holeRank2: 'A' }, { holeType: 'offsuit' }]) {
    assert.deepEqual(ids(f.service.history('observer', f.rooms[0].code, query)), []);
  }
  for (const cards of [undefined, [null, null], ['As', 'As'], ['As']]) {
    h.players[0].cards = cards;
    assert.deepEqual(ids(f.service.handLibrary('me', { holeSuit1: 's' })), []);
  }
});

test('number and starting-card filters apply before latest-N, pagination and full-match aggregates', () => {
  const f = fixture();
  for (let n = 0; n < 27; n++) f.add(`match-${String(n).padStart(2, '0')}`, { cards: ['Kh', 'Ah'], net: 20 });
  f.add('wrong-number', { number: 112 }); f.add('wrong-rank', { cards: ['3h', '4h'] }); f.add('wrong-suit', { cards: ['As', 'Ks'] });
  const query = { handNumber: '12', holeRank1: 'A', holeSuit1: 'red', holeType: 'suited', limit: '20' };
  const first = f.service.handLibrary('me', query), second = f.service.handLibrary('me', { ...query, before: first.nextCursor });
  assert.equal(first.hands.length, 20); assert.equal(second.hands.length, 7); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.hands, ...second.hands].map(h => h.id)).size, 27);
  assert.equal(first.totals.count, 27); assert.equal(first.totals.net, 540); assert.equal(first.opponents.uniqueHands, 27);
  assert.deepEqual(first.totals, second.totals); assert.deepEqual(first.opponents, second.opponents);
  const limited = f.service.handLibrary('me', { ...query, maxHands: '3' });
  assert.deepEqual(ids(limited), ['match-24', 'match-25', 'match-26']); assert.equal(limited.totals.count, 3); assert.equal(limited.opponents.net, 60);
});
