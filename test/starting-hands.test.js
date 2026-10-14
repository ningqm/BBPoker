import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTING_HAND_PRESETS, normalizeStartingHandFilter as normalize, matchesStartingHand, startingHandSummary } from '../public/starting-hands.js';

const deck = [...'23456789TJQKA'].flatMap(rank => [...'shdc'].map(suit => rank + suit));
const combinations = deck.flatMap((card, index) => deck.slice(index + 1).map(other => [card, other]));
const matches = (cards, filter) => matchesStartingHand(cards, normalize(filter));

test('preset sets cover the independently known counts among all 1326 physical starting hands', () => {
  const counts = { all: 1326, pair: 78, bigPair: 30, suitedConnector: 48, offsuitConnector: 144, suitedGapper: 44, suitedAce: 48, broadway: 160, premium: 34 };
  assert.deepEqual(STARTING_HAND_PRESETS.map(p => p.id), Object.keys(counts));
  for (const { id, label, description } of STARTING_HAND_PRESETS) {
    assert.ok(label && description);
    const filter = normalize({ holePreset: id });
    assert.equal(combinations.filter(cards => matchesStartingHand(cards, filter)).length, counts[id], id);
    for (const cards of combinations) assert.equal(matchesStartingHand(cards, filter), matchesStartingHand([...cards].reverse(), filter), `${id}: ${cards}`);
  }
});

test('connector, gapper, broadway and premium boundaries use ace high and explicitly exclude wheel wraps', () => {
  const cases = [
    ['suitedConnector', ['3h', '2h'], true], ['suitedConnector', ['As', 'Ks'], true], ['suitedConnector', ['Ah', '2h'], false],
    ['suitedConnector', ['Qs', 'Ks'], true], ['offsuitConnector', ['2h', '3d'], true], ['offsuitConnector', ['Qh', 'Kd'], true],
    ['offsuitConnector', ['Qc', 'Ks'], true], ['offsuitConnector', ['Ah', 'Ks'], true], ['offsuitConnector', ['Ah', '2s'], false],
    ['offsuitConnector', ['Qs', 'Ks'], false], ['offsuitConnector', ['Ah', 'Ac'], false], ['offsuitConnector', ['Qs', 'Ah'], false],
    ['suitedConnector', ['7h', '6d'], false], ['suitedGapper', ['4c', '2c'], true], ['suitedGapper', ['Ad', 'Qd'], true],
    ['suitedGapper', ['As', '3s'], false], ['suitedGapper', ['As', 'Ks'], false],
    ['bigPair', ['Ts', 'Th'], true], ['bigPair', ['9s', '9d'], false],
    ['broadway', ['Ts', 'Jh'], true], ['broadway', ['Ad', 'Ac'], false], ['broadway', ['9s', 'Ac'], false],
    ['premium', ['Qs', 'Qh'], true], ['premium', ['Js', 'Jh'], false], ['premium', ['Ad', 'Ks'], true], ['premium', ['Ad', 'Qd'], false],
    ['suitedAce', ['2s', 'As'], true], ['suitedAce', ['Ah', 'Ad'], false],
  ];
  for (const [holePreset, cards, expected] of cases) assert.equal(matches(cards, { holePreset }), expected, `${holePreset}: ${cards}`);
});

test('suited and offsuit connectors partition the 192 adjacent-rank physical hands without confusing red/black with suits', () => {
  // Twelve adjacent rank pairs × sixteen suit combinations; the wheel is
  // deliberately separate. This list is independent of the matcher arithmetic.
  const adjacent = new Set(['23', '34', '45', '56', '67', '78', '89', '9T', 'TJ', 'JQ', 'QK', 'KA']);
  let count = 0;
  for (const cards of combinations) {
    const suited = matches(cards, { holePreset: 'suitedConnector' });
    const offsuit = matches(cards, { holePreset: 'offsuitConnector' });
    const ranks = cards.map(card => card[0]).join('');
    assert.equal(suited && offsuit, false, `disjoint: ${cards}`);
    assert.equal(suited || offsuit, adjacent.has(ranks), `complete partition: ${cards}`);
    if (suited || offsuit) count++;
  }
  assert.equal(count, 192);
  assert.equal(matches(['Kh', 'Qd'], { holePreset: 'offsuitConnector' }), true, 'two red suits are still offsuit');
  assert.equal(matches(['Ks', 'Qc'], { holePreset: 'offsuitConnector' }), true, 'two black suits are still offsuit');
});

