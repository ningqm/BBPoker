// Presentation only: the server has already settled and closed the room. Keep
// the last public hand on screen briefly; never delay or repeat a money action.
export const ROOM_ENDING_MS = 5000;
const clock = () => globalThis.performance?.now?.() ?? Date.now();

export function createRoomEnding({ now: readNow = clock } = {}) {
  let ending = null;
  let resultSeen = null;
  const sameHand = (a, b) => a && b && a.code === b.code && a.meId === b.meId && a.handId === b.handId;
  const handKey = room => ({ code: room?.code, meId: room?.meId, handId: room?.hand?.id });
  const boardKey = room => JSON.stringify(room?.hand?.rabbit?.board || room?.hand?.board || []);
  const same = room => ending && room?.code === ending.code && room?.meId === ending.meId && room?.hand?.id === ending.handId;
  return {
    reset() { ending = null; resultSeen = null; },
    update(previous, room, { live = true, now = readNow() } = {}) {
      if (!live || !Number.isFinite(now)) { ending = null; resultSeen = null; return; }
      if (same(room) && room.status === 'closed') return;
      ending = null;
      const key = handKey(room);
      if (!room?.hand || room.hand.status !== 'complete' || room.hand.rabbit?.active) { resultSeen = null; return; }
      if (room.status !== 'closed') {
        // A room may close during the ordinary result hold. Count time already
        // spent looking at this result instead of starting a second review.
        if (!sameHand(resultSeen, key) || resultSeen.board !== boardKey(room)) {
          resultSeen = { ...key, board: boardKey(room), at: now };
        }
        return;
      }
      if (previous?.status === 'closed' || !sameHand(handKey(previous), key)) { resultSeen = null; return; }
      const newlyVisible = previous?.hand?.status !== 'complete' || previous.hand.rabbit?.active || boardKey(previous) !== boardKey(room);
      const readyAt = newlyVisible ? now : sameHand(resultSeen, key) ? resultSeen.at : null;
      // An already-complete hand with no live observation is an old/resynced
      // result, not a new final hand. Do not replay its ending on manual close.
      if (readyAt === null || now >= readyAt + ROOM_ENDING_MS) { resultSeen = null; return; }
      // Only placement and the previous cash-out counter survive. Card faces,
      // results, balances and categories always come from the final snapshot.
      const seats = (previous.players || []).filter(p => p.seat != null).map(p => ({
        id: p.id, seat: p.seat, cashedOut: Number(p.cashedOut) || 0,
      }));
      if (!seats.length) return;
      const q = room.mini?.squid, before = previous.mini?.squid;
      const settledSquid = before?.active && !q?.active && q?.lastResult?.round === before.round
        ? q.lastResult : null;
      ending = { code: room.code, meId: room.meId, handId: room.hand.id,
        until: readyAt + ROOM_ENDING_MS, seats, squidDelta: settledSquid?.changes?.[room.meId] ?? null };
    },
    view(room, now = readNow()) {
      if (!same(room) || room.status !== 'closed' || !Number.isFinite(now) || now >= ending.until) return null;
      const seats = new Map(ending.seats.map(p => [p.id, p]));
      const displayRoom = { ...room, players: (room.players || []).map(p => {
        const before = seats.get(p.id);
        return before ? { ...p, seat: before.seat,
          stack: Math.max(0, (Number(p.cashedOut) || 0) - before.cashedOut),
          pendingDeparture: null, waitingFor: null, entryBlind: null, sittingOut: false,
        } : p;
      }) };
      return { room: displayRoom, remaining: Math.max(1, Math.ceil((ending.until - now) / 1000)),
        squidDelta: ending.squidDelta };
    },
  };
}
