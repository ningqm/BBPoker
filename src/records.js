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
  const result = choice(input.result, ['all', 'win', 'loss', 'even'], '盈亏筛选');
  const type = choice(input.type, ['all', 'holdem', 'bomb'], '牌局类型');
  const status = choice(input.status, ['all', 'active', 'closed'], '对局状态');
  if (!optional(input.q) && (typeof input.q !== 'string' || [...input.q].length > 80)) fail('搜索内容最多 80 字');
  const q = (input.q || '').trim().toLocaleLowerCase('zh-CN');
  return { start, end, result, type, status, q };
}
export function resultMatches(net, result) {
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
  const rows = new Map(), users = grouped.users ?? new Map(Object.values(db.users).map(user => [user.id, user]));
  const player = id => {
    if (!rows.has(id)) rows.set(id, { id, name: users.get(id)?.name ?? '朋友', hands: 0, holdemNet: 0, miniNet: 0, net: 0, totalBuyIn: room.members[id]?.totalBuyIn ?? 0 });
    return rows.get(id);
  };
  for (const member of Object.values(room.members)) if (member.totalBuyIn > 0) player(member.id);
  for (const hand of hands) for (const p of hand.players) {
    const row = player(p.id); if (!users.has(p.id)) row.name = p.name ?? '朋友';
    row.hands++; row.holdemNet += p.stack - p.startingStack; row.miniNet += hand.miniChanges?.[p.id] ?? 0;
  }
  const refunds = grouped.refunds ?? db.ledger.filter(l => l.roomCode === room.code && l.type === 'mushroomRefund');
  for (const refund of refunds) player(refund.playerId).miniNet += refund.amount;
  const players = [...rows.values()].map(row => ({ ...row, net: row.holdemNet + row.miniNet })).sort((a, b) => b.net - a.net || a.id.localeCompare(b.id));
  const me = players.find(p => p.id === userId);
  return { code: room.code, name: room.name, status: room.status === 'closed' ? 'closed' : 'active',
    at: room.startedAt != null ? new Date(room.startedAt).toISOString() : room.createdAt, closedAt: room.closedAt ?? null,
    smallBlind: room.settings.smallBlind, bigBlind: room.settings.bigBlind, handCount: hands.length, playerCount: players.length,
    meNet: me?.net ?? 0, meHoldemNet: me?.holdemNet ?? 0, meMiniNet: me?.miniNet ?? 0,
    handInProgress: room.hand?.status === 'playing', adjustments: refunds.length > 0, players };
}
export function sessionLibrary(db, userId, input = {}) {
  const filter = recordFilters(input);
  const rooms = Object.values(db.rooms).filter(r => Boolean(r.members[userId]) && (!input.room || r.code === input.room));
  const users = new Map(Object.values(db.users).map(user => [user.id, user]));
  const grouped = new Map(rooms.map(room => [room.code, { hands: [], refunds: [], users }]));
  for (const hand of db.hands) if (hand.status === 'complete' && grouped.has(hand.roomCode)) grouped.get(hand.roomCode).hands.push(hand);
  for (const row of db.ledger) if (row.type === 'mushroomRefund' && grouped.has(row.roomCode)) grouped.get(row.roomCode).refunds.push(row);
  const sessions = rooms.map(room => sessionRecord(db, room, userId, grouped.get(room.code)))
    .filter(row => (row.handCount > 0 || row.playerCount > 0) && Date.parse(row.at) >= filter.start && Date.parse(row.at) <= filter.end
      && resultMatches(row.meNet, filter.result) && (filter.status === 'all' || row.status === filter.status)
      && (!filter.q || `${row.name} ${row.code}`.toLocaleLowerCase('zh-CN').includes(filter.q)));
  const totals = recordTotals(sessions, r => r.meHoldemNet, r => r.meMiniNet);
  const { page, nextCursor } = pageRecords(sessions.map(s => ({ ...s, id: s.code })), input);
  return { sessions: page.map(({ players, id, adjustments, ...summary }) => summary), totals, nextCursor };
}
