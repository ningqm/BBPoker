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
      seq: hand.actionSeq, log: log.map(event => ({
        seq: event.seq, type: event.type, playerId: event.playerId,
        amount: event.amount, to: event.to, street: event.street,
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
  return a && b && ['seq', 'type', 'playerId', 'amount', 'to', 'street'].every(key => a[key] === b[key]);
}

function olderThan(current, previous) {
  if (current?.code !== previous?.code || current?.meId !== previous?.meId) return false;
  if (Number.isFinite(current.revision) && Number.isFinite(previous.revision) && current.revision < previous.revision) return true;
  if (!previous.hand) return false;
  if (!current.hand) return true;
  return current.hand.number < previous.hand.number ||
    (current.hand.id === previous.hand.id && current.hand.seq < previous.hand.seq);
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

const tones = {
  deal: [[660, 360, 0, 0.055, 0.025], [760, 440, 0.065, 0.055, 0.02]],
  board: [[520, 820, 0, 0.075, 0.022]],
  chip: [[1300, 850, 0, 0.045, 0.018], [1700, 1050, 0.04, 0.035, 0.012]],
  fold: [[260, 130, 0, 0.06, 0.015]],
  check: [[480, 340, 0, 0.035, 0.022]],
  yourturn: [[660, 660, 0, 0.075, 0.025], [880, 880, 0.09, 0.075, 0.025]],
  win: [[660, 660, 0, 0.075, 0.025], [880, 880, 0.075, 0.075, 0.022], [1100, 1100, 0.15, 0.09, 0.019]],
};

/** Short, locally synthesized cues. No requests, autoplay attempts or queued sounds. */
export function createTableSounds({ enabled = false,
  AudioContext: AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  document: doc = globalThis.document, now = () => Date.now() } = {}) {
  let context = null, unlocked = false, disposed = false, lastPlayed = -Infinity, generation = 0;
  const active = new Set();
  const visible = () => doc?.visibilityState !== 'hidden';
  const ignoreRejection = promise => { if (promise?.catch) promise.catch(() => {}); };
  function stop() {
    for (const entry of active) {
      try { entry.oscillator.stop(); } catch {}
      try { entry.oscillator.disconnect(); entry.gain.disconnect(); } catch {}
    }
    active.clear();
  }
  function suspend() {
    generation++; unlocked = false; stop();
    try { if (context && context.state !== 'closed') ignoreRejection(context.suspend()); } catch {}
  }
  function visibilityChanged() { if (!visible()) suspend(); }
  doc?.addEventListener?.('visibilitychange', visibilityChanged);
  return {
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) suspend();
    },
    async unlock() {
      if (disposed || !enabled || !visible() || !AudioContextClass) return false;
      const attempt = generation;
      try {
        if (!context || context.state === 'closed') context = new AudioContextClass();
        if (context.state !== 'running') await context.resume();
        unlocked = !disposed && enabled && visible() && attempt === generation && context.state === 'running';
        return unlocked;
      } catch { unlocked = false; return false; }
    },
    play(type) {
      if (disposed || !enabled || !unlocked || !visible() || context?.state !== 'running' || !Object.hasOwn(tones, type)) return false;
      const timestamp = now();
      if (timestamp - lastPlayed < 90) return false;
      stop(); // A newer cue replaces a just-started cue; never stack up a backlog.
      try {
        const start = context.currentTime;
        for (const [from, to, delay, duration, volume] of tones[type]) {
          const oscillator = context.createOscillator(), gain = context.createGain();
          const entry = { oscillator, gain }; active.add(entry);
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(from, start + delay);
          oscillator.frequency.exponentialRampToValueAtTime(to, start + delay + duration);
          gain.gain.setValueAtTime(0.0001, start + delay);
          gain.gain.exponentialRampToValueAtTime(volume, start + delay + 0.006);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + duration);
          oscillator.connect(gain); gain.connect(context.destination);
          oscillator.onended = () => {
            active.delete(entry);
            try { oscillator.disconnect(); gain.disconnect(); } catch {}
          };
          oscillator.start(start + delay); oscillator.stop(start + delay + duration + 0.01);
        }
        lastPlayed = timestamp;
        return true;
      } catch { stop(); return false; }
    },
    suspend,
    dispose() {
      disposed = true; generation++; unlocked = false; stop();
      doc?.removeEventListener?.('visibilitychange', visibilityChanged);
      try { if (context && context.state !== 'closed') ignoreRejection(context.close()); } catch {}
      context = null;
    },
  };
}
