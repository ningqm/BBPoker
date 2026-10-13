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
  return minutes ? `剩余 ${minutes} 分钟` : '本手结束后散桌';
}

export function participation(room, player) {
  if (!player || player.seat == null) return { label: '观战中', note: '选择空座，带入积分后参加。' };
  if (player.pendingDeparture) return {
    label: player.pendingDeparture === 'stand' ? '本手后离座' : '本手后暂离',
    note: '已安排，当前这手仍照常进行。', canCancel: true,
  };
  if (player.waitingFor === 'squid') return { label: '等待下一轮', note: '已入座，本轮鱿鱼结束后参与。' };
  if (player.waitingFor === 'hand') return { label: '等待下一手', note: '已入座，从下一手开始参与。' };
  if (player.sittingOut) return { label: '你已暂离', note: '座位和积分保留，回来后继续。', canReturn: true };
  return { label: '已入座', note: '' };
}

export function buyinTiming(room, isSit = true) {
  if (!isSit && room.hand?.status === 'playing') return '补充积分会从下一手生效，不影响当前手的投入。';
  if (isSit && room.mini?.squid?.active) return '本轮鱿鱼正在进行，入座后从下一轮参与。';
  if (isSit && room.hand?.status === 'playing') return '这手已经开始，入座后从下一手参与。';
  return isSit ? '确认后立即入座，无需房主审核。' : '确认后立即补充积分，无需房主审核。';
}

export function departurePlan(room, player, type) {
  const squid = room.mini?.squid, participant = Boolean(squid?.active && squid.participants?.includes(player?.id));
  const won = participant && Boolean(squid.won?.includes(player.id));
  const cost = participant && !won ? Math.max(0, (squid.participants.length - 1) * Number(squid.unit || 0)) : 0;
  const queued = room.hand?.status === 'playing' && Boolean(player?.inHand);
  return {
    type, queued, cost, round: participant ? Number(squid.round) || 0 : 0, won,
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
