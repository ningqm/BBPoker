import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions, advanceRunout, rabbitRunout } from '../src/poker.js';
import { handContext, handContextMatches } from '../src/hand-context.js';
import { recordFilters } from '../src/records.js';

function hand(seats = [0, 2, 5, 8], options = {}) {
  return createHand({ id: 'context', players: seats.map(seat => ({ id: `p${seat}`, seat, stack: 1000 })),
    buttonSeat: seats[0], smallBlind: 5, bigBlind: 10, ...options });
}
function callOrCheck(h) {
  const a = availableActions(h, h.actingId);
  applyAction(h, h.actingId, a.canCheck ? 'check' : 'call');
}
function toFlop(h) { while (h.status === 'playing' && h.street === 'preflop') callOrCheck(h); }
function finish(h) { while (h.status === 'playing') h.runout?.active ? advanceRunout(h) : callOrCheck(h); }

test('positions use actual dealt seats across 2–9 players, empty seats and every button rotation', () => {
  const expected = {
    2: ['BB', 'BTN/SB'], 3: ['SB', 'BB', 'BTN'], 4: ['SB', 'BB', 'CO', 'BTN'],
    5: ['SB', 'BB', 'HJ', 'CO', 'BTN'], 6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
    7: ['SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO', 'BTN'],
    8: ['SB', 'BB', 'UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN'],
    9: ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
  };
  for (let size = 2; size <= 9; size++) {
    const seats = [0, 2, 4, 6, 8, 1, 3, 5, 7].slice(0, size).sort((a, b) => a - b);
    for (let button = 0; button < size; button++) {
      const h = hand(seats, { buttonSeat: seats[button] });
      const clockwise = [...seats.slice(button + 1), ...seats.slice(0, button + 1)];
      assert.deepEqual(clockwise.map(s => handContext(h, `p${s}`).position), expected[size]);
      assert.equal(handContext(h, `p${seats[button]}`).tableSize, size);
    }
  }
  const h = hand([2, 7]), context = handContext(h, 'p2');
  assert.equal(handContextMatches(context, 'p2', recordFilters({ position: 'BTN' })), true);
  assert.equal(handContextMatches(context, 'p2', recordFilters({ position: 'SB' })), true);
  assert.equal(handContextMatches(context, 'p2', recordFilters({ position: 'BB' })), false);
});

test('initial flop counts survive later folds; a hero folding preflop is never heads-up or multiway', () => {
  const h = hand();
  assert.equal(h.actingId, 'p8'); applyAction(h, 'p8', 'fold'); toFlop(h);
  applyAction(h, h.actingId, 'fold'); finish(h);
  assert.equal(h.players.filter(p => !p.folded).length, 2);
  for (const id of ['p0', 'p2', 'p5']) {
    const context = handContext(h, id);
    assert.equal(context.potType, 'multiway'); assert.equal(context.flopPlayers, 3);
    assert.deepEqual(context.flopPlayerIds, ['p0', 'p2', 'p5']);
  }
  assert.equal(handContext(h, 'p8').potType, 'noFlop');
  assert.equal(handContextMatches(handContext(h, 'p0'), 'p0', recordFilters({ opponent: 'p8', potType: 'multiway' })), false);
  assert.equal(handContextMatches(handContext(h, 'p0'), 'p0', recordFilters({ opponent: 'p8' })), true);
});

test('multi-seat hand can reach a two-player flop and pair filters require that same opponent', () => {
  const h = hand(); applyAction(h, 'p8', 'fold'); applyAction(h, 'p0', 'fold'); toFlop(h); finish(h);
  const context = handContext(h, 'p2');
  assert.equal(context.potType, 'headsUp'); assert.equal(context.flopPlayers, 2); assert.equal(context.tableSize, 4);
  assert.equal(handContextMatches(context, 'p2', recordFilters({ opponent: 'p5', potType: 'headsUp', tableSize: 'short' })), true);
  assert.equal(handContextMatches(context, 'p2', recordFilters({ opponent: 'p0', potType: 'headsUp' })), false);
  assert.equal(handContextMatches(context, 'p2', recordFilters({ tableSize: 'headsUp' })), false);
});

test('real deferred preflop all-in runouts count after third card, rabbit runouts never do', () => {
  const allIn = hand([1, 7], { deferredRunout: true });
  applyAction(allIn, allIn.actingId, 'allin'); applyAction(allIn, allIn.actingId, 'call');
  advanceRunout(allIn); advanceRunout(allIn);
  assert.equal(handContext(allIn, 'p1').potType, 'unknown');
  advanceRunout(allIn); finish(allIn);
  assert.equal(handContext(allIn, 'p1').potType, 'headsUp');
  assert.equal(handContext(allIn, 'p1').flopPlayers, 2);
  const folded = hand([1, 7]); applyAction(folded, folded.actingId, 'fold');
  folded.rabbit = { board: rabbitRunout(folded).cards, originalCount: 0, active: false };
  for (const id of ['p1', 'p7']) {
    assert.equal(handContext(folded, id).potType, 'noFlop'); assert.equal(handContext(folded, id).flopPlayers, 0);
  }
});

test('bomb pots expose only the real button position and count all players seeing their automatic flop', () => {
  const h = hand([1, 4, 8], { bombPot: true, ante: 20 }); finish(h);
  assert.equal(handContext(h, 'p1').position, 'BTN');
  for (const id of ['p4', 'p8']) assert.equal(handContext(h, id).position, 'bomb');
  for (const p of h.players) assert.equal(handContext(h, p.id).potType, 'multiway');
});

test('exact dealt counts distinguish four, five and nine-handed positions without guessing a bomb blind', () => {
  for (const count of [4, 5, 9]) {
    const h = hand(Array.from({ length: count }, (_, i) => i));
    const context = handContext(h, 'p0');
    for (let size = 2; size <= 9; size++) assert.equal(handContextMatches(context, 'p0', recordFilters({ tableSize: String(size) })), size === count);
  }
  const bomb = hand([0, 2, 5, 8], { bombPot: true, ante: 20 });
  assert.equal(handContextMatches(handContext(bomb, 'p2'), 'p2', recordFilters({ position: 'SB' })), false);
  assert.equal(handContextMatches(handContext(bomb, 'p2'), 'p2', recordFilters({ position: 'bomb' })), true);
});

test('missing/corrupt historical facts remain unknown without looking at private cards or final fold flags', () => {
  const h = hand(); toFlop(h); finish(h);
  const legacy = structuredClone(h); delete legacy.log; delete legacy.buttonSeat;
  assert.equal(handContext(legacy, 'p0').potType, 'unknown'); assert.equal(handContext(legacy, 'p0').position, 'unknown');
  const corrupt = structuredClone(h); corrupt.log.splice(1, 1);
  assert.equal(handContext(corrupt, 'p0').potType, 'unknown');
  const absentBlind = structuredClone(h); delete absentBlind.smallBlindSeat;
  assert.equal(handContext(absentBlind, 'p0').position, 'unknown');
  const duplicateSeat = structuredClone(h); duplicateSeat.players[1].seat = duplicateSeat.players[0].seat;
  assert.equal(handContext(duplicateSeat, 'p0').position, 'unknown');
  for (const p of h.players) for (const key of ['cards', 'folded']) Object.defineProperty(p, key, { get() { throw new Error(`must not read ${key}`); } });
  for (const key of ['deck', 'audit', 'rabbit']) Object.defineProperty(h, key, { get() { throw new Error(`must not read ${key}`); } });
  assert.equal(handContext(h, 'p0').potType, 'multiway');
  assert.equal(handContext(h, 'observer').potType, 'unknown');
});
