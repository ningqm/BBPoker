import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions, shuffleDeck, evaluate } from '../src/poker.js';

const ranks = '23456789TJQKA';
const canonical = [...'cdhs'].flatMap(s => [...ranks].map(r => r + s));
const deck = prefix => [...prefix, ...canonical.filter(c => !prefix.includes(c))];
const players = stacks => stacks.map((stack, seat) => ({ id: String(seat), name: `玩家${seat}`, seat, stack }));
function hand(stacks = [100, 100], extra = {}) {
  return createHand({ id: 'test', players: players(stacks), buttonSeat: 0, smallBlind: 5, bigBlind: 10, ...extra });
}
const act = (h, type, amount) => applyAction(h, h.actingId, type, amount);
function checkDown(h) {
  for (let n = 0; h.status === 'playing'; n++) {
    assert.ok(n < 100, '应在有限动作内结算');
    const a = availableActions(h, h.actingId);
    act(h, a.canCheck ? 'check' : 'call');
  }
  return h;
}
function conserved(h) {
  const initial = h.players.reduce((s, p) => s + p.startingStack, 0);
  const stacks = h.players.reduce((s, p) => s + p.stack, 0);
  const contributed = h.players.reduce((s, p) => s + p.contributed, 0);
  assert.equal(stacks + (h.status === 'playing' ? contributed : 0), initial);
  for (const p of h.players) {
    assert.ok(Number.isSafeInteger(p.stack) && p.stack >= 0);
    assert.ok(Number.isSafeInteger(p.contributed) && p.contributed >= 0);
    assert.ok(p.bet >= 0 && p.bet <= p.contributed);
  }
  if (h.status === 'complete') {
    assert.equal(Object.values(h.result.payouts).reduce((a, b) => a + b, 0), contributed);
    assert.equal(h.result.pots.reduce((a, p) => a + p.amount, 0), contributed);
    for (const pot of h.result.pots) {
      assert.ok(pot.winnerIds.every(id => pot.eligibleIds.includes(id)));
      assert.ok(pot.winnerIds.every(id => !h.players.find(p => p.id === id).folded));
    }
  }
}

test('hand evaluator: every category, wheel, two trips, kickers, and board-only tie', () => {
  const cases = [
    ['As Kd 9h 7c 3s', [0, 14, 13, 9, 7, 3]],
    ['As Ad Kh 7c 3s', [1, 14, 13, 7, 3]],
    ['As Ad Kh Kc 3s', [2, 14, 13, 3]],
    ['As Ad Ah Kc 3s', [3, 14, 13, 3]],
    ['As 2d 3h 4c 5s', [4, 5]],
    ['As Js 9s 7s 3s', [5, 14, 11, 9, 7, 3]],
    ['As Ad Ah Kc Ks', [6, 14, 13]],
    ['As Ad Ah Ac Ks', [7, 14, 13]],
    ['As Ks Qs Js Ts', [8, 14]],
    ['As Ad Ah Kc Ks Kh 2d', [6, 14, 13]],
    ['As Ad Kc Qh Js 9c 2h', [1, 14, 13, 12, 11]],
  ];
  for (const [cards, tuple] of cases) assert.deepEqual(evaluate(cards.split(' ')).tuple, tuple);
  assert.deepEqual(evaluate('As Ks Qs Js Ts 2c 3d'.split(' ')), evaluate('As Ks Qs Js Ts 8c 9d'.split(' ')));
  assert.throws(() => evaluate(['As', 'As', 'Kh', 'Qh', 'Jh']), /不重复/);
});

