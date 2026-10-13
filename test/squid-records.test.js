import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAnalytics } from '../src/analytics.js';
import { sessionRecord, sessionLibrary } from '../src/records.js';

const D1 = '2026-10-12T10:00:00.000Z', D2 = '2026-10-13T10:00:00.000Z';
function fixture() {
  const ids = ['a', 'b', 'left'];
  const room = { code: '123456', name: 'Synthetic friends', status: 'closed', createdAt: D1, startedAt: Date.parse(D1), closedAt: D2,
    settings: { smallBlind: 1, bigBlind: 2 }, members: Object.fromEntries(ids.map(id => [id, { id, totalBuyIn: 100, seat: null }])) };
  const db = { users: Object.fromEntries(ids.map(id => [id, { id, name: id }])), rooms: { [room.code]: room }, hands: [], ledger: [] };
  function hand({ id = 'hand-1', at = D1, mini = {}, squid, squidChanges, net = 4 } = {}) {
    const h = { id, status: 'complete', at, roomCode: room.code, number: db.hands.length + 1, bigBlind: 2, board: [], log: [],
      players: [{ id: 'a', startingStack: 100, stack: 100 + net }, { id: 'b', startingStack: 100, stack: 100 - net }],
      miniChanges: mini, result: { showdown: false, payouts: { a: 8 }, pots: [] } };
    if (squid) { h.squidSettlementId = squid; if (squidChanges) h.squidSettlementChanges = squidChanges; }
    db.hands.push(h); return h;
  }
  function settle(id, amounts, { at = D2, reason = 'normal', handId = db.hands.at(-1)?.id ?? null, roomCode = room.code } = {}) {
    for (const [playerId, amount] of Object.entries(amounts)) db.ledger.push({ id: `${id}-${playerId}`, type: 'squidSettlement', at,
      roomCode, playerId, amount, roundSettlementId: id, round: 1, reason, handId, note: 'synthetic settlement' });
  }
  return { db, room, hand, settle };
}

test('normal squid ledger replaces its per-hand mirror once, preserves another mini change and deduplicates retries', () => {
  const f = fixture();
  f.hand({ mini: { a: 1, b: -4 }, squid: 'round-normal', squidChanges: { a: 2, b: -4, left: 2 } });
  f.settle('round-normal', { a: 2, b: -4, left: 2 });
  f.db.ledger.push(structuredClone(f.db.ledger[0]));
  f.db.ledger.push({ type: 'mushroomRefund', playerId: 'a', roomCode: f.room.code, at: D2, amount: 1 });
  const s = sessionRecord(f.db, f.room, 'a'), a = aggregateAnalytics(f.db, 'a');
  assert.equal(s.meMiniNet, 2); assert.equal(a.miniNet, 2); assert.equal(a.holdemNet, 4);
  assert.equal(a.hands, 1); assert.equal(a.squidSettlementCount, 1); assert.equal(a.adjustmentCount, 1);
  assert.equal(s.players.reduce((sum, row) => sum + row.net, 0), 0);
  assert.equal(s.players.find(row => row.id === 'left').miniNet, 2);
  assert.equal(s.players.find(row => row.id === 'left').hands, 0);
});

test('forfeit and partial settlement credit departed token holders without inventing hands or Holdem/EV', () => {
  const f = fixture(); f.hand();
  f.settle('forfeit', { a: -4, b: 2, left: 2 }, { reason: 'forfeit' });
  f.settle('partial', { a: -2, b: 0, left: 2 }, { reason: 'partial' });
  const left = aggregateAnalytics(f.db, 'left', { from: '2026-10-13', to: '2026-10-13' });
  assert.equal(left.hands, 0); assert.equal(left.matchedHands, 0); assert.equal(left.sessions, 1);
  assert.equal(left.holdemNet, 0); assert.equal(left.miniNet, 4); assert.equal(left.net, 4);
  assert.equal(left.squidSettlementCount, 2); assert.equal(left.standaloneSquidSettlementCount, 2);
  assert.equal(left.metrics.vpip.opportunities, 0); assert.equal(left.allIn.count, 0); assert.equal(left.allIn.expectedNet, null);
  assert.equal(left.curve.at(-1).miniNet, 4); assert.ok(left.curve.every(row => row.handId === null));
  const session = sessionRecord(f.db, f.room, 'left');
  assert.equal(session.meNet, 4); assert.equal(session.handCount, 1);
  assert.equal(session.players.reduce((sum, row) => sum + row.net, 0), 0);
  const filtered = sessionLibrary(f.db, 'left', { result: 'win', from: '2026-10-12', to: '2026-10-12' });
  assert.equal(filtered.totals.net, 4); assert.equal(filtered.totals.count, 1);
  assert.equal(sessionLibrary(f.db, 'left', { result: 'loss' }).totals.count, 0);
});

