import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { aggregateAnalytics, analyticsFilters, handTendencies } from '../src/analytics.js';
import { calculateEquity } from '../src/equity.js';

function hand(id, { at = '2026-10-13T10:00:00.000Z', room = '123456', net = 10, mini = 0, bigBlind = 2, bomb = false, log = [], showdown = false } = {}) {
  return { id, status: 'complete', at, roomCode: room, number: 1, bigBlind, smallBlind: 1, bombPot: bomb,
    board: showdown ? ['2c', '3c', '4c', '5c', '6c'] : [],
    players: [{ id: 'me', startingStack: 100, stack: 100 + net, folded: false, cards: ['Ah', 'Ad'] }, { id: 'other', startingStack: 100, stack: 100 - net, folded: !showdown, cards: ['Kh', 'Kd'] }],
    log, miniChanges: { me: mini }, result: { showdown, payouts: { me: net > 0 ? 20 : 0 }, pots: [] } };
}
function db(hands = [], ledger = []) { return { hands, ledger, rooms: { '123456': { name: '测试桌', members: { me: { totalBuyIn: 100 } } } } }; }
const act = (type, playerId, amount, to, extra = {}) => ({ type, playerId, ...(amount !== undefined ? { amount } : {}), ...(to !== undefined ? { to } : {}), street: 'preflop', ...extra });
function engineHand(players = [{ id: 'me', seat: 0, stack: 1000 }, { id: 'other', seat: 1, stack: 1000 }]) {
  return createHand({ id: 'engine', players, buttonSeat: 0, smallBlind: 1, bigBlind: 2 });
}

test('VPIP counts voluntary contributions once, excludes blind walks and bomb antes; no opportunities is null', () => {
  const blindWalk = hand('blind', { net: 1, log: [act('smallBlind', 'other', 1, 1), act('bigBlind', 'me', 2, 2), act('fold', 'other')] });
  const limpRaise = hand('limp', { log: [act('call', 'me', 2, 2), act('raise', 'other', 10, 10), act('raise', 'me', 30, 32)] });
  const bomb = hand('bomb', { bomb: true, log: [act('ante', 'me', 10), { type: 'street', street: 'flop', board: ['2c', '3d', '4h'] }] });
  const stats = aggregateAnalytics(db([blindWalk, limpRaise, bomb]), 'me');
  assert.equal(stats.hands, 3); assert.equal(stats.preflopHands, 2);
  assert.deepEqual(stats.metrics.vpip, { count: 1, opportunities: 2, percent: 50 });
  assert.deepEqual(stats.metrics.pfr, { count: 1, opportunities: 2, percent: 50 });
  assert.equal(stats.metrics.fiveBet.percent, null); assert.equal(stats.metrics.fiveBet.opportunities, 0);
});

test('RFI is only unopened pots: prior limpers and a limp-reraise do not count as an open raise', () => {
  const open = hand('open', { log: [act('raise', 'me', 6, 6)] });
  assert.equal(handTendencies(open, 'me').rfi, true);
  const overLimp = hand('iso', { log: [act('call', 'other', 2, 2), act('raise', 'me', 6, 6)] });
  assert.equal(handTendencies(overLimp, 'me').rfiOpportunity, false);
  const limpRaise = hand('limp', { log: [act('call', 'me', 2, 2), act('raise', 'other', 10, 10), act('raise', 'me', 30, 32)] });
  const stats = handTendencies(limpRaise, 'me');
  assert.equal(stats.rfiOpportunity, true); assert.equal(stats.rfi, false); assert.equal(stats.threeBet, true);
});

test('3-bet, 4-bet and 5-bet use distinct legal decision opportunities, not all dealt hands', () => {
  const h = engineHand();
  applyAction(h, 'me', 'raise', 6); applyAction(h, 'other', 'raise', 18);
  applyAction(h, 'me', 'raise', 50); applyAction(h, 'other', 'raise', 150); applyAction(h, 'me', 'fold');
  const me = handTendencies(h, 'me'), other = handTendencies(h, 'other');
  assert.equal(me.rfi, true); assert.equal(me.threeBetOpportunity, false);
  assert.equal(me.fourBetOpportunity, true); assert.equal(me.fourBet, true); assert.equal(me.fiveBetOpportunity, false);
  assert.equal(other.threeBet, true); assert.equal(other.fiveBet, true);
  assert.equal(other.fourBetOpportunity, false);
});

