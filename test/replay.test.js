import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { replaySnapshot, replayStreets } from '../public/replay.js';

function filtered(h, viewer = 'a') {
  return { id: h.id, board: [...h.board], log: structuredClone(h.log),
    players: h.players.map(p => ({ id: p.id, seat: p.seat, name: p.name, startingStack: p.startingStack,
      cards: p.id === viewer || (h.result.showdown && !p.folded) ? [...p.cards] : [null, null],
      net: p.stack - p.startingStack, miniNet: 0, endingStack: p.stack })) };
}
function hand(stacks = [100, 200, 500], ante = 0) {
  return createHand({ id: 'replay-hand', players: stacks.map((stack, i) => ({ id: 'abc'[i], seat: i, stack })), buttonSeat: 0, smallBlind: 5, bigBlind: 10, ante });
}
function finish(h, choose = a => a.canCheck ? 'check' : 'call') {
  for (let i = 0; h.status === 'playing'; i++) {
    assert.ok(i < 100);
    applyAction(h, h.actingId, choose(availableActions(h, h.actingId)));
  }
}
function conservedEveryFrame(h) {
  const record = filtered(h), total = h.players.reduce((n, p) => n + p.startingStack, 0);
  for (let i = 0; i <= h.log.length; i++) {
    const view = replaySnapshot(record, i, 'a');
    assert.equal(view.players.reduce((n, p) => n + p.stack, 0) + view.pot, total);
    assert.ok(view.players.every(p => p.stack >= 0 && p.bet >= 0 && p.contributed >= 0));
  }
  const final = replaySnapshot(record, h.log.length, 'a');
  assert.equal(final.pot, 0);
  for (const p of h.players) assert.equal(final.players.find(x => x.id === p.id).stack, p.stack);
  return record;
}
test('replay conserves points at every step, including ante, all-ins, side-pots and refunds', () => {
  const h = hand([100, 200, 500], 5);
  finish(h, a => a.canAllIn ? 'allin' : a.canCheck ? 'check' : 'call');
  assert.ok(h.result.pots.length > 1);
  conservedEveryFrame(h);
  const unmatched = hand([100, 100]);
  applyAction(unmatched, unmatched.actingId, 'raise', 80);
  applyAction(unmatched, unmatched.actingId, 'fold');
  assert.ok(unmatched.log.some(x => x.type === 'refund' && x.amount === 70));
  conservedEveryFrame(unmatched);
});
test('replay does not reveal future streets or final opponent cards before the result frame', () => {
  const h = hand(); finish(h);
  const record = conservedEveryFrame(h);
  for (const jump of replayStreets(record).filter(x => x.street !== 'complete')) {
    const view = replaySnapshot(record, jump.index, 'a');
    assert.equal(view.board.length, { preflop: 0, flop: 3, turn: 4, river: 5 }[jump.street]);
    assert.deepEqual(view.players[0].cards, record.players[0].cards);
    assert.deepEqual(view.players[1].cards, [null, null]);
  }
  assert.deepEqual(replaySnapshot(record, record.log.length, 'a').players[1].cards, record.players[1].cards);
});
test('folded private cards stay hidden even at replay end, and final flags do not leak backwards', () => {
  const h = hand(); applyAction(h, h.actingId, 'fold'); finish(h);
  const record = filtered(h, 'b');
  assert.equal(replaySnapshot(record, 0, 'b').players[0].folded, false);
  assert.deepEqual(replaySnapshot(record, record.log.length, 'b').players[0].cards, [null, null]);
  assert.equal(replaySnapshot(record, record.log.length, 'b').players[0].folded, true);
});
test('timeout and reconnect events do not double-count bets or payouts, and mini points remain separate', () => {
  const h = hand([100, 100]); finish(h);
  h.log.push({ type: 'timeout', amount: 0, playerId: 'a', street: 'river' }, { type: 'reconnect', amount: 0 });
  const record = conservedEveryFrame(h);
  record.players[0].miniNet = 20; record.players[0].endingStack += 20;
  const last = replaySnapshot(record, record.log.length, 'a');
  assert.equal(last.players[0].stack, h.players[0].stack);
  assert.equal(last.players[0].endingStack, h.players[0].stack + 20);
});
test('fold-only hands have start/result navigation, inputs are immutable and raw decks rejected', () => {
  const h = hand([100, 100]); applyAction(h, h.actingId, 'fold');
  const record = conservedEveryFrame(h), before = structuredClone(record);
  assert.deepEqual(replayStreets(record).map(x => x.street), ['preflop', 'complete']);
  replaySnapshot(record, 999, 'a'); assert.deepEqual(record, before);
  assert.throws(() => replaySnapshot(h, 0, 'a'), /过滤/);
});
