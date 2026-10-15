import { createCheckKnockBuffer } from './check-knock.js';

// Presentation only: these helpers never choose cards, settle a pot, or submit an action.
const SLIDER_MAX = 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function raiseScale(minimum, maximum, bigBlind) {
  const min = clamp(Math.ceil(finite(minimum)), 0, Number.MAX_SAFE_INTEGER);
  const max = clamp(Math.floor(finite(maximum, min)), min, Number.MAX_SAFE_INTEGER);
  const scale = Math.max(1, finite(bigBlind, 1));
  return { min, max, scale, curve: Math.log1p((max - min) / scale) };
}

/** A 0..1000 slider, precise near the minimum and progressively faster near all-in. */
export function raiseFromSlider(position, minimum, maximum, bigBlind) {
  const { min, max, scale, curve } = raiseScale(minimum, maximum, bigBlind);
  const t = clamp(finite(position), 0, SLIDER_MAX) / SLIDER_MAX;
  if (!curve || t === 0) return min;
  if (t === 1) return max;
  return clamp(Math.round(min + scale * Math.expm1(t * curve)), min, max);
}

/** Does not round the actual bet: callers retain the exact manually entered amount. */
export function sliderFromRaise(amount, minimum, maximum, bigBlind) {
  const { min, max, scale, curve } = raiseScale(minimum, maximum, bigBlind);
  const value = clamp(finite(amount, min), min, max);
  if (!curve || value === min) return 0;
  if (value === max) return SLIDER_MAX;
  return clamp(Math.round(SLIDER_MAX * Math.log1p((value - min) / scale) / curve), 0, SLIDER_MAX);
}

const playerActions = new Set(['fold', 'check', 'call', 'raise', 'allin']);
const emptyFeedback = () => ({ animations: [], sound: null });

// Only retain public event identifiers and counts. In particular, no hole cards,
// avatar images, chat text or profile data are copied into this presentation state.
function snapshot(room, now) {
  if (!room || typeof room.code !== 'string') return null;
  const hand = room.hand;
  const log = Array.isArray(hand?.log) ? hand.log : [];
  const serverTime = typeof room.serverTime === 'number' ? room.serverTime : Date.parse(room.serverTime);
  const clock = Number.isFinite(serverTime) ? serverTime : now;
  const actionReadyAt = Number(hand?.actionReadyAt) || 0;
  const turnReady = Boolean(hand?.status === 'playing' && hand.actingId && !hand.transition &&
    clock >= actionReadyAt && (hand.actingId !== room.meId || room.actions?.canAct !== false));
  return {
    code: room.code, meId: room.meId, revision: room.revision,
    serverTime,
    hand: hand ? {
      id: hand.id, number: hand.number, status: hand.status, actingId: hand.actingId,
      actionReadyAt, turnReady,
      boardLength: Array.isArray(hand.board) ? hand.board.length : 0,
      seq: hand.actionSeq, allInIds: (room.players ?? []).filter(player => player.allIn).map(player => player.id), log: log.map(event => ({
        seq: event.seq, type: event.type, playerId: event.playerId,
        amount: event.amount, to: event.to, street: event.street, isRaise: event.isRaise,
      })),
      winnerIds: [...(hand.result?.mainWinnerIds ?? [])],
      paidOut: Object.values(hand.result?.payouts ?? {}).some(amount => Number.isFinite(amount) && amount > 0),
    } : null,
  };
}

function validLog(hand) {
  return hand && Number.isSafeInteger(hand.seq) && hand.seq >= 0 &&
    hand.seq === hand.log.length && hand.log.every((event, index) => event.seq === index + 1);
}

function sameEvent(a, b) {
  return a && b && ['seq', 'type', 'playerId', 'amount', 'to', 'street', 'isRaise'].every(key => a[key] === b[key]);
}

function olderThan(current, previous) {
  if (current?.code !== previous?.code || current?.meId !== previous?.meId) return false;
  if (Number.isFinite(current.revision) && Number.isFinite(previous.revision) && current.revision < previous.revision) return true;
  if (!previous.hand) return false;
  if (!current.hand) return true;
  return current.hand.number < previous.hand.number ||
    (current.hand.id === previous.hand.id && current.hand.seq < previous.hand.seq);
}

