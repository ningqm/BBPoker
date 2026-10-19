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

export function createTurnRecovery({ getContext, fetchRoom, probeRoom, apply, reconnect, clock = Date.now,
  monotonicClock = () => globalThis.performance?.now?.() ?? clock(),
  setTimer = setTimeout, clearTimer = clearTimeout, diagnose = () => {} }) {
  let generation = 0, pending = null, lastAttempt = -Infinity, lastTick = null, lastFresh = null, probeFailures = 0, freshSequence = 0;
  let transportScope = null, transportAnchor = null, clockCandidate = null, needsFullSnapshot = false;
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
  function transportNow(context = getContext()) {
    const scope = JSON.stringify([context?.identity, context?.room?.code, context?.room?.meId]);
    if (scope !== transportScope) { transportScope = scope; transportAnchor = clockCandidate = null; needsFullSnapshot = false; }
    return transportAnchor ? transportAnchor.server + Math.max(0, monotonicClock() - transportAnchor.tick) : context?.now ?? clock();
  }
  // The displayed countdown intentionally never rewinds. A server clock step
  // must not make every future state permanently stale against that display.
  // Only two matching, complete no-store GETs may calibrate transport time:
  // fast bodies, no older revision, and server time advancing with monotonic
  // elapsed time. One delayed/cached response is insufficient evidence.
  function acceptHttpSnapshot(snapshot, request) {
    const context = getContext(), at = monotonicClock(), expectedNow = transportNow(context);
    const sample = timestamp(snapshot?.serverTime), revision = snapshot?.revision;
    if (!request || !Number.isFinite(request.durationMs) || request.durationMs < 0 || request.durationMs > 1500
      || snapshot?.code !== context?.room?.code || snapshot?.meId !== context?.room?.meId
      || !Number.isSafeInteger(revision) || !Number.isSafeInteger(request.revision)
      || !Number.isSafeInteger(context?.room?.revision) || revision < request.revision || revision < context.room.revision
      || !Number.isFinite(sample)) { if (request) clockCandidate = null; return false; }
    const correction = expectedNow - sample;
    if (correction <= 3000 || correction > 60000) { clockCandidate = null; return false; }
    const candidate = clockCandidate; needsFullSnapshot = true;
    clockCandidate = { tick: at, server: sample, revision, durationMs: request.durationMs };
    if (!candidate) return false;
    const elapsed = at - candidate.tick, serverElapsed = sample - candidate.server;
    if (elapsed < 1000 || elapsed > 10000 || revision < candidate.revision || serverElapsed <= 0
      || Math.abs(serverElapsed - elapsed) > Math.max(750, request.durationMs + candidate.durationMs)) return false;
    transportAnchor = { tick: at, server: sample }; clockCandidate = null;
    return true;
  }
  const report = (type,detail) => { try { diagnose(type,detail); } catch {} };
  const eligible = context => context?.page === 'room' && context.room?.code && context.identity
    && context.visible && context.online && context.connected && (!context.resync || context.staleSnapshot || needsFullSnapshot)
    && !context.foregroundPending && !context.busy;
  function reset() {
    generation++;
    pending?.abort(); pending = null; lastAttempt = -Infinity; lastTick = lastFresh = null; probeFailures = 0; freshSequence++;
    clockCandidate = null; needsFullSnapshot = false;
  }
  // Called for accepted SSE/HTTP snapshots, never for raw heartbeat bytes.
  function observed(snapshot) {
    const sample = timestamp(snapshot?.serverTime);
    const serverNow = transportNow();
    // Buffered but increasing revisions are still useful business updates;
    // they are not proof the stream has caught up to the live table.
    if (Number.isFinite(sample) && Number.isFinite(serverNow) && serverNow - sample > 3000) return false;
    if (transportAnchor && Number.isFinite(sample) && sample > serverNow) transportAnchor = { server: sample, tick: monotonicClock() };
    lastFresh = clock(); probeFailures = 0; freshSequence++; needsFullSnapshot = false; clockCandidate = null; return true;
  }
  async function check() {
    const context = getContext(), time = clock();
    const timerLagMs=lastTick===null?0:Math.max(0,time-lastTick-400);
    const resumed = lastTick !== null && time - lastTick > 5000;
    lastTick = time;
    if (lastFresh === null) lastFresh = time;
    if (!eligible(context) || pending || time - lastAttempt < 2500) return false;
    const stalled = stalledTurnReason(context.room, transportNow(context));
    // Buffered snapshots must not enable betting. They can nevertheless open
    // this bounded recovery path while the action controls remain gated.
    const stale = context.staleSnapshot === true || needsFullSnapshot;
    // A previous player may have acted early. Waiting until their OLD deadline
    // to recover the missing frame can consume most of our own 20-second turn.
    const probe = !stale && !resumed && !stalled && typeof probeRoom === 'function'
      && context.room.status !== 'closed' && time - lastFresh >= 3000;
    if (!stale && !resumed && !stalled && !probe) return false;
    const capturedFreshSequence = freshSequence;
    const capturedGeneration = generation, code = context.room.code, identity = context.identity;
    const current = () => {
      const value = getContext();
      return capturedGeneration === generation && eligible(value) && value.identity === identity && value.room.code === code;
    };
    const controller = new AbortController(); pending = controller; lastAttempt = time;
    const reason = stale ? 'stale_snapshot' : probe ? 'idle' : resumed ? 'timer_resume' : stalled;
    const phase = probe ? 'idle' : 'full';
    const reportCurrent = (type,detail) => { const value=getContext(); if(capturedGeneration===generation&&value?.identity===identity&&value.room?.code===code)report(type,{room:code,streamId:context.streamId,phase,...detail}); };
    let timedOut=false,applyFailed=false;const requestStarted=monotonicClock();
    reportCurrent('probe_start',{reason,timerLagMs,lastFreshAgeMs:Math.max(0,time-lastFresh),revision:context.room.revision});
    const timer = setTimer(() => { timedOut=true;controller.abort(); }, probe ? 2500 : 4000);
    try {
      const response = probe ? await probeRoom(code, { revision: context.room.revision,
        canAct: Boolean(context.room.actions?.canAct) }, controller.signal) : await fetchRoom(code, controller.signal);
      if (!controller.signal.aborted && current()) {
        const room = probe ? response?.room : response;
        if (probe && response?.unchanged === true && response.code === code && response.meId === context.room.meId) {
          const fresh=observed(response);if(!fresh)needsFullSnapshot=true;reportCurrent('probe_result',{reason:fresh?'unchanged':'stale_snapshot',durationMs:clock()-time});
        } else if (room?.code === code && room.meId === context.room.meId) {
          const httpClockCorrection=!probe&&acceptHttpSnapshot(room,{revision:context.room.revision,durationMs:Math.max(0,monotonicClock()-requestStarted)});
          const fresh=observed(room);if(probe&&!fresh)needsFullSnapshot=true;try{apply(room,{httpClockCorrection});}catch(error){applyFailed=true;throw error;}reportCurrent('probe_result',{reason:fresh?'ok':'stale_snapshot',durationMs:clock()-time});
        } else reportCurrent('probe_result',{reason:'wrong_snapshot',durationMs:clock()-time});
      } else reportCurrent('probe_result',{reason:'superseded',durationMs:clock()-time});
    } catch (error) {
      // A slow auxiliary GET must not tear down a stream that has supplied
      // fresh authoritative state since this request began. One failed idle
      // probe is not evidence of a broken stream; repeated failures still
      // recover a connection delivering heartbeats but no usable state.
      const superseded=!current()||(!applyFailed&&freshSequence!==capturedFreshSequence);
      reportCurrent('probe_result',{reason:applyFailed?'client_apply_error':superseded?'superseded':timedOut?'timeout':error.status?'http_error':error.transportReason||'network_error',status:error.status,durationMs:clock()-time,failures:probeFailures+(superseded?0:1)});
      if (!superseded && (applyFailed || (!probe && !stale) || ++probeFailures >= 2)) {
        const cause=applyFailed?'client_apply_error':probe?'probe_failures':'stalled_refresh_failed';
        reportCurrent('probe_reconnect',{reason:cause,failures:probeFailures,durationMs:clock()-time});reconnect(code,cause);
      }
    } finally {
      clearTimer(timer);
      if (pending === controller) pending = null;
    }
    return true;
  }
  return { check, reset, observed, acceptHttpSnapshot, needsFullSnapshot: () => needsFullSnapshot };
}