test('ace-high straight flush shares its category name while retaining rank and split strength', () => {
  for (const cards of ['As Ks Qs Js Ts', 'Ah Kh Qh Jh Th 2c', 'Ad Kd Qd Jd Td 2c 3s']) {
    assert.deepEqual(evaluate(cards.split(' ')), { tuple: [8, 14], name: '同花顺' });
  }
  assert.deepEqual(evaluate('Ks Qs Js Ts 9s'.split(' ')), { tuple: [8, 13], name: '同花顺' });
  assert.deepEqual(evaluate('As 2s 3s 4s 5s'.split(' ')), { tuple: [8, 5], name: '同花顺' });
  assert.equal(evaluate('As Ks Qs Js Th'.split(' ')).name, '顺子');
  assert.equal(evaluate('As Ks Qs Js 9s'.split(' ')).name, '同花');
  // A board-only royal still ties and splits the pot equally.
  const h = hand([100, 100], { deck: deck('2c 3c 4d 5d 6c As Ks Qs 7c Js 8c Ts'.split(' ')) });
  checkDown(h);
  assert.equal(h.result.showdown, true);
  assert.deepEqual(h.result.handNames, { '0': '同花顺', '1': '同花顺' });
  assert.deepEqual(h.result.payouts, { '0': 10, '1': 10 });
  conserved(h);
});

test('ace-high and king-high straight flushes keep distinct winners across main and side pots', () => {
  const h = hand([100, 200, 300], { deck: deck('9s 2h As 4c 2c 3c 6d Ts Js Qs 7d Ks 8d 2d'.split(' ')) });
  while (h.status === 'playing') act(h, availableActions(h, h.actingId).canRaise ? 'allin' : 'call');
  assert.deepEqual(h.result.handNames, { '0': '同花顺', '1': '同花顺', '2': '三条' });
  assert.deepEqual(h.result.pots.map(p => ({ amount: p.amount, winners: p.winnerIds })), [
    { amount: 300, winners: ['0'] }, { amount: 200, winners: ['1'] },
  ]);
  assert.deepEqual(h.result.payouts, { '0': 300, '1': 200, '2': 0 });
  conserved(h);
});

test('shuffle always supplies the entire unique standard deck', () => {
  const outcomes = new Set();
  for (let i = 0; i < 100; i++) {
    const d = shuffleDeck();
    assert.deepEqual([...d].sort(), [...canonical].sort());
    outcomes.add(d.join(''));
  }
  assert.equal(outcomes.size, 100);
});

test('heads-up BTN is SB and acts first preflop; BB first postflop; burn indices remain private', () => {
  const h = hand([100, 100], { deck: canonical });
  assert.equal(h.smallBlindSeat, 0);
  assert.equal(h.bigBlindSeat, 1);
  assert.equal(h.actingId, '0');
  assert.deepEqual(h.players[1].cardIndices, [0, 2]);
  assert.deepEqual(h.players[0].cardIndices, [1, 3]);
  act(h, 'call');
  assert.equal(h.actingId, '1');
  act(h, 'check');
  assert.equal(h.street, 'flop');
  assert.equal(h.actingId, '1');
  checkDown(h);
  assert.deepEqual(h.boardIndices, [5, 6, 7, 9, 11]);
  assert.deepEqual(h.burnIndices, [4, 8, 10]);
  assert.deepEqual(h.deck, canonical);
  assert.ok(Object.isFrozen(h.deck));
  assert.ok(!JSON.stringify(h.log).includes('cards'));
  conserved(h);
});

test('multiway dealing and actions follow occupied seats, not input array order', () => {
  const h = hand([100, 100, 100, 100], { players: [
    { id: 'a', seat: 8, stack: 100 }, { id: 'b', seat: 1, stack: 100 },
    { id: 'c', seat: 5, stack: 100 }, { id: 'd', seat: 3, stack: 100 },
  ], buttonSeat: 5 });
  assert.equal(h.smallBlindSeat, 8);
  assert.equal(h.bigBlindSeat, 1);
  assert.equal(h.actingId, 'd');
  assert.deepEqual(h.players.find(p => p.id === 'a').cardIndices, [0, 4]);
  act(h, 'call'); act(h, 'call'); act(h, 'call'); act(h, 'check');
  assert.equal(h.actingId, 'a');
  conserved(checkDown(h));
});

