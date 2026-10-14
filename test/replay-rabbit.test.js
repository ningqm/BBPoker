import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { historyBoard, replaySnapshot, replayStreets } from '../public/replay.js';

const deck = [...'cdhs'].flatMap(suit => [...'23456789TJQKA'].map(rank => rank + suit));

function recordAtFold(boardCount) {
  const hand = createHand({ id: 'rabbit-replay', deck, players: [
    { id: 'a', seat: 0, stack: 1000 }, { id: 'b', seat: 1, stack: 1000 },
  ], buttonSeat: 0, smallBlind: 5, bigBlind: 10 });
  for (let i = 0; hand.board.length < boardCount; i++) {
    assert.ok(i < 20);
    const actions = availableActions(hand, hand.actingId);
    applyAction(hand, hand.actingId, actions.canCheck ? 'check' : 'call');
  }
  applyAction(hand, hand.actingId, 'fold');
  // A heads-up hand deals four hole cards, then burns positions 4, 8 and 10.
  const fullBoard = [5, 6, 7, 9, 11].map(index => deck[index]);
  return { id: hand.id, board: [...hand.board], result: structuredClone(hand.result), log: structuredClone(hand.log),
    players: hand.players.map(p => ({ id: p.id, name: p.id, seat: p.seat, startingStack: p.startingStack,
      endingStack: p.stack, net: p.stack - p.startingStack, cards: p.id === 'a' ? [...p.cards] : [null, null] })),
    rabbit: { board: fullBoard, originalCount: boardCount, active: false, nextAt: null, finishedAt: 1800000000000,
      proofs: [{ position: 11, card: fullBoard[4], salt: 'synthetic', siblings: [{ side: 'left', hash: 'synthetic' }] }] } };
}

test('rabbit preview is only visible at the result frame and never extends poker streets or equities', () => {
  for (const boardCount of [0, 3, 4]) {
    const hand = recordAtFold(boardCount), before = structuredClone(hand);
    const noRabbit = structuredClone(hand); delete noRabbit.rabbit;
    for (let index = 0; index <= hand.log.length; index++) {
      const frame = replaySnapshot(hand, index, 'a'), original = replaySnapshot(noRabbit, index, 'a');
      assert.deepEqual({ ...frame, rabbit: null }, original);
      if (index < hand.log.length) assert.equal(frame.rabbit, null);
      else {
        assert.deepEqual(frame.rabbit, hand.rabbit);
        assert.deepEqual(frame.board, hand.board);
        assert.deepEqual(frame.players[1].cards, [null, null]);
        assert.equal(frame.equity, null);
      }
    }
    assert.deepEqual(replayStreets(hand), replayStreets(noRabbit));
    assert.deepEqual(hand, before);
    assert.equal(replaySnapshot(hand, 0, 'a').rabbit, null, 'dragging back hides the preview again');
  }
});

test('partially revealed rabbit histories are copied without completing the board or sharing mutable data', () => {
  const hand = recordAtFold(3);
  hand.rabbit.board = hand.rabbit.board.slice(0, 4);
  hand.rabbit.active = true; hand.rabbit.nextAt = 1800000000650; hand.rabbit.finishedAt = null;
  hand.rabbit.proofs[0].position = 9; hand.rabbit.proofs[0].card = hand.rabbit.board[3];
  hand.rabbit.cursor = 10; hand.rabbit.futureCard = 'Kc'; // Never project extra internal fields.
  const frame = replaySnapshot(hand, hand.log.length, 'a');
  assert.equal(frame.rabbit.board.length, 4);
  assert.equal(frame.rabbit.cursor, undefined); assert.equal(frame.rabbit.futureCard, undefined);
  frame.rabbit.board[0] = 'As'; frame.rabbit.proofs[0].siblings[0].hash = 'mutated';
  assert.notEqual(hand.rabbit.board[0], 'As'); assert.equal(hand.rabbit.proofs[0].siblings[0].hash, 'synthetic');
});