test('short all-ins do not create a re-raise opportunity for a player whose action has not reopened', () => {
  const h = engineHand([{ id: 'me', seat: 0, stack: 1000 }, { id: 'other', seat: 1, stack: 150 }]);
  applyAction(h, 'me', 'raise', 100); applyAction(h, 'other', 'allin');
  assert.equal(availableActions(h, 'me').canRaise, false); applyAction(h, 'me', 'fold');
  const me = handTendencies(h, 'me'), other = handTendencies(h, 'other');
  assert.equal(me.fourBetOpportunity, false); assert.equal(other.threeBet, true);
});

test('cumulative short all-ins reopen raising only after reaching the original minimum increment', () => {
  const h = engineHand([{ id: 'me', seat: 0, stack: 1000 }, { id: 'b', seat: 1, stack: 14 }, { id: 'c', seat: 2, stack: 18 }, { id: 'd', seat: 3, stack: 1000 }]);
  applyAction(h, 'd', 'call'); applyAction(h, 'me', 'raise', 10); applyAction(h, 'b', 'allin'); applyAction(h, 'c', 'allin'); applyAction(h, 'd', 'call');
  assert.equal(availableActions(h, 'me').canRaise, true); applyAction(h, 'me', 'raise', 30); applyAction(h, 'd', 'fold');
  const me = handTendencies(h, 'me'); assert.equal(me.fiveBetOpportunity, true); assert.equal(me.fiveBet, true);
});

test('win rate means positive poker net; flop, showdown and showdown-pot rates have their own denominators', () => {
  const preflopFold = hand('fold', { net: -2, log: [act('fold', 'me'), { type: 'street', street: 'flop', board: ['2c', '3d', '4h'] }] }); preflopFold.players[0].folded = true;
  const flopFold = hand('flopfold', { net: -4, log: [{ type: 'street', street: 'flop', board: ['2c', '3d', '4h'] }, { type: 'fold', playerId: 'me', street: 'flop' }] }); flopFold.players[0].folded = true;
  const split = hand('split', { net: 0, showdown: true, log: [{ type: 'street', street: 'flop', board: ['2c', '3d', '4h'] }] }); split.result.payouts.me = 10;
  const win = hand('win', { net: 10 });
  const stats = aggregateAnalytics(db([preflopFold, flopFold, split, win]), 'me');
  assert.deepEqual(stats.metrics.winRate, { count: 1, opportunities: 4, percent: 25 });
  assert.deepEqual(stats.metrics.flopSeen, { count: 2, opportunities: 4, percent: 50 });
  assert.deepEqual(stats.metrics.wtsd, { count: 1, opportunities: 2, percent: 50 });
  assert.deepEqual(stats.metrics.wsd, { count: 1, opportunities: 1, percent: 100 });
});

test('date and room boundaries apply before latest-hand cap, and unfinished or spectator hands are omitted', () => {
  const older = hand('older', { at: '2026-10-12T15:59:59.999Z', net: 99 });
  const first = hand('first', { at: '2026-10-12T16:00:00.000Z', net: 1 });
  const last = hand('last', { at: '2026-10-13T15:59:59.999Z', net: 2 });
  const after = hand('after', { at: '2026-10-13T16:00:00.000Z', net: 99 });
  const wrongRoom = hand('room', { room: '654321', net: 99 });
  const active = hand('active'); active.status = 'playing';
  const observed = hand('observed'); observed.players = [{ id: 'other', stack: 1, startingStack: 1 }];
  const result = aggregateAnalytics(db([older, first, last, after, wrongRoom, active, observed]), 'me',
    { from: '2026-10-13T00:00:00.000+08:00', to: '2026-10-13T23:59:59.999+08:00', maxHands: '1', room: '123456' });
  assert.equal(result.matchedHands, 2); assert.equal(result.hands, 1); assert.equal(result.net, 2); assert.equal(result.curve[0].handId, 'last');
});

