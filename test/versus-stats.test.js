import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions, advanceRunout } from '../src/poker.js';
import { calculateEquity } from '../src/equity.js';
import { versusStats } from '../src/versus-stats.js';

const DECK = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
function make({ ids = ['me', 'peer'], stacks, bb = 10, bomb = false, deferred = false, holes, board, entryPosts = [] } = {}) {
  const players = ids.map((id, seat) => ({ id, seat, stack: stacks?.[seat] ?? 1000 }));
  const order = [...ids.slice(1), ids[0]], assigned = new Map();
  if (holes) for (let c = 0; c < 2; c++) order.forEach((id, i) => assigned.set(c * ids.length + i, holes[id][c]));
  if (board) [ids.length * 2 + 1, ids.length * 2 + 2, ids.length * 2 + 3, ids.length * 2 + 5, ids.length * 2 + 7].forEach((position, i) => assigned.set(position, board[i]));
  const remaining = DECK.filter(c => ![...assigned.values()].includes(c)), deck = DECK.map((_, i) => assigned.get(i) ?? remaining.shift());
  return createHand({ id: 'test', players, buttonSeat: 0, smallBlind: bb / 2, bigBlind: bb, deck,
    bombPot: bomb, ante: bomb ? bb * 2 : 0, deferredRunout: deferred, entryPosts });
}
function finish(h) {
  for (let n = 0; h.status === 'playing' && n < 100; n++) {
    if (h.runout?.active) advanceRunout(h);
    else applyAction(h, h.actingId, availableActions(h, h.actingId).canCheck ? 'check' : 'call');
  }
  assert.equal(h.status, 'complete'); return h;
}
function toFlop(h) { while (h.street === 'preflop' && h.status === 'playing') applyAction(h, h.actingId, availableActions(h, h.actingId).canCheck ? 'check' : 'call'); }
const stat = (h, me = 'me', peer = 'peer') => versusStats(Array.isArray(h) ? h : [h], me, peer);
const cleanCoverage = s => assert.deepEqual(s.coverage, { flopUnknownHands: 0, actionUnknownHands: 0, showdownUnknownHands: 0, allInUnknownHands: 0 });

// No deterministic winning fixtures rely on final-fold state for flop membership.
test('heads-up means both at the original flop; net is viewer whole-hand BB at each historical stake', () => {
  const a = make({ ids: ['me', 'peer', 'third'] });
  applyAction(a, 'me', 'raise', 30); applyAction(a, 'peer', 'call'); applyAction(a, 'third', 'fold');
  applyAction(a, 'peer', 'raise', 30); applyAction(a, 'me', 'fold');
  const b = make({ bb: 20 }); toFlop(b); applyAction(b, 'peer', 'raise', 40); applyAction(b, 'me', 'fold');
  a.miniChanges = { me: 100000 };
  const s = stat([a, b]); cleanCoverage(s);
  assert.equal(s.sharedHands, 2); assert.equal(s.headsUp.hands, 2); assert.equal(s.headsUp.netBB, -4);
  assert.deepEqual(s.headsUp.profitRate, { count: 0, opportunities: 2, percent: 0 });
  assert.equal(s.showdown.hands, 0); assert.equal(stat(a, 'peer', 'me').headsUp.netBB, 4);
});

test('a multiway flop remains multiway after one fold; final two-player showdown can still count', () => {
  const h = make({ ids: ['me', 'peer', 'third'] }); toFlop(h);
  applyAction(h, 'peer', 'raise', 20); applyAction(h, 'third', 'fold'); applyAction(h, 'me', 'call'); finish(h);
  const s = stat(h); cleanCoverage(s); assert.equal(s.headsUp.hands, 0); assert.equal(s.showdown.hands, 1);
  assert.equal(s.responses.mine.call.count, 1); assert.equal(s.responses.opponent.call.opportunities, 0);
});

