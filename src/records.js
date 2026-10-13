// Read-only views over settled records. No cards, invites, decks or credentials.
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export const compareRecords = (a, b) => a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1;
const optional = value => value === undefined || value === null || value === '';
function choice(value, values, label) {
  if (optional(value)) return values[0];
  if (!values.includes(value)) fail(`${label}无效`);
  return value;
}
function boundary(value, end = false) {
  if (optional(value)) return end ? Infinity : -Infinity;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) fail('日期范围无效');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10)) fail('日期范围无效');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail('日期范围无效');
  return time + (end && value.length === 10 ? 86400000 - 1 : 0);
}
export function recordFilters(input = {}) {
  const start = boundary(input.from), end = boundary(input.to, true);
  if (start > end) fail('开始日期不能晚于结束日期');
  const result = choice(input.result, ['all', 'win', 'loss', 'even', 'winOver', 'lossOver'], '盈亏筛选');
  const minBB = thresholdBB(input.minBB, result === 'winOver' || result === 'lossOver');
  const holeRanks = startingRanks(input.holeRanks), holeType = choice(input.holeType, ['all', 'pair', 'suited', 'offsuit'], '起手牌类型');
  const type = choice(input.type, ['all', 'holdem', 'bomb'], '牌局类型');
  const status = choice(input.status, ['all', 'active', 'closed'], '对局状态');
  const position = choice(input.position, ['all', 'BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'unknown'], '位置筛选');
  const potType = choice(input.potType, ['all', 'headsUp', 'multiway', 'noFlop', 'unknown'], '翻牌人数筛选');
  const tableSize = choice(input.tableSize, ['all', 'headsUp', 'short', 'full'], '发牌人数筛选');
  if (!optional(input.opponent) && (typeof input.opponent !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.opponent))) fail('对手筛选无效');
  const opponent = optional(input.opponent) ? '' : input.opponent;
  let maxHands = null;
  if (!optional(input.maxHands) && input.maxHands !== 'all') {
    if (!['string', 'number'].includes(typeof input.maxHands) || !/^[1-9]\d{0,5}$/.test(String(input.maxHands)) || Number(input.maxHands) > 100000) fail('手数需要是 1–100000 的整数');
    maxHands = Number(input.maxHands);
  }
  if (!optional(input.q) && (typeof input.q !== 'string' || [...input.q].length > 80)) fail('搜索内容最多 80 字');
  const q = (input.q || '').trim().toLocaleLowerCase('zh-CN');
  return { start, end, result, minBB, holeRanks, holeType, type, status, position, potType, tableSize, opponent, maxHands, q };
}
function thresholdBB(value, required = false) {
  if (optional(value)) { if (required) fail('请输入盈亏筛选的 BB 阈值'); return null; }
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))
    || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1000000000) fail('BB 阈值需要是 0–1000000000 的数字，最多两位小数');
  return Number(value);
}
const RANKS = '23456789TJQKA';
function startingRanks(value) {
  if (optional(value)) return '';
  if (typeof value !== 'string') fail('起手牌点数需要是 1–2 个 23456789TJQKA 字母或数字');
  const ranks = value.trim().toUpperCase();
  if (!/^[23456789TJQKA]{1,2}$/.test(ranks)) fail('起手牌点数需要是 1–2 个 23456789TJQKA 字母或数字');
  return [...ranks].sort((a, b) => RANKS.indexOf(b) - RANKS.indexOf(a)).join('');
}
export function handBigBlind(hand) {
  const bb = hand.settings?.bigBlind ?? hand.bigBlind;
  return Number.isSafeInteger(bb) && bb > 0 ? bb : null;
}
/** Only the viewer's own dealt cards may be passed here, never public or peer cards. */
export function holeMatches(cards, filter) {
  if (!filter.holeRanks && filter.holeType === 'all') return true;
  if (!Array.isArray(cards) || cards.length !== 2 || !cards.every(card => typeof card === 'string' && /^[23456789TJQKA][cdhs]$/.test(card)) || cards[0] === cards[1]) return false;
  const pair = cards[0][0] === cards[1][0], suited = cards[0][1] === cards[1][1];
  if (filter.holeType === 'pair' && !pair || filter.holeType === 'suited' && (pair || !suited) || filter.holeType === 'offsuit' && (pair || suited)) return false;
  if (!filter.holeRanks) return true;
  const ranks = cards.map(card => card[0]);
  return filter.holeRanks.length === 1 ? ranks.includes(filter.holeRanks) : startingRanks(ranks.join('')) === filter.holeRanks;
}
export function resultMatches(net, result, minBB = null, bigBlind = null) {
  if (result === 'winOver' || result === 'lossOver') {
    if (!Number.isSafeInteger(net) || !Number.isSafeInteger(bigBlind) || bigBlind <= 0 || minBB === null) return false;
    if (result === 'winOver' ? net <= 0 : net >= 0) return false;
    // Chips are integral; compare exact hundredths of BB without division or
    // floating-point rounding at the strict greater-than boundary.
    return BigInt(Math.abs(net)) * 100n > BigInt(Math.round(minBB * 100)) * BigInt(bigBlind);
  }
  return result === 'all' || (result === 'win' && net > 0) || (result === 'loss' && net < 0) || (result === 'even' && net === 0);
}
export function recordTotals(rows, holdem = row => row.holdemNet, mini = row => row.miniNet) {
  const totals = { count: rows.length, net: 0, holdemNet: 0, miniNet: 0, wins: 0, losses: 0, even: 0 };
  for (const row of rows) {
    const h = holdem(row), m = mini(row), net = h + m;
    totals.holdemNet += h; totals.miniNet += m; totals.net += net;
    totals[net > 0 ? 'wins' : net < 0 ? 'losses' : 'even']++;
  }
  return totals;
}
/** Co-dealt opponent report, not inferred chip transfers between two people.
 * Each row repeats the hero's entire poker net on hands shared with that peer;
 * therefore rows overlap and must never be summed together. The summary counts
 * each selected own hand once. Squid/other mini adjustments are excluded.
 * Heads-up here means both players were the only survivors at the initial real
 * flop, including all-in runouts. A multiway flop never becomes heads-up later.
 * Missing historical BB contributes chips/hands but not netBB/bbHands. Keep raw
 * fractions until presentation, including across mixed blind levels.
 */