test('illegal actions are rejected without changing the hand', () => {
  const h = hand();
  for (const f of [() => applyAction(h, '1', 'call'), () => act(h, 'check'),
    () => act(h, 'raise', 15), () => act(h, 'raise', 101),
    () => act(h, 'raise', 20.5), () => act(h, 'unknown')]) {
    const before = JSON.stringify(h);
    assert.throws(f);
    assert.equal(JSON.stringify(h), before);
  }
  act(h, 'raise', 30);
  assert.equal(h.minRaise, 20);
  assert.equal(availableActions(h, '1').minRaiseTo, 50);
});

test('a short all-in does not reopen an earlier full wager', () => {
  const h = hand([1000, 130, 1000]);
  act(h, 'raise', 100);
  act(h, 'allin');
  assert.equal(h.currentBet, 130);
  assert.equal(h.minRaise, 90);
  act(h, 'call');
  assert.equal(h.actingId, '0');
  const a = availableActions(h, '0');
  assert.equal(a.canRaise, false);
  assert.equal(a.canAllIn, false);
  assert.equal(a.callAmount, 30);
  assert.throws(() => act(h, 'raise', 220), /加注/);
  conserved(checkDown(h));
});

test('multiple short all-ins cumulatively reopen a previous player, but do not change min raise', () => {
  const h = hand([190, 1000, 1000, 130]);
  // Button 0; SB 1; BB 2; UTG 3. Use the flop to establish action order.
  act(h, 'call'); act(h, 'call'); act(h, 'call'); act(h, 'check');
  act(h, 'raise', 100); // SB 1 opens 100.
  act(h, 'call'); // BB 2 calls 100.
  act(h, 'allin'); // Seat 3 has 120 left: short raise by 20.
  act(h, 'allin'); // Seat 0 has 180 left: cumulative 80, still short.
  assert.equal(h.actingId, '1');
  assert.equal(availableActions(h, '1').canRaise, false);
  conserved(checkDown(h));

  const h2 = hand([220, 1000, 1000, 150]);
  act(h2, 'call'); act(h2, 'call'); act(h2, 'call'); act(h2, 'check');
  act(h2, 'raise', 100); act(h2, 'call');
  act(h2, 'allin'); // 140, increment 40.
  act(h2, 'allin'); // 210, increment 70, cumulative 110.
  const reopened = availableActions(h2, '1');
  assert.equal(reopened.canRaise, true);
  assert.equal(reopened.minRaiseTo, 310);
  act(h2, 'raise', 310);
  conserved(checkDown(h2));
});

test('side pots, automatic all-in runout, and uncalled refund do not manufacture a win', () => {
  const d = deck('Ks As Qs Kh Ah Qh Jc 2c 3d 4h Tc 8s Td 9c'.split(' '));
  const h = hand([200, 100, 50], { deck: d });
  act(h, 'allin'); act(h, 'call'); act(h, 'call');
  assert.equal(h.status, 'complete');
  assert.deepEqual(h.result.pots, [
    { amount: 150, eligibleIds: ['0', '1', '2'], winnerIds: ['2'] },
    { amount: 100, eligibleIds: ['0', '1'], winnerIds: ['1'] },
  ]);
  assert.deepEqual(h.result.payouts, { 0: 0, 1: 100, 2: 150 });
  assert.deepEqual(h.result.mainWinnerIds, ['2']);
  assert.deepEqual(h.players.map(p => p.stack), [100, 100, 150]);
  assert.deepEqual(h.log.filter(e => e.type === 'refund').map(e => [e.playerId, e.amount]), [['0', 100]]);
  conserved(h);
});

test('odd chips go clockwise after the button, ties have multiple main winners', () => {
  const d = deck('Jd As Js Qd Ah Qs Kc Tc 9d 8h 3c 7s 4c 2h'.split(' '));
  const h = hand([5, 5, 5], { smallBlind: 1, bigBlind: 2, deck: d });
  act(h, 'allin'); act(h, 'call'); act(h, 'call');
  assert.deepEqual(h.result.mainWinnerIds, ['1', '0']);
  assert.deepEqual(h.result.payouts, { 0: 7, 1: 8, 2: 0 });
  conserved(h);
});

