import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions, advanceRunout } from '../src/poker.js';
import { replaySnapshot, replayStreets } from '../public/replay.js';

const deck = [...'cdhs'].flatMap(suit => [...'23456789TJQKA'].map(rank => rank + suit));

function completedRunout(lockStreet) {
  const hand = createHand({ id: `replay-${lockStreet}`, buttonSeat: 0, smallBlind: 5, bigBlind: 10,
    deck, deferredRunout: true,
    players: [100, 200, 350].map((stack, seat) => ({ id: String(seat), seat, stack })) });
  let safety = 0;
  while (hand.street !== lockStreet) {
    assert.ok(++safety < 30);
    const actions = availableActions(hand, hand.actingId);
    applyAction(hand, hand.actingId, actions.canCheck ? 'check' : 'call');
  }
  while (hand.actingId) {
    assert.ok(++safety < 50);
    const actions = availableActions(hand, hand.actingId);
    applyAction(hand, hand.actingId, actions.canAllIn ? 'allin' : 'call');
  }
  assert.equal(hand.runout.active, true);
  const runtime = [];
  while (hand.runout?.active) {
    advanceRunout(hand);
    const event = hand.log.findLast(item => item.type === 'street');
    runtime.push({ logSeq: event.seq, street: hand.street, board: [...hand.board],
      bets: hand.players.map(player => player.bet) });
  }
  assert.ok(hand.result.pots.length > 1);
  const record = { id: hand.id, board: [...hand.board], log: structuredClone(hand.log),
    allIn: { logSeq: hand.allInLock.logSeq, playerIds: hand.allInLock.players.map(player => player.id) },
    players: hand.players.map(player => ({ id: player.id, seat: player.seat,
      startingStack: player.startingStack, cards: [...player.cards],
      net: player.stack - player.startingStack, miniNet: 0, endingStack: player.stack })) };
  return { hand, record, runtime };
}

function verifyConservation(record) {
  const total = record.players.reduce((sum, player) => sum + player.startingStack, 0);
  for (let index = 0; index <= record.log.length; index++) {
    const frame = replaySnapshot(record, index, '0');
    assert.equal(frame.players.reduce((sum, player) => sum + player.stack, frame.pot), total);
    assert.ok(frame.players.every(player => player.stack >= 0 && player.bet >= 0));
    if (index < record.allIn.logSeq) assert.deepEqual(frame.players[1].cards, [null, null]);
  }
  assert.deepEqual(replaySnapshot(record, record.log.length, '0').players.map(player => player.stack),
    record.players.map(player => player.endingStack));
}

for (const lockStreet of ['preflop', 'flop', 'turn']) {
  test(`current ${lockStreet} all-in replay follows the real engine at every subsequent street`, () => {
    const { record, runtime } = completedRunout(lockStreet);
    for (const state of runtime) {
      const frame = replaySnapshot(record, state.logSeq, '0');
      assert.equal(frame.street, state.street); assert.deepEqual(frame.board, state.board);
      assert.deepEqual(frame.players.map(player => player.bet), state.bets);
    }
    assert.deepEqual(replayStreets(record).map(step => step.street), ['preflop', 'flop', 'turn', 'river', 'complete']);
    verifyConservation(record);
  });

  test(`legacy ${lockStreet} per-card all-in replay has street shortcuts and no stale previous-street wagers`, () => {
    const { record } = completedRunout(lockStreet);
    // Replay an old-format equivalent of these real engine cards and payouts;
    // only the public event encoding changes, never winners or amounts.
    const originalLockSeq = record.allIn.logSeq;
    record.log = record.log.flatMap(event => {
      if (event.seq <= originalLockSeq || event.type !== 'street') return [event];
      if (event.street === 'flop') return [1, 2, 3].map(count => ({ ...event,
        type: 'runoutCard', board: event.board.slice(0, count) }));
      return [{ ...event, type: 'runoutCard' }];
    }).map((event, index) => ({ ...event, seq: index + 1 }));
    const stages = replayStreets(record);
    assert.deepEqual(stages.map(step => step.street), ['preflop', 'flop', 'turn', 'river', 'complete']);
    for (const stage of stages.filter(step => ['flop', 'turn', 'river'].includes(step.street))) {
      const frame = replaySnapshot(record, stage.index, '0');
      assert.equal(frame.board.length, { flop: 3, turn: 4, river: 5 }[stage.street]);
      assert.ok(frame.players.every(player => player.bet === 0));
    }
    const beforeRunout = replaySnapshot(record, originalLockSeq, '0');
    assert.ok(beforeRunout.players.some(player => player.bet > 0));
    verifyConservation(record);
  });
}
