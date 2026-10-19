// Local, bounded diagnostics. Never pass room snapshots or request payloads to
// this recorder: its allowlists intentionally accept only phases and durations.
const ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin', 'timebank']);
const STAGES = new Set(['start', 'request', 'headers', 'parsed', 'confirmed', 'rendered', 'frame']);
const METRICS = new Set(['inputDelayMs', 'renderMs', 'parseMs', 'normalizeMs', 'layoutMs', 'transitionMs', 'dealMs']);
const MAX_METRICS = new Set(['renderMs', 'normalizeMs', 'layoutMs']);
const SERVER = new Set(['app', 'clone', 'command', 'persist', 'broadcast', 'state', 'serialize']);
const SOURCES = new Set(['http', 'sse', 'recovery']);
const OUTCOMES = new Set(['ok', 'error', 'cancelled', 'interrupted']);
const MAX_ACTIONS = 50, MAX_LONG_TASKS = 100, MAX_DURATION = 120_000;
const round = value => Math.round(value * 100) / 100;
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION;
const clock = () => globalThis.performance?.now?.() ?? Date.now();

function distribution(values) {
  const sorted = values.filter(duration).sort((a, b) => a - b), count = sorted.length;
  return { samples: count, medianMs: count ? round((sorted[Math.floor((count - 1) / 2)] + sorted[Math.ceil((count - 1) / 2)]) / 2) : null,
    p95Ms: count ? sorted[Math.ceil(count * .95) - 1] : null };
}

