import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions, advanceRunout } from '../src/poker.js';
import { calculateEquity } from '../src/equity.js';

const canonical = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
const make = (stacks = [100, 100], options = {}) => createHand({ id: 'runout', players: stacks.map((stack, seat) => ({ id: String(seat), seat, stack })), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: canonical, deferredRunout: true, ...options });
const act = (h, type, amount) => applyAction(h, h.actingId, type, amount);
const finish = h => { for (let i = 0; h.runout?.active; i++) { assert.ok(i < 5); advanceRunout(h); } return h; };

test('preflop all-in locks public inputs before any future cards and reveals exactly one card per tick', () => {
  const h = make();
  act(h, 'allin');
  assert.equal(h.allInLock, null, 'last caller still has a decision');
  act(h, 'call');
  assert.equal(h.status, 'playing'); assert.equal(h.actingId, null); assert.equal(h.board.length, 0);
  assert.equal(h.deckCursor, 4); assert.equal(h.runout.active, true);
  assert.deepEqual(h.allInLock.board, []);
  assert.deepEqual(h.allInLock.pots, [{ amount: 200, eligibleIds: ['0', '1'] }]);
  const anchor = structuredClone(h.allInLock);
  assert.equal(h.log.find(l => l.seq === h.allInLock.logSeq).type, 'allInLock');
  for (let count = 1; count <= 5; count++) {
    advanceRunout(h);
    assert.equal(h.board.length, count);
    assert.equal(h.status, count === 5 ? 'complete' : 'playing');
    assert.equal(availableActions(h, '0').canAct, false);
    assert.deepEqual(h.allInLock, anchor);
  }
  assert.deepEqual(h.boardIndices, [5, 6, 7, 9, 11]);
  assert.deepEqual(h.burnIndices, [4, 8, 10]);
  assert.deepEqual(h.log.filter(l => l.type === 'street').map(l => l.board.length), [3, 4, 5]);
  assert.deepEqual(h.log.filter(l => l.type === 'runoutCard').map(l => l.board.length), [1, 2]);
  assert.equal(h.runout.active, false);
  const snapshot = structuredClone(h); advanceRunout(h); assert.deepEqual(h, snapshot);
});

test('deferred and legacy immediate runouts preserve identical board, settlement and chip conservation', () => {
  for (const stacks of [[100, 100], [50, 100, 200], [5, 10, 30], [1, 1]]) {
    const deferred = make(stacks), immediate = make(stacks, { deferredRunout: false });
    for (const h of [deferred, immediate]) {
      for (let i = 0; h.actingId; i++) { assert.ok(i < 20); const a = availableActions(h, h.actingId); act(h, a.canAllIn ? 'allin' : a.canCheck ? 'check' : 'call'); }
      finish(h);
    }
    assert.deepEqual(deferred.board, immediate.board);
    assert.deepEqual(deferred.result, immediate.result);
    assert.deepEqual(deferred.players.map(p => p.stack), immediate.players.map(p => p.stack));
    assert.equal(deferred.players.reduce((sum, p) => sum + p.stack, 0), stacks.reduce((a, b) => a + b, 0));
  }
});

test('a short stack all-in does not reveal cards while two opponents can still bet', () => {
  const h = make([20, 200, 200]);
  act(h, 'allin'); act(h, 'call'); act(h, 'call');
  assert.equal(h.street, 'flop'); assert.equal(h.runout, null); assert.equal(h.allInLock, null);
  assert.ok(h.actingId);
  act(h, 'check'); act(h, 'check');
  assert.equal(h.street, 'turn'); assert.equal(h.allInLock, null);
  act(h, 'allin'); act(h, 'call');
  assert.equal(h.board.length, 4); assert.equal(h.allInLock.board.length, 4); assert.equal(h.runout.active, true);
  assert.deepEqual(h.allInLock.pots.map(p => p.amount), [60, 360]);
  finish(h);
});

test('unmatched all-in overbet is refunded before lock and never counted in expected profit', () => {
  const h = make([200, 50]);
  act(h, 'allin'); act(h, 'call');
  assert.equal(h.players[0].stack, 150); assert.equal(h.players[0].contributed, 50);
  assert.deepEqual(h.allInLock.players.map(p => p.contributed), [50, 50]);
  assert.deepEqual(h.allInLock.pots.map(p => p.amount), [100]);
  assert.ok(h.log.find(l => l.type === 'refund' && l.amount === 150).seq < h.allInLock.logSeq);
  const equity = calculateEquity(h.allInLock);
  assert.ok(equity.players.every(p => p.expectedNet >= -50 && p.expectedNet <= 50));
  finish(h);
});

test('folded private cards never enter lock; no-contest hands have no lock and river all-ins have final equity without a runout', () => {
  const h = make([100, 100, 100]);
  act(h, 'fold'); act(h, 'allin'); act(h, 'call');
  assert.deepEqual(h.allInLock.players.map(p => p.id), ['1', '2']);
  const folded = h.players.find(p => p.folded);
  assert.ok(folded.cards.every(c => !JSON.stringify(h.allInLock).includes(`"${c}"`)));
  const foldedHeadsUp = make(); act(foldedHeadsUp, 'fold');
  assert.equal(foldedHeadsUp.status, 'complete'); assert.equal(foldedHeadsUp.allInLock, null);
  const river = make();
  while (river.street !== 'river') { const a = availableActions(river, river.actingId); act(river, a.canCheck ? 'check' : 'call'); }
  act(river, 'allin'); act(river, 'call');
  assert.equal(river.status, 'complete'); assert.equal(river.allInLock.board.length, 5); assert.equal(river.runout, null);
  const equity = calculateEquity(river.allInLock);
  assert.equal(equity.method, 'exact'); assert.equal(equity.samples, 1);
  for (const p of equity.players) assert.equal(p.expectedPayout, river.result.payouts[p.id]);
});

test('serialized partial runout resumes without changing deck, lock or future outcomes', () => {
  const h = make(); act(h, 'allin'); act(h, 'call'); advanceRunout(h);
  const restored = JSON.parse(JSON.stringify(h));
  finish(h); finish(restored);
  assert.deepEqual(restored, h);
});
