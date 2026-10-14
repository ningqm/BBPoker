import test from 'node:test';
import assert from 'node:assert/strict';
import { directSquidTransfers, directHandTransfers } from '../src/opponent-transfers.js';
import { directRecordLibrary } from '../src/direct-records.js';
import { aggregateAnalytics } from '../src/analytics.js';

const AT = '2026-10-14T14:00:00.000Z';
// Nine original seats are followed by replacements. The original first player
// and final newcomer never share a dealt hand, but owe each other fish money.
function fixture(mode, size) {
  const ids = Array.from({ length: size }, (_, i) => `player-${i}`);
  const counts = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? (mode === 'unlimited' ? 4 : 1) : i === 1 ? 1 : 0]));
  const tokensAwarded = mode === 'unlimited' ? 5 : 2;
  const tokenBudget = size + (mode === 'unlimited' ? 3 : -1), unit = 20, losers = size - 2;
  const changes = Object.fromEntries(ids.map(id => [id, counts[id] ? counts[id] * losers * unit : -tokensAwarded * unit]));
  const roundSettlementId = 'round-with-replacements';
  const q = { active: true, round: 1, roundSettlementId, mode, unit, participants: ids.slice(0, 9),
    counts: Object.fromEntries(ids.slice(0, 9).map(id => [id, counts[id]])), won: ids.slice(0, 2),
    tokenBudget: 9 + (mode === 'unlimited' ? 3 : -1) };
  // Settlement occurs between hands, so old snapshots must not truncate the
  // final authoritative ledger roster or apply the old fish budget.
  const hand = { id: 'before-replacements', status: 'complete', roomCode: '100001', at: AT,
    players: ids.slice(0, 9).map(id => ({ id })), miniBefore: { squid: structuredClone(q) }, miniAfter: { squid: structuredClone(q) } };
  const rows = ids.map(playerId => ({ id: `row-${playerId}`, type: 'squidSettlement', playerId, roomCode: '100001',
    at: AT, round: 1, roundSettlementId, amount: changes[playerId], reason: 'partial',
    participantIds: [...ids], squidMode: mode, squidUnit: unit, squidCount: counts[playerId],
    tokenBudget, tokensAwarded, bigBlind: 10 }));
  const room = { code: '100001', name: 'Local synthetic round', status: 'closed', createdAt: AT, closedAt: AT,
    settings: { bigBlind: 10 }, members: Object.fromEntries(ids.map(id => [id, { id }])) };
  return { ids, counts, changes, rows, evidence: { roundSettlementId, participants: ids, mode, unit, counts, tokenBudget, tokensAwarded },
    db: { users: Object.fromEntries(ids.map(id => [id, { id, name: id }])), rooms: { '100001': room }, hands: [hand], ledger: rows } };
}

for (const mode of ['normal', 'unlimited']) for (const size of [10, 30]) {
  test(`${mode} squid: ${size} cumulative participants reconcile direct money after seat replacements`, () => {
    const f = fixture(mode, size), before = structuredClone(f.db);
    const transfer = directSquidTransfers(f.rows, f.evidence);
    assert.equal(transfer.covered, true);
    assert.equal(transfer.transfers.length, (size - 2) * 2);
    assert.equal(Object.values(f.changes).reduce((a, b) => a + b, 0), 0);
    let aggregateNet = 0;
    for (const id of f.ids) {
      const report = directRecordLibrary(f.db, id).opponents;
      assert.equal(report.summary.squid.unknownEvents, 0);
      assert.equal(report.summary.squid.events, 1);
      assert.equal(report.summary.squid.net, f.changes[id]);
      assert.equal(report.rows.reduce((n, row) => n + row.squid.net, 0), f.changes[id]);
      assert.equal(aggregateAnalytics(f.db, id).miniNet, f.changes[id]);
      aggregateNet += report.summary.squid.net;
    }
    assert.equal(aggregateNet, 0);
    const last = directRecordLibrary(f.db, f.ids.at(-1)).opponents;
    assert.equal(last.summary.hands, 0);
    assert.equal(last.rows.find(row => row.id === f.ids[0]).squid.lost, (mode === 'unlimited' ? 4 : 1) * 20);
    assert.deepEqual(f.db, before, 'reports cannot rewrite archived rosters or account data');
  });
}

test('expanded squid rosters still reject impossible budgets, absent liabilities and a 31st member', () => {
  const f = fixture('unlimited', 10);
  const oldBudget = structuredClone(f.evidence); oldBudget.tokenBudget = 12;
  assert.equal(directSquidTransfers(f.rows, oldBudget).covered, false);
  assert.equal(directSquidTransfers(f.rows.slice(1), f.evidence).reason, 'incomplete_squid_rows');
  const tooMany = fixture('normal', 31);
  assert.equal(directSquidTransfers(tooMany.rows, tooMany.evidence).covered, false);
  // Enlarging a round's historical roster never permits ten-player Holdem.
  assert.equal(directHandTransfers({ status: 'complete', players: f.ids.map(id => ({ id })) }).reason, 'invalid_players');
});
