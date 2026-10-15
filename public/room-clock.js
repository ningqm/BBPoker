// Room snapshots carry a server timestamp and absolute deadlines. Transport
// latency is not extra thinking time: re-anchoring to every received timestamp
// would rewind the clock whenever an old SSE/HTTP response arrives late.
const timestamp = value => typeof value === 'number' ? value
  : typeof value === 'string' && value ? Date.parse(value) : NaN;
const defaultMonotonicNow = () => typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now() : Date.now();

export function isOlderRoomSnapshot(previous, incoming) {
  if (!previous || previous.code !== incoming?.code || previous.meId !== incoming?.meId) return false;
  const before = Number(previous.revision), after = Number(incoming.revision);
  if (Number.isFinite(before) && Number.isFinite(after)) {
    if (after < before) return true;
    // A newer business revision remains authoritative even if the server's
    // wall clock was adjusted. Only equal revisions use time as a tie-breaker.
    if (after > before) return false;
  }
  const earlier = timestamp(previous.serverTime), later = timestamp(incoming.serverTime);
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) return false;
  if (later !== earlier) return later < earlier;
  // state() evaluates readiness before stamping serverTime. Two projections
  // spanning readyAt can share a millisecond/revision, then arrive backwards.
  // Readiness is one-way only within this exact action and unchanged deadline;
  // a new action, time card or newer business revision remains authoritative.
  const current = previous.hand, next = incoming.hand;
  return Number.isFinite(before) && before === after
    && current?.status === 'playing' && next?.status === 'playing'
    && Boolean(current.id) && Number.isSafeInteger(current.actionSeq)
    && ['id', 'street', 'actionSeq', 'actingId', 'turnStartedAt', 'actionReadyAt'].every(key => current[key] === next[key])
    && previous.deadline === incoming.deadline
    && previous.actions?.turnAvailable === true && incoming.actions?.turnAvailable === true
    && previous.actions.canAct === true && incoming.actions.canAct === false;
}

export function createRoomClock({ monotonicNow = defaultMonotonicNow, wallNow = Date.now } = {}) {
  let scope = null, server = null, tick = null, last = null;
  function now() {
    if (server === null) return wallNow();
    const elapsed = Math.max(0, monotonicNow() - tick);
    last = Math.max(last, server + elapsed);
    return last;
  }
  function accept(room) {
    const sample = timestamp(room?.serverTime);
    if (!Number.isFinite(sample)) return false;
    const key = JSON.stringify([room?.code ?? null, room?.meId ?? null]);
    // A fresh room/account starts from its own server sample. Reconnects to the
    // same room deliberately retain elapsed time, including background time.
    const next = scope !== key || server === null ? sample : Math.max(now(), sample);
    scope = key; server = last = next; tick = monotonicNow();
    return true;
  }
  function reset() { scope = server = tick = last = null; }
  return { now, accept, reset };
}