export function opponentRecords(entries, userId, filter, users = new Map()) {
  const rows = new Map(), summary = { uniqueHands: 0, net: 0, netBB: 0, bbHands: 0 };
  for (const { hand, player, context } of entries) {
    if (!player) continue;
    const net = player.stack - player.startingStack, bb = handBigBlind(hand);
    summary.uniqueHands++; summary.net += net;
    if (bb !== null) { summary.netBB += net / bb; summary.bbHands++; }
    let opponents = context.dealtIds.filter(id => id !== userId);
    if (['headsUp', 'multiway'].includes(filter.potType)) opponents = opponents.filter(id => context.flopPlayerIds.includes(id));
    if (filter.opponent) opponents = opponents.filter(id => id === filter.opponent);
    for (const id of opponents) {
      if (!rows.has(id)) rows.set(id, { id, name: users.get(id)?.name ?? hand.players.find(p => p.id === id)?.name ?? '朋友',
        hands: 0, net: 0, netBB: 0, bbHands: 0, wins: 0, losses: 0, even: 0,
        headsUpHands: 0, headsUpNet: 0, headsUpNetBB: 0, headsUpBBHands: 0, lastAt: hand.at });
      const row = rows.get(id);
      row.hands++; row.net += net; row[net > 0 ? 'wins' : net < 0 ? 'losses' : 'even']++;
      if (bb !== null) { row.netBB += net / bb; row.bbHands++; }
      if (context.potType === 'headsUp' && context.flopPlayerIds.includes(id)) {
        row.headsUpHands++; row.headsUpNet += net; if (bb !== null) { row.headsUpNetBB += net / bb; row.headsUpBBHands++; }
      }
      if (hand.at > row.lastAt) row.lastAt = hand.at;
    }
  }
  return { rows: [...rows.values()].sort((a, b) => b.hands - a.hands || b.net - a.net || a.id.localeCompare(b.id)), ...summary };
}
export const squidSettlementKey = (roomCode, settlementId, playerId) => JSON.stringify([roomCode, settlementId, playerId]);
/** Ledger is authoritative for new rounds. Keep one settlement per room/round/player. */
export function squidSettlementMap(ledger = []) {
  const settlements = new Map();
  for (const row of ledger) {
    if (row.type !== 'squidSettlement' || typeof row.roundSettlementId !== 'string' || !row.roundSettlementId
      || typeof row.playerId !== 'string' || !Number.isFinite(row.amount)) continue;
    const key = squidSettlementKey(row.roomCode, row.roundSettlementId, row.playerId);
    if (!settlements.has(key)) settlements.set(key, row);
  }
  return settlements;
}
/** Only remove a mirrored amount when its matching authoritative ledger row exists. */
export function handMiniNet(hand, userId, settlements) {
  const total = hand.miniChanges?.[userId] ?? 0;
  const row = hand.squidSettlementId && settlements.get(squidSettlementKey(hand.roomCode, hand.squidSettlementId, userId));
  if (!row || !Object.hasOwn(hand.miniChanges ?? {}, userId)) return total;
  return total - (hand.squidSettlementChanges?.[userId] ?? row.amount);
}
function recordCursor(value) {
  if (optional(value)) return null;
  if (typeof value !== 'string' || value.length > 400 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('分页位置无效');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.at !== 'string' || new Date(parsed.at).toISOString() !== parsed.at || typeof parsed.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(parsed.id)) throw new Error();
    return { at: parsed.at, id: parsed.id };
  } catch { fail('分页位置无效'); }
}
export function pageRecords(rows, { before, limit = '20' } = {}) {
  if (typeof limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) fail('每页记录数量需要是 1–50');
  const cursor = recordCursor(before), count = Number(limit);
  const matches = rows.filter(row => !cursor || compareRecords(row, cursor) > 0).sort(compareRecords);
  const page = matches.slice(0, count), last = page.at(-1);
  return { page, nextCursor: matches.length > count ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString('base64url') : null };
}
export function sessionRecord(db, room, userId, grouped = {}) {
  const hands = grouped.hands ?? db.hands.filter(h => h.roomCode === room.code && h.status === 'complete');
  const settlements = grouped.settlements ?? squidSettlementMap(db.ledger.filter(row => row.roomCode === room.code));
  const rows = new Map(), users = grouped.users ?? new Map(Object.values(db.users).map(user => [user.id, user]));
  const player = id => {
    if (!rows.has(id)) rows.set(id, { id, name: users.get(id)?.name ?? '朋友', hands: 0, holdemNet: 0, miniNet: 0, net: 0, totalBuyIn: room.members[id]?.totalBuyIn ?? 0 });
    return rows.get(id);
  };
  for (const member of Object.values(room.members)) if (member.totalBuyIn > 0) player(member.id);
  for (const hand of hands) for (const p of hand.players) {
    const row = player(p.id); if (!users.has(p.id)) row.name = p.name ?? '朋友';
    row.hands++; row.holdemNet += p.stack - p.startingStack; row.miniNet += handMiniNet(hand, p.id, settlements);
  }
  for (const settlement of settlements.values()) player(settlement.playerId).miniNet += settlement.amount;
  const refunds = grouped.refunds ?? db.ledger.filter(l => l.roomCode === room.code && l.type === 'mushroomRefund');
  for (const refund of refunds) player(refund.playerId).miniNet += refund.amount;
  const players = [...rows.values()].map(row => ({ ...row, net: row.holdemNet + row.miniNet })).sort((a, b) => b.net - a.net || a.id.localeCompare(b.id));
  const me = players.find(p => p.id === userId);
  return { code: room.code, name: room.name, status: room.status === 'closed' ? 'closed' : 'active',
    at: room.startedAt != null ? new Date(room.startedAt).toISOString() : room.createdAt, closedAt: room.closedAt ?? null,
    smallBlind: room.settings.smallBlind, bigBlind: room.settings.bigBlind, handCount: hands.length, playerCount: players.length,
    meNet: me?.net ?? 0, meHoldemNet: me?.holdemNet ?? 0, meMiniNet: me?.miniNet ?? 0,
    handInProgress: room.hand?.status === 'playing', adjustments: refunds.length > 0,
    squidSettlementCount: [...settlements.values()].filter(row => row.playerId === userId).length, players };
}
export function sessionLibrary(db, userId, input = {}) {
  const filter = recordFilters(input);
  const rooms = Object.values(db.rooms).filter(r => Boolean(r.members[userId]) && (!input.room || r.code === input.room));
  const users = new Map(Object.values(db.users).map(user => [user.id, user]));
  const grouped = new Map(rooms.map(room => [room.code, { hands: [], refunds: [], settlements: new Map(), users }]));
  for (const hand of db.hands) if (hand.status === 'complete' && grouped.has(hand.roomCode)) grouped.get(hand.roomCode).hands.push(hand);
  for (const row of db.ledger) if (row.type === 'mushroomRefund' && grouped.has(row.roomCode)) grouped.get(row.roomCode).refunds.push(row);
  for (const [key, row] of squidSettlementMap(db.ledger)) if (grouped.has(row.roomCode)) grouped.get(row.roomCode).settlements.set(key, row);
  const sessions = rooms.map(room => sessionRecord(db, room, userId, grouped.get(room.code)))
    .filter(row => (row.handCount > 0 || row.playerCount > 0) && Date.parse(row.at) >= filter.start && Date.parse(row.at) <= filter.end
      && resultMatches(row.meNet, filter.result, filter.minBB, row.bigBlind) && (filter.status === 'all' || row.status === filter.status)
      && (!filter.q || `${row.name} ${row.code}`.toLocaleLowerCase('zh-CN').includes(filter.q)));
  const totals = recordTotals(sessions, r => r.meHoldemNet, r => r.meMiniNet);
  const { page, nextCursor } = pageRecords(sessions.map(s => ({ ...s, id: s.code })), input);
  return { sessions: page.map(({ players, id, adjustments, ...summary }) => summary), totals, nextCursor };
}
