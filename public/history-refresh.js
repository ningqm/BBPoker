// Refresh only unfinished, already-authorized rabbit reveals. Old requests can
// never replace a newly opened hand, modal, room or logged-in identity.
export function createHistoryRefresh({ getContext, isVisible = () => true, fetchHand, apply,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let epoch = 0, timer = null, failures = 0;
  const pending = context => context?.hand?.rabbit?.active === true && context.hand.rabbit.board?.length < 5;
  function stop() { epoch++; if (timer !== null) clearTimer(timer); timer = null; failures = 0; }
  function schedule(version, delay = 600) { timer = setTimer(() => { timer = null; void refresh(version); }, delay); }
  async function refresh(version) {
    if (version !== epoch) return;
    const context = getContext();
    if (!pending(context)) return;
    if (!isVisible()) { schedule(version, 1000); return; }
    try {
      const response = await fetchHand(context), hand = response?.hand || response;
      if (version !== epoch || getContext() !== context) return;
      if (!hand || hand.id !== context.hand.id || hand.roomCode !== context.hand.roomCode) return;
      // A delayed or stale response must not conceal a reveal already received.
      if ((hand.rabbit?.board?.length || 0) < (context.hand.rabbit?.board?.length || 0)) return;
      failures = 0; apply(context, hand);
    } catch {
      if (version !== epoch || getContext() !== context) return;
      failures++;
    }
    if (version === epoch && getContext() === context && pending(context) && failures < 3) schedule(version, failures ? 1500 : 600);
  }
  return { watch() { stop(); if (pending(getContext())) schedule(epoch); }, stop };
}
