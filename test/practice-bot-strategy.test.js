import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAction } from '../scripts/practice-bot-strategy.mjs';
import { createHand, availableActions, applyAction } from '../src/poker.js';

const rng = (seed = 1) => () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
const room = () => ({
  status: 'open', meId: 'bot', settings: { bigBlind: 10 },
  hand: { status: 'playing', actingId: 'bot', street: 'river', board: ['Qs', 'Js', 'Ts', '2d', '3c'], currentBet: 20, pot: 100 },
  players: [
    { id: 'bot', inHand: true, cards: ['As', 'Ks'], stack: 1000, bet: 0 },
    { id: 'friend', inHand: true, cards: [null, null], stack: 1000, bet: 20 },
  ],
  actions: { canAct: true, canCheck: false, canFold: true, callAmount: 20, canRaise: true, minRaiseTo: 40, maxRaiseTo: 1000, canAllIn: true },
});

test('inactive, another turn, finished, runout and unseated bots do not act', () => {
  const changes = [r => r.status = 'closed', r => r.hand = null, r => r.actions.canAct = false,
    r => r.hand.actingId = 'friend', r => r.hand.status = 'complete', r => r.hand.runout = { active: true },
    r => r.players[0].inHand = false, r => r.players[0].folded = true, r => r.players[0].allIn = true];
  for (const change of changes) { const r = room(); change(r); assert.equal(decideAction(r), null); }
});

test('the nuts value-bet within legal bounds, including a min-raise beyond preferred size', () => {
  const r = room();
  r.actions.minRaiseTo = 150;
  assert.deepEqual(decideAction(r, { random: () => 0 }), { action: 'raise', amount: 150 });
  r.actions.maxRaiseTo = 150;
  assert.deepEqual(decideAction(r, { random: () => 0 }), { action: 'raise', amount: 150 });
});

test('short all-in can increase only when permitted; closed raise rights cannot be bypassed', () => {
  const r = room();
  Object.assign(r.actions, { canRaise: false, minRaiseTo: 40, maxRaiseTo: 30 });
  assert.deepEqual(decideAction(r, { random: () => 0 }), { action: 'allin' });
  r.actions.canAllIn = false;
  assert.deepEqual(decideAction(r, { random: () => 0 }), { action: 'call' });
  Object.assign(r.actions, { canAllIn: true, maxRaiseTo: 15, callAmount: 15 });
  assert.deepEqual(decideAction(r, { random: () => 0 }), { action: 'call' });
});

test('weak hands never fold a free check and can fold expensive calls', () => {
  const r = room();
  r.players[0].cards = ['2c', '3d'];
  r.hand.board = ['As', 'Kd', 'Qh', '9c', '7s'];
  Object.assign(r.actions, { canRaise: false, canAllIn: false, canCheck: true, callAmount: 0 });
  assert.deepEqual(decideAction(r, { random: rng() }), { action: 'check' });
  Object.assign(r.actions, { canCheck: false, callAmount: 100 });
  assert.deepEqual(decideAction(r, { random: rng() }), { action: 'fold' });
});

test('hidden enemy cards, future deck and diagnostic equity are never read', () => {
  const r = room();
  const expected = decideAction(r, { random: rng(53) });
  const forbidden = { get() { throw new Error('private data access'); } };
  Object.defineProperty(r.players[1], 'cards', forbidden);
  Object.defineProperty(r.hand, 'deck', forbidden);
  Object.defineProperty(r.hand, 'equity', forbidden);
  Object.defineProperty(r.hand, 'rabbit', forbidden);
  assert.deepEqual(decideAction(r, { random: rng(53) }), expected);
});

test('missing or invalid self cards fail safely without spending chips', () => {
  const r = room();
  for (const cards of [[], [null, null], ['As', 'As'], ['XX', 'Ks']]) {
    r.players[0].cards = cards;
    assert.deepEqual(decideAction(r), { action: 'fold' });
    r.actions.canCheck = true;
    assert.deepEqual(decideAction(r), { action: 'check' });
    r.actions.canCheck = false;
  }
});

test('real engine accepts all bot choices in heads-up and multiway hands, conserving chips', () => {
  const random = rng(981);
  for (const stacks of [[100, 100], [25, 100, 180]]) {
    const hand = createHand({ id: 'practice-test', players: stacks.map((stack, seat) => ({ id: String(seat), seat, stack })), buttonSeat: 0, smallBlind: 5, bigBlind: 10 });
    let steps = 0;
    while (hand.status === 'playing') {
      assert.ok(++steps < 80);
      const meId = hand.actingId;
      const r = { status: 'open', meId, settings: { bigBlind: 10 },
        hand: { status: hand.status, street: hand.street, actingId: meId, board: hand.board, currentBet: hand.currentBet, pot: hand.players.reduce((sum, p) => sum + p.contributed, 0) },
        players: hand.players.map(p => ({ id: p.id, inHand: true, folded: p.folded, allIn: p.allIn, cards: p.id === meId ? p.cards : [null, null] })),
        actions: availableActions(hand, meId) };
      const decision = decideAction(r, { random });
      assert.ok(decision);
      if (decision.action === 'raise') assert.ok(decision.amount % 10 === 0 || decision.amount === r.actions.maxRaiseTo);
      assert.doesNotThrow(() => applyAction(hand, meId, decision.action, decision.amount));
    }
    assert.equal(hand.players.reduce((sum, p) => sum + p.stack, 0), stacks.reduce((sum, stack) => sum + stack, 0));
  }
});


test('practice bot raises in whole BB while preserving exact fractional all-in stacks', () => {
  for (const bigBlind of [7, 10, 25]) {
    const r = room(); r.settings.bigBlind = bigBlind;
    r.actions.minRaiseTo = bigBlind * 4 + 1;
    r.actions.maxRaiseTo = bigBlind * 100 + 3;
    const result = decideAction(r, { random: () => 0 });
    assert.equal(result.action, 'raise');
    assert.ok(result.amount >= r.actions.minRaiseTo);
    assert.equal(result.amount % bigBlind, 0);
    r.actions.minRaiseTo = bigBlind * 4 + 1;
    r.actions.maxRaiseTo = bigBlind * 4 + 2;
    assert.deepEqual(decideAction(r, { random: () => 0 }), { action: 'raise', amount: r.actions.maxRaiseTo });
  }
});
