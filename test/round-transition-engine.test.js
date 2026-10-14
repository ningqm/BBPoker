import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions, advanceRunout, advanceTransition } from '../src/poker.js';

test('scheduled round/reveal/award boundaries preserve the synchronous engine results across 120 varied histories', () => {
  let seed = 94031;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const observed = new Set();
  for (let game = 0; game < 120; game++) {
    const count = 2 + random(8), deck = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
    for (let i = deck.length - 1; i > 0; i--) { const j = random(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const input = { id: `boundary-equivalence-${game}`, players: Array.from({ length: count }, (_, seat) => ({ id: `p${seat}`, seat, stack: 50 + random(20) * 10 })),
      buttonSeat: random(count), smallBlind: 5, bigBlind: 10, bombPot: game % 4 === 0, ante: game % 4 === 0 ? 20 : 0, deck };
    const sync = createHand(input), scheduled = createHand({ ...input, deferredRunout: true, deferredTransitions: true });
    const resolve = () => {
      for (let steps = 0; scheduled.status === 'playing' && !scheduled.actingId; steps++) {
        assert.ok(steps < 20);
        const board = [...scheduled.board], cursor = scheduled.deckCursor;
        if (scheduled.transition) {
          observed.add(scheduled.transition.kind);
          const kind = scheduled.transition.kind;
          advanceTransition(scheduled);
          if (kind !== 'street') { assert.deepEqual(scheduled.board, board); assert.equal(scheduled.deckCursor, cursor); }
        } else { assert.equal(scheduled.runout.active, true); observed.add('runout'); advanceRunout(scheduled); }
      }
    };
    resolve();
    for (let actions = 0; sync.status === 'playing'; actions++) {
      assert.ok(actions < 200);
      assert.equal(scheduled.actingId, sync.actingId); assert.deepEqual(scheduled.board, sync.board);
      const a = availableActions(sync, sync.actingId), choice = random(20);
      const type = a.canRaise && choice < 3 ? 'raise' : a.canAllIn && choice === 3 ? 'allin'
        : !a.canCheck && choice < 7 ? 'fold' : a.canCheck ? 'check' : 'call';
      const actor = sync.actingId;
      applyAction(sync, actor, type, a.minRaiseTo); applyAction(scheduled, actor, type, a.minRaiseTo);
      resolve();
    }
    assert.equal(scheduled.status, 'complete'); assert.equal(scheduled.transition, null);
    assert.deepEqual(scheduled.result, sync.result); assert.deepEqual(scheduled.board, sync.board);
    assert.deepEqual(scheduled.players, sync.players);
    const coreLog = hand => hand.log.filter(event => event.type !== 'runoutCard').map(({ seq, ...event }) => event);
    assert.deepEqual(coreLog(scheduled), coreLog(sync));
    assert.deepEqual(scheduled.burnIndices, sync.burnIndices); assert.equal(scheduled.deckCursor, sync.deckCursor);
  }
  assert.deepEqual(observed, new Set(['street', 'showdown', 'award', 'runout']));
});