test('settlement time and room boundaries apply even if referenced hand was played outside the range', () => {
  const f = fixture(); f.hand({ mini: { a: 2 }, squid: 'normal' }); f.settle('normal', { a: 2 });
  f.settle('outside', { a: 50 }, { at: '2026-10-14T00:00:00.000Z' });
  f.settle('other-room', { a: 100 }, { roomCode: '654321' });
  const day = aggregateAnalytics(f.db, 'a', { from: '2026-10-13', to: '2026-10-13', room: f.room.code });
  assert.equal(day.miniNet, 2); assert.equal(day.hands, 0); assert.equal(day.holdemNet, 0); assert.equal(day.sessions, 1);
  assert.equal(day.squidSettlementCount, 1);
  const previous = aggregateAnalytics(f.db, 'a', { from: '2026-10-12', to: '2026-10-12' });
  assert.equal(previous.hands, 1); assert.equal(previous.miniNet, 0); assert.equal(previous.net, 4);
  const rolling = aggregateAnalytics(f.db, 'a', { period: '1', room: f.room.code }, Date.parse(D2) + 1);
  assert.equal(rolling.miniNet, 2);
});

test('latest-hand filters count only mirrored settlement of those hands, never a standalone reference', () => {
  const f = fixture();
  f.hand({ id: 'old', mini: { a: 20 }, squid: 'old-round' }); f.settle('old-round', { a: 20 }, { at: D1 });
  f.hand({ id: 'new', at: D2, mini: { a: 2 }, squid: 'new-round' }); f.settle('new-round', { a: 2 });
  f.settle('off-table', { a: 50 }, { reason: 'partial', handId: 'new' });
  const capped = aggregateAnalytics(f.db, 'a', { maxHands: '1' });
  assert.equal(capped.hands, 1); assert.equal(capped.holdemNet, 4); assert.equal(capped.miniNet, 2);
  assert.equal(capped.squidSettlementCount, 1); assert.equal(capped.standaloneSquidSettlementCount, 0);
  assert.equal(capped.adjustmentsExcluded, true);
  const all = aggregateAnalytics(f.db, 'a'); assert.equal(all.miniNet, 72);
  const left = aggregateAnalytics(f.db, 'left', { maxHands: '1' }); assert.equal(left.hands, 0); assert.equal(left.miniNet, 0);
});

test('old hand-only mini data and missing mirror-ledger fallbacks retain their historical totals', () => {
  const f = fixture(); f.hand({ mini: { a: -6, b: 6 } });
  f.hand({ id: 'linked-no-ledger', mini: { a: 2, b: -2 }, squid: 'missing' });
  const a = aggregateAnalytics(f.db, 'a'), session = sessionRecord(f.db, f.room, 'a');
  assert.equal(a.miniNet, -4); assert.equal(session.meMiniNet, -4); assert.equal(a.hands, 2);
  assert.equal(a.squidSettlementCount, 0);
});

test('zero-net cancelled rounds remain visible as settlements without counting as a win or a hand', () => {
  const f = fixture(); f.settle('zero', { a: 0, b: 0, left: 0 }, { reason: 'partial', handId: null });
  const a = aggregateAnalytics(f.db, 'a');
  assert.equal(a.squidSettlementCount, 1); assert.equal(a.hands, 0); assert.equal(a.winHands, 0); assert.equal(a.miniNet, 0);
  assert.equal(a.allIn.eligibleCount, 0);
  assert.equal(sessionRecord(f.db, f.room, 'a').players.reduce((n, p) => n + p.net, 0), 0);
});