test('fold winner receives only contested pot and has no forced card reveal', () => {
  const h = hand();
  act(h, 'fold');
  assert.equal(h.status, 'complete');
  assert.equal(h.result.showdown, false);
  assert.deepEqual(h.result.handNames, {});
  assert.deepEqual(h.result.payouts, { 0: 0, 1: 10 });
  assert.equal(h.log.find(e => e.type === 'refund').amount, 5);
  assert.deepEqual(h.players.map(p => p.stack), [95, 105]);
  conserved(h);
});

test('short big blind does not force a sole opponent to overcall a nonexistent wager', () => {
  const h = hand([100, 2]);
  assert.equal(h.status, 'complete');
  assert.equal(h.result.pots[0].amount, 4);
  assert.equal(h.log.find(e => e.type === 'refund').amount, 3);
  conserved(h);
});

test('antes contribute to pots without reducing the minimum street bet', () => {
  const h = hand([100, 100, 100], { ante: 3 });
  assert.equal(h.currentBet, 10);
  assert.equal(h.players[0].contributed, 3);
  assert.equal(h.players[0].bet, 0);
  assert.equal(availableActions(h, '0').callAmount, 10);
  conserved(checkDown(h));
  const forced = hand([1, 2, 3], { ante: 5 });
  assert.equal(forced.status, 'complete');
  conserved(forced);
});

test('short opening all-in keeps a full blind increment and identifies all-in calls accurately', () => {
  const h = hand([100, 15, 100]);
  act(h, 'call'); act(h, 'call'); act(h, 'check');
  assert.equal(h.actingId, '1');
  act(h, 'allin');
  assert.equal(h.currentBet, 5);
  assert.equal(h.minRaise, 10);
  assert.equal(availableActions(h, '2').minRaiseTo, 15);
  assert.equal(h.log.at(-1).isRaise, true);
  act(h, 'raise', 15);
  act(h, 'call');
  conserved(checkDown(h));

  const h2 = hand([100, 50]);
  act(h2, 'allin');
  act(h2, 'allin');
  assert.deepEqual(h2.log.filter(e => e.type === 'allin').map(e => e.isRaise), [true, false]);
  conserved(h2);
});

test('only the effective outstanding amount is shown when everyone else is all-in', () => {
  const h = hand([100, 5, 2]);
  assert.equal(h.actingId, '0');
  assert.equal(availableActions(h, '0').callAmount, 5);
  act(h, 'call');
  assert.equal(h.status, 'complete');
  conserved(h);
});

test('cumulative short all-ins reopen each player according to their own last call', () => {
  const h = hand([210, 1000, 1000, 150, 1000]);
  for (let i = 0; i < 4; i++) act(h, 'call');
  act(h, 'check');
  assert.equal(h.street, 'flop');
  act(h, 'raise', 100); // Seat 1 opens; its next full raise threshold is 200.
  act(h, 'call'); // Seat 2 also last acted at 100.
  act(h, 'allin'); // Seat 3 raises to 140, an incomplete raise.
  act(h, 'call'); // Seat 4 last acted at 140; its threshold is 240.
  act(h, 'allin'); // Seat 0 raises to 200: cumulative 100 for seats 1 and 2.
  for (const id of ['1', '2']) {
    assert.equal(h.actingId, id);
    assert.equal(availableActions(h, id).canRaise, true);
    assert.equal(availableActions(h, id).minRaiseTo, 300);
    act(h, 'call');
  }
  assert.equal(h.actingId, '4');
  const a = availableActions(h, '4');
  assert.equal(a.callAmount, 60);
  assert.equal(a.canRaise, false);
  assert.equal(a.canAllIn, false);
  const before = JSON.stringify(h);
  assert.throws(() => act(h, 'raise', 300), /加注/);
  assert.equal(JSON.stringify(h), before);
  act(h, 'call');
  assert.equal(h.street, 'turn');
  conserved(checkDown(h));
});

