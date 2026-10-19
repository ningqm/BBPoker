import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction } from '../src/poker.js';
import { exportPhh } from '../src/phh.js';
import { calculateEquity } from '../src/equity.js';
import { directHandTransfers } from '../src/opponent-transfers.js';
import { replayIndependently } from './helpers/pokerkit-oracle.mjs';

// The random dual-table acceptance failure is frozen here. Folded players paid
// 5, 10 and 90; live contenders paid 840, 2340 and 2340. Everyone plays AA33Q.
// One main pot: 840*3+105 = 2625, exactly 875 each. One side pot: 3000,
// exactly 1500 each to seats3 and5. No pot has an indivisible odd chip.
const EXPECTED = [875, 1335, 1830, 2375, 2750, 3375, 3840, 4340, 4840];
function fixture() {
  const pack = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
  const fixed = new Map([[2,'7s'],[11,'Ts'],[4,'5h'],[13,'9s'],[8,'Jh'],[17,'5s'],
    [19,'3c'],[20,'As'],[21,'Qs'],[23,'Ac'],[25,'3d']]);
  const rest = pack.filter(card => ![...fixed.values()].includes(card));
  const deck = pack.map((_, i) => fixed.get(i) ?? rest.shift());
  const hand = createHand({ id: 'folded-tiers-false-odd-chips', buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck,
    players: Array.from({ length: 9 }, (_, seat) => ({ id: String(seat), name: `seat${seat}`, seat, stack: 1000 + seat*500 - 160 })) });
  const actions = [['3','raise',30],['4','raise',90],['5','raise',270],['6','fold'],['7','fold'],['8','fold'],['0','call'],
    ['1','fold'],['2','fold'],['3','call'],['4','fold'],['3','allin'],['5','call'],['0','call']];
  for (const [id, type, amount] of actions) { assert.equal(hand.actingId, id); applyAction(hand, id, type, amount); }
  assert.deepEqual(hand.board, ['3c','As','Qs','Ac','3d']);
  return hand;
}

test('folded contribution levels with identical eligibility form one pot before odd-chip distribution', () => {
  const hand = fixture();
  assert.deepEqual(hand.players.map(p => p.stack), EXPECTED);
  assert.deepEqual(hand.result.pots.map(p => p.amount), [2625, 3000]);
  assert.deepEqual(hand.result.mainWinnerIds, ['3','5','0']);
  assert.equal(hand.players.reduce((sum, p) => sum + p.stack, 0), hand.players.reduce((sum, p) => sum + p.startingStack, 0));
});

test('PokerKit independently confirms the hand-calculated folded-tier payout without an odd-chip adjustment',
  { skip: !process.env.POKERKIT_PYTHON }, () => {
    const hand = fixture(), visible = { id: hand.id, number: 1, at: '2026-10-15T00:00:00.000Z', roomCode: 'synthetic', roomName: 'deterministic odd chip regression',
      buttonSeat: hand.buttonSeat, smallBlindSeat: hand.smallBlindSeat, bigBlindSeat: hand.bigBlindSeat, ante: 0,
      settings: { smallBlind: 5, bigBlind: 10 }, board: hand.board, log: hand.log,
      result: { payouts: Object.fromEntries(hand.players.map(p => [p.id, EXPECTED[p.seat] - (p.startingStack - p.contributed)])) },
      players: hand.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, startingStack: p.startingStack,
        endingStack: EXPECTED[p.seat], net: EXPECTED[p.seat] - p.startingStack, miniNet: 0, cards: p.folded ? [null,null] : p.cards, folded: p.folded })) };
    const result = replayIndependently(exportPhh([visible]), 1);
    assert.equal(result.odd_chip_normalizations, 0);
  });

test('all-in locked pots, river EV and direct-opponent accounting agree with the merged payout', () => {
  const hand = fixture();
  assert.deepEqual(hand.allInLock.pots.map(p => p.amount), [2625, 3000]);
  const equity = calculateEquity({ ...hand.allInLock, board: hand.board });
  const direct = directHandTransfers(hand); assert.equal(direct.covered, true, direct.reason);
  for (const p of hand.players) {
    if (!p.folded) assert.equal(equity.players.find(e => e.id === p.id).expectedPayout, hand.result.payouts[p.id]);
    const net = direct.transfers.reduce((sum, row) => sum + (row.toId === p.id ? row.amount : 0) - (row.fromId === p.id ? row.amount : 0), 0);
    assert.ok(Math.abs(net - (EXPECTED[p.seat] - p.startingStack)) < 1e-8);
  }
});