// All names are fixed cues, never text supplied by a player. The log is public.
function spokenAction(hand, event) {
  if (event.type === 'allin' || (['raise', 'call'].includes(event.type) && hand.allInIds.includes(event.playerId))) return 'allin';
  if (event.type !== 'raise') return event.type;
  const street = event.street ?? 'preflop';
  const prior = hand.log.filter(item => item.seq < event.seq && (item.street ?? 'preflop') === street &&
    (item.type === 'raise' || (item.type === 'allin' && item.isRaise === true))).length;
  if (street === 'preflop') return prior ? 'reraise' : 'raise';
  return prior === 0 ? 'bet' : prior === 1 ? 'raise' : 'reraise';
}

function transitions(previous, current) {
  const before = previous.hand, after = current.hand;
  const feedback = emptyFeedback();
  if (!validLog(after)) return feedback;
  const newHand = before?.id !== after.id;
  if (newHand) {
    // A live, consecutive fresh deal is animated. A late join or missed hand is
    // a state restore: never replay earlier players' actions or old victories.
    if (after.status !== 'playing' || after.number !== (before?.number ?? 0) + 1 ||
        (before && before.status !== 'complete') || after.log.some(event => playerActions.has(event.type))) return feedback;
    feedback.animations.push({ type: 'deal' });
    if (after.boardLength) feedback.animations.push({ type: 'board', from: 0 });
    if (after.turnReady) feedback.animations.push({ type: 'turn', playerId: after.actingId });
    feedback.sound = 'deal';
    feedback.eventId = `${current.code}:${current.meId}:${after.id}:${after.seq}`;
    return feedback;
  }
  if (!validLog(before) || after.seq < before.seq ||
      !before.log.every((event, index) => sameEvent(event, after.log[index]))) return feedback;
  const fresh = after.log.slice(before.seq);
  const freshActions = fresh.filter(event => playerActions.has(event.type));
  for (const event of freshActions) {
    feedback.animations.push({ type: 'action', playerId: event.playerId, action: event.type, seq: event.seq });
  }
  // A batched response may include a raise followed by somebody's fold/check.
  // Announce only the most recent action and attach chips to that same action;
  // OR-ing every earlier bet makes an unrelated check or fold sound like a bet.
  // Checks are physical table taps, independent of the newest spoken action
  // and turn/board notifications. Keep each fresh action's identity.
  const checks = freshActions.filter(event => event.type === 'check').slice(-9);
  if (checks.length) feedback.checks = checks.map(event => `${current.code}:${current.meId}:${after.id}:check:${event.seq}`);
  const latestAction = freshActions.at(-1);
  if (latestAction) {
    const chips = ['raise', 'call', 'allin'].includes(latestAction.type) &&
      (latestAction.amount === undefined || finite(latestAction.amount) > 0);
    feedback.sound = chips ? 'chip' : ['fold', 'check'].includes(latestAction.type) ? latestAction.type : null;
    if (latestAction.type !== 'check') feedback.speech = spokenAction(after, latestAction);
    feedback.chips = chips;
  }
  if (after.boardLength > before.boardLength) {
    feedback.animations.push({ type: 'board', from: before.boardLength });
    feedback.sound = 'board';
  }
  // Readiness is published without adding another poker action to the log.
  // Do not call a player while cards are still flipping; announce that same
  // action sequence only when its authoritative ready snapshot arrives.
  if (after.turnReady && (after.actingId !== before.actingId || !before.turnReady || after.actionReadyAt !== before.actionReadyAt)) {
    feedback.animations.push({ type: 'turn', playerId: after.actingId });
    if (after.actingId === current.meId && after.boardLength === before.boardLength) feedback.sound = 'yourturn';
  }
  if (before.status !== 'complete' && after.status === 'complete') {
    feedback.animations.push({ type: 'win', playerIds: after.winnerIds });
    // One collection cue for the actual settlement, including split and side
    // pots. Merely showing the river, a refund or a complete-state restore is
    // not a payout. Replace any final-action chip hit instead of layering it.
    if (after.paidOut || fresh.some(event => event.type === 'payout' && finite(event.amount) > 0)) {
      feedback.sound = 'collect';
      feedback.chips = false;
    }
  }
  if (feedback.sound || feedback.speech) {
    const turn = feedback.sound === 'yourturn' ? `:turn:${after.actingId}:${after.actionReadyAt}` : feedback.sound === 'collect' ? ':payout' : '';
    feedback.eventId = `${current.code}:${current.meId}:${after.id}:${after.seq}${turn}`;
  }
  return feedback;
}

