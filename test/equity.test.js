import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/poker.js';
import { calculateEquity, equityScore } from '../src/equity.js';

const canonical = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
const encode = tuple => tuple[0] * 15 ** 5 + tuple.slice(1).reduce((sum, rank, i) => sum + rank * 15 ** (4 - i), 0);
const players = cards => cards.map((c, i) => ({ id: String(i), seat: i, contributed: 100, cards: c.split(' ') }));
const input = (cards, board = '') => ({ players: players(cards), board: board ? board.split(' ') : [], pots: [{ amount: cards.length * 100, eligibleIds: cards.map((_, i) => String(i)) }], buttonSeat: 0 });

test('fast evaluator matches independent 5-card enumeration for every category and deterministic random hands', () => {
  const cases = [
    'As Kd 9h 7c 3s', 'As Ad Kh 7c 3s', 'As Ad Kh Kc 3s', 'As Ad Ah Kc 3s',
    'As 2d 3h 4c 5s', 'As Js 9s 7s 3s', 'As Ad Ah Kc Ks', 'As Ad Ah Ac Ks', 'As Ks Qs Js Ts',
    'As Ad Ah Kc Ks Kh 2d', 'As Ad Kc Qh Js 9c 2h', 'As 2s 3s 4s 5s 9s Ts',
    '2h 3h 4h 6h 7h 5c 5s', 'As Ad Kh Kc Qs Qc Jd',
  ].map(s => s.split(' '));
  let state = 918731;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  for (let i = 0; i < 1800; i++) {
    const deck = [...canonical];
    for (let j = 0; j < 7; j++) { const k = j + random(52 - j); [deck[j], deck[k]] = [deck[k], deck[j]]; }
    cases.push(deck.slice(0, 5 + i % 3));
  }
  for (const cards of cases) assert.equal(equityScore(cards), encode(evaluate(cards).tuple), cards.join(' '));
});

test('turn exact enumeration agrees with original evaluator and conserves payout', () => {
  const value = input(['Ah Ad', 'Kh Qh', 'Tc Td'], 'Jh 9h 2c 3s');
  const result = calculateEquity(value);
  assert.equal(result.method, 'exact');
  assert.equal(result.samples, 42);
  const remaining = canonical.filter(c => ![...value.board, ...value.players.flatMap(p => p.cards)].includes(c));
  const shares = [0, 0, 0];
  for (const card of remaining) {
    const scores = value.players.map(p => encode(evaluate([...p.cards, ...value.board, card]).tuple));
    const best = Math.max(...scores), winners = scores.map((s, i) => s === best ? i : -1).filter(i => i >= 0);
    for (const i of winners) shares[i] += 1 / winners.length;
  }
  result.players.forEach((p, i) => assert.ok(Math.abs(p.equity - shares[i] / remaining.length * 100) < 1e-10));
  assert.ok(Math.abs(result.players.reduce((sum, p) => sum + p.expectedPayout, 0) - 300) < 1e-9);
});

test('complete-board ties split equity, with odd chips clockwise after the button in each side pot', () => {
  const value = input(['2c 3c', '4d 5d', '6h 7h'], 'As Ks Qs Js Ts');
  value.players[0].contributed = 3; value.players[1].contributed = 5; value.players[2].contributed = 5;
  value.pots = [{ amount: 9, eligibleIds: ['0', '1', '2'] }, { amount: 5, eligibleIds: ['1', '2'] }];
  const result = calculateEquity(value);
  assert.equal(result.samples, 1);
  assert.deepEqual(result.players.map(p => p.expectedPayout), [3, 6, 5]);
  result.players.forEach(p => { assert.ok(Math.abs(p.equity - 100 / 3) < 1e-10); assert.equal(p.winPct, 0); assert.equal(p.tiePct, 100); });
  assert.deepEqual(result.pots[1].players.map(p => p.expectedPayout), [3, 2]);
  value.buttonSeat = 1;
  assert.deepEqual(calculateEquity(value).pots[1].players.map(p => p.expectedPayout), [2, 3]);
});

test('side pots use actual eligible players, not main-pot equity multiplied by whole pot', () => {
  const value = input(['Ah Ad', 'Kh Kd', 'Qh Qd'], 'Ac Ks Qc 2d 3c');
  value.players.forEach((p, i) => { p.contributed = [50, 100, 100][i]; });
  value.pots = [{ amount: 150, eligibleIds: ['0', '1', '2'] }, { amount: 100, eligibleIds: ['1', '2'] }];
  const result = calculateEquity(value);
  assert.deepEqual(result.players.map(p => p.equity), [100, 0, 0]);
  assert.deepEqual(result.players.map(p => p.expectedPayout), [150, 100, 0]);
  assert.deepEqual(result.players.map(p => p.expectedNet), [100, 0, -100]);
  assert.deepEqual(result.pots[1].players.map(p => p.equity), [100, 0]);
});

test('preflop simulation is deterministic, approximate, input-only, and close to established AA versus KK odds', () => {
  const value = input(['Ah Ad', 'Kh Kd']);
  const before = structuredClone(value);
  const a = calculateEquity(value), b = calculateEquity({ ...value, deck: ['future cards must be ignored'], burnIndices: [0] });
  assert.deepEqual(a, b);
  assert.deepEqual(value, before);
  assert.equal(a.method, 'monte-carlo');
  assert.equal(a.samples, 20000);
  assert.ok(a.error95Pct > 0 && a.error95Pct < 0.7);
  assert.ok(a.players[0].equity > 80 && a.players[0].equity < 84);
  assert.ok(Math.abs(a.players.reduce((sum, p) => sum + p.equity, 0) - 100) < 1e-8);
  assert.ok(Math.abs(a.players.reduce((sum, p) => sum + p.expectedNet, 0)) < 1e-8);
});

test('flop and partial-flop calculations condition only on currently revealed cards', () => {
  for (const board of ['2c', '2c 3d', '2c 3d 4h']) {
    const result = calculateEquity(input(['Ah Ad', 'Kh Kd'], board));
    assert.equal(result.board.join(' '), board);
    assert.equal(result.method, board.split(' ').length === 3 ? 'exact' : 'monte-carlo');
    assert.ok(Math.abs(result.players.reduce((sum, p) => sum + p.equity, 0) - 100) < 1e-8);
  }
});

test('nine-way equity remains bounded and validates malformed public inputs', () => {
  const value = input(['Ac Ad', 'Kc Kd', 'Qc Qd', 'Jc Jd', 'Tc Td', '9c 9d', '8c 8d', '7c 7d', '6c 6d']);
  const result = calculateEquity({ ...value, samples: 2000 });
  assert.ok(result.players.every(p => p.equity >= 0 && p.equity <= 100));
  assert.ok(Math.abs(result.players.reduce((sum, p) => sum + p.expectedPayout, 0) - 900) < 1e-8);
  assert.throws(() => calculateEquity(input(['Ac Ad', 'Ac Kd'])), /重复/);
  assert.throws(() => calculateEquity({ ...value, board: ['no'] }), /无效/);
  assert.throws(() => calculateEquity({ ...value, pots: [{ amount: 2, eligibleIds: ['stranger'] }] }), /底池/);
  assert.throws(() => calculateEquity({ ...value, samples: 100001 }), /参数/);
});
