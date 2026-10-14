import test from 'node:test';
import assert from 'node:assert/strict';
import { directRecordLibrary, squidRecordGroups } from '../src/direct-records.js';
import { recordFilters } from '../src/records.js';

const BEFORE = '2026-10-13T23:59:58.000Z', AFTER = '2026-10-14T00:00:02.000Z';
// A was absent from the final three-player hand but belongs to the frozen
// four-player round. This deliberately differs from API's all-dealt fixture.
function fixture({ cancelled = false } = {}) {
  const ids = [...'ABCD'], counts = cancelled ? { A: 0, B: 0, C: 0, D: 0 } : { A: 1, B: 1, C: 1, D: 0 };
  const changes = cancelled ? { A: 0, B: 0, C: 0, D: 0 } : { A: 20, B: 20, C: 20, D: -60 };
  const lastResult = { round: 1, roundSettlementId: 'frozen-round', handId: 'final-hand',
    mode: 'normal', unit: 20, counts, tokenBudget: 3, tokensAwarded: cancelled ? 0 : 3,
    winnerIds: cancelled ? [] : ['A', 'B', 'C'], loserIds: cancelled ? ids : ['D'], changes };
  const q = { active: false, participants: ids, round: 1, roundSettlementId: 'frozen-round', mode: 'normal',
    unit: 20, won: cancelled ? [] : ['A', 'B', 'C'], counts, tokenBudget: 3, lastResult };
  const hand = { id: 'final-hand', status: 'complete', roomCode: '100001', at: BEFORE, bigBlind: 10, settings: { bigBlind: 10, squid: true },
    players: ['B', 'C', 'D'].map(id => ({ id, name: `Old ${id}`, startingStack: 100, stack: id === 'B' ? 120 : 90,
      contributed: 10, deadContribution: 0, folded: id !== 'B', cards: [`PRIVATE-CARD-${id}`] })),
    result: { pots: [{ amount: 30, eligibleIds: ['B'], winnerIds: ['B'] }], payouts: { B: 30, C: 0, D: 0 } },
    squidSettlementId: 'frozen-round', squidSettlementChanges: changes, miniChanges: changes,
    miniAfter: { squid: q }, deck: ['PRIVATE-DECK'], audit: { key: 'PRIVATE-AUDIT' }, shown: {} };
  const rows = ids.map(playerId => ({ id: `row-${playerId}`, type: 'squidSettlement', roomCode: '100001', round: 1,
    roundSettlementId: 'frozen-round', handId: 'final-hand', at: AFTER, playerId, amount: changes[playerId],
    squidMode: 'normal', squidCount: counts[playerId], tokenBudget: 3, tokensAwarded: cancelled ? 0 : 3,
    squidUnit: 20, participantIds: ids }));
  const db = { users: Object.fromEntries([...ids, 'outsider'].map(id => [id, { id, name: `Current ${id}`, avatar: 1,
    passwordHash: `PRIVATE-PASSWORD-${id}`, recoveryHash: `PRIVATE-RECOVERY-${id}`, sessions: ['PRIVATE-SESSION'] }])),
    rooms: { '100001': { code: '100001', settings: { bigBlind: 1000, squidUnit: 5000, squid: false }, members: {}, invite: 'PRIVATE-INVITE' } },
    hands: [hand], ledger: rows };
  return { db, hand, q, rows };
}
const fish = (f, user = 'A', options = {}) => directRecordLibrary(f.db, user, options).opponents.summary.squid;

