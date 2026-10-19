import { performance } from 'node:perf_hooks';

// Only fixed phase names and millisecond durations reach the response header.
// This is request-local: no users, cards, amounts, tokens or telemetry storage.
const PHASES = ['clone', 'command', 'persist', 'broadcast', 'state', 'serialize'];
export function createRequestTiming({ now = () => performance.now() } = {}) {
  const startedAt = now(), durations = new Map();
  return {
    measure(phase, work) {
      if (!PHASES.includes(phase)) throw new TypeError('Unknown request timing phase');
      const before = now();
      try { return work(); }
      finally { durations.set(phase, (durations.get(phase) ?? 0) + Math.max(0, now() - before)); }
    },
    header() {
      const ms = value => Math.max(0, Number.isFinite(value) ? value : 0).toFixed(2);
      return [`app;dur=${ms(now() - startedAt)}`, ...PHASES.filter(phase => durations.has(phase)).map(phase => `${phase};dur=${ms(durations.get(phase))}`)].join(', ');
    },
  };
}
