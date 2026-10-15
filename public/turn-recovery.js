// A delayed SSE frame must not leave a visible table on a deal gate or an
// expired turn. Fetch authoritative state; never enable actions locally or
// replay the player's last command.
export function stalledTurnReason(room, now) {
  const hand = room?.hand;
  if (room?.status === 'closed' || hand?.status !== 'playing') return null;
  const ready = hand.actionReadyAt;
  if (room.actions?.turnAvailable && !room.actions.canAct && !hand.transition && !hand.runout?.active
    && Number.isFinite(ready) && now >= ready + 500) return 'ready';
  const deadline = room.deadline;
  if (hand.actingId && Number.isFinite(deadline) && now >= deadline + 1200) return 'deadline';
  const transition = hand.transition?.nextAt ?? (hand.runout?.active ? hand.runout.nextAt : null);
  if (Number.isFinite(transition) && now >= transition + 1200) return 'presentation';
  return null;
}

export function createTurnRecovery({ getContext, fetchRoom, apply, reconnect, clock = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0, pending = null, lastAttempt = -Infinity, lastTick = null;
  const eligible = context => context?.page === 'room' && context.room?.code && context.identity
    && context.visible && context.online && context.connected && !context.resync && !context.busy;
  function reset() {
    generation++;
    pending?.abort(); pending = null; lastAttempt = -Infinity; lastTick = null;
  }
  async function check() {
    const context = getContext(), time = clock();
    const resumed = lastTick !== null && time - lastTick > 5000;
    lastTick = time;
    if (!eligible(context) || pending || time - lastAttempt < 2500) return false;
    if (!resumed && !stalledTurnReason(context.room, context.now ?? time)) return false;
    const capturedGeneration = generation, code = context.room.code, identity = context.identity;
    const current = () => {
      const value = getContext();
      return capturedGeneration === generation && eligible(value) && value.identity === identity && value.room.code === code;
    };
    const controller = new AbortController(); pending = controller; lastAttempt = time;
    const timer = setTimer(() => controller.abort(), 4000);
    try {
      const room = await fetchRoom(code, controller.signal);
      if (!controller.signal.aborted && current() && room?.code === code && room.meId === context.room.meId) apply(room);
    } catch {
      if (current()) reconnect(code);
    } finally {
      clearTimer(timer);
      if (pending === controller) pending = null;
    }
    return true;
  }
  return { check, reset };
}