test('each custom card preserves its own rank/suit association and matches either dealt order', () => {
  const filter = { holeRank1: 'A', holeSuit1: 's', holeRank2: 'K', holeSuit2: 'red' };
  assert.equal(matches(['As', 'Kh'], filter), true); assert.equal(matches(['Kd', 'As'], filter), true);
  assert.equal(matches(['Ah', 'Ks'], filter), false); assert.equal(matches(['As', 'Kc'], filter), false);
  assert.equal(matches(['As', 'Kh'], { holeRank1: 'A', holeSuit2: 's' }), false, 'one card cannot satisfy both separate slots');
  assert.equal(matches(['As', 'Ks'], { holeRank1: 'A', holeSuit2: 's' }), true);
  assert.equal(matches(['As', 'Kh'], { holeRank1: 'A', holeRank2: 'A' }), false);
  assert.equal(matches(['Ah', 'Ad'], { holeRank1: 'A', holeSuit1: 'red', holeRank2: 'A', holeSuit2: 'red' }), true);
});

test('rank-only, suit-only and red/black selections remain independently optional', () => {
  assert.equal(matches(['Ah', 'Kd'], { holeSuit1: 'red', holeSuit2: 'red' }), true);
  assert.equal(matches(['Ah', 'Kd'], { holeSuit1: 'red', holeSuit2: 'black' }), false);
  assert.equal(matches(['As', 'Kc'], { holeSuit1: 'black', holeSuit2: 'black' }), true);
  assert.equal(matches(['Ah', 'Kd'], { holeRank2: 'K' }), true);
  assert.equal(matches(['Ah', 'Kd'], { holeSuit2: 's' }), false);
  assert.equal(matches(['Kh', 'Kd'], { holeSuit1: 'red', holeSuit2: 'red', holeType: 'pair' }), true);
  assert.equal(matches(['Kh', 'Kd'], { holeType: 'offsuit' }), false);
  assert.equal(matches(['Ks', 'As'], { holeType: 'suited' }), true);
});

test('custom conditions override a stale preset without an invisible intersection or input mutation', () => {
  const input = { holePreset: 'pair', holeRank1: ' a ', holeSuit2: 'black' }, copy = structuredClone(input);
  assert.deepEqual(normalize(input), { holePreset: 'all', holeRank1: 'A', holeSuit1: '', holeRank2: '', holeSuit2: 'black', holeType: 'all' });
  assert.deepEqual(input, copy); assert.equal(matches(['Ah', 'Kc'], input), true);
  assert.equal(normalize({ holePreset: 'pair', holeType: 'suited' }).holePreset, 'all');
  assert.equal(matches(['Ah', 'Kh'], { holePreset: 'pair', holeType: 'suited' }), true);
  assert.equal(normalize({ holePreset: 'pair', holeType: 'all', holeRank1: '' }).holePreset, 'pair');
});

test('normalization rejects malformed values and duplicated exact cards without coercion', () => {
  for (const input of [null, false, [], 'A', { holePreset: 'random' }, { holeType: 'other' },
    ...[[], {}, true, 10, 'AA', '10', 'As', ' '].map(holeRank1 => ({ holeRank1 })),
    ...[[], {}, true, 'hearts', 'S', 'RED'].map(holeSuit1 => ({ holeSuit1 })),
    { holePreset: ['pair'] }, { holeType: ['pair'] }]) assert.throws(() => normalize(input), e => e.status === 400, JSON.stringify(input));
  assert.throws(() => normalize({ holeRank1: 'A', holeSuit1: 'h', holeRank2: 'a', holeSuit2: 'h' }), /同一张牌/);
  assert.equal(matches(['Ah', 'Ad'], { holeRank1: 'A', holeRank2: 'A', holeType: 'suited' }), false);
});

test('incomplete, malformed and duplicated physical cards never match the shared helper', () => {
  for (const cards of [undefined, null, [], ['As'], ['As', 'Kh', '2d'], [null, null], ['As', 'As'], ['A♠', 'K♥'], ['as', 'kh']]) {
    assert.equal(matches(cards, {}), false); assert.equal(matches(cards, { holePreset: 'pair' }), false);
  }
});

test('summaries describe custom suits, arbitrary ordering and normalized preset precedence plainly', () => {
  assert.equal(startingHandSummary(), '不限起手牌');
  assert.match(startingHandSummary({ holePreset: 'premium' }), /AA、KK、QQ 或 AK/);
  assert.match(startingHandSummary({ holeRank1: 'T', holeSuit1: 'h', holeSuit2: 'black' }), /红桃 10.*黑色 任意点数.*顺序不限/);
  assert.equal(startingHandSummary({ holeType: 'suited' }), '同花且非对子');
  assert.equal(startingHandSummary({ holePreset: 'pair', holeRank1: 'A' }), 'A + 任意牌（顺序不限）');
});
