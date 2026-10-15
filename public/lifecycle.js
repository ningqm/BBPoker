// Public room summaries only. These helpers never authorize access or actions.
export function lobbyRoomAction(room) {
  if (room.joined) return { action: 'open-room', label: '返回牌桌', disabled: false };
  if (room.access !== 'public') return { action: 'join-invite', label: '需要邀请', disabled: false };
  if (!room.canJoin) return { action: 'join-public', label: '暂不可加入', disabled: true };
  return { action: 'join-public', label: room.seatedCount >= room.maxPlayers ? '加入观战' : '加入牌桌', disabled: false };
}

export function filterLobbyRooms(rooms, filter = 'all') {
  return (Array.isArray(rooms) ? rooms : []).filter(room => room && room.status !== 'closed' &&
    (filter === 'mine' ? room.joined : filter === 'joinable' ? room.joined || room.access === 'public' && room.canJoin : true))
    .sort((a, b) => Number(Boolean(b.joined)) - Number(Boolean(a.joined)) ||
      Number(b.status === 'playing') - Number(a.status === 'playing') || String(a.code).localeCompare(String(b.code)));
}

export function lobbyTime(endsAt, now = Date.now()) {
  if (!endsAt) return '首手开始计时';
  const end = typeof endsAt === 'number' ? endsAt : Date.parse(endsAt);
  if (!Number.isFinite(end)) return '';
  const minutes = Math.max(0, Math.ceil((end - now) / 60000));
  return minutes ? `剩余 ${minutes} 分钟` : '已到时 · 等待收尾';
}

export function squidName(mode) { return mode === 'unlimited' ? '无限鱿鱼' : '普通鱿鱼'; }

// Read only the public round snapshot. Legacy rounds have one mark per winner;
// a new room's settings must never relabel an already-running legacy round.
export function squidProgress(room) {
  const squid = room.mini?.squid, active = Boolean(squid?.active);
  const mode = (active ? squid.mode : room.settings?.squidMode) === 'unlimited' ? 'unlimited' : 'normal';
  const participants = Array.isArray(squid?.participants) ? squid.participants : [];
  const winners = Array.isArray(squid?.won) ? squid.won : Object.keys(squid?.won || {}).filter(id => squid.won[id]);
  const counts = Object.fromEntries(participants.map(id => {
    const value = squid?.counts?.[id];
    const count = Number.isSafeInteger(value) && value >= 0 ? value : Number(winners.includes(id));
    return [id, mode === 'unlimited' ? count : Math.min(count, 1)];
  }));
  const awarded = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const holders = Object.values(counts).filter(count => count > 0).length;
  const budget = Number.isSafeInteger(squid?.tokenBudget) && squid.tokenBudget > 0 ? squid.tokenBudget : null;
  return { mode, name: squidName(mode), active, counts, awarded, holders, participants: participants.length,
    missing: participants.length - holders, budget, remaining: budget === null ? null : Math.max(0, budget - awarded) };
}

export function playerSquidCount(room, player) {
  const value = player?.squidCount;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return squidProgress(room).counts[player?.id] ?? Number(Boolean(player?.squidWon));
}

