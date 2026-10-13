// A directory grants discovery only. Never spread a room/member/user object
// here: invite tokens, cards, chat, balances and account fields stay private.
export function lobbyDirectory(db, userId) {
  const names = new Map(Object.values(db.users).map(user => [user.id, user.name]));
  const rooms = Object.values(db.rooms).filter(room => room.status !== 'closed')
    .sort((a, b) => Number(Boolean(b.members[userId])) - Number(Boolean(a.members[userId])) || b.createdAt.localeCompare(a.createdAt))
    .map(room => {
      const joined = Object.hasOwn(room.members, userId), access = room.access === 'public' ? 'public' : 'invite';
      return { code: room.code, name: room.name, hostName: names.get(room.hostId) ?? '朋友',
        status: room.hand?.status === 'playing' ? 'playing' : 'waiting', access, joined,
        seatedCount: Object.values(room.members).filter(member => Number.isInteger(member.seat)).length,
        maxPlayers: room.settings.maxPlayers, smallBlind: room.settings.smallBlind, bigBlind: room.settings.bigBlind,
        squid: room.settings.squid === true, handNumber: room.handNumber ?? 0, endsAt: room.endsAt ?? null,
        canJoin: joined || (access === 'public' && Object.keys(room.members).length < 30) };
    });
  return { rooms, limit: 10 };
}
