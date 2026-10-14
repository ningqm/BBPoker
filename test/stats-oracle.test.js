import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, advanceRunout, availableActions } from '../src/poker.js';
import { calculateEquity } from '../src/equity.js';
import { aggregateAnalytics } from '../src/analytics.js';
import { publicPlayerStats } from '../src/player-stats.js';
import { versusStats } from '../src/versus-stats.js';

// Controlled engine fixtures. Expected chips, ratios and EV below are hand
// calculated from the stated pots / winning river cards, not from another stats
// function, an evaluator, or the engine's result as an expected-value oracle.
const PACK = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
function fixture({ ids = ['A', 'B'], stacks = ids.map(() => 100), holes, board, bb = 10, room = '100001', id = 'oracle', deferred = true } = {}) {
  const assigned = new Map(), order = [...ids.slice(1), ids[0]];
  for (let i = 0; i < 2; i++) order.forEach((p, j) => assigned.set(i * ids.length + j, holes[p][i]));
  [ids.length * 2 + 1, ids.length * 2 + 2, ids.length * 2 + 3, ids.length * 2 + 5, ids.length * 2 + 7].forEach((p, i) => assigned.set(p, board[i]));
  assert.equal(new Set(assigned.values()).size, assigned.size);
  const unused = PACK.filter(c => ![...assigned.values()].includes(c));
  const deck = PACK.map((_, i) => assigned.get(i) ?? unused.shift());
  const h = createHand({ id, players: ids.map((p, seat) => ({ id: p, name: p, seat, stack: stacks[seat] })),
    buttonSeat: 0, smallBlind: bb / 2, bigBlind: bb, deck, deferredRunout: deferred });
  Object.assign(h, { roomCode: room, number: 1, at: '2026-10-14T08:00:00.000Z', miniChanges: {}, settings: { smallBlind: bb / 2, bigBlind: bb } });
  return h;
}
function checkThrough(h, street) {
  while (h.status === 'playing' && h.street !== street) applyAction(h, h.actingId, availableActions(h, h.actingId).canCheck ? 'check' : 'call');
  assert.equal(h.street, street);
}
function complete(h) {
  if (h.allInLock) h.allInEquity = calculateEquity(h.allInLock);
  while (h.status === 'playing') h.runout?.active ? advanceRunout(h) : applyAction(h, h.actingId, availableActions(h, h.actingId).canCheck ? 'check' : 'call');
  return h;
}
const db = hands => ({ hands, ledger: [], rooms: {} });
const profile = (hands, viewer, target, scope = 'career', room = '100001') => publicPlayerStats(db(hands), viewer, room, { id: target, name: target }, { scope });
const ratio = (metric, numerator, denominator) => assert.deepEqual(metric, { count: numerator, opportunities: denominator, percent: denominator ? Math.round(numerator / denominator * 1000) / 10 : null });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from hand-calculated ${expected}`);

function threeWaySidePots() {
  const h = fixture({ ids: ['A', 'B', 'C'], stacks: [100, 200, 200], holes: { A: ['As', 'Ah'], B: ['Ks', 'Kh'], C: ['Qs', 'Qh'] },
    board: ['Ac', 'Kd', 'Qc', '2s', '3d'], id: 'three-way-main-and-side' });
  checkThrough(h, 'turn'); applyAction(h, 'B', 'allin'); applyAction(h, 'C', 'call'); applyAction(h, 'A', 'call'); return complete(h);
}

test('independent oracle: three-way main/side winners, zero-net side winner and exact turn EV all agree', () => {
  const h = threeWaySidePots();
  // A contributes 100, B and C 200. AAA wins 300 main; KKK wins 200 side.
  assert.deepEqual(h.result.pots, [
    { amount: 300, eligibleIds: ['A', 'B', 'C'], winnerIds: ['A'] },
    { amount: 200, eligibleIds: ['B', 'C'], winnerIds: ['B'] },
  ]);
  assert.deepEqual(h.players.map(p => p.stack - p.startingStack), [200, 0, -200]);
  // 42 possible river cards: only Kc (1) or Qd (1) change the main winner;
  // only Qd changes the side winner. None split. No evaluator supplies this oracle.
  assert.equal(h.allInEquity.method, 'exact'); assert.equal(h.allInEquity.samples, 42);
  const expected = [300 * 40 / 42 - 100, 300 / 42 + 200 * 41 / 42 - 200, 500 / 42 - 200];
  h.allInEquity.players.forEach((p, i) => near(p.expectedNet, expected[i]));
  for (const [i, id] of ['A', 'B', 'C'].entries()) {
    const own = aggregateAnalytics(db([h]), id), card = profile([h], 'A', id);
    assert.equal(own.holdemNet, [200, 0, -200][i]); assert.equal(own.holdemNetBB, [20, 0, -20][i]);
    assert.equal(own.allIn.actualNetBB, [20, 0, -20][i]); near(own.allIn.expectedNetBB, expected[i] / 10);
    ratio(card.metrics.winRate, [1, 0, 0][i], 1); ratio(card.metrics.wsd, [1, 1, 0][i], 1); ratio(card.metrics.wtsd, 1, 1);
    ratio(card.metrics.vpip, [1, 1, 0][i], 1); ratio(card.metrics.pfr, 0, 1);
  }
  for (const [a, b] of [['A', 'B'], ['A', 'C'], ['B', 'C']]) {
    const v = versusStats([h], a, b); assert.equal(v.sharedHands, 1); assert.equal(v.headsUp.hands, 0);
    assert.equal(v.showdown.hands, 0); assert.equal(v.allIn.eligibleHands, 0);
    assert.equal(v.responses.mine.call.opportunities, 0); assert.equal(v.coverage.actionUnknownHands, 0);
  }
});

test('independent oracle: tied pair splits an odd dead-money pot while both have profitable hands', () => {
  const h = fixture({ ids: ['A', 'C', 'B'], stacks: [100, 100, 100], holes: { A: ['2d', '3d'], B: ['4h', '5h'], C: ['6d', '7d'] },
    board: ['Ac', 'Kc', 'Qc', 'Jc', 'Tc'], id: 'tie-with-odd-dead-money' });
  applyAction(h, 'A', 'raise', 20); applyAction(h, 'C', 'fold'); applyAction(h, 'B', 'call'); complete(h);
  // 20 + 20 + small blind 5 = 45. B is first clockwise after button A.
  assert.deepEqual(h.result.payouts, { A: 22, C: 0, B: 23 });
  assert.deepEqual(h.players.map(p => p.stack - p.startingStack), [2, -5, 3]);
  const a = profile([h], 'A', 'B').versus, b = profile([h], 'B', 'A').versus;
  assert.equal(a.headsUp.hands, 1); assert.equal(a.headsUp.netBB, 0.2); assert.equal(b.headsUp.netBB, 0.3);
  assert.deepEqual(a.showdown, { hands: 1, wins: 0, losses: 0, ties: 1 });
  assert.deepEqual(b.showdown, a.showdown); ratio(a.headsUp.profitRate, 1, 1);
  ratio(profile([h], 'A', 'A').metrics.winRate, 1, 1); ratio(profile([h], 'A', 'B').metrics.winRate, 1, 1);
  ratio(profile([h], 'A', 'A').metrics.wsd, 1, 1); ratio(profile([h], 'A', 'B').metrics.wsd, 1, 1);
});

function twoWayTurn({ bb = 10, room = '100001', river = 'Kc', id = 'two-way' } = {}) {
  const h = fixture({ bb, room, id, stacks: [bb * 10, bb * 10], holes: { A: ['As', 'Ah'], B: ['Ks', 'Kh'] }, board: ['2c', '7d', '8h', '9s', river] });
  checkThrough(h, 'turn'); applyAction(h, 'B', 'allin'); applyAction(h, 'A', 'call'); return complete(h);
}

test('independent oracle: mixed-stake table/career scopes, bilateral responses, showdown and 42-of-44 turn EV', () => {
  const lose = twoWayTurn({ id: 'AA-loses-table-one' }), win = twoWayTurn({ bb: 20, room: '100002', river: '3d', id: 'AA-wins-table-two' });
  for (const h of [lose, win]) {
    assert.equal(h.allInEquity.samples, 44); assert.equal(h.allInEquity.method, 'exact');
    // Two remaining kings beat aces; every other river wins for AA, with no tie.
    near(h.allInEquity.players.find(p => p.id === 'A').expectedNet, h.bigBlind * (20 * 42 / 44 - 10));
  }
  const table = profile([lose, win], 'A', 'B', 'table'), career = profile([lose, win], 'A', 'B');
  assert.equal(table.hands, 1); assert.equal(career.hands, 2);
  assert.equal(table.versus.headsUp.netBB, -10); assert.equal(career.versus.headsUp.netBB, 0);
  ratio(table.versus.headsUp.profitRate, 0, 1); ratio(career.versus.headsUp.profitRate, 1, 2);
  assert.deepEqual(table.versus.showdown, { hands: 1, wins: 0, losses: 1, ties: 0 });
  assert.deepEqual(career.versus.showdown, { hands: 2, wins: 1, losses: 1, ties: 0 });
  ratio(career.versus.responses.mine.call, 2, 2); ratio(career.versus.responses.opponent.call, 0, 0);
  ratio(career.versus.threeBet.mine, 0, 0); ratio(career.versus.threeBet.opponent, 0, 0);
  assert.deepEqual(career.versus.allIn, { eligibleHands: 2, hands: 2, unavailableHands: 0, estimatedHands: 0,
    actualNetBB: 0, expectedNetBB: 18.18, differenceBB: -18.18, bbHands: 2, bbComplete: true });
  // Stakes 10 and 20 must be normalized per hand: chip profit is +100, BB profit 0.
  const own = aggregateAnalytics(db([lose, win]), 'A'); assert.equal(own.holdemNet, 100); assert.equal(own.holdemNetBB, 0);
  near(own.allIn.expectedNetBB, 200 / 11); assert.equal(own.allIn.actualNetBB, 0);
});

test('independent oracle: short all-ins reopening cumulatively produce precise 3/4/5-bet opportunities', () => {
  const h = fixture({ ids: ['A', 'B', 'C', 'D'], stacks: [500, 70, 90, 500],
    holes: { A: ['As', 'Ah'], B: ['Ks', 'Kh'], C: ['Qs', 'Qh'], D: ['Js', 'Jh'] }, board: ['2c', '7d', '8h', '9s', '3d'], id: 'cumulative-short-raises' });
  applyAction(h, 'D', 'call'); applyAction(h, 'A', 'raise', 50);
  applyAction(h, 'B', 'allin'); applyAction(h, 'C', 'allin'); applyAction(h, 'D', 'call');
  assert.equal(availableActions(h, 'A').canRaise, true); applyAction(h, 'A', 'raise', 130); applyAction(h, 'D', 'fold'); complete(h);
  const cards = ['A', 'B', 'C', 'D'].map(id => profile([h], 'A', id));
  for (const c of cards) ratio(c.metrics.vpip, 1, 1);
  cards.forEach((c, i) => ratio(c.metrics.pfr, i === 3 ? 0 : 1, 1));
  ratio(cards[0].metrics.threeBet, 0, 0); ratio(cards[0].metrics.fourBet, 0, 0); ratio(cards[0].metrics.fiveBet, 1, 1);
  ratio(cards[1].metrics.threeBet, 1, 1); ratio(cards[1].metrics.fourBet, 0, 0);
  ratio(cards[2].metrics.threeBet, 0, 0); ratio(cards[2].metrics.fourBet, 1, 1);
  ratio(cards[3].metrics.fiveBet, 0, 1);
  ratio(profile([h], 'A', 'B').versus.threeBet.opponent, 1, 1);
  ratio(profile([h], 'A', 'C').versus.threeBet.opponent, 0, 0);
  // D folded only on the turn of action after the short raises, not at the flop.
  assert.equal(profile([h], 'A', 'D').versus.headsUp.hands, 0);
});

test('independent oracle: a losing deep stack gets its uncalled 900 back without a showdown win or inflated all-in cost', () => {
  const h = fixture({ stacks: [1000, 100], holes: { A: ['Ks', 'Kh'], B: ['As', 'Ah'] }, board: ['2c', '7d', '8h', '9s', '3d'], id: 'uncalled-900-refund' });
  checkThrough(h, 'turn'); applyAction(h, 'B', 'check'); applyAction(h, 'A', 'allin'); applyAction(h, 'B', 'call'); complete(h);
  assert.deepEqual(h.result.payouts, { A: 0, B: 200 });
  assert.equal(h.players.find(p => p.id === 'A').stack, 900);
  assert.equal(h.log.filter(e => e.type === 'refund' && e.playerId === 'A').reduce((sum, e) => sum + e.amount, 0), 900);
  assert.deepEqual(h.allInLock.players.map(p => p.contributed), [100, 100]);
  near(h.allInEquity.players.find(p => p.id === 'A').expectedNet, 200 * 2 / 44 - 100);
  const mine = profile([h], 'B', 'A'), won = profile([h], 'A', 'B');
  ratio(mine.metrics.wsd, 0, 1); ratio(mine.metrics.winRate, 0, 1); ratio(mine.metrics.wtsd, 1, 1);
  ratio(won.metrics.wsd, 1, 1); ratio(won.metrics.winRate, 1, 1);
  assert.equal(won.versus.allIn.actualNetBB, -10); assert.equal(won.versus.allIn.expectedNetBB, -9.09); assert.equal(won.versus.allIn.differenceBB, -0.91);
  for (const id of ['A', 'B']) {
    const card = profile([h], 'A', id), own = aggregateAnalytics(db([h]), id);
    for (const [key, metric] of Object.entries(card.metrics)) assert.deepEqual(metric, own.metrics[key], `${id}.${key}`);
  }
});

test('independent oracle: multiway flop becomes two-player all-in with folded dead money without rewriting flop classification', () => {
  const h = fixture({ ids: ['A', 'B', 'C'], stacks: [100, 100, 100], holes: { A: ['As', 'Ah'], B: ['Qd', 'Jh'], C: ['Ks', 'Kh'] },
    board: ['2c', '7d', '8h', '9s', '3d'], id: 'multiway-to-two-lock' });
  checkThrough(h, 'flop'); applyAction(h, 'B', 'check'); applyAction(h, 'C', 'raise', 20); applyAction(h, 'A', 'call'); applyAction(h, 'B', 'fold');
  applyAction(h, 'C', 'allin'); applyAction(h, 'A', 'call'); complete(h);
  assert.deepEqual(h.result.payouts, { A: 210, B: 0, C: 0 });
  assert.deepEqual(h.players.map(p => p.stack - p.startingStack), [110, -10, -100]);
  assert.equal(h.allInEquity.samples, 44); // Folded B's hidden cards do not remove extra outs.
  near(h.allInEquity.players.find(p => p.id === 'A').expectedNet, 210 * 42 / 44 - 100);
  near(h.allInEquity.players.find(p => p.id === 'C').expectedNet, 210 * 2 / 44 - 100);
  const v = profile([h], 'A', 'C').versus;
  assert.equal(v.headsUp.hands, 0); assert.equal(v.headsUp.netBB, 0);
  assert.deepEqual(v.showdown, { hands: 1, wins: 1, losses: 0, ties: 0 });
  assert.equal(v.allIn.eligibleHands, 1); assert.equal(v.allIn.hands, 1);
  assert.equal(v.allIn.actualNetBB, 11); assert.equal(v.allIn.expectedNetBB, 10.05); assert.equal(v.allIn.differenceBB, 0.95);
  ratio(v.responses.mine.call, 1, 1); // Flop call was still three-way; only turn call counts.
  for (const [i, id] of ['A', 'B', 'C'].entries()) {
    const card = profile([h], 'A', id), own = aggregateAnalytics(db([h]), id);
    ratio(card.metrics.wtsd, i === 1 ? 0 : 1, 1);
    for (const [key, metric] of Object.entries(card.metrics)) assert.deepEqual(metric, own.metrics[key], `${id}.${key}`);
  }
});

test('independent oracle: forced preflop all-ins see the real deferred flop once and WTSD never exceeds 100 percent', () => {
  const h = fixture({ stacks: [5, 10], holes: { A: ['As', 'Ah'], B: ['Ks', 'Kh'] }, board: ['2c', '7d', '8h', '9s', '3d'], id: 'forced-blind-runout' });
  assert.equal(h.actingId, null); assert.equal(h.runout.active, true);
  while (h.status === 'playing') advanceRunout(h);
  assert.deepEqual(h.result.payouts, { A: 10, B: 0 });
  for (const id of ['A', 'B']) {
    const card = profile([h], 'A', id), own = aggregateAnalytics(db([h]), id);
    ratio(card.metrics.vpip, 0, 1); ratio(card.metrics.pfr, 0, 1); ratio(card.metrics.wtsd, 1, 1); ratio(own.metrics.flopSeen, 1, 1);
    for (const [key, metric] of Object.entries(card.metrics)) { assert.deepEqual(metric, own.metrics[key], `${id}.${key}`); assert.ok(metric.percent === null || metric.percent <= 100); }
  }
  const v = profile([h], 'A', 'B').versus;
  assert.equal(v.headsUp.hands, 1); assert.equal(v.headsUp.netBB, 0.5);
  assert.equal(v.allIn.eligibleHands, 1); assert.equal(v.allIn.unavailableHands, 1); assert.equal(v.allIn.expectedNetBB, null);
});
