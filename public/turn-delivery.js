// Rendering a turn is acknowledged independently of betting. A lost receipt
// never locks buttons and is retried only while this exact turn is still live.
export function createTurnDelivery({ getContext, acknowledge, apply, clock = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0, pending = null, lastAttempt = -Infinity, lastKey = null, acceptedKey = null;
  function reset() {
    generation++; pending?.abort(); pending = null;
    lastAttempt = -Infinity; lastKey = acceptedKey = null;
  }
  const keyFor = context => {
    const room = context?.room, hand = room?.hand;
    if (context?.page !== 'room' || !context.identity || !context.visible || !context.online
      || !context.connected || context.resync || context.busy || !room?.actions?.canAct
      || hand?.status !== 'playing' || hand.actingId !== room.meId || hand.transition || hand.runout?.active
      || !hand.id || !Number.isSafeInteger(hand.actionSeq)) return null;
    return JSON.stringify([context.identity, room.code, room.meId, hand.id, hand.actionSeq]);
  };
  async function check() {
    const context = getContext(), key = keyFor(context), time = clock();
    if (pending && key && key !== lastKey) { pending.abort(); pending = null; }
    if (!key || pending || key === acceptedKey || context.room.hand.deliveryGrace?.acknowledged) return false;
    if (key === lastKey && time - lastAttempt < 2000) return false;
    lastKey = key; lastAttempt = time;
    const capturedGeneration = generation, controller = new AbortController(); pending = controller;
    const timer = setTimer(() => controller.abort(), 3500);
    try {
      const response = await acknowledge(context.room.code, { handId: context.room.hand.id, actionSeq: context.room.hand.actionSeq }, controller.signal);
      if (controller.signal.aborted || generation !== capturedGeneration || keyFor(getContext()) !== key) return true;
      if (response?.accepted) acceptedKey = key;
      if (response?.room?.code === context.room.code && response.room.meId === context.room.meId) apply(response.room);
    } catch { /* Normal state recovery will retry; do not interrupt betting. */ }
    finally { clearTimer(timer); if (pending === controller) pending = null; }
    return true;
  }
  return { check, reset };
}