test('preflop walks, rabbit boards, active hands and undealt observer rows are not heads-up samples', () => {
  const walk = make(); applyAction(walk, 'me', 'fold'); walk.rabbit = { cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'] };
  const live = make(), observed = finish(make()); observed.players[0].cards = [];
  const s = stat([walk, live, observed]); cleanCoverage(s); assert.equal(s.sharedHands, 1); assert.equal(s.headsUp.hands, 0);
  assert.equal(s.responses.mine.fold.opportunities, 0); assert.equal(s.threeBet.mine.percent, null);
  assert.equal(versusStats([walk], 'me', 'me'), null);
});

test('responses count decisions in both directions, with legal raises and actual 3-bet opportunities', () => {
  const h = make(); applyAction(h, 'me', 'raise', 30); applyAction(h, 'peer', 'raise', 90); applyAction(h, 'me', 'call');
  applyAction(h, 'peer', 'raise', 100); applyAction(h, 'me', 'raise', 200); applyAction(h, 'peer', 'call'); finish(h);
  const s = stat(h); cleanCoverage(s);
  assert.deepEqual(s.responses.mine.call, { count: 1, opportunities: 2, percent: 50 });
  assert.deepEqual(s.responses.mine.raise, { count: 1, opportunities: 2, percent: 50 });
  assert.deepEqual(s.responses.opponent.raise, { count: 1, opportunities: 2, percent: 50 });
  assert.deepEqual(s.threeBet.opponent, { count: 1, opportunities: 1, percent: 100 });
  assert.deepEqual(s.threeBet.mine, { count: 0, opportunities: 0, percent: null });
  assert.deepEqual(stat(h, 'peer', 'me').responses.mine, s.responses.opponent);
});

test('a third-player re-raise replaces the wager source and excludes opponent-open 3-bet opportunities', () => {
  const h = make({ ids: ['peer', 'third', 'me'] });
  applyAction(h, 'peer', 'raise', 30); applyAction(h, 'third', 'raise', 90); applyAction(h, 'me', 'call'); applyAction(h, 'peer', 'call'); finish(h);
  const s = stat(h); cleanCoverage(s); assert.equal(s.responses.mine.call.opportunities, 0);
  assert.equal(s.threeBet.mine.opportunities, 0); assert.equal(s.headsUp.hands, 0); assert.equal(s.showdown.hands, 0);
});

test('a cold call after opponent first raise is a 3-bet opportunity, including raises after limpers', () => {
  const h = make({ ids: ['third', 'peer', 'me'] });
  applyAction(h, 'third', 'call'); applyAction(h, 'peer', 'raise', 30); applyAction(h, 'me', 'call'); applyAction(h, 'third', 'fold'); finish(h);
  const s = stat(h); cleanCoverage(s); assert.deepEqual(s.threeBet.mine, { count: 0, opportunities: 1, percent: 0 });
});

test('short all-in increases count as raises; short all-in calls count as calls and cannot raise back', () => {
  const raised = make({ stacks: [1000, 150] }); applyAction(raised, 'me', 'raise', 100); applyAction(raised, 'peer', 'allin'); applyAction(raised, 'me', 'call');
  const a = stat(raised); cleanCoverage(a); assert.equal(a.responses.opponent.raise.count, 1); assert.equal(a.threeBet.opponent.count, 1);
  assert.equal(a.responses.mine.call.count, 1); assert.equal(a.threeBet.mine.opportunities, 0);
  const called = make({ stacks: [1000, 70] }); applyAction(called, 'me', 'raise', 100); applyAction(called, 'peer', 'allin');
  const b = stat(called); cleanCoverage(b); assert.equal(b.responses.opponent.call.count, 1); assert.equal(b.responses.opponent.raise.count, 0);
  assert.equal(b.threeBet.opponent.opportunities, 0);
});

test('two final contenders compare the shared pot, not larger total payouts or positive hand net', () => {
  const tieBoard = ['Ac', 'Kc', 'Qc', 'Jc', 'Tc'];
  const tie = make({ holes: { me: ['2d', '3d'], peer: ['4h', '5h'] }, board: tieBoard }); finish(tie);
  const s = stat(tie); cleanCoverage(s); assert.deepEqual(s.showdown, { hands: 1, wins: 0, losses: 0, ties: 1 });
  assert.equal(s.headsUp.profitRate.percent, 0);
  const side = make({ ids: ['me', 'peer', 'third'], stacks: [20, 100, 100],
    holes: { me: ['As', 'Ah'], peer: ['Kd', 'Ks'], third: ['5h', '5d'] }, board: ['2c', '7d', '8h', '9s', 'Jd'] });
  applyAction(side, 'me', 'allin'); applyAction(side, 'peer', 'raise', 40); applyAction(side, 'third', 'call');
  applyAction(side, 'peer', 'raise', 20); applyAction(side, 'third', 'fold');
  assert.equal(side.result.pots.length, 2); assert.ok(side.result.payouts.peer > 0);
  assert.deepEqual(stat(side).showdown, { hands: 1, wins: 1, losses: 0, ties: 0 });
});

test('a three-way showdown or two-player side pot within it does not become a bilateral showdown', () => {
  const h = make({ ids: ['me', 'peer', 'third'], stacks: [100, 100, 20] });
  applyAction(h, 'me', 'allin'); applyAction(h, 'peer', 'call'); applyAction(h, 'third', 'call');
  const s = stat(h); cleanCoverage(s); assert.equal(h.result.pots.length, 2); assert.equal(s.showdown.hands, 0); assert.equal(s.allIn.eligibleHands, 0);
});

test('all-in luck uses saved initial two-player lock EV; deferred runout, refunds and dead money keep the same net basis', () => {
  const h = make({ ids: ['me', 'peer', 'third'], stacks: [100, 60, 1000], deferred: true });
  applyAction(h, 'me', 'allin'); applyAction(h, 'peer', 'call'); applyAction(h, 'third', 'fold');
  assert.equal(h.status, 'playing'); assert.equal(h.players[0].contributed, 60);
  h.allInEquity = calculateEquity({ ...h.allInLock, samples: 500, exactLimit: 0, seed: 'versus-fixture' }); finish(h);
  const s = stat(h), expected = h.allInEquity.players.find(p => p.id === 'me').expectedNet / 10;
  cleanCoverage(s); assert.equal(s.headsUp.hands, 1); assert.equal(s.allIn.hands, 1); assert.equal(s.allIn.estimatedHands, 1);
  assert.equal(s.allIn.actualNetBB, (h.players[0].stack - 100) / 10); assert.equal(s.allIn.expectedNetBB, Math.round(expected * 100) / 100);
  assert.equal(s.allIn.differenceBB, Math.round((s.allIn.actualNetBB - expected) * 100) / 100);
  h.miniChanges = { me: 100000 }; assert.deepEqual(stat(h).allIn, s.allIn);
});

test('flop locks can be exact; river all-ins and multiway locks are excluded', () => {
  const h = make({ stacks: [100, 100] }); toFlop(h); applyAction(h, 'peer', 'allin'); applyAction(h, 'me', 'call');
  h.allInEquity = calculateEquity(h.allInLock); const s = stat(h); cleanCoverage(s); assert.equal(s.allIn.hands, 1); assert.equal(s.allIn.estimatedHands, 0);
  const river = make({ stacks: [100, 100] }); while (river.street !== 'river') applyAction(river, river.actingId, availableActions(river, river.actingId).canCheck ? 'check' : 'call');
  applyAction(river, 'peer', 'allin'); applyAction(river, 'me', 'call'); assert.equal(stat(river).allIn.eligibleHands, 0);
});

test('missing snapshots and mismatched later-board snapshots report coverage instead of fabricated EV', () => {
  const h = make({ stacks: [100, 100] }); applyAction(h, 'me', 'allin'); applyAction(h, 'peer', 'call');
  let s = stat(h); cleanCoverage(s); assert.equal(s.allIn.eligibleHands, 1); assert.equal(s.allIn.unavailableHands, 1); assert.equal(s.allIn.expectedNetBB, null);
  h.allInEquity = calculateEquity({ ...h.allInLock, board: h.board }); s = stat(h); assert.equal(s.allIn.hands, 0);
  delete h.allInLock; s = stat(h); assert.equal(s.allIn.eligibleHands, 1); assert.equal(s.allIn.unavailableHands, 1);
});

test('bomb antes, entry posts and timeouts validate without becoming voluntary responses', () => {
  const bomb = make({ bomb: true }); finish(bomb); cleanCoverage(stat(bomb)); assert.equal(stat(bomb).threeBet.mine.opportunities, 0);
  const entry = make({ ids: ['me', 'peer', 'third'], entryPosts: [{ playerId: 'me', live: 10, dead: 5 }] });
  applyAction(entry, 'me', 'check'); applyAction(entry, 'peer', 'call'); finish(entry);
  entry.log.splice(2, 0, { type: 'timeout', street: 'preflop', playerId: 'me', amount: 0 }); entry.log.forEach((e, i) => e.seq = i + 1);
  cleanCoverage(stat(entry)); assert.equal(stat(entry).responses.mine.call.opportunities, 0);
});

test('incomplete or illegal old logs are excluded wholly and expose unknown coverage', () => {
  const h = make(); applyAction(h, 'me', 'raise', 30); applyAction(h, 'peer', 'call'); finish(h);
  const broken = structuredClone(h); broken.log.find(e => e.type === 'call').amount++;
  const s = stat(broken); assert.equal(s.coverage.actionUnknownHands, 1); assert.equal(s.responses.opponent.call.opportunities, 0); assert.equal(s.threeBet.opponent.opportunities, 0);
  const old = structuredClone(h); delete old.log; delete old.allInLock;
  const before = structuredClone(old), missing = stat(old); assert.equal(missing.coverage.flopUnknownHands, 1); assert.equal(missing.headsUp.hands, 0);
  assert.equal(missing.coverage.actionUnknownHands, 1); assert.equal(missing.coverage.allInUnknownHands, 1); assert.deepEqual(old, before);
});

test('missing historical BB is null, never replaced with a present table blind or partial net', () => {
  const a = finish(make()), b = finish(make()); delete b.bigBlind;
  const s = stat([a, b]); assert.equal(s.headsUp.hands, 2); assert.equal(s.headsUp.bbHands, 1); assert.equal(s.headsUp.bbComplete, false); assert.equal(s.headsUp.netBB, null);
});

test('aggregation never reads hidden card values, archived deck or account data, and serializes only counters', () => {
  const h = make(); applyAction(h, 'me', 'raise', 30); applyAction(h, 'peer', 'call'); finish(h);
  const expected = stat(h);
  for (const p of h.players) p.cards = new Proxy(['SECRET_CARD', 'SECRET_CARD'], { get(target, key) { if (key !== 'length') throw new Error('private card read'); return target.length; } });
  Object.defineProperty(h, 'deck', { get() { throw new Error('private deck read'); } });
  h.passwordHash = 'SECRET_PASSWORD'; h.invite = 'SECRET_INVITE';
  const actual = stat(h); assert.deepEqual(actual, expected);
  const serialized = JSON.stringify(actual); for (const forbidden of ['SECRET', 'cards', 'deck', 'playerId', 'roomCode', 'payouts', 'log', 'password']) assert.ok(!serialized.includes(forbidden), forbidden);
});


test('responses exclude multiway decisions, then count later decisions once only these two remain', () => {
  const h = make({ ids: ['me', 'peer', 'third'] });
  applyAction(h, 'me', 'raise', 30); applyAction(h, 'peer', 'call'); applyAction(h, 'third', 'call');
  applyAction(h, 'peer', 'raise', 30); applyAction(h, 'third', 'call'); applyAction(h, 'me', 'call');
  applyAction(h, 'peer', 'raise', 40); applyAction(h, 'third', 'fold'); applyAction(h, 'me', 'call'); finish(h);
  const s = stat(h); cleanCoverage(s);
  assert.equal(s.headsUp.hands, 0);
  assert.deepEqual(s.responses.mine.call, { count: 1, opportunities: 1, percent: 100 });
  assert.equal(s.responses.opponent.call.opportunities, 0);
  assert.deepEqual(s.threeBet.opponent, { count: 0, opportunities: 1, percent: 0 });
});