// A hand keeps its entry-time squid round, including an older ordinary hand
// restored during a version upgrade. Display never changes settlement eligibility.
export function squidMode(room) {
  const squid = room.mini?.squid;
  if (!squid?.active || room.status === 'closed') return null;
  const playing = room.hand?.status === 'playing', round = Number(squid.round) || 0;
  const countsForSquid = Boolean(room.hand && (Object.hasOwn(room.hand, 'squidRound')
    ? Number(room.hand.squidRound) > 0 && Number(room.hand.squidRound) === round : true));
  const ordinaryHand = playing && !countsForSquid;
  const waitingAtExpiry = room.expiryMode === 'wait-squid', admissionClosed = squidAdmissionClosed(room, null);
  const blocked = Boolean(squid.blockerSince), settlingAbsentees = Boolean(squid.absentSettlementAt);
  const label = settlingAbsentees ? '本轮即将按现有标记结算' : waitingAtExpiry ? playing ? '已到时 · 本手结束后等待原轮继续' : '原轮鱿鱼等待玩家 · 期间不开新手'
    : ordinaryHand ? '本手普通德州 · 下一手继续原轮鱿鱼'
    : blocked ? playing ? '本手仍计鱿鱼 · 结束后等待玩家' : '原轮鱿鱼等待玩家' : '';
  const note = settlingAbsentees ? '可继续的原轮玩家均已有标记。等待片刻后按现有标记结轮；未获标者及时回来并满足参与条件，仍可继续原轮。' : waitingAtExpiry ? '牌桌已到时，可参与的原轮玩家不足两人。等待窗口内恢复就继续原轮，否则按现有标记结算散桌。'
    : admissionClosed ? '牌桌已到时，仅已加入本轮的玩家继续或返回；不再增加参与者或本轮鱼数。'
    : ordinaryHand ? '本手沿用发牌时的玩法，不获得鱿鱼标记；下一手继续本轮，符合入场条件的新人可加入。'
    : blocked ? '可参与的本轮玩家不足两人，暂不开新手。已有鱼和预留保留；未到时可等返桌或符合条件的新人加入。'
    : '缺席者不发新牌、不持续扣盲，已有鱼与预留保留。新人符合等盲或补盲及预留条件后，从下一手加入本轮，初始无鱼且总鱼数加 1。';
  return { paused: blocked, playing, round, countsForSquid, ordinaryHand, waitingAtExpiry, settlingAbsentees, label, note };
}

// Amounts are server quotes. They are informative; the server posts them only
// when the player actually enters an eligible hand, never on a UI toggle.
export function entryBlindView(room, player) {
  const entry = player?.entryBlind;
  if (!entry?.required || room.status === 'closed' || room.hand?.status === 'playing' && player.inHand) return null;
  const live = Math.max(0, Number(entry.live) || 0), dead = Math.max(0, Number(entry.dead) || 0);
  const mode = entry.mode === 'post' ? 'post' : 'wait', waitingFor = entry.waitingFor || null;
  const naturalBigBlind = entry.naturalBigBlind === true, estimated = entry.estimated === true;
  let label = naturalBigBlind ? `${estimated ? '预计' : ''}下一手大盲加入` : mode === 'wait' ? '等待大盲加入'
    : waitingFor === 'button' ? '已选补盲 · 等待过庄' : '已选补盲 · 等待发牌';
  let seatLabel = naturalBigBlind ? '下手大盲' : mode === 'wait' ? '等大盲' : waitingFor === 'button' ? '等过庄' : '待补盲';
  let note = naturalBigBlind ? '已入座。轮到自然大盲时只交一份大盲，不重复补交；漏小盲按所选方式处理，实际发牌前不扣。'
    : mode === 'wait' ? '已入座。轮到大盲后自动参与，等待期间不发牌、不扣盲；可切换为补盲加入。'
    : waitingFor === 'button' ? '已入座，补盲选择已保存。此座位在庄位或小盲保护区，等庄位经过后自动参与；等待时不扣盲。'
    : '已入座，补盲选择已保存。从符合位置条件的下一手参与，发牌时才补盲。自然轮到大盲不会重复扣。';
  const blocked = {
    funds: ['等待补码', '等补码', '已入座，现有积分不足以完成入桌补盲。请先补码；等待时不发牌、不扣盲。'],
    players: ['等待其他玩家', '等玩家', '已入座，选择已保存。至少两位可参与玩家就绪后才发牌。'],
    allWaiting: ['全桌正在等盲', '等开牌', '已入座。全员选择等大盲，至少一人切换为补盲加入后才能开牌。'],
    ordinaryHand: ['等待普通手补盲', '等补盲', '已入座。炸弹池不会抵消入桌补盲，下一手普通德州再按选择参与。'],
    reserve: ['等待补足鱿鱼预留', '等预留', '已入座，选择已保存。满足本轮鱿鱼预留后才能拿牌，等待时不扣盲。'],
    expired: ['已到时 · 不再加入本轮', '已到时', '已入座，但牌桌已到时，仅收尾原轮。'],
    capacity: ['本轮暂不可增加参与者', '等下轮', '已入座，本轮参与人数已达上限，等待本轮结束。'],
    offline: ['等待连接恢复', '离线', '座位与参与方式已保存，连接恢复后再参与。'],
    sittingOut: ['已暂离', '暂离', '座位与参与方式已保留，返回牌桌后再参与。'],
    departing: ['等待取消离开安排', '待离开', '已安排离座或暂离；请先取消安排，再修改参与方式。'],
  }[waitingFor];
  if (blocked) [label, seatLabel, note] = blocked;
  if (estimated && !blocked) note += ' 本手仍在进行，最终以结束后的座位和积分为准。';
  return { mode, modeLabel: mode === 'wait' ? '等大盲加入' : '补盲加入', live, dead, total: live + dead, waitingFor, label, note, seatLabel,
    naturalBigBlind, estimated, nextHandEligible: entry.nextHandEligible === true,
    missed: entry.reason === 'missed', canChoose: player.seat != null && !player.pendingDeparture && !player.sittingOut };
}

