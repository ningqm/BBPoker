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

// A hand keeps its entry-time squid round even if someone reconnects mid-hand.
export function squidMode(room) {
  const squid = room.mini?.squid;
  if (!squid?.active || room.status === 'closed') return null;
  const paused = Boolean(squid.paused), playing = room.hand?.status === 'playing';
  const round = Number(squid.round) || 0, hand = room.hand;
  const countsForSquid = Boolean(hand && (Object.hasOwn(hand, 'squidRound')
    ? Number(hand.squidRound) > 0 && Number(hand.squidRound) === round
    : !paused));
  const ordinaryHand = playing && !countsForSquid;
  const waitingAtExpiry = room.expiryMode === 'wait-squid';
  const label = waitingAtExpiry ? playing ? countsForSquid ? '本手仍计鱿鱼 · 结束后等待恢复' : '本手普通德州 · 结束后等待原轮恢复'
    : '原轮鱿鱼待恢复 · 期间不开新手'
    : paused ? playing && countsForSquid ? '本手仍计鱿鱼 · 下手先打普通桌'
    : ordinaryHand ? '鱿鱼暂停 · 本手普通德州' : '鱿鱼暂停 · 在线玩家继续'
    : ordinaryHand ? '本手普通德州 · 下一手恢复鱿鱼' : '';
  const note = waitingAtExpiry ? '牌桌已到时，当前手打完后不再开启普通手。原轮保留并等待恢复；等待窗口内恢复就继续原轮，否则按现有标记结算散桌。'
    : paused ? '原轮与标记保留。在线玩家可继续普通德州，普通手不获得鱿鱼标记；必要参与者回来后，从下一手恢复原轮。'
    : ordinaryHand ? '本手不获得鱿鱼标记，打完后恢复原轮；新加入者仍需等下一轮鱿鱼。' : '';
  return { paused, playing, round, countsForSquid, ordinaryHand, waitingAtExpiry, label, note };
}

export function participation(room, player) {
  if (!player || player.seat == null) return { label: '观战中', note: '选择空座，带入积分后参加。' };
  if (player.pendingDeparture) return {
    label: player.pendingDeparture === 'stand' ? '本手后离座' : '本手后暂离',
    note: '已安排，当前这手仍照常进行。', canCancel: true,
  };
  if (room.hand?.status === 'playing' && player.inHand) return { label: '正在参与本手', note: '' };
  if (player.waitingFor === 'squid') return { label: '等待下一轮鱿鱼', note: '原轮鱿鱼恢复后仍需等下一轮；鱿鱼暂停时可参与普通德州。' };
  if (player.waitingFor === 'hand') return { label: '等待下一手', note: room.mini?.squid?.paused
    ? '已入座，下一手可参加普通德州；原轮鱿鱼恢复后，新加入者仍需等下一轮。'
    : '已入座，从下一手开始参与。' };
  if (player.sittingOut) return { label: '你已暂离', note: '座位和积分保留，回来后继续。', canReturn: true };
  return { label: '已入座', note: '' };
}

export function buyinTiming(room, isSit = true) {
  if (!isSit && room.hand?.status === 'playing') return '补充积分会从下一手生效，不影响当前手的投入。';
  if (isSit && room.expiryMode) return '牌桌已到时，当前仅收尾原轮鱿鱼；新入座者不参加原轮，也不会再开启新的普通手。';
  if (isSit && room.mini?.squid?.active && room.mini.squid.paused) return '鱿鱼暂停，入座后可从下一手普通德州参与；原轮恢复后，新加入者仍需等下一轮鱿鱼。';
  if (isSit && room.mini?.squid?.active) return '本轮鱿鱼正在进行，入座后从下一轮参与。';
  if (isSit && room.hand?.status === 'playing') return '这手已经开始，入座后从下一手参与。';
  return isSit ? '确认后立即入座，无需房主审核。' : '确认后立即补充积分，无需房主审核。';
}

export function departurePlan(room, player, type) {
  const squid = room.mini?.squid, participant = Boolean(squid?.active && squid.participants?.includes(player?.id));
  const won = participant && Boolean(squid.won?.includes(player.id));
  const cost = participant && !won ? Math.max(0, (squid.participants.length - 1) * Number(squid.unit || 0)) : 0;
  const queued = room.hand?.status === 'playing' && Boolean(player?.inHand || participant && !won);
  return {
    type, queued, cost, round: participant ? Number(squid.round) || 0 : 0, won,
    canEarnMark: queued && Boolean(player?.inHand) && Boolean(squidMode(room)?.countsForSquid),
    title: type === 'stand' ? '离开座位' : '暂离牌桌',
    label: queued ? type === 'stand' ? '本手后离座' : '本手后暂离' : type === 'stand' ? '确认离座' : '确认暂离',
    description: type === 'stand' ? '离座后收回桌上积分，留在房间观战；以后可以重新带入。' : '保留座位和积分，暂不参加新的手牌；回来后可继续。',
  };
}

export function squidSettlement(room) {
  const squid = room.mini?.squid;
  if (!squid?.active) return null;
  const participants = squid.participants ?? [], winners = squid.won ?? [];
  return { canSettle: Boolean(squid.canSettle), blocked: Boolean(squid.blockerSince),
    waitSeconds: Number(squid.settleAfterSeconds) || 90,
    loserCost: winners.length * Number(squid.unit || 0), winnerGain: (participants.length - winners.length) * Number(squid.unit || 0),
    winnerCount: winners.length, loserCount: participants.length - winners.length };
}
