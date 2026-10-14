import { recordFilters, ledgerBlindLookup } from './records.js';
import { directOpponentRecords } from './opponent-transfers.js';

// Complete rounds are assembled before date/player filtering. The last hand
// may omit a disconnected participant; its dealt list is not a round roster.
export function squidRecordGroups(db, userId, filter, room) {
  const grouped = new Map(), snapshots = new Map(), blindFor = ledgerBlindLookup(db);
  for (const hand of db.hands ?? []) {
    if (hand.status !== 'complete') continue;
    for (const q of [hand.miniBefore?.squid, hand.miniAfter?.squid]) {
      if (!q) continue;
      const key = `${hand.roomCode}/${q.round}`, list = snapshots.get(key) ?? [];
      list.push(q); snapshots.set(key, list);
    }
  }
  for (const row of db.ledger ?? []) {
    if (row.type !== 'squidSettlement' || room && row.roomCode !== room) continue;
    // Malformed legacy records remain visible as unavailable, never disappear.
    const key = `${row.roomCode}/${row.roundSettlementId ?? `legacy-${row.round ?? row.id}`}`;
    const rows = grouped.get(key) ?? []; rows.push(row); grouped.set(key, rows);
  }
  const result = [];
  for (const rows of grouped.values()) {
    const own = rows.find(row => row.playerId === userId) ?? rows[0];
    const historical = snapshots.get(`${own.roomCode}/${own.round}`) ?? [];
    const settled = historical.findLast(q => q.lastResult?.roundSettlementId === own.roundSettlementId);
    const snapshot = settled ?? historical.findLast(q => q.roundSettlementId === own.roundSettlementId) ?? historical.at(-1);
    const roster = own.participantIds ?? settled?.lastResult?.winnerIds?.concat(settled.lastResult.loserIds ?? []) ?? snapshot?.participants ?? [];
    if (!rows.some(row => row.playerId === userId) && !roster.includes(userId)) continue;
    const times = rows.map(row => Date.parse(row.at));
    // Conflicting duplicate dates must not depend on row order. Keep an
    // unavailable group in every affected date range; the validator rejects it.
    if (times.every(Number.isFinite) && !times.some(at => at >= filter.start && at <= filter.end)) continue;
    let evidence = settled ? { ...settled, lastResult: settled.lastResult } : null;
    if (!evidence) {
      const participants = own.participantIds ?? snapshot?.participants;
      // v5 per-player counts are the authoritative final counts even for a
      // settlement between hands. Earlier archived q.counts can be incomplete.
      const counts = Object.fromEntries(rows.map(row => [row.playerId, row.squidCount]));
      evidence = participants ? { roundSettlementId: own.roundSettlementId, participants,
        mode: own.squidMode ?? snapshot?.mode ?? 'normal', unit: own.squidUnit ?? snapshot?.unit,
        counts: Object.values(counts).every(Number.isSafeInteger) ? counts : snapshot?.counts,
        won: snapshot?.won, tokenBudget: own.tokenBudget ?? snapshot?.tokenBudget,
        ...(own.tokensAwarded === undefined ? {} : { tokensAwarded: own.tokensAwarded }) } : null;
    }
    const blinds = rows.map(blindFor), bigBlind = blinds.every(bb => bb === blinds[0]) ? blinds[0] : null;
    result.push({ rows, evidence, bigBlind, at: own.at });
  }
  return result;
}