// A successful change needs visible acknowledgement even when a position or
// squid reserve still prevents dealing. Never promise insertion into a live hand.
export function entryChoiceFeedback(room, player) {
  const entry = entryBlindView(room, player);
  if (!entry) return participation(room, player).label;
  const squid = squidJoinView(room, player);
  const status = squid && !['next-hand', 'entry-blind'].includes(squid.status) ? squid.label : entry.label;
  return `已保存：${entry.modeLabel} · ${status}`;
}

// The server projects admission against the next legal deal. The client does not
// expand the round or calculate charges, including when several newcomers wait.
export function squidJoinView(room, player) {
  const squid = room.mini?.squid;
  if (!squid?.active || room.status === 'closed' || player?.seat == null || squid.participants?.includes(player.id)) return null;
  const quote = player.squidJoin;
  if (quote && Number(quote.round) !== Number(squid.round)) return null;
  if (!quote && player.waitingFor !== 'squid') return null;
  const status = quote?.status || 'next-hand', entry = entryBlindView(room, player);
  const names = {
    'next-hand': ['等待加入本轮', '待入本轮'],
    'entry-blind': [entry?.label || '等待入桌位置', entry?.seatLabel || '等入桌'],
    reserve: ['等待补足鱿鱼预留', '等预留'], expired: ['已到时 · 不再加入本轮', '已到时'],
    offline: ['连接恢复后再加入本轮', '离线'], 'sitting-out': ['返回后再加入本轮', '暂离'],
    capacity: ['本轮暂不可增加参与者', '暂不可入'],
  };
  const [label, seatLabel] = names[status] || ['等待加入本轮', '待入本轮'];
  const requiredReserve = Number.isSafeInteger(quote?.requiredReserve) && quote.requiredReserve >= 0 ? quote.requiredReserve : null;
  const budget = Number.isSafeInteger(quote?.tokenBudgetAfterJoin) && quote.tokenBudgetAfterJoin > 0 ? quote.tokenBudgetAfterJoin : null;
  return { status, label, seatLabel, requiredReserve, budget, minimum: room.hand?.status === 'playing',
    note: typeof quote?.reason === 'string' && quote.reason ? quote.reason : '符合等盲或补盲及预留条件后，实际拿牌才加入本轮；以 0 鱼入轮，总鱼数加 1。' };
}

export function squidAdmissionClosed(room, player, now = Date.now()) {
  const end = typeof room.endsAt === 'number' ? room.endsAt : Date.parse(room.endsAt);
  return Boolean(room.mini?.squid?.active && !room.mini.squid.participants?.includes(player?.id) &&
    (room.expiryMode || Number.isFinite(end) && now >= end));
}