test('historical unmerged archives retain their recorded odd-chip result without being rewritten or excluded', () => {
  const hand = fixture();
  hand.result.pots = [30, 25, 320, 2250].map(amount => ({ amount, eligibleIds: ['0','3','5'], winnerIds: ['3','5','0'] }))
    .concat([{ amount: 3000, eligibleIds: ['3','5'], winnerIds: ['3','5'] }]);
  hand.result.payouts['0'] = 874; hand.result.payouts['3'] = 2376;
  hand.players.find(p => p.id === '0').stack = 874; hand.players.find(p => p.id === '3').stack = 2376;
  for (const event of hand.log.filter(e => e.type === 'payout')) event.amount = hand.result.payouts[event.playerId];
  const before = structuredClone(hand), direct = directHandTransfers(hand);
  assert.equal(direct.covered, true, direct.reason); assert.deepEqual(hand, before);
  for (const p of hand.players) {
    const net = direct.transfers.reduce((sum, row) => sum + (row.toId === p.id ? row.amount : 0) - (row.fromId === p.id ? row.amount : 0), 0);
    assert.ok(Math.abs(net - (p.stack - p.startingStack)) < 1e-8);
  }
});

// Frozen from dual-table hand 5d6a4f4f-2a12-46c6-9c12-54660ac52794.
// Seats4/5/8 tie with straights. Seat3 is eligible for the 2500-point pot,
// but not the following 2000-point pot. Killing its losing hand must not
// erase that boundary: 2500 splits 834/833/833; 2000 splits 667/667/666.
const KILLED_EXPECTED = [0, 0, 14500, 0, 1501, 2250, 4000, 0, 4749];
function killedContenderFixture() {
  const pairs = ['6h9h','JsJd','Qc6d','Th8c','Ts5d','2c2d','7s5s','4cTc','6sQd'];
  const fixed = new Map(pairs.flatMap((pair, i) => [[i, pair.slice(0, 2)], [i + 9, pair.slice(2)]])
    .concat([[19,'Kh'],[20,'9d'],[21,'Ks'],[23,'Jc'],[25,'Qh']]));
  const pack = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
  const rest = pack.filter(card => ![...fixed.values()].includes(card));
  const deck = pack.map((_, i) => fixed.get(i) ?? rest.shift());
  const hand = createHand({ id: 'killed-contender-side-pot-boundary', buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck,
    players: Array.from({ length: 9 }, (_, seat) => ({ id: String(seat), name: `seat${seat}`, seat, stack: 1000 + seat * 500 })) });
  for (const [id, type] of [['3','allin'],['4','allin'],['5','allin'],['6','fold'],['7','allin'],['8','call'],['0','call'],['1','call'],['2','call']]) {
    assert.equal(hand.actingId, id); applyAction(hand, id, type);
  }
  return hand;
}
function killedContenderView(hand) {
  return { id: hand.id, number: 1, at: '2026-10-17T00:00:00.000Z', roomCode: 'synthetic', roomName: 'showdown side-pot boundary',
    buttonSeat: hand.buttonSeat, smallBlindSeat: hand.smallBlindSeat, bigBlindSeat: hand.bigBlindSeat, ante: 0,
    settings: { smallBlind: 5, bigBlind: 10 }, board: hand.board, log: hand.log,
    result: { showdown: true, payouts: Object.fromEntries(hand.players.map(p => [p.id, KILLED_EXPECTED[p.seat] - (p.startingStack - p.contributed)])) },
    players: hand.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, startingStack: p.startingStack,
      endingStack: KILLED_EXPECTED[p.seat], net: KILLED_EXPECTED[p.seat] - p.startingStack, miniNet: 0,
      cards: p.folded ? [null,null] : p.cards, folded: p.folded })) };
}

test('distinct side pots distribute odd chips separately even when their eventual winners are identical', () => {
  const hand = killedContenderFixture();
  assert.deepEqual(hand.players.map(p => p.stack), KILLED_EXPECTED);
  assert.deepEqual(hand.result.pots.map(p => p.amount), [8000, 3500, 3000, 2500, 2000, 1500, 2000]);
  assert.deepEqual(hand.result.pots[3].eligibleIds, ['3','4','5','7','8']);
  assert.deepEqual(hand.result.pots[4].eligibleIds, ['4','5','7','8']);
  assert.deepEqual(hand.result.pots[3].winnerIds, ['4','5','8']);
  assert.deepEqual(hand.result.pots[4].winnerIds, ['4','5','8']);
});

test('PokerKit oracle preserves its original side pots before killing losing showdown hands',
  { skip: !process.env.POKERKIT_PYTHON }, () => {
    const visible = killedContenderView(killedContenderFixture());
    const result = replayIndependently(exportPhh([visible]), 1);
    assert.equal(result.odd_chip_normalizations, 1);
    assert.equal(result.pot_boundary_normalizations, 1);
    // The unnormalized PokerKit result conserves total chips but is wrong for
    // our per-pot rule. Reject it rather than allowing either one-point result.
    const wrong = structuredClone(visible);
    wrong.players[4].net--; wrong.players[4].endingStack--;
    wrong.players[8].net++; wrong.players[8].endingStack++;
    wrong.result.payouts['4']--; wrong.result.payouts['8']++;
    assert.throws(() => replayIndependently(exportPhh([wrong]), 1), /killed-contender-side-pot-boundary/);
  });
