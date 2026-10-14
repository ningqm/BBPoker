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
  const waitingAtExpiry = room.expiryMode === 'wait-squid';
  const blocked = Boolean(squid.blockerSince), settlingAbsentees = Boolean(squid.absentSettlementAt);
  const label = settlingAbsentees ? '本轮即将按现有标记结算' : waitingAtExpiry ? playing ? '已到时 · 本手结束后等待原轮继续' : '原轮鱿鱼等待玩家 · 期间不开新手'
    : ordinaryHand ? '本手普通德州 · 下一手继续原轮鱿鱼'
    : blocked ? playing ? '本手仍计鱿鱼 · 结束后等待玩家' : '原轮鱿鱼等待玩家' : '';
  const note = settlingAbsentees ? '可继续的原轮玩家均已有标记。等待片刻后按现有标记结轮；未获标者及时回来并满足参与条件，仍可继续原轮。' : waitingAtExpiry ? '牌桌已到时，可参与的原轮玩家不足两人。等待窗口内恢复就继续原轮，否则按现有标记结算散桌。'
    : ordinaryHand ? '本手沿用发牌时的玩法，不获得鱿鱼标记；下一手按原名单继续，新人等下一轮。'
    : blocked ? '可参与的原轮玩家不足两人，暂不开新手。名单、标记和预留保留，回来后可继续本轮。'
    : '缺席者不发新牌、不持续扣盲，已有标记与预留保留。其余原轮玩家继续；新人等下一轮。';
  return { paused: blocked, playing, round, countsForSquid, ordinaryHand, waitingAtExpiry, settlingAbsentees, label, note };
}

// Amounts are server quotes. They are informative; the server posts them only
// when the player actually enters an eligible hand, never on a UI toggle.
export function entryBlindView(room, player) {
  const entry = player?.entryBlind;
  if (!entry?.required || room.status === 'closed' || room.hand?.status === 'playing' && player.inHand) return null;
  const live = Math.max(0, Number(entry.live) || 0), dead = Math.max(0, Number(entry.dead) || 0);
  const mode = entry.mode === 'post' ? 'post' : 'wait';
  const waitingFor = entry.waitingFor === 'button' ? 'button' : 'bigBlind';
  const label = mode === 'wait' ? '等待大盲加入' : waitingFor === 'button' ? '已选补盲 · 等待过庄' : '已选补盲 · 等待发牌';
  const note = mode === 'wait' ? '轮到大盲后自动参与，等待期间不发牌、不扣盲。'
    : waitingFor === 'button' ? '此座位需要等庄位经过；到可参与的下一手才补盲，等待时不扣。'
    : '从符合位置条件的下一手参与，发牌时才补盲。自然轮到大盲不会重复扣。';
  return { mode, live, dead, total: live + dead, waitingFor, label, note, seatLabel: mode === 'wait' ? '等大盲' : waitingFor === 'button' ? '等过庄' : '待补盲',
    missed: entry.reason === 'missed', canChoose: player.seat != null && !player.pendingDeparture && !player.sittingOut };
}

export function participation(room, player) {
  if (!player || player.seat == null) return { label: '观战中', note: '选择空座，带入积分后参加。' };
  if (player.pendingDeparture) return {
    label: player.pendingDeparture === 'stand' ? '本手后离座' : '本手后暂离',
    note: '已安排，当前这手仍照常进行。', canCancel: true,
  };
  if (room.hand?.status === 'playing' && player.inHand) return { label: '正在参与本手', note: '' };
  if (player.sittingOut) return { label: '你已暂离', note: '座位、鱿鱼资格与预留保留。回来后可继续未结束的原轮。', canReturn: true };
  if (player.waitingFor === 'squid') return { label: '等待下一轮鱿鱼', note: '当前轮名单固定；入桌等盲或补盲的选择在本轮结束后生效。' };
  const entry = entryBlindView(room, player);
  if (entry) return entry;
  if (player.waitingFor === 'hand') return { label: '等待下一手', note: '已入座，从符合条件的下一手开始参与。' };
  return { label: '已入座', note: '' };
}

export function buyinTiming(room, isSit = true, player = null) {
  if (!isSit && room.hand?.status === 'playing') return '本手结束后可补充积分，不影响当前手的投入。';
  const original = room.mini?.squid?.active && room.mini.squid.participants?.includes(player?.id);
  if (isSit && room.expiryMode && !original) return '牌桌已到时，仅收尾原轮鱿鱼；新入座者不参加原轮。';
  if (isSit && original) return '本轮鱿鱼资格、已有标记与预留都保留，重新入座不会再收一份预留。';
  if (isSit && room.mini?.squid?.active) return '本轮鱿鱼正在进行，入座后等下一轮，再按等盲或补盲方式参与。';
  if (isSit && room.hand?.status === 'playing') return '这手已经开始，入座后等待后续符合条件的手牌。';
  return isSit ? '确认后立即入座，无需房主审核。' : '确认后立即补充积分，无需房主审核。';
}

export function departurePlan(room, player, type) {
  const squid = room.mini?.squid, participant = Boolean(squid?.active && squid.participants?.includes(player?.id));
  const progress = squidProgress(room), fishCount = participant ? progress.counts[player.id] || 0 : 0, won = fishCount > 0;
  const maxFish = progress.mode === 'unlimited' ? progress.budget ?? progress.participants + Number(room.settings?.squidExtraTokens ?? 3) : progress.participants - 1;
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
