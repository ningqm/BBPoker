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
function snapshot(room) {
  if (!room || typeof room.code !== 'string') return null;
  const hand = room.hand;
  const log = Array.isArray(hand?.log) ? hand.log : [];
  return {
    code: room.code, meId: room.meId, revision: room.revision,
    hand: hand ? {
      id: hand.id, number: hand.number, status: hand.status, actingId: hand.actingId,
      boardLength: Array.isArray(hand.board) ? hand.board.length : 0,
      seq: hand.actionSeq, allInIds: (room.players ?? []).filter(player => player.allIn).map(player => player.id), log: log.map(event => ({
        seq: event.seq, type: event.type, playerId: event.playerId,
        amount: event.amount, to: event.to, street: event.street, isRaise: event.isRaise,
      })),
      winnerIds: [...(hand.result?.mainWinnerIds ?? [])],
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
    if (after.actingId) feedback.animations.push({ type: 'turn', playerId: after.actingId });
    feedback.sound = 'deal';
    return feedback;
  }
  if (!validLog(before) || after.seq <= before.seq ||
      !before.log.every((event, index) => sameEvent(event, after.log[index]))) return feedback;
  const fresh = after.log.slice(before.seq);
  for (const event of fresh) if (playerActions.has(event.type)) {
    feedback.animations.push({ type: 'action', playerId: event.playerId, action: event.type, seq: event.seq });
    feedback.sound = ['raise', 'call', 'allin'].includes(event.type) ? 'chip' : event.type;
    feedback.speech = spokenAction(after, event);
    feedback.chips = feedback.chips || ['raise', 'call', 'allin'].includes(event.type);
  }
  if (after.boardLength > before.boardLength) {
    feedback.animations.push({ type: 'board', from: before.boardLength });
    feedback.sound = 'board';
  }
  if (after.status === 'playing' && after.actingId && after.actingId !== before.actingId) {
    feedback.animations.push({ type: 'turn', playerId: after.actingId });
    if (after.actingId === current.meId) feedback.sound = 'yourturn';
  }
  if (before.status !== 'complete' && after.status === 'complete') {
    feedback.animations.push({ type: 'win', playerIds: after.winnerIds });
    feedback.sound = 'win';
  }
  return feedback;
}

/** One tracker per active table. Always feed snapshots, even while effects are off. */
export function createTableFeedback() {
  let previous = null, mutedBaseline = false;
  return {
    reset() { previous = null; mutedBaseline = false; },
    update(room, { live = true, visible = true, reconnected = false } = {}) {
      const current = snapshot(room);
      if (!current) { previous = null; mutedBaseline = false; return emptyFeedback(); }
      if (olderThan(current, previous)) return emptyFeedback();
      const sameRoom = previous?.code === current.code && previous?.meId === current.meId;
      const suppressed = !live || !visible || reconnected;
      const result = previous && sameRoom && !suppressed && !mutedBaseline
        ? transitions(previous, current) : emptyFeedback();
      previous = current;
      // The first visible state after returning from another app is a baseline,
      // even when the stream delivered one last hidden state before suspension.
      mutedBaseline = !visible;
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
      if (!mine || !Number.isFinite(deadline) || !Number.isFinite(now)) { previous = null; return quiet(null); }
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
  chip: [[2500, 1700, 0, 0.065, 0.035], [3400, 2600, 0.027, 0.05, 0.026], [2850, 1800, 0.061, 0.075, 0.034], [3900, 3100, 0.103, 0.055, 0.018]],
  fold: [[260, 130, 0, 0.06, 0.015]],
  check: [[480, 340, 0, 0.035, 0.022]],
  yourturn: [[660, 660, 0, 0.075, 0.025], [880, 880, 0.09, 0.075, 0.025]],
  win: [[660, 660, 0, 0.075, 0.025], [880, 880, 0.075, 0.075, 0.022], [1100, 1100, 0.15, 0.09, 0.019]],
  countdown: [[820, 820, 0, 0.055, 0.035]],
  'countdown-last': [[1050, 1050, 0, 0.075, 0.045]],
};

export const TABLE_VOICE_CUES = Object.freeze(['bet', 'raise', 'reraise', 'call', 'check', 'fold', 'allin']);

/** Same-origin recorded cues and synthesized effects; never a delayed action queue. */
export function createTableSounds({ enabled = false, voiceEnabled = true,
  AudioContext: AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  document: doc = globalThis.document, now = () => Date.now(), fetch: fetcher = globalThis.fetch } = {}) {
  let context = null, unlocked = false, disposed = false, lastPlayed = -Infinity, generation = 0;
  let voiceSource = null, loadingVoices = null, loadController = null, chipNoise = null;
  const voices = new Map(), active = new Set();
  const visible = () => doc?.visibilityState !== 'hidden';
  const ready = () => !disposed && enabled && unlocked && visible() && context?.state === 'running';
  const ignoreRejection = promise => { if (promise?.catch) promise.catch(() => {}); };
  function stopVoice() {
    if (!voiceSource) return;
    try { voiceSource.node.stop(); } catch {}
    try { voiceSource.node.disconnect(); voiceSource.gain.disconnect(); } catch {}
    voiceSource = null;
  }
  function stop() {
    for (const entry of active) {
      try { entry.node.stop(); } catch {}
      try { entry.node.disconnect(); entry.gain.disconnect(); } catch {}
    }
    active.clear();
  }
  function suspend() {
    generation++; unlocked = false; stop(); stopVoice();
    try { if (context && context.state !== 'closed') ignoreRejection(context.suspend()); } catch {}
  }
  function visibilityChanged() { if (!visible()) suspend(); }
  doc?.addEventListener?.('visibilitychange', visibilityChanged);
  function preloadVoices() {
    if (disposed || !voiceEnabled || !context?.decodeAudioData || typeof fetcher !== 'function') return Promise.resolve(false);
    if (loadingVoices) return loadingVoices;
    const audio = context;
    const controller = new AbortController(); loadController = controller;
    const timer = setTimeout(() => controller.abort(), 5000);
    loadingVoices = Promise.all(TABLE_VOICE_CUES.map(async type => {
      if (voices.has(type)) return true;
      try {
        const response = await fetcher(new URL(`./audio/${type}.wav`, import.meta.url), { credentials: 'omit', signal: controller.signal });
        if (!response.ok) return false;
        const bytes = await response.arrayBuffer();
        if (disposed || context !== audio) return false;
        const buffer = await audio.decodeAudioData(bytes);
        if (disposed || context !== audio || !buffer?.duration || buffer.duration > 2) return false;
        voices.set(type, buffer); return true;
      } catch { return false; }
    })).then(results => results.every(Boolean)).finally(() => {
      clearTimeout(timer); if (loadController === controller) loadController = null;
      loadingVoices = null;
    });
    return loadingVoices;
  }
  function register(node, gain) {
    const entry = { node, gain }; active.add(entry);
    node.connect(gain); gain.connect(context.destination);
    node.onended = () => {
      active.delete(entry);
      try { node.disconnect(); gain.disconnect(); } catch {}
    };
  }
  function cue(type, offset = 0) {
    const start = context.currentTime + offset;
    for (const [from, to, delay, duration, volume] of tones[type]) {
      const oscillator = context.createOscillator(), gain = context.createGain();
      register(oscillator, gain); oscillator.type = type === 'chip' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(from, start + delay);
      oscillator.frequency.exponentialRampToValueAtTime(to, start + delay + duration);
      gain.gain.setValueAtTime(0.0001, start + delay);
      gain.gain.exponentialRampToValueAtTime(volume, start + delay + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + duration);
      oscillator.start(start + delay); oscillator.stop(start + delay + duration + 0.01);
    }
    // Four dry impact transients over the resonances make chips distinct from
    // the turn notification. Pseudorandom presentation noise is unrelated to cards.
    if (type === 'chip' && context.createBuffer && context.createBufferSource) {
      if (!chipNoise) {
        const rate = context.sampleRate || 44100;
        chipNoise = context.createBuffer(1, Math.ceil(rate * 0.025), rate);
        const channel = chipNoise.getChannelData(0); let seed = 739;
        for (let i = 0; i < channel.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; channel[i] = (seed / 2147483648 - 1) * (1 - i / channel.length); }
      }
      for (const delay of [0, 0.027, 0.061, 0.103]) {
        const source = context.createBufferSource(), gain = context.createGain(); source.buffer = chipNoise;
        register(source, gain); gain.gain.setValueAtTime(0.065, start + delay);
        source.start(start + delay); source.stop(start + delay + 0.03);
      }
    }
  }
  function play(type, { chips = false } = {}) {
    if (!ready() || !Object.hasOwn(tones, type)) return false;
    const timestamp = now(); if (timestamp - lastPlayed < 90) return false;
    stop();
    try {
      if (chips && type !== 'chip') cue('chip');
      cue(type, chips && type !== 'chip' ? 0.08 : 0);
      lastPlayed = timestamp; return true;
    } catch { stop(); return false; }
  }
  function speak(type) {
    // Cancel first even when this clip is unavailable, so a previous player's
    // action cannot continue to masquerade as the new player's action.
    stopVoice();
    if (!ready() || !voiceEnabled || !voices.has(type) || !context.createBufferSource) return false;
    try {
      const node = context.createBufferSource(), gain = context.createGain();
      node.buffer = voices.get(type); gain.gain.setValueAtTime(0.7, context.currentTime);
      node.connect(gain); gain.connect(context.destination); const entry = { node, gain }; voiceSource = entry;
      node.onended = () => { if (voiceSource === entry) voiceSource = null; try { node.disconnect(); gain.disconnect(); } catch {} };
      node.start(context.currentTime + 0.025); return true;
    } catch { stopVoice(); return false; }
  }
  return {
    setEnabled(value) { enabled = Boolean(value); if (!enabled) suspend(); },
    setVoiceEnabled(value) {
      voiceEnabled = Boolean(value);
      if (!voiceEnabled) stopVoice(); else if (ready()) ignoreRejection(preloadVoices());
    },
    async unlock() {
      if (disposed || !enabled || !visible() || !AudioContextClass) return false;
      const attempt = generation;
      try {
        if (!context || context.state === 'closed') { context = new AudioContextClass(); voices.clear(); chipNoise = null; }
        if (context.state !== 'running') await context.resume();
        unlocked = !disposed && enabled && visible() && attempt === generation && context.state === 'running';
        if (unlocked) ignoreRejection(preloadVoices());
        return unlocked;
      } catch { unlocked = false; return false; }
    },
    play, speak, preloadVoices,
    playFeedback(feedback) {
      const effect = feedback?.sound ? play(feedback.sound, { chips: feedback.chips === true }) : false;
      const spoken = feedback?.speech ? speak(feedback.speech) : false;
      return effect || spoken;
    },
    suspend,
    dispose() {
      disposed = true; generation++; unlocked = false; stop(); stopVoice(); loadController?.abort();
      doc?.removeEventListener?.('visibilitychange', visibilityChanged);
      try { if (context && context.state !== 'closed') ignoreRejection(context.close()); } catch {}
      context = null; voices.clear(); chipNoise = null;
    },
  };
}