test('rabbit metadata on live, showdown, inconsistent and legacy records cannot reveal additional cards', () => {
  const original = recordAtFold(3);
  const variants = [
    { status: 'playing' }, { result: { showdown: true } }, { result: null },
    { rabbit: { ...original.rabbit, originalCount: 0 } },
    { rabbit: { ...original.rabbit, board: ['As', ...original.rabbit.board.slice(1)] } },
    { rabbit: { ...original.rabbit, board: [...original.rabbit.board, 'As'] } },
    { rabbit: { ...original.rabbit, board: [...original.board, original.board[0]] } },
    { rabbit: null },
  ];
  for (const patch of variants) {
    const hand = { ...original, ...patch }, frame = replaySnapshot(hand, hand.log.length, 'a');
    assert.equal(frame.rabbit, null);
    assert.deepEqual(frame.board, original.board);
  }
});

test('history list and detail place already public turn and river cards in the same five-card row', () => {
  for (const count of [0, 3, 4]) {
    const hand = recordAtFold(count), before = structuredClone(hand);
    const expected = { board: [...hand.rabbit.board], actualCount: count, rabbitCount: 5 - count, pending: false };
    assert.deepEqual(historyBoard(hand), expected);
    const summary = { board: hand.board, rabbit: { board: hand.rabbit.board, originalCount: count } };
    assert.deepEqual(historyBoard(summary, { summary: true }), expected);
    assert.deepEqual(historyBoard(summary).board, hand.board, 'only the explicit summary contract may omit showdown metadata');
    assert.deepEqual(hand, before);
    const display = historyBoard(hand); display.board[4] = 'As';
    assert.deepEqual(hand, before, 'a renderer must not mutate stored hand data');
  }
});

test('five-card replay display adds supplementary cards only at settlement and hides them when rewinding', () => {
  const hand = recordAtFold(3);
  for (let index = 0; index <= hand.log.length; index++) {
    const frame = replaySnapshot(hand, index, 'a');
    const display = historyBoard({ ...hand, board: frame.board, rabbit: frame.rabbit });
    assert.deepEqual(display.board, index === hand.log.length ? hand.rabbit.board : frame.board);
    assert.equal(display.rabbitCount, index === hand.log.length ? 2 : 0);
    assert.deepEqual(frame.players[1].cards, [null, null]);
  }
  assert.equal(historyBoard({ ...hand, board: [], rabbit: null }).board.length, 0);
});

test('pending histories expose only delivered supplementary cards and never future card fields', () => {
  const hand = recordAtFold(3);
  hand.rabbit.board.length = 3; hand.rabbit.active = true;
  hand.rabbit.futureCards = ['Ac', 'Ad'];
  assert.deepEqual(historyBoard(hand), { board: hand.board, actualCount: 3, rabbitCount: 0, pending: true });
  hand.rabbit.board.push('Qc');
  assert.deepEqual(historyBoard(hand), { board: [...hand.board, 'Qc'], actualCount: 3, rabbitCount: 1, pending: true });
});

test('history display rejects raw decks, playing hands, malformed boards and untrusted supplementary prefixes', () => {
  const hand = recordAtFold(3);
  for (const key of ['deck', 'audit', 'allInLock']) assert.throws(() => historyBoard({ ...hand, [key]: {} }), /过滤/);
  for (const patch of [
    { status: 'playing' }, { result: { showdown: true } },
    { rabbit: { ...hand.rabbit, originalCount: 0 } },
    { rabbit: { ...hand.rabbit, board: [...hand.board, hand.board[0], 'Ac'] } },
    { rabbit: { ...hand.rabbit, board: ['Ac', ...hand.rabbit.board.slice(1)] } },
  ]) {
    const view = historyBoard({ ...hand, ...patch });
    assert.deepEqual(view.board, hand.board); assert.equal(view.rabbitCount, 0); assert.equal(view.pending, false);
  }
  assert.deepEqual(historyBoard({ ...hand, board: ['invalid'], rabbit: { originalCount: 0, board: ['As'], active: true } }),
    { board: [], actualCount: 0, rabbitCount: 0, pending: false });
});