test('invalid analytics filters fail explicitly rather than silently broadening the query', () => {
  for (const value of ['0', '-1', '1.5', '100001', '1e3', 'xyz']) assert.throws(() => analyticsFilters({ maxHands: value }), e => e.status === 400);
  for (const filter of [{ from: '2026-02-30' }, { from: '2026-10-14', to: '2026-10-13' }, { room: 'anything' }, { period: '5' }, { period: '7', from: '2026-10-01' }])
    assert.throws(() => analyticsFilters(filter), e => e.status === 400);
  const now = Date.parse('2026-10-13T12:00:00.000Z'); assert.equal(analyticsFilters({ period: '3' }, now).start, now - 3 * 86400000);
});

test('bb/100 normalizes each hand by its own blind and excludes mini-game income and buy-ins', () => {
  const stats = aggregateAnalytics(db([hand('a', { net: 10, bigBlind: 2, mini: 100 }), hand('b', { net: -10, bigBlind: 10 })],
    [{ type: 'buyin', playerId: 'me', amount: 1000 }]), 'me');
  assert.equal(stats.net, 100); assert.equal(stats.holdemNet, 0); assert.equal(stats.bbNet, 4); assert.equal(stats.bbPer100, 200); assert.equal(stats.totalBuyIn, 1000);
});

function lockedHand(id, options = {}) {
  const h = hand(id, { net: -100, showdown: true, ...options });
  h.allInLock = { street: 'flop', board: ['2c', '7d', '8h'], players: [{ id: 'me' }, { id: 'other' }] };
  h.allInEquity = { method: 'exact', samples: 990, players: [{ id: 'me', expectedNet: 64, equity: 82 }, { id: 'other', expectedNet: -64, equity: 18 }] };
  return h;
}

test('all-in luck compares saved initial-lock expected net to settled poker net, not later equity or minigames', () => {
  const a = lockedHand('a', { mini: 500 });
  const b = lockedHand('b', { net: 100 }); b.allInEquity.method = 'monte-carlo'; b.allInEquity.players[0].expectedNet = 20;
  const ordinary = hand('ordinary', { net: 1000 });
  const result = aggregateAnalytics(db([a, b, ordinary]), 'me');
  assert.equal(result.allIn.count, 2); assert.equal(result.allIn.eligibleCount, 2); assert.equal(result.allIn.actualNet, 0);
  assert.equal(result.allIn.expectedNet, 84); assert.equal(result.allIn.difference, -84); assert.equal(result.allIn.estimatedCount, 1);
  assert.equal(result.allIn.curve.at(-1).difference, -84); assert.deepEqual(result.allIn.hands.find(h => h.id === 'a').board, ['2c', '7d', '8h']);
  assert.equal(result.allIn.hands.find(h => h.id === 'a').actualNet, -100);
});

test('real unequal-stack multiway all-in aggregates saved per-pot EV with the same cost basis as settlement', () => {
  const h = engineHand([{ id: 'me', seat: 0, stack: 20 }, { id: 'b', seat: 1, stack: 50 }, { id: 'c', seat: 2, stack: 50 }]);
  applyAction(h, 'me', 'allin'); applyAction(h, 'b', 'allin'); applyAction(h, 'c', 'call');
  assert.equal(h.status, 'complete'); assert.equal(h.allInLock.pots.length, 2);
  h.at = '2026-10-13T10:00:00.000Z'; h.roomCode = '123456'; h.number = 1;
  h.allInEquity = calculateEquity({ ...h.allInLock, samples: 1000, seed: 'analytics-multiway-fixture' });
  const results = h.players.map(p => aggregateAnalytics(db([h]), p.id));
  assert.equal(results.reduce((sum, value) => sum + value.allIn.actualNet, 0), 0);
  assert.ok(Math.abs(results.reduce((sum, value) => sum + value.allIn.expectedNet, 0)) <= 0.02);
  for (const [i, stats] of results.entries()) {
    assert.equal(stats.allIn.count, 1); assert.equal(stats.allIn.eligibleCount, 1);
    assert.equal(stats.allIn.actualNet, h.players[i].stack - h.players[i].startingStack);
    assert.ok(Math.abs(stats.allIn.difference - (stats.allIn.actualNet - stats.allIn.expectedNet)) <= 0.011);
  }
});