export function createActionPerformance({ now = clock, requestAnimationFrame: raf = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelAnimationFrame: cancelRaf = globalThis.cancelAnimationFrame?.bind(globalThis), document: doc = globalThis.document,
  PerformanceObserver: Observer = globalThis.PerformanceObserver } = {}) {
  let traces = new WeakMap(), rows = [], longTasks = [], disposed = false, observer = null, pendingFrame = null;
  let epoch = now(), visibleSince = epoch, longTaskSupported = false;
  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const current = trace => trace && typeof trace === 'object' ? traces.get(trace) : undefined;
  const editable = trace => {
    const row = current(trace);
    return !disposed && row?.retained && (!row.outcome || row.outcome === 'ok') ? row : null;
  };
  const elapsed = row => {
    const value = now() - row.started;
    return duration(value) ? round(value) : null;
  };
  function cancelFrame() {
    const frame = pendingFrame;
    pendingFrame = null;
    if (frame && typeof cancelRaf === 'function') { try { cancelRaf(frame.id); } catch {} }
  }
  function mark(trace, stage) {
    const row = editable(trace);
    if (!row || !STAGES.has(stage) || Object.hasOwn(row.stages, stage)) return false;
    const value = elapsed(row);
    if (value === null) return false;
    row.stages[stage] = value;
    return true;
  }
  function measure(trace, name, value) {
    const row = editable(trace);
    if (!row || !METRICS.has(name) || !duration(value)) return false;
    row.metrics[name] = round(MAX_METRICS.has(name) ? Math.max(row.metrics[name] ?? 0, value) : value);
    return true;
  }
  function finish(trace, outcome = 'ok') {
    const row = current(trace);
    if (disposed || !row?.retained || row.outcome || !OUTCOMES.has(outcome)) return false;
    row.outcome = outcome;
    row.totalMs = elapsed(row);
    if (outcome !== 'ok' && pendingFrame?.row === row) cancelFrame();
    return true;
  }
  function visibilityChanged() {
    if (disposed) return;
    if (visible()) { visibleSince = now(); return; }
    cancelFrame();
    for (const row of rows) if (!row.outcome || (row.outcome === 'ok' && !Object.hasOwn(row.stages, 'confirmed'))) {
      row.outcome = 'interrupted'; row.totalMs = elapsed(row);
    }
  }
  doc?.addEventListener?.('visibilitychange', visibilityChanged);
  try {
    if (typeof Observer === 'function' && Observer.supportedEntryTypes?.includes('longtask')) {
      observer = new Observer(list => {
        if (disposed || !visible()) return;
        for (const entry of list.getEntries()) {
          // Do not inspect attribution, names, URLs, frame identifiers or nodes.
          const start = entry.startTime, ms = entry.duration;
          if (!Number.isFinite(start) || start < Math.max(epoch, visibleSince) || !duration(ms) || ms < 50) continue;
          longTasks.push({ start, duration: round(ms) });
          if (longTasks.length > MAX_LONG_TASKS) longTasks.shift();
        }
      });
      observer.observe({ type: 'longtask', buffered: false });
      longTaskSupported = true;
    }
  } catch { observer?.disconnect?.(); observer = null; }

  function summary() {
    const valid = rows.filter(row => row.outcome !== 'interrupted');
    const tasks = longTasks.filter(task => task.start >= (rows[0]?.started ?? epoch));
    return {
      count: rows.length, completedCount: rows.filter(row => row.outcome === 'ok').length,
      interruptedCount: rows.filter(row => row.outcome === 'interrupted').length,
      pendingCount: rows.filter(row => !row.outcome).length,
      confirmation: distribution(valid.map(row => row.stages.confirmed)),
      serverApp: distribution(valid.map(row => row.serverMetrics.app)),
      maxRenderMs: valid.reduce((max, row) => Math.max(max, row.metrics.renderMs ?? 0), 0),
      longTasks: { supported: longTaskSupported, count: tasks.length,
        totalMs: round(tasks.reduce((sum, task) => sum + task.duration, 0)), maxMs: tasks.reduce((max, task) => Math.max(max, task.duration), 0) },
    };
  }

  return {
    begin(type, eventTimeStamp) {
      if (disposed) return null;
      cancelFrame();
      const trace = Object.freeze({}), started = now();
      const row = { started, retained: true, type: ACTIONS.has(type) ? type : 'unknown', stages: { start: 0 }, metrics: {}, serverMetrics: {},
        source: null, outcome: visible() ? null : 'interrupted', totalMs: visible() ? null : 0 };
      // Safari versions may expose event timestamps in epoch time. Only use a
      // plausible same-clock sample; never keep the original timestamp.
      const inputDelay = started - eventTimeStamp;
      if (typeof eventTimeStamp === 'number' && inputDelay >= 0 && inputDelay <= 10_000) row.metrics.inputDelayMs = round(inputDelay);
      traces.set(trace, row); rows.push(row);
      if (rows.length > MAX_ACTIONS) rows.shift().retained = false;
      return trace;
    },
    mark, measure,
    server(trace, header) {
      const row = editable(trace);
      if (!row || typeof header !== 'string' || header.length > 2048) return false;
      let accepted = false;
      for (const part of header.split(',').slice(0, 32)) {
        const name = part.split(';', 1)[0].trim();
        if (!SERVER.has(name)) continue;
        const match = /(?:^|;)\s*dur\s*=\s*(\d+(?:\.\d+)?)\s*(?:;|$)/i.exec(part);
        const value = match ? Number(match[1]) : NaN;
        if (duration(value)) { row.serverMetrics[name] = round(value); accepted = true; }
      }
      return accepted;
    },
    confirm(trace, { source, transitionMs, dealMs } = {}) {
      const row = editable(trace);
      if (!row || !SOURCES.has(source) || Object.hasOwn(row.stages, 'confirmed')) return false;
      if (!mark(trace, 'confirmed')) return false;
      row.source = source;
      measure(trace, 'transitionMs', transitionMs); measure(trace, 'dealMs', dealMs);
      return true;
    },
    paint(trace) {
      const row = editable(trace);
      if (!row || row !== rows.at(-1) || !visible() || typeof raf !== 'function' || Object.hasOwn(row.stages, 'frame')) return false;
      if (pendingFrame?.row === row) return true;
      cancelFrame();
      const frame = { row, started: now(), id: null };
      pendingFrame = frame;
      try { frame.id = raf(() => {
        if (pendingFrame !== frame) return;
        pendingFrame = null;
        if (!editable(trace) || !visible()) return;
        const wait = now() - frame.started;
        if (!duration(wait)) return;
        row.frameWaitMs = round(wait);
        mark(trace, 'frame');
      }); } catch { if (pendingFrame === frame) pendingFrame = null; return false; }
      return true;
    },
    finish, summary,
    exportData() {
      return { version: 1, limits: {
        scope: 'This page session only; memory only; no automatic upload.',
        maxActions: MAX_ACTIONS, maxLongTasks: MAX_LONG_TASKS,
        frame: 'requestAnimationFrame callback delay; not an actual paint or display timestamp.',
        confirmation: 'Time from local input handling to first accepted state; not network latency alone.',
        parsing: 'parseMs is elapsed response-body reading and JSON decoding time; not JSON parsing CPU time alone.',
        processing: 'renderMs, normalizeMs and layoutMs retain the slowest processing pass for this action; nested durations are not additive.',
        longTasks: 'Browser support varies; counts cover only the retained foreground sample window.',
        interrupted: 'Background-interrupted actions are excluded from timing distributions.',
      }, summary: summary(), actions: rows.map(row => ({ type: row.type, source: row.source, outcome: row.outcome, totalMs: row.totalMs,
        stages: { ...row.stages }, metrics: { ...row.metrics }, serverMetrics: { ...row.serverMetrics },
        ...(row.frameWaitMs === undefined ? {} : { frameWaitMs: row.frameWaitMs }) })) };
    },
    clear() {
      cancelFrame();
      for (const row of rows) row.retained = false;
      traces = new WeakMap(); rows = []; longTasks = []; epoch = visibleSince = now();
    },
    dispose() {
      if (disposed) return;
      disposed = true; cancelFrame(); observer?.disconnect?.(); observer = null;
      doc?.removeEventListener?.('visibilitychange', visibilityChanged);
      for (const row of rows) row.retained = false;
      traces = new WeakMap();
    },
  };
}