export function participation(room, player) {
  if (!player || player.seat == null) return { label: '观战中', note: '选择空座，带入积分后参加。' };
  if (player.pendingDeparture) return {
    label: player.pendingDeparture === 'stand' ? '本手后离座' : '本手后暂离',
    note: '已安排，当前这手仍照常进行。', canCancel: true,
  };
  if (room.hand?.status === 'playing' && player.inHand) return { label: '正在参与本手', note: '' };
  if (player.sittingOut) return { label: '你已暂离', note: '座位、鱿鱼资格与预留保留。回来后可继续未结束的原轮。', canReturn: true };
  const join = squidJoinView(room, player);
  if (join) return join;
  const entry = entryBlindView(room, player);
  if (entry) return entry;
  if (player.waitingFor === 'hand') return { label: '等待下一手', note: '已入座，从符合条件的下一手开始参与。' };
  return { label: '已入座', note: '' };
}

export function buyinTiming(room, isSit = true, player = null, now = Date.now()) {
  if (!isSit) return room.hand?.status === 'playing'
    ? '现在补码将于本手结束后到账，下一手可用，不增加本手可下注筹码。'
    : '立即到账，下次发牌前可用。';
  const original = room.mini?.squid?.active && room.mini.squid.participants?.includes(player?.id);
  if (isSit && squidAdmissionClosed(room, player, now)) return '牌桌已到时，仅收尾本轮；新玩家不能再入座参加本轮，可留在房间观战。';
  if (isSit && original) return '确认后立即入座。本轮鱿鱼资格、已有鱼与预留都保留，重新入座不重复增加鱼数或收一份入轮预留；漏盲仍按提示处理。';
  if (isSit && room.mini?.squid?.active) return '确认后立即入座，可中途加入本轮。符合等盲或补盲及预留条件后，从符合条件的下一手以 0 鱼加入，总鱼数加 1；实际拿牌时才收预留，等待时不扣盲。';
  if (isSit && room.hand?.status === 'playing') return '确认后立即入座。这手已经开始，等待后续符合条件的手牌，等待时不扣盲。';
  return '确认后立即入座，无需房主审核。';
}

export function departurePlan(room, player, type) {
  const squid = room.mini?.squid, participant = Boolean(squid?.active && squid.participants?.includes(player?.id));
  const progress = squidProgress(room), fishCount = participant ? progress.counts[player.id] || 0 : 0, won = fishCount > 0;
  const maxFish = progress.budget ?? (progress.mode === 'unlimited' ? progress.participants + Number(room.settings?.squidExtraTokens ?? 3) : progress.participants - 1);
  const cost = participant && !won ? Number.isSafeInteger(player?.squidMaxLoss) && player.squidMaxLoss >= 0
    ? player.squidMaxLoss : Math.max(0, maxFish * Number(squid.unit || 0)) : 0;
  const reserve = participant ? Math.max(0, Number(player?.squidReserve) || cost) : 0;
  const queued = room.hand?.status === 'playing' && Boolean(player?.inHand);
  return {
    type, queued, cost, reserve, participant, round: participant ? Number(squid.round) || 0 : 0, won, fishCount,
    canEarnMark: queued && Boolean(squidMode(room)?.countsForSquid),
    title: type === 'stand' ? '离开座位' : '暂离牌桌',
    label: queued ? type === 'stand' ? '本手后离座' : '本手后暂离' : type === 'stand' ? '确认离座' : '确认暂离',
    description: type === 'stand' ? '离座后收回可用的桌上积分，留在房间观战；本轮鱿鱼预留仍保留至结算。以后可以重新入座。' : '保留座位和积分，暂不参加新的手牌、不持续扣盲；回来后可继续。',
  };
}

export function squidSettlement(room) {
  const squid = room.mini?.squid;
  if (!squid?.active) return null;
  const progress = squidProgress(room);
  return { canSettle: Boolean(squid.canSettle), blocked: Boolean(squid.blockerSince),
    waitSeconds: Number(squid.settleAfterSeconds) || 90,
    mode: progress.mode, awarded: progress.awarded,
    loserCost: progress.awarded * Number(squid.unit || 0), winnerGain: progress.missing * Number(squid.unit || 0),
    winnerCount: progress.holders, loserCount: progress.missing };
}