export function directRecordLibrary(db, userId, options = {}) {
  // A round spans hands, positions and starting cards. Keep this report's
  // filters event-based; hand-specific analysis belongs to the hand library.
  const allowed = new Set(['from', 'to', 'room', 'opponent']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw Object.assign(new Error('对手战绩支持按日期、对局和对手筛选'), { status: 400 });
  const filter = recordFilters(options);
  if (filter.opponent === userId) throw Object.assign(new Error('请选择其他玩家作为对手'), { status: 400 });
  const entries = (db.hands ?? []).filter(h => h.status === 'complete' && (!options.room || h.roomCode === options.room)
    && Date.parse(h.at) >= filter.start && Date.parse(h.at) <= filter.end && h.players?.some(p => p.id === userId))
    .map(hand => ({ hand, player: hand.players.find(p => p.id === userId) }));
  const users = new Map(Object.values(db.users).map(user => [user.id, user]));
  const squidGroups = squidRecordGroups(db, userId, filter, options.room);
  const representedRounds = new Set(squidGroups.filter(group => group.rows[0]?.round != null)
    .map(group => `${group.rows[0].roomCode}/${group.rows[0].round}`));
  const existingSettlements = new Set((db.ledger ?? []).filter(row => row.type === 'squidSettlement').map(row => `${row.roomCode}/${row.roundSettlementId}`));
  const missingRounds = new Set(); let excludedMiniEvents = 0;
  // A missing whole ledger can affect someone absent from the finishing hand.
  // Inspect frozen settlement rosters, not just the viewer's dealt hands.
  for (const hand of db.hands ?? []) {
    if (hand.status !== 'complete' || options.room && hand.roomCode !== options.room) continue;
    const q = hand.miniAfter?.squid, last = q?.lastResult;
    const roundId = hand.squidSettlementId ?? last?.roundSettlementId;
    if (!roundId || existingSettlements.has(`${hand.roomCode}/${roundId}`)) continue;
    if (representedRounds.has(`${hand.roomCode}/${last?.round ?? q?.round}`)) continue;
    const participants = last?.winnerIds && last?.loserIds ? [...last.winnerIds, ...last.loserIds] : q?.participants ?? [];
    if (!participants.includes(userId)) continue;
    const at = last?.settledAt;
    // If a damaged legacy archive lost its settlement date, an exact dated
    // total cannot be claimed; preserve an unavailable event conservatively.
    if (at && (Date.parse(at) < filter.start || Date.parse(at) > filter.end)) continue;
    const key = `${hand.roomCode}/${roundId}`; if (missingRounds.has(key)) continue;
    missingRounds.add(key);
    squidGroups.push({ rows: [], evidence: null, participants, roomCode: hand.roomCode, roundSettlementId: roundId, at: at ?? hand.at, bigBlind: null });
  }
  for (const { hand } of entries) {
    if (!hand.miniChanges?.[userId]) continue;
    const q = hand.miniAfter?.squid ?? hand.miniBefore?.squid;
    const roundId = hand.squidSettlementId ?? q?.lastResult?.roundSettlementId;
    if (roundId && existingSettlements.has(`${hand.roomCode}/${roundId}`)) continue;
    if (representedRounds.has(`${hand.roomCode}/${q?.lastResult?.round ?? q?.round}`)) continue;
    const settledAt = q?.lastResult?.settledAt;
    if (settledAt && (Date.parse(settledAt) < filter.start || Date.parse(settledAt) > filter.end)) continue;
    if (hand.squidSettlementId || q?.lastResult?.handId === hand.id || hand.settings?.squid && q?.participants?.includes(userId)) {
      const key = `${hand.roomCode}/${roundId ?? `legacy-${q?.round ?? hand.id}`}`;
      if (missingRounds.has(key)) continue;
      missingRounds.add(key);
      squidGroups.push({ rows: [], evidence: null, participants: q?.participants ?? hand.players.map(p => p.id), roomCode: hand.roomCode,
        roundSettlementId: roundId ?? `legacy-${q?.round ?? hand.id}`, at: hand.at, bigBlind: null });
    } else excludedMiniEvents++;
  }
  const opponents = directOpponentRecords(entries, userId, filter, users, { squidGroups });
  // Options derive only from the requester's own events, never global users.
  const names = new Map();
  for (const { hand } of entries) for (const p of hand.players) if (p.id !== userId) names.set(p.id, users.get(p.id)?.name ?? p.name ?? '朋友');
  for (const group of squidGroups) for (const row of group.rows) if (row.playerId !== userId) names.set(row.playerId, users.get(row.playerId)?.name ?? row.name ?? '朋友');
  for (const peer of opponents.opponentOptions) if (!names.has(peer.id)) names.set(peer.id, peer.name);
  return { opponents, excludedMiniEvents, excludedMiniTypes: excludedMiniEvents ? ['legacyMini'] : [],
    opponentOptions: [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) };
}