test('heads-up wraps occupied seats and preserves the BB option after the button limps', () => {
  const h = hand([100, 100], {
    players: [{ id: 'button', seat: 8, stack: 100 }, { id: 'blind', seat: 3, stack: 100 }],
    buttonSeat: 8,
  });
  assert.equal(h.smallBlindSeat, 8);
  assert.equal(h.bigBlindSeat, 3);
  assert.equal(h.actingId, 'button');
  act(h, 'call');
  assert.equal(h.actingId, 'blind');
  assert.equal(availableActions(h, 'blind').canCheck, true);
  assert.equal(availableActions(h, 'blind').canRaise, true);
  act(h, 'raise', 30);
  assert.equal(h.actingId, 'button');
  act(h, 'call');
  assert.equal(h.actingId, 'blind');
  checkDown(h);
  for (const street of ['flop', 'turn', 'river']) {
    assert.deepEqual(h.log.filter(e => e.street === street && e.type === 'check').map(e => e.playerId), ['blind', 'button']);
  }
  conserved(h);
});

test('a dry side pot waits for the remaining call or fold, then refunds excess and keeps folded money', () => {
  const d = deck('4d 6h 2c 5d 7h 3c 8c As Ks Qs 9c Js Tc Ts'.split(' '));
  const h = hand([100, 100, 20], { deck: d });
  act(h, 'call'); act(h, 'call'); act(h, 'allin');
  act(h, 'call'); act(h, 'call');
  assert.equal(h.street, 'flop');
  assert.equal(h.actingId, '1');
  // One all-in player does not stop betting between the other two players.
  assert.equal(availableActions(h, '1').canRaise, true);
  act(h, 'raise', 30);
  act(h, 'allin');
  // Only seat 1 has chips now, but it still owes 50 and must get a decision.
  assert.equal(h.status, 'playing');
  assert.equal(h.board.length, 3);
  assert.equal(h.actingId, '1');
  const a = availableActions(h, '1');
  assert.equal(a.callAmount, 50);
  assert.equal(a.canCheck, false);
  assert.equal(a.canRaise, false);
  act(h, 'fold');
  assert.equal(h.status, 'complete');
  assert.deepEqual(h.result.pots, [
    { amount: 60, eligibleIds: ['0', '2'], winnerIds: ['2', '0'] },
    { amount: 60, eligibleIds: ['0'], winnerIds: ['0'] },
  ]);
  assert.deepEqual(h.result.mainWinnerIds, ['2', '0']);
  assert.deepEqual(h.result.payouts, { 0: 90, 1: 0, 2: 30 });
  assert.deepEqual(h.players.map(p => p.stack), [140, 50, 30]);
  assert.deepEqual(h.log.filter(e => e.type === 'refund').map(e => [e.playerId, e.amount]), [['0', 50]]);
  assert.equal(h.result.handNames['1'], undefined);
  conserved(h);
});

test('a short caller closes heads-up action without another check or fictitious side-pot win', () => {
  const h = hand([100, 20]);
  act(h, 'raise', 40);
  assert.equal(h.actingId, '1');
  assert.equal(availableActions(h, '1').callAmount, 10);
  act(h, 'call');
  assert.equal(h.status, 'complete');
  assert.equal(h.actingId, null);
  assert.equal(h.board.length, 5);
  assert.equal(h.result.pots.length, 1);
  assert.equal(h.result.pots[0].amount, 40);
  assert.deepEqual(h.log.filter(e => e.type === 'refund').map(e => [e.playerId, e.amount]), [['0', 20]]);
  assert.deepEqual(h.log.filter(e => ['raise', 'call', 'check'].includes(e.type)).map(e => e.type), ['raise', 'call']);
  conserved(h);
});