test('direct library audit: absent frozen participant is counted on the settlement day, not final hand day', () => {
  const f = fixture();
  const previous = directRecordLibrary(f.db, 'A', { from: '2026-10-13', to: '2026-10-13' });
  assert.equal(previous.opponents.summary.hands, 0); assert.equal(previous.opponents.summary.squid.events, 0);
  const next = directRecordLibrary(f.db, 'A', { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(next.opponents.summary.hands, 0); assert.equal(next.opponents.summary.squid.events, 1);
  assert.equal(next.opponents.summary.squid.net, 20); assert.equal(next.opponents.summary.squid.netBB, 2);
  assert.equal(next.opponents.rows.find(row => row.id === 'D').squid.won, 20);
  assert.equal(next.opponents.rows.find(row => row.id === 'B').squid.net, 0);
});

test('direct library audit: disabled current squid and changed blinds never rewrite frozen settlement meaning', () => {
  const f = fixture(); assert.equal(fish(f).netBB, 2);
  f.db.rooms['100001'].settings = { squid: false, squidUnit: 999999, bigBlind: 2000 };
  assert.equal(fish(f).net, 20); assert.equal(fish(f).netBB, 2);
  delete f.db.rooms['100001']; assert.equal(fish(f).netBB, 2);
  delete f.hand.bigBlind; delete f.hand.settings.bigBlind;
  assert.equal(fish(f).net, 20); assert.equal(fish(f).netBB, null, 'current settings cannot fabricate missing historical BB');
});

test('direct library audit: repeated identical ledger rows deduplicate but contradictory amounts are unavailable', () => {
  const f = fixture(); f.db.ledger.push(structuredClone(f.rows[0]));
  assert.equal(fish(f).events, 1); assert.equal(fish(f).net, 20);
  f.db.ledger.push({ ...f.rows[0], id: 'conflicting-A', amount: 21 });
  assert.equal(fish(f).events, 1); assert.equal(fish(f).net, null); assert.equal(fish(f).unknownEvents, 1);
});

test('direct library audit: missing another frozen participant is unknown rather than treating that opponent as even', () => {
  const f = fixture(); f.db.ledger = f.rows.filter(row => row.playerId !== 'D');
  const report = directRecordLibrary(f.db, 'A').opponents;
  assert.equal(report.summary.squid.events, 1); assert.equal(report.summary.squid.net, null);
  assert.equal(report.rows.find(row => row.id === 'D').squid.net, null);
});

test('direct library audit: losing the viewer row cannot erase a known frozen round into zero', () => {
  const f = fixture(); f.db.ledger = f.rows.filter(row => row.playerId !== 'A');
  const report = directRecordLibrary(f.db, 'A').opponents;
  assert.equal(report.summary.squid.events, 1); assert.equal(report.summary.squid.unknownEvents, 1);
  assert.equal(report.summary.squid.net, null); assert.equal(report.summary.hands, 0);
});

test('direct library audit: an explicit settled snapshot remains unknown when every ledger row is missing and hero was absent', () => {
  const f = fixture(); f.db.ledger = [];
  const report = directRecordLibrary(f.db, 'A').opponents;
  assert.equal(report.summary.squid.events, 1); assert.equal(report.summary.squid.unknownEvents, 1);
  assert.equal(report.summary.squid.net, null); assert.equal(report.summary.hands, 0);
});

test('direct library audit: a known later settlement date is not reinserted by the dealt-hand missing-ledger fallback', () => {
  const f = fixture(); f.db.ledger = []; f.q.lastResult.settledAt = AFTER;
  const before = directRecordLibrary(f.db, 'B', { from: '2026-10-13', to: '2026-10-13' }).opponents;
  assert.equal(before.summary.hands, 1); assert.equal(before.summary.holdem.net, 20);
  assert.equal(before.summary.squid.events, 0); assert.equal(before.summary.squid.net, 0);
  const after = directRecordLibrary(f.db, 'B', { from: '2026-10-14', to: '2026-10-14' }).opponents;
  assert.equal(after.summary.hands, 0); assert.equal(after.summary.squid.events, 1);
  assert.equal(after.summary.squid.unknownEvents, 1); assert.equal(after.summary.squid.net, null);
});

test('direct library audit: a cancelled zero-fish round is a known zero event, distinct from missing evidence', () => {
  const f = fixture({ cancelled: true });
  assert.equal(fish(f).events, 1); assert.equal(fish(f).coveredEvents, 1); assert.equal(fish(f).unknownEvents, 0);
  assert.equal(fish(f).net, 0); assert.equal(fish(f).netBB, 0);
});

test('direct library audit: same settlement identifier in another room neither merges nor leaks an unrelated participant', () => {
  const f = fixture();
  f.db.ledger.push({ ...f.rows[0], roomCode: '200002', playerId: 'outsider', participantIds: ['outsider', 'X', 'Y'], amount: 999 });
  assert.equal(fish(f).events, 1); assert.equal(fish(f).net, 20);
  const ownRoom = directRecordLibrary(f.db, 'A', { room: '100001' });
  assert.equal(ownRoom.opponentOptions.some(row => row.id === 'outsider'), false);
  assert.equal(directRecordLibrary(f.db, 'A', { room: '200002' }).opponents.summary.squid.events, 0);
});

test('direct library audit: reports disclose no cards, account credentials, invite or unknown users; reads are pure', () => {
  const f = fixture(), before = structuredClone(f.db);
  const report = directRecordLibrary(f.db, 'A'), encoded = JSON.stringify(report);
  assert.equal(encoded.includes('PRIVATE-'), false);
  assert.deepEqual(report.opponentOptions.map(row => row.id).sort(), ['B', 'C', 'D']);
  assert.deepEqual(f.db, before);
  const outsider = directRecordLibrary(f.db, 'outsider');
  assert.deepEqual(outsider.opponents.rows, []); assert.deepEqual(outsider.opponentOptions, []);
});

test('direct library audit: cross-day duplicate timestamps cannot silently choose a profitable day by row order', () => {
  const f = fixture(); f.db.ledger.push({ ...f.rows[0], id: 'replayed-A', at: BEFORE });
  const groups = squidRecordGroups(f.db, 'A', recordFilters({}), '100001');
  assert.equal(groups.length, 1);
  const all = fish(f);
  assert.equal(all.events, 1); assert.equal(all.net, null, 'conflicting settlement dates are unavailable, not first-row-wins');
  for (const date of ['2026-10-13', '2026-10-14']) {
    const dated = fish(f, 'A', { from: date, to: date });
    assert.equal(dated.events, 1); assert.equal(dated.unknownEvents, 1); assert.equal(dated.net, null);
  }
  f.db.ledger.reverse();
  const reversed = fish(f);
  assert.equal(reversed.events, 1); assert.equal(reversed.net, null);
});

test('direct library audit: damaged legacy ledger identity and its frozen snapshot represent one unknown round, not two', () => {
  const f = fixture(); f.db.ledger.forEach(row => delete row.roundSettlementId);
  const result = fish(f);
  assert.equal(result.events, 1); assert.equal(result.unknownEvents, 1); assert.equal(result.net, null);
});