/** One tracker per active table. Always feed snapshots, even while effects are off. */
export function createTableFeedback() {
  let previous = null, mutedBaseline = false;
  return {
    reset() { previous = null; mutedBaseline = false; },
    update(room, { live = true, visible = true, connected = true, reconnected = false, now = Date.now() } = {}) {
      const current = snapshot(room, now);
      if (!current) { previous = null; mutedBaseline = false; return emptyFeedback(); }
      if (olderThan(current, previous)) return emptyFeedback();
      const sameRoom = previous?.code === current.code && previous?.meId === current.meId;
      // Transport delay is measured against the caller's server-adjusted clock.
      // A missing serverTime keeps old clients/tests compatible. No catch-up queue.
      const delayed = Number.isFinite(current.serverTime) && Number.isFinite(now) && now - current.serverTime > 5000;
      const suppressed = !live || !visible || !connected || reconnected || delayed;
      const result = previous && sameRoom && !suppressed && !mutedBaseline
        ? transitions(previous, current) : emptyFeedback();
      previous = current;
      // The first visible state after returning from another app is a baseline,
      // even when the stream delivered one last hidden state before suspension.
      mutedBaseline = !live || !visible || !connected;
      return result;
    },
  };
}

/** Current action only. The first state and restores establish a silent baseline. */
export function createTurnCountdown() {
  let previous = null;
  const quiet = remaining => ({ remaining, urgent: false, sound: null });
  return {
    reset() { previous = null; },
    update(room, { now = Date.now(), live = true, visible = true, connected = true, reconnected = false } = {}) {
      const hand = room?.hand;
      const deadline = typeof room?.deadline === 'number' ? room.deadline : Date.parse(room?.deadline);
      const mine = Boolean(hand?.status === 'playing' && hand.actingId && hand.actingId === room?.meId);
      if (!mine || hand.transition || !Number.isFinite(deadline) || !Number.isFinite(now) ||
          now < (Number(hand.actionReadyAt) || 0) || room.actions?.canAct === false) {
        previous = null; return quiet(null);
      }
      const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
      const key = `${room.code}:${room.meId}:${hand.id}:${hand.actionSeq}:${deadline}`;
      const allowed = live && visible && connected && !reconnected;
      const prior = previous;
      previous = { key, remaining, now, allowed, lowest: prior?.key === key ? Math.min(prior.lowest, remaining) : remaining };
      if (!allowed) return quiet(remaining);
      const urgent = remaining > 0 && remaining <= 7;
      // No catch-up queue after reconnect/background suspension, even if several
      // elapsed seconds disappeared. Repeated render/timer calls stay silent.
      const fresh = prior?.key === key && prior.allowed && now >= prior.now && remaining < prior.lowest;
      return { remaining, urgent, sound: urgent && fresh ? (remaining <= 3 ? 'countdown-last' : 'countdown') : null };
    },
  };
}

const tones = {
  deal: [[660, 360, 0, 0.055, 0.025], [760, 440, 0.065, 0.055, 0.02]],
  board: [[520, 820, 0, 0.075, 0.022]],
  chip: [], // Same-origin multi-chip foley; no synthetic click fallback.
  collect: [], // The selected recording, fuller and lower for a pot being gathered.
  fold: [[260, 130, 0, 0.06, 0.015]],
  check: [], // Short double table knock in a separate action channel.
  yourturn: [[660, 660, 0, 0.075, 0.025], [880, 880, 0.09, 0.075, 0.025]],
  win: [[660, 660, 0, 0.075, 0.025], [880, 880, 0.075, 0.075, 0.022], [1100, 1100, 0.15, 0.09, 0.019]],
  countdown: [[820, 820, 0, 0.055, 0.035]],
  'countdown-last': [[1050, 1050, 0, 0.075, 0.045]],
};