test('PokerKit published Ivey–Dwan hand replays to the exact stacks, including the overbet refund', () => {
  // Independently translated betting transcript from PokerKit's documented
  // "A Sample No-Limit Texas Hold'em Hand", not a runtime dependency:
  // https://github.com/uoftcprg/pokerkit#a-sample-no-limit-texas-holdem-hand
  // Seat 0 = Dwan (BTN), 1 = Ivey (SB), 2 = Antonius (BB).
  // Antonius's unknown cards and unreported stack are filled with irrelevant
  // valid values; he folds preflop and loses exactly his ante + big blind.
  const d = deck('Ac Ks 7h 2d Kd 6h Qd Jc 3d 5c Qs 4h Qh Jh'.split(' '));
  const h = hand([553500, 1125600, 1000000], {
    smallBlind: 1000, bigBlind: 2000, ante: 500, deck: d,
  });
  const replay = [
    ['0', 'raise', 7000], ['1', 'raise', 23000], ['2', 'fold'], ['0', 'call'],
    ['1', 'raise', 35000], ['0', 'call'],
    ['1', 'raise', 90000], ['0', 'raise', 232600], ['1', 'raise', 1067100], ['0', 'call'],
  ];
  for (const [id, type, amount] of replay) {
    assert.equal(h.actingId, id);
    applyAction(h, id, type, amount);
    conserved(h);
  }
  assert.equal(h.status, 'complete');
  assert.deepEqual(h.board, ['Jc', '3d', '5c', '4h', 'Jh']);
  assert.deepEqual(h.players.map(p => p.stack), [1109500, 572100, 997500]);
  assert.deepEqual(h.result.mainWinnerIds, ['0']);
  assert.equal(h.result.payouts['0'], 1109500);
  assert.deepEqual(h.log.filter(e => e.type === 'refund').map(e => [e.playerId, e.amount]), [['1', 572100]]);
});

test('a completed hand exposes no actions and rejects further moves without mutating settlement', () => {
  const h = hand();
  act(h, 'fold');
  const settled = JSON.stringify(h);
  for (const p of h.players) {
    const a = availableActions(h, p.id);
    assert.equal(a.canAct, false);
    assert.equal(a.canAllIn, false);
    assert.equal(a.canRaise, false);
    for (const type of ['fold', 'check', 'call', 'raise', 'allin']) {
      assert.throws(() => applyAction(h, p.id, type, 100), /结束/);
      assert.equal(JSON.stringify(h), settled);
    }
  }
});

test('invalid setup and deck data fail early', () => {
  assert.throws(() => hand([100]));
  assert.throws(() => hand([100, -1]));
  assert.throws(() => hand([100, 100], { buttonSeat: 9 }));
  assert.throws(() => hand([100, 100], { smallBlind: 0 }));
  assert.throws(() => hand([100, 100], { bigBlind: 2 }));
  assert.throws(() => hand([100, 100], { deck: Array(52).fill('As') }));
});

test('1,200 deterministic random action histories conserve every chip and terminate', () => {
  let seed = 0x9e3779b9;
  const rand = max => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  for (let game = 0; game < 1200; game++) {
    const n = 2 + rand(8);
    const stacks = Array.from({ length: n }, () => 1 + rand(1000));
    const fixed = [...canonical];
    for (let i = 51; i > 0; i--) { const j = rand(i + 1); [fixed[i], fixed[j]] = [fixed[j], fixed[i]]; }
    const h = hand(stacks, { deck: fixed, buttonSeat: rand(n), ante: rand(8) });
    conserved(h);
    let steps = 0;
    while (h.status === 'playing') {
      assert.ok(++steps < 500, `对局 ${game} 未能结束`);
      const a = availableActions(h, h.actingId);
      const choice = rand(10);
      if (choice === 0) act(h, 'fold');
      else if (choice < 3 && a.canAllIn) act(h, 'allin');
      else if (choice < 5 && a.canRaise) act(h, 'raise', a.minRaiseTo + rand(a.maxRaiseTo - a.minRaiseTo + 1));
      else act(h, a.canCheck ? 'check' : 'call');
      conserved(h);
    }
    const dealt = [...h.players.flatMap(p => p.cardIndices), ...h.boardIndices, ...h.burnIndices];
    assert.equal(new Set(dealt).size, dealt.length);
    assert.equal(h.log.every((e, i) => e.seq === i + 1), true);
  }
});
