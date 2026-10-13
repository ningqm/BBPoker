import { recordFilters } from './records.js';

const DAY = 86400000;
const ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin']);
const PAID = new Set(['smallBlind', 'bigBlind', 'ante', 'call', 'raise', 'allin']);
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 100) / 100;
const rate = (count, opportunities) => ({ count, opportunities, percent: opportunities ? Math.round(count / opportunities * 1000) / 10 : null });

/** Date and room filters are applied before the most-recent-hand limit. */
export function analyticsFilters(input = {}, now = Date.now()) {
  const dates = recordFilters({ from: input.from, to: input.to });
  const period = input.period === undefined || input.period === '' ? 'all' : String(input.period);
  if (!['all', '1', '3', '7', '30'].includes(period)) fail('时间筛选无效');
  if (period !== 'all' && (input.from || input.to)) fail('请选择时间范围或自定义日期，不能同时使用');
  let maxHands = null;
  if (input.maxHands !== undefined && input.maxHands !== '' && input.maxHands !== 'all') {
    if (!/^[1-9]\d{0,5}$/.test(String(input.maxHands)) || Number(input.maxHands) > 100000) fail('手数需要是 1–100000 的整数');
    maxHands = Number(input.maxHands);
  }
  if (input.room !== undefined && input.room !== '' && !/^\d{6}$/.test(String(input.room))) fail('牌桌编号无效');
  return { start: period === 'all' ? dates.start : now - Number(period) * DAY,
    end: period === 'all' ? dates.end : now, maxHands, room: input.room || null, period };
}

function initialPlayers(hand) {
  return new Map(hand.players.map(player => [player.id, { id: player.id, stack: player.startingStack,
    bet: 0, contributed: 0, folded: false, acted: false, reopenAt: null }]));
}

function applyLoggedPayment(players, event) {
  const p = players.get(event.playerId);
  if (!p) return;
  if (event.type === 'fold') p.folded = true;
  if (PAID.has(event.type)) {
    const amount = finite(event.amount) ? event.amount : 0;
    p.stack -= amount; p.contributed += amount;
    if (event.type !== 'ante') p.bet = finite(event.to) ? event.to : p.bet + amount;
  } else if (event.type === 'refund') {
    p.stack += event.amount; p.contributed -= event.amount;
    p.bet -= Math.min(p.bet, event.amount);
  }
}

/** Reconstruct only public wagers. Private cards and future board cards are never read. */
export function handTendencies(hand, userId) {
  const out = { vpip: false, pfr: false, rfi: false, rfiOpportunity: false,
    threeBet: false, threeBetOpportunity: false, fourBet: false, fourBetOpportunity: false,
    fiveBet: false, fiveBetOpportunity: false, flopSeen: false };
  const players = initialPlayers(hand);
  let currentBet = hand.bigBlind, minRaise = hand.bigBlind, raiseCount = 0, unopened = true;
  for (const event of hand.log ?? []) {
    if (event.type === 'street' && event.board?.length >= 3) {
      out.flopSeen = Boolean(players.has(userId) && !players.get(userId).folded);
      break;
    }
    if (event.street !== 'preflop') continue;
    const p = players.get(event.playerId);
    if (!p) continue;
    if (!ACTIONS.has(event.type)) { applyLoggedPayment(players, event); continue; }
    const target = finite(event.to) ? event.to : p.bet + (event.amount ?? 0);
    const isRaise = ['raise', 'allin'].includes(event.type) && target > currentBet;
    if (!hand.bombPot && p.id === userId) {
      const responder = [...players.values()].some(other => other.id !== p.id && !other.folded && other.stack > 0);
      // A legal short all-in is also a raise opportunity. An un-reopened wager is not.
      const canIncrease = (!p.acted || currentBet >= p.reopenAt) && responder && p.bet + p.stack > currentBet;
      if (['call', 'raise', 'allin'].includes(event.type) && event.amount > 0) out.vpip = true;
      if (isRaise) out.pfr = true;
      if (canIncrease && unopened) { out.rfiOpportunity = true; if (isRaise) out.rfi = true; }
      const metric = { 1: 'threeBet', 2: 'fourBet', 3: 'fiveBet' }[raiseCount];
      if (canIncrease && metric) { out[metric + 'Opportunity'] = true; if (isRaise) out[metric] = true; }
    }
    applyLoggedPayment(players, event);
    if (isRaise) {
      const increment = target - currentBet;
      if (increment >= minRaise) minRaise = increment;
      currentBet = target; raiseCount++;
    }
    if (['call', 'raise', 'allin'].includes(event.type) && event.amount > 0) unopened = false;
    p.acted = true; p.reopenAt = currentBet + minRaise;
  }
  return out;
}