export const TABLE_VOICE_CUES = Object.freeze(['bet', 'raise', 'reraise', 'call', 'fold', 'allin']);
export const TABLE_VOICE_LABELS = Object.freeze({ bet: '下注', raise: '加注', reraise: '再加注', call: '跟注', check: '过牌', fold: '弃牌', allin: 'All-in' });
// Versioned separately from the app release so replaced media never uses an old cache.
const AUDIO_ASSET_VERSION = '20261015-real-table-taps-v8';
export const TABLE_AUDIO_MIX = Object.freeze({ chips: 0.70, chipsUnderVoice: 0.42, collect: 0.78, collectRate: 0.92, check: 0.85, voice: 0.8, voiceLead: 0.025 });

/** Same-origin recorded cues and synthesized effects; never a delayed action queue. */
export function createTableSounds({ enabled = false, voiceEnabled = true,
  AudioContext: AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  document: doc = globalThis.document, now = () => Date.now(), fetch: fetcher = globalThis.fetch } = {}) {
  let context = null, unlocked = false, disposed = false, lastPlayed = -Infinity, generation = 0;
  let voiceSource = null, knockNextAt = 0;
  let activated = false, suspendedByApp = false, recoveryAttempted = false;
  const buffers = new Map(), loading = new Map(), active = new Set();
  const heardEvents = new Set();
  const visible = () => doc?.visibilityState !== 'hidden';
  const ready = () => !disposed && enabled && unlocked && visible() && context?.state === 'running';
  const ignoreRejection = promise => { if (promise?.catch) promise.catch(() => {}); };
  function stopVoice() {
    if (!voiceSource) return;
    try { voiceSource.node.stop(); } catch {}
    try { voiceSource.node.disconnect(); voiceSource.gain.disconnect(); } catch {}
    voiceSource = null;
  }
  function stop(kind = null) {
    for (const entry of active) {
      if (kind && entry.kind !== kind) continue;
      try { entry.node.stop(); } catch {}
      try { entry.node.disconnect(); entry.gain.disconnect(); } catch {}
      active.delete(entry);
    }
  }
  function stopPlayback() {
    stop(); stopVoice(); knockNextAt = 0;
  }
  function suspend() {
    generation++; unlocked = false; suspendedByApp = true; stop(); stopVoice(); knockNextAt = 0;
    try { if (context && context.state !== 'closed') ignoreRejection(context.suspend()); } catch {}
  }
  async function resumeActivated() {
    // Reuse only an already activated context. Browsers may still require a
    // fresh real gesture; a rejected/pending resume never blocks the table or
    // queues missed sounds. One attempt per interruption avoids retry loops.
    if (disposed || !activated || !enabled || !visible() || suspendedByApp ||
        !context || context.state === 'closed' || recoveryAttempted) return false;
    recoveryAttempted = true;
    const audio = context, attempt = generation;
    try {
      if (audio.state !== 'running') await audio.resume();
      if (disposed || context !== audio || attempt !== generation || !enabled || !visible() || suspendedByApp) return false;
      unlocked = audio.state === 'running';
      if (unlocked) { recoveryAttempted = false; ignoreRejection(preloadAudio()); }
      return unlocked;
    } catch { if (context === audio && attempt === generation) unlocked = false; return false; }
  }
  function audioStateChanged() {
    if (disposed || !activated || !enabled || !visible() || suspendedByApp) return;
    if (context?.state === 'running') { unlocked = true; recoveryAttempted = false; }
    else if (['suspended', 'interrupted'].includes(context?.state)) {
      unlocked = false; stopPlayback(); ignoreRejection(resumeActivated());
    }
  }
  function visibilityChanged() {
    if (!visible()) suspend();
    else { suspendedByApp = false; recoveryAttempted = false; ignoreRejection(resumeActivated()); }
  }
  doc?.addEventListener?.('visibilitychange', visibilityChanged);
  function preloadAudio() {
    if (disposed || !context?.decodeAudioData || typeof fetcher !== 'function') return Promise.resolve(false);
    const audio = context;
    const types = ['chips', ...(voiceEnabled ? TABLE_VOICE_CUES : [])];
    return Promise.all(types.map(type => {
      if (buffers.has(type)) return Promise.resolve(true);
      if (loading.has(type)) return loading.get(type).promise;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const entry = { controller, promise: null };
      entry.promise = (async () => {
        try {
          const response = await fetcher(new URL(`./audio/${type}.wav?v=${AUDIO_ASSET_VERSION}`, import.meta.url), { credentials: 'omit', signal: controller.signal });
          if (!response.ok) return false;
          const bytes = await response.arrayBuffer();
          if (disposed || context !== audio) return false;
          const buffer = await audio.decodeAudioData(bytes);
          if (disposed || context !== audio || !buffer?.duration || buffer.duration > 2) return false;
          buffers.set(type, buffer); return true;
        } catch { return false; }
        finally {
          clearTimeout(timer);
          if (loading.get(type) === entry) loading.delete(type);
        }
      })();
      loading.set(type, entry);
      return entry.promise;
    })).then(results => results.every(Boolean));
  }
  function clearAudio() {
    for (const { controller } of loading.values()) controller.abort();
    loading.clear(); buffers.clear();
  }
  function register(node, gain, kind = 'tone') {
    const entry = { node, gain, kind }; active.add(entry);
    node.connect(gain); gain.connect(context.destination);
    node.onended = () => {
      active.delete(entry);
      try { node.disconnect(); gain.disconnect(); } catch {}
    };
    return entry;
  }
  function knock() {
    if (!ready() || !context.createBufferSource || !context.createBuffer) return false;
    try {
      // Embedded real table taps: no download race can swallow
      // an early check. A short bounded burst separates coalesced live checks;
      // there is no timer queue and suspend/disconnect stops every source.
      if (!buffers.has('check-knock')) buffers.set('check-knock', createCheckKnockBuffer(context));
      const taps = [...active].filter(entry => entry.kind === 'knock');
      if (taps.length >= 18) { const oldest = taps[0]; oldest.node.stop(); oldest.node.disconnect(); oldest.gain.disconnect(); active.delete(oldest); }
      const start = Math.max(context.currentTime, Math.min(knockNextAt, context.currentTime + 0.8));
      knockNextAt = start + 0.1;
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = buffers.get('check-knock'); register(source, gain, 'knock');
      gain.gain.setValueAtTime(TABLE_AUDIO_MIX.check, start);
      source.start(start); source.stop(start + source.buffer.duration + 0.01); return true;
    } catch { return false; }
  }
  function cue(type, offset = 0, speech = false) {
    let played = false;
    const start = context.currentTime + offset;
    for (const [from, to, delay, duration, volume] of tones[type]) {
      const oscillator = context.createOscillator(), gain = context.createGain();
      register(oscillator, gain); oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(from, start + delay);
      oscillator.frequency.exponentialRampToValueAtTime(to, start + delay + duration);
      gain.gain.setValueAtTime(0.0001, start + delay);
      gain.gain.exponentialRampToValueAtTime(volume, start + delay + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + duration);
      oscillator.start(start + delay); oscillator.stop(start + delay + duration + 0.01); played = true;
    }
    if (['chip', 'collect'].includes(type) && buffers.has('chips') && context.createBufferSource) {
      // Ordinary prompts may accompany the natural tail. Another chip event
      // replaces this channel so rapid bets never pile up recorded impacts.
      stop('chip');
      const source = context.createBufferSource(), gain = context.createGain(); source.buffer = buffers.get('chips');
      const entry = register(source, gain, 'chip');
      const rate = type === 'collect' ? TABLE_AUDIO_MIX.collectRate : 1;
      source.playbackRate?.setValueAtTime(rate, start);
      entry.volume = speech ? TABLE_AUDIO_MIX.chipsUnderVoice : type === 'collect' ? TABLE_AUDIO_MIX.collect : TABLE_AUDIO_MIX.chips;
      gain.gain.setValueAtTime(entry.volume, start);
      source.start(start); source.stop(start + source.buffer.duration / rate + 0.01); played = true;
    }
    return played;
  }
  function play(type, { chips = false, speech = false } = {}) {
    if (!ready() || !Object.hasOwn(tones, type)) return false;
    if (type === 'check') return knock();
    // A real payout can share a response with the final action. It replaces
    // that chip channel immediately; the event ID prevents duplicate playback.
    const timestamp = now(); if (type !== 'collect' && timestamp - lastPlayed < 90) return false;
    stop('tone');
    try {
      const separateChips = chips && !['chip', 'collect'].includes(type);
      const chipsPlayed = separateChips ? cue('chip', 0, speech) : false;
      const effectPlayed = cue(type, separateChips ? 0.08 : 0, speech);
      if (chipsPlayed || effectPlayed) lastPlayed = timestamp;
      return chipsPlayed || effectPlayed;
    } catch { stop(); return false; }
  }
  function speak(type) {
    // Cancel first even when this clip is unavailable, so a previous player's
    // action cannot continue to masquerade as the new player's action.
    stopVoice();
    if (type === 'check' || !ready() || !voiceEnabled || !buffers.has(type) || !context.createBufferSource) return false;
    try {
      // A check/fold voice can arrive while an earlier chip-only cue finishes.
      // Apply the same existing duck level before this new voice starts.
      for (const entry of active) if (entry.kind === 'chip' && entry.volume !== TABLE_AUDIO_MIX.chipsUnderVoice) {
        entry.volume = TABLE_AUDIO_MIX.chipsUnderVoice;
        entry.gain.gain.setValueAtTime(entry.volume, context.currentTime);
      }
      const node = context.createBufferSource(), gain = context.createGain();
      node.buffer = buffers.get(type); gain.gain.setValueAtTime(TABLE_AUDIO_MIX.voice, context.currentTime);
      node.connect(gain); gain.connect(context.destination); const entry = { node, gain }; voiceSource = entry;
      node.onended = () => { if (voiceSource === entry) voiceSource = null; try { node.disconnect(); gain.disconnect(); } catch {} };
      node.start(context.currentTime + TABLE_AUDIO_MIX.voiceLead); return true;
    } catch { stopVoice(); return false; }
  }
  return {
    setEnabled(value) { enabled = Boolean(value); if (!enabled) suspend(); },
    setVoiceEnabled(value) {
      voiceEnabled = Boolean(value);
      if (!voiceEnabled) stopVoice(); else if (ready()) ignoreRejection(preloadAudio());
    },
    async unlock() {
      if (disposed || !enabled || !visible() || !AudioContextClass) return false;
      // A newer real gesture supersedes an automatic recovery or an older
      // gesture. Late promises must not relock a successfully resumed table.
      const attempt = ++generation;
      let audio;
      try {
        suspendedByApp = false; recoveryAttempted = false;
        if (!context || context.state === 'closed') {
          context?.removeEventListener?.('statechange', audioStateChanged);
          clearAudio(); activated = false; context = new AudioContextClass();
          context.addEventListener?.('statechange', audioStateChanged);
        }
        audio = context;
        if (audio.state !== 'running') await audio.resume();
        if (disposed || attempt !== generation || context !== audio || !enabled || !visible() || suspendedByApp) return false;
        unlocked = audio.state === 'running';
        if (unlocked) { activated = true; ignoreRejection(preloadAudio()); }
        return unlocked;
      } catch { if (attempt === generation && (!audio || context === audio)) unlocked = false; return false; }
    },
    play, speak, stopPlayback, preloadAudio, preloadVoices: preloadAudio,
    playFeedback(feedback) {
      // A command response and SSE can reach independent presentation hooks.
      // Consume the event even while muted/loading so enabling audio cannot play
      // an old action. Keep a bounded set, not a playback queue.
      if (feedback?.eventId) {
        if (heardEvents.has(feedback.eventId)) return false;
        heardEvents.add(feedback.eventId);
        if (heardEvents.size > 256) heardEvents.delete(heardEvents.values().next().value);
      }
      let checked = false;
      const checks = Array.isArray(feedback?.checks) ? feedback.checks.slice(-9) : [];
      for (const id of checks) {
        if (typeof id !== 'string' || heardEvents.has(id)) continue;
        heardEvents.add(id);
        if (heardEvents.size > 256) heardEvents.delete(heardEvents.values().next().value);
        checked = knock() || checked;
      }
      if (checks.length && !feedback?.speech) stopVoice();
      const effect = feedback?.sound && !(feedback.sound === 'check' && checks.length) ? play(feedback.sound, { chips: feedback.chips === true, speech: voiceEnabled && buffers.has(feedback.speech) }) : false;
      const spoken = feedback?.speech ? speak(feedback.speech) : false;
      return checked || effect || spoken;
    },
    suspend,
    dispose() {
      disposed = true; generation++; unlocked = false; stop(); stopVoice(); knockNextAt = 0; clearAudio();
      doc?.removeEventListener?.('visibilitychange', visibilityChanged);
      context?.removeEventListener?.('statechange', audioStateChanged);
      try { if (context && context.state !== 'closed') ignoreRejection(context.close()); } catch {}
      context = null; heardEvents.clear();
    },
  };
}
