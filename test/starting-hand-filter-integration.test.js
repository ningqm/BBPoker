import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomService } from '../src/room.js';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';

const allCards = [...'cdhs'].flatMap(suit => [...'23456789TJQKA'].map(rank => rank + suit));
function fixture() {
  const users = ['me', 'alice', 'bob', 'observer', 'stranger'].map(id => ({ id, name: id, avatar: 0 }));
  const db = { version: 1, users: Object.fromEntries(users.map(user => [user.id, user])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data: db });
  const a = service.create(users[0], { name: '同名朋友局' }), b = service.create(users[1], { name: '同名朋友局' });
  for (const room of [a, b]) for (const user of users.slice(0, 4)) service.join(user, room.code, room.invite);
  const add = (id, cards, { room = a, number = db.hands.length + 1000, peers = ['alice'], lose = false, peerCards = null } = {}) => {
    const ids = ['me', ...peers], count = ids.length, deck = new Array(52);
    deck[count - 1] = cards[0]; deck[count * 2 - 1] = cards[1];
    if (peerCards) { deck[0] = peerCards[0]; deck[count] = peerCards[1]; }
    const occupied = deck.filter(Boolean), rest = allCards.filter(card => !occupied.includes(card));
    for (let i = 0; i < deck.length; i++) if (!deck[i]) deck[i] = rest.shift();
    const hand = createHand({ id, players: ids.map((id, seat) => ({ id, name: id, seat, stack: 2000 })), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    Object.assign(hand, { number, at: `2026-10-14T10:${String(db.hands.length).padStart(2, '0')}:00.000Z`, roomCode: room.code, roomName: room.name,
      settings: { ...room.settings, smallBlind: 5, bigBlind: 10 }, shown: {}, miniChanges: {}, miniBefore: {}, miniAfter: {}, timeBankUses: [] });
    hand.audit = commitDeck(hand);
    while (hand.status === 'playing') {
      const actor = hand.actingId, actions = availableActions(hand, actor), winner = lose ? peers[0] : 'me';
      applyAction(hand, actor, hand.street !== 'preflop' && actor !== winner ? 'fold' : actions.canCheck ? 'check' : 'call');
    }
    hand.endingStacks = Object.fromEntries(hand.players.map(player => [player.id, player.stack]));
    assert.deepEqual(hand.players.find(player => player.id === 'me').cards, cards);
    db.hands.push(hand); return hand;
  };
  add('a-aa', ['As', 'Ah']);
  add('a-aks', ['As', 'Ks'], { peers: ['alice', 'bob'] });
  add('a-ako', ['As', 'Kh'], { lose: true });
  add('a-76s', ['7s', '6s']);
  add('a-75s', ['7h', '5h']);
  add('a-a2s', ['As', '2s']);
  add('a-22', ['2c', '2d']);
  add('a-black-ak', ['Ac', 'Ks']);
  add('a-red-ak', ['Ah', 'Kd']);
  add('a-12', ['Qs', 'Jh'], { number: 12 });
  add('a-112', ['Qh', 'Jh'], { number: 112 });
  add('a-reverse-65s', ['5d', '6d']);
  add('a-a3s', ['Ah', '3h']);
  add('a-aqs', ['Ad', 'Qd']);
  add('a-qq', ['Qc', 'Qs']);
  add('b-aa', ['Ad', 'Ah'], { room: b });
  add('b-12', ['Kh', 'As'], { room: b, number: 12 });
  add('b-112', ['2s', '2h'], { room: b, number: 112 });
  add('b-private-aa', ['Ts', '9h'], { room: b, peerCards: ['Ac', 'Ad'] });
  return { service, db, a, b, add };
}
const ids = result => result.hands.map(hand => hand.id).sort();
const read = (f, query = {}, user = 'me') => f.service.handLibrary(user, { limit: '50', ...query });

test('presets match completed real hands and document ace-edge boundaries', () => {
  const f = fixture();
  const cases = [
    ['pair', ['a-aa', 'a-22', 'a-qq', 'b-aa', 'b-112']],
    ['bigPair', ['a-aa', 'a-qq', 'b-aa']],
    ['suitedConnector', ['a-aks', 'a-76s', 'a-112', 'a-reverse-65s']],
    ['suitedGapper', ['a-75s', 'a-aqs']],
    ['suitedAce', ['a-aks', 'a-a2s', 'a-a3s', 'a-aqs']],
    ['premium', ['a-aa', 'a-qq', 'a-aks', 'a-ako', 'a-black-ak', 'a-red-ak', 'b-aa', 'b-12']],
  ];
  for (const [holePreset, expected] of cases) assert.deepEqual(ids(read(f, { holePreset })), expected.sort(), holePreset);
});

test('custom rank and suit are bound to the same card, slots are distinct and order is irrelevant', () => {
  const f = fixture();
  assert.deepEqual(ids(read(f, { holeRank1: 'A', holeSuit1: 's', holeRank2: 'K', holeSuit2: 'h' })), ['a-ako', 'b-12']);
  assert.deepEqual(ids(read(f, { holeRank1: 'K', holeSuit1: 'h', holeRank2: 'A', holeSuit2: 's' })), ['a-ako', 'b-12']);
  assert.deepEqual(ids(read(f, { holeRank1: 'A', holeSuit1: 'red', holeRank2: 'A', holeSuit2: 'black' })), ['a-aa']);
  assert.deepEqual(ids(read(f, { holeSuit1: 'black', holeSuit2: 'black' })), ['a-76s', 'a-a2s', 'a-aks', 'a-black-ak', 'a-qq']);
  assert.deepEqual(ids(read(f, { holeSuit1: 'red', holeSuit2: 'red' })), ['a-112', 'a-75s', 'a-a3s', 'a-aqs', 'a-red-ak', 'a-reverse-65s', 'b-aa']);
  const oneAcePlusSeparateSpade = ids(read(f, { holeRank1: 'A', holeSuit2: 's' }));
  assert.deepEqual(oneAcePlusSeparateSpade, ['a-a2s', 'a-aa', 'a-aks', 'a-black-ak']);
  assert.ok(!oneAcePlusSeparateSpade.includes('a-ako'), 'As cannot satisfy both the A slot and separate spade slot');
  assert.throws(() => read(f, { holeRank1: 'A', holeSuit1: 'h', holeRank2: 'A', holeSuit2: 'h' }), error => error.status === 400);
  assert.deepEqual(ids(read(f, { holeRank1: 'A', holeSuit1: 'h', holeRank2: 'K', holeSuit2: 's', holeType: 'suited' })), []);
});

test('custom selections replace a stale preset and do not inherit invisible legacy constraints', () => {
  const f = fixture();
  const custom = { holeRank1: '7', holeSuit1: 'h', holeRank2: '5', holeSuit2: 'h' };
  assert.deepEqual(ids(read(f, { holePreset: 'bigPair', ...custom })), ['a-75s']);
  assert.deepEqual(ids(read(f, { holeRanks: 'AK', holeType: 'suited' })), ['a-aks'], 'old explicit API rank filter remains compatible');
  assert.deepEqual(ids(read(f, { holePreset: 'pair', holeRanks: 'AK' })), ['a-22', 'a-aa', 'a-qq', 'b-112', 'b-aa'], 'new explicit preset wins over old ranks');
  assert.deepEqual(ids(read(f, { holeSuit1: 'red', holeSuit2: 'red', holeRanks: 'AK' })), ids(read(f, { holeSuit1: 'red', holeSuit2: 'red' })), 'suit-only custom selections do not inherit obsolete ranks');
});

test('exact hand numbers intersect a selected room and never match longer hand numbers', () => {
  const f = fixture();
  assert.deepEqual(ids(read(f, { handNumber: '12' })), ['a-12', 'b-12']);
  assert.deepEqual(ids(read(f, { handNumber: '0012' })), ['a-12', 'b-12']);
  assert.deepEqual(ids(read(f, { handNumber: '12', room: f.a.code })), ['a-12']);
  assert.deepEqual(ids(read(f, { handNumber: '112', room: f.b.code })), ['b-112']);
  assert.deepEqual(ids(read(f, { handNumber: '12', holeRank1: 'A', holeRank2: 'K' })), ['b-12']);
  for (const handNumber of ['0', '-12', '1.2', '1e2', '12abc', {}, [], true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => read(f, { handNumber }), error => error.status === 400, String(handNumber));
  }
  assert.throws(() => read(f, { room: f.a.code, handNumber: '12' }, 'stranger'), error => error.status === 403);
});

test('starting-hand matches precede opponent, latest-N pagination and whole-result totals', () => {
  const f = fixture();
  for (let index = 0; index < 5; index++) f.add(`late-aks-${index}`, ['As', 'Ks'], { number: 200 + index });
  const query = { holePreset: 'suitedAce', opponent: 'alice', potType: 'headsUp', position: 'BTN', tableSize: 'headsUp', room: f.a.code, maxHands: '3', limit: '2' };
  const first = read(f, query), second = read(f, { ...query, before: first.nextCursor });
  assert.deepEqual([...first.hands, ...second.hands].map(hand => hand.id), ['late-aks-4', 'late-aks-3', 'late-aks-2']);
  assert.equal(first.totals.count, 3); assert.equal(first.opponents.uniqueHands, 3);
  assert.deepEqual(first.totals, second.totals); assert.deepEqual(first.opponents, second.opponents); assert.equal(second.nextCursor, null);
});

test('starting filters cannot infer observer or opponent cards and projections remain private', () => {
  const f = fixture();
  assert.ok(!ids(read(f, { holePreset: 'pair' })).includes('b-private-aa'));
  const visible = f.service.handFor('me', f.b.code, 'b-private-aa');
  assert.deepEqual(visible.players.find(player => player.id === 'alice').cards, [null, null]);
  const observerAll = f.service.history('observer', f.a.code, { limit: '50' });
  assert.ok(observerAll.hands.length > 0);
  assert.deepEqual(f.service.history('observer', f.a.code, { limit: '50', holeSuit1: 'black' }).hands, []);
  for (const hand of f.db.hands) for (const player of hand.players) if (player.id !== 'me') {
    Object.defineProperty(player, 'cards', { get() { throw new Error('filter read another player’s private cards'); } });
  }
  const result = read(f, { holePreset: 'premium' });
  assert.ok(result.hands.length > 0);
  for (const row of result.hands) {
    for (const field of ['players', 'deck', 'audit', 'salts', 'proofs', 'log', 'invite']) assert.equal(Object.hasOwn(row, field), false, field);
  }
});