// Old archives have no initial equity snapshot. Identify an otherwise eligible
// runout to report missing coverage, without calculating with the final board.
function legacyRunoutParticipant(hand, userId) {
  const players = initialPlayers(hand);
  let boardCount = 0;
  for (const event of hand.log ?? []) {
    if (event.type === 'street') {
      const live = [...players.values()].filter(p => !p.folded);
      const mobile = live.filter(p => p.stack > 0);
      const matched = mobile.every(p => p.bet >= Math.max(0, ...live.filter(q => q !== p).map(q => q.bet)));
      if (boardCount < 5 && live.length >= 2 && mobile.length <= 1 && matched && live.some(p => p.id === userId)) return true;
      boardCount = event.board?.length ?? boardCount;
      for (const p of players.values()) p.bet = 0;
    } else if (event.type !== 'payout') applyLoggedPayment(players, event);
  }
  return false;
}

function boundedCurve(rows, maximum = 200) {
  if (rows.length <= maximum) return rows;
  return Array.from({ length: maximum }, (_, i) => rows[Math.round(i * (rows.length - 1) / (maximum - 1))]);
}

/** Self-only settled statistics; callers authorize an optional room separately. */
export function aggregateAnalytics(db, userId, input = {}, now = Date.now()) {
  const filter = analyticsFilters(input, now), inRange = row => Date.parse(row.at) >= filter.start && Date.parse(row.at) <= filter.end;
  const matched = db.hands.filter(hand => hand.status === 'complete' && (!filter.room || hand.roomCode === filter.room)
    && inRange(hand) && hand.players.some(player => player.id === userId))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || String(b.id).localeCompare(String(a.id)));
  const hands = (filter.maxHands ? matched.slice(0, filter.maxHands) : matched).reverse();
  const totals = { hands: hands.length, wins: 0, winHands: 0, lossHands: 0, evenHands: 0,
    net: 0, holdemNet: 0, miniNet: 0, bbNet: 0, bbPer100: null, preflopHands: 0, showdowns: 0 };
  const counters = { vpip: 0, pfr: 0, rfi: 0, rfiOpportunity: 0, threeBet: 0, threeBetOpportunity: 0,
    fourBet: 0, fourBetOpportunity: 0, fiveBet: 0, fiveBetOpportunity: 0, flopSeen: 0, wonShowdown: 0 };
  const events = [], allInRows = [];
  let eligibleCount = 0, bbHands = 0;
  // Preserves chronological ordering with legacy off-table mini-game refunds.
  const settlementOrder = new Map();
  db.ledger.forEach((row, i) => { if (row.playerId === userId && row.type === 'holdem') settlementOrder.set(`${row.roomCode}/${row.note}`, i); });
  for (const hand of hands) {
    const player = hand.players.find(p => p.id === userId), holdemNet = player.stack - player.startingStack;
    const miniNet = hand.miniChanges?.[userId] ?? 0;
    totals[holdemNet > 0 ? 'winHands' : holdemNet < 0 ? 'lossHands' : 'evenHands']++;
    if ((hand.result?.payouts?.[userId] ?? 0) > 0) totals.wins++;
    const showdown = Boolean(hand.result?.showdown && !player.folded);
    if (showdown) { totals.showdowns++; if ((hand.result.payouts?.[userId] ?? 0) > 0) counters.wonShowdown++; }
    if (finite(hand.bigBlind) && hand.bigBlind > 0) { totals.bbNet += holdemNet / hand.bigBlind; bbHands++; }
    const tendency = handTendencies(hand, userId);
    for (const key of Object.keys(counters)) if (tendency[key]) counters[key]++;
    if (!hand.bombPot) totals.preflopHands++;
    events.push({ at: hand.at, handId: hand.id, holdemDelta: holdemNet, miniDelta: miniNet,
      order: settlementOrder.get(`${hand.roomCode}/第 ${hand.number} 手德州结算`) ?? -1 });

    const lock = hand.allInLock;
    const lockedPlayer = lock?.players?.find(p => p.id === userId);
    const eligible = lock ? Boolean(lockedPlayer && lock.board?.length < 5 && lock.players?.length >= 2) : legacyRunoutParticipant(hand, userId);
    if (!eligible) continue;
    eligibleCount++;
    const equity = hand.allInEquity, expected = equity?.players?.find(p => p.id === userId);
    if (!lock || !finite(expected?.expectedNet)) continue;
    allInRows.push({ id: hand.id, roomCode: hand.roomCode, roomName: db.rooms?.[hand.roomCode]?.name ?? hand.roomName ?? '朋友局',
      number: hand.number, at: hand.at, actualNet: holdemNet, expectedNet: expected.expectedNet,
      difference: holdemNet - expected.expectedNet, method: equity.method, board: [...lock.board], street: lock.street,
      equity: expected.equity, samples: equity.samples, error95Pct: equity.error95Pct });
  }
  // A hand-count limit contains exactly those hands; standalone legacy refunds
  // have no hand to attach to and are intentionally excluded in this mode.
  let adjustmentCount = 0;
  if (!filter.maxHands) db.ledger.forEach((row, order) => {
    if (row.playerId === userId && row.type === 'mushroomRefund' && (!filter.room || row.roomCode === filter.room) && inRange(row)) {
      events.push({ at: row.at, handId: null, holdemDelta: 0, miniDelta: row.amount, order, adjustment: '蘑菇池退款' }); adjustmentCount++;
    }
  });
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order);
  const curve = events.map(event => {
    totals.holdemNet += event.holdemDelta; totals.miniNet += event.miniDelta;
    return { at: event.at, handId: event.handId, net: totals.holdemNet + totals.miniNet,
      holdemNet: totals.holdemNet, miniNet: totals.miniNet, ...(event.adjustment ? { adjustment: event.adjustment } : {}) };
  });
  totals.net = totals.holdemNet + totals.miniNet;
  totals.bbPer100 = bbHands ? round(totals.bbNet / bbHands * 100) : null; totals.bbNet = round(totals.bbNet);
  let actual = 0, expected = 0;
  const allInCurve = allInRows.map(row => { actual += row.actualNet; expected += row.expectedNet;
    return { at: row.at, handId: row.id, actual: round(actual), expected: round(expected), difference: round(actual - expected) }; });
  const metrics = { winRate: rate(totals.winHands, hands.length), vpip: rate(counters.vpip, totals.preflopHands), pfr: rate(counters.pfr, totals.preflopHands),
    rfi: rate(counters.rfi, counters.rfiOpportunity), threeBet: rate(counters.threeBet, counters.threeBetOpportunity),
    fourBet: rate(counters.fourBet, counters.fourBetOpportunity), fiveBet: rate(counters.fiveBet, counters.fiveBetOpportunity),
    flopSeen: rate(counters.flopSeen, hands.length), wtsd: rate(totals.showdowns, counters.flopSeen), wsd: rate(counters.wonShowdown, totals.showdowns) };
  const ledger = db.ledger.filter(row => row.playerId === userId && (!filter.room || row.roomCode === filter.room)
    && (filter.start === -Infinity && filter.end === Infinity || inRange(row)));
  return { ...totals, metrics, vpip: metrics.vpip.percent ?? 0, pfr: metrics.pfr.percent ?? 0,
    totalBuyIn: ledger.filter(row => row.type === 'buyin').reduce((sum, row) => sum + row.amount, 0),
    sessions: filter.maxHands || filter.start !== -Infinity || filter.end !== Infinity ? new Set(hands.map(hand => hand.roomCode)).size
      : Object.values(db.rooms ?? {}).filter(room => (!filter.room || room.code === filter.room) && room.members?.[userId]?.totalBuyIn > 0).length,
    curve: boundedCurve(curve), matchedHands: matched.length, adjustmentCount, adjustmentsExcluded: Boolean(filter.maxHands),
    filters: { from: Number.isFinite(filter.start) ? new Date(filter.start).toISOString() : null, to: Number.isFinite(filter.end) ? new Date(filter.end).toISOString() : null,
      maxHands: filter.maxHands, room: filter.room },
    allIn: { count: allInRows.length, eligibleCount, unavailableCount: eligibleCount - allInRows.length,
      estimatedCount: allInRows.filter(row => row.method !== 'exact').length,
      actualNet: allInRows.length ? round(actual) : null, expectedNet: allInRows.length ? round(expected) : null,
      difference: allInRows.length ? round(actual - expected) : null, curve: boundedCurve(allInCurve),
      hands: allInRows.slice(-50).reverse().map(row => ({ ...row, expectedNet: round(row.expectedNet), difference: round(row.difference) })) } };
}