test('old all-in runouts report unavailable coverage; final board/private card knowledge never invents EV', () => {
  const old = hand('old', { showdown: true, log: [act('allin', 'me', 100, 100), act('allin', 'other', 100, 100),
    { type: 'street', street: 'flop', board: ['2c', '3c', '4c'] }, { type: 'street', street: 'turn', board: ['2c', '3c', '4c', '5c'] }] });
  const result = aggregateAnalytics(db([old]), 'me');
  assert.equal(result.allIn.eligibleCount, 1); assert.equal(result.allIn.count, 0); assert.equal(result.allIn.unavailableCount, 1);
  assert.equal(result.allIn.expectedNet, null); assert.equal(result.allIn.difference, null); assert.deepEqual(result.allIn.hands, []);
  const changed = structuredClone(old); changed.players[1].cards = ['2h', '2d']; changed.board = ['As', 'Ks', 'Qs', 'Js', 'Ts'];
  assert.deepEqual(aggregateAnalytics(db([changed]), 'me').allIn, result.allIn);
});

test('river all-ins, an earlier folded player and ordinary showdown are not runout-luck samples', () => {
  const river = hand('river', { showdown: true, log: [act('call', 'me', 2, 2), act('check', 'other'),
    ...[['flop', ['2c', '3d', '4h']], ['turn', ['2c', '3d', '4h', '5s']], ['river', ['2c', '3d', '4h', '5s', '6h']]].map(([street, board]) => ({ type: 'street', street, board })),
    act('allin', 'me', 98, 98, { street: 'river' }), act('allin', 'other', 98, 98, { street: 'river' })] });
  assert.equal(aggregateAnalytics(db([river]), 'me').allIn.eligibleCount, 0);
  const folded = lockedHand('folded'); folded.players[0].folded = true; folded.allInLock.players = [{ id: 'a' }, { id: 'b' }];
  assert.equal(aggregateAnalytics(db([folded]), 'me').allIn.eligibleCount, 0);
});

test('legacy off-table refunds retain chronological totals; hand-count mode excludes them explicitly', () => {
  const a = hand('a', { at: '2026-10-01T00:00:00.000Z', net: 0, mini: -5 });
  const b = hand('b', { at: '2026-10-03T00:00:00.000Z', net: 0 });
  const ledger = [{ type: 'mushroomRefund', playerId: 'me', roomCode: '123456', at: '2026-10-02T00:00:00.000Z', amount: 5 }];
  const all = aggregateAnalytics(db([b, a], ledger), 'me');
  assert.deepEqual(all.curve.map(point => point.net), [-5, 0, 0]); assert.equal(all.net, 0); assert.equal(all.adjustmentCount, 1);
  const capped = aggregateAnalytics(db([a, b], ledger), 'me', { maxHands: '2' });
  assert.equal(capped.miniNet, -5); assert.equal(capped.adjustmentsExcluded, true); assert.equal(capped.adjustmentCount, 0);
});

test('long curves are bounded while preserving endpoints, final values and full summary totals', () => {
  const hands = Array.from({ length: 501 }, (_, i) => hand(`h${i}`, { net: 1, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
  const result = aggregateAnalytics(db(hands), 'me');
  assert.equal(result.hands, 501); assert.equal(result.curve.length, 200); assert.equal(result.curve[0].handId, 'h0');
  assert.equal(result.curve.at(-1).handId, 'h500'); assert.equal(result.curve.at(-1).net, 501);
});

test('analytics responses contain no hole cards, action log, full decks, invite tokens or identity secrets', () => {
  const source = lockedHand('secure'); source.deck = ['PRIVATE']; source.audit = { token: 'PRIVATE' };
  source.allInLock.players[0].cards = ['Ah', 'Ad']; source.allInLock.players[1].cards = ['Kh', 'Kd'];
  const result = aggregateAnalytics(db([source]), 'me');
  const keys = new Set(['cards', 'deck', 'audit', 'log', 'invite', 'token', 'passwordHash', 'recoveryHash', 'allInLock']);
  function inspect(value) { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { assert.ok(!keys.has(key), key); inspect(child); } }
  inspect(result); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
