import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionPerformance } from '../public/action-performance.js';

function fixture({ supported = true, observerThrows = false, frames = true } = {}) {
  let time = 1000, frameId = 0, callback = null, disconnected = 0;
  const scheduled = new Map(), cancelled = [], listeners = new Map();
  const document = { visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); } };
  class Observer {
    static supportedEntryTypes = supported ? ['longtask'] : [];
    constructor(fn) { callback = fn; }
    observe(options) { assert.deepEqual(options, { type: 'longtask', buffered: false }); if (observerThrows) throw Error('unsupported'); }
    disconnect() { disconnected++; }
  }
  const recorder = createActionPerformance({ now: () => time, document, PerformanceObserver: Observer,
    requestAnimationFrame: frames ? fn => { scheduled.set(++frameId, fn); return frameId; } : null,
    cancelAnimationFrame: id => { cancelled.push(id); scheduled.delete(id); } });
  return { recorder, scheduled, cancelled, listeners, get disconnected() { return disconnected; },
    tick(ms) { time += ms; }, get time() { return time; },
    visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; listeners.get('visibilitychange')?.(); },
    tasks(entries) { callback?.({ getEntries: () => entries }); },
    frame() { const [id, fn] = scheduled.entries().next().value ?? []; if (fn) { scheduled.delete(id); fn(); } },
  };
}

test('one action separates local confirmation, request phases, server phases and frame callback', () => {
  const f = fixture(), p = f.recorder, t = p.begin('raise', 994);
  assert.deepEqual(t, {}); assert.ok(Object.isFrozen(t));
  f.tick(3); p.mark(t, 'request');
  f.tick(40); p.mark(t, 'headers'); p.server(t, 'app;dur=12.5, persist;dur=5, command;dur=3');
  f.tick(4); p.mark(t, 'parsed'); p.measure(t, 'parseMs', 4);
  f.tick(2); p.confirm(t, { source: 'http', transitionMs: 150, dealMs: 0 });
  f.tick(9); p.measure(t, 'renderMs', 9); p.measure(t, 'normalizeMs', 2); p.measure(t, 'layoutMs', 1); p.mark(t, 'rendered');
  p.paint(t); p.finish(t, 'ok'); f.tick(16); f.frame();
  const row = p.exportData().actions[0];
  assert.deepEqual(row.stages, { start: 0, request: 3, headers: 43, parsed: 47, confirmed: 49, rendered: 58, frame: 74 });
  assert.deepEqual(row.metrics, { inputDelayMs: 6, parseMs: 4, transitionMs: 150, dealMs: 0, renderMs: 9, normalizeMs: 2, layoutMs: 1 });
  assert.deepEqual(row.serverMetrics, { app: 12.5, persist: 5, command: 3 });
  assert.equal(row.frameWaitMs, 16); assert.equal(row.totalMs, 58);
  assert.equal(p.summary().confirmation.medianMs, 49);
  assert.match(p.exportData().limits.frame, /not an actual paint/);
});

test('SSE wins confirmation; later HTTP fields augment that action without overwriting confirmation', () => {
  const f = fixture(), p = f.recorder, t = p.begin('call');
  f.tick(20); assert.ok(p.confirm(t, { source: 'sse', transitionMs: 200 })); p.paint(t);
  f.tick(16); f.frame();
  f.tick(40); assert.ok(p.mark(t, 'headers')); p.finish(t, 'ok');
  assert.ok(p.server(t, 'app;dur=25, broadcast;dur=10'));
  assert.equal(p.confirm(t, { source: 'http', transitionMs: 900 }), false);
  assert.equal(p.mark(t, 'confirmed'), false);
  const row = p.exportData().actions[0];
  assert.equal(row.source, 'sse'); assert.equal(row.stages.confirmed, 20); assert.equal(row.metrics.transitionMs, 200);
  assert.equal(row.serverMetrics.broadcast, 10);
});

test('HTTP finishing before accepted recovery permits its later confirmation and frame', () => {
  const f = fixture(), p = f.recorder, t = p.begin('check');
  f.tick(15); p.finish(t, 'ok'); f.tick(10);
  assert.ok(p.confirm(t, { source: 'recovery' })); assert.ok(p.paint(t)); f.tick(16); f.frame();
  assert.equal(p.exportData().actions[0].stages.confirmed, 25);
  assert.equal(p.exportData().actions[0].frameWaitMs, 16);
});

test('no secret strings, raw payloads, names, URLs, timestamps or descriptions survive export', () => {
  const f = fixture(), p = f.recorder;
  const t = p.begin('secret-user-name', 1_790_000_000_000);
  assert.equal(p.mark(t, 'https://secret.example/room/token'), false);
  assert.equal(p.measure(t, 'private-cards', 123), false);
  assert.equal(p.measure(t, 'renderMs', 'secret-token'), false);
  assert.equal(p.confirm(t, { source: 'secret-room' }), false);
  assert.equal(p.finish(t, 'secret-error'), false);
  p.server(t, 'username;dur=123;desc="secret", app;dur=10;desc="secret-token", state;dur=2');
  assert.equal(p.server(t, 'app;dur=1,' + 'secret'.repeat(400)), false);
  p.confirm(t, { source: 'http' }); p.finish(t, 'ok');
  const data = p.exportData(), json = JSON.stringify(data);
  assert.equal(data.actions[0].type, 'unknown');
  assert.equal(data.actions[0].metrics.inputDelayMs, undefined);
  assert.deepEqual(data.actions[0].serverMetrics, { app: 10, state: 2 });
  for (const secret of ['secret', 'username', 'private-cards', 'https://', '1790000000000']) assert.ok(!json.includes(secret));
  data.actions[0].metrics.renderMs = 99;
  assert.equal(p.exportData().actions[0].metrics.renderMs, undefined, 'export must be detached from internal records');
});

test('only bounded finite nonnegative duration values enter client and server metrics', () => {
  const f = fixture(), p = f.recorder, t = p.begin('fold');
  for (const n of [NaN, Infinity, -1, 120001, '2', null, {}]) assert.equal(p.measure(t, 'renderMs', n), false);
  assert.equal(p.server(t, 'app;dur=-1, state;dur=Infinity, command;dur=10000000, persist;dur=abc'), false);
  assert.ok(p.measure(t, 'renderMs', 1.234)); assert.ok(p.server(t, 'app;dur=2.1234'));
  assert.equal(p.exportData().actions[0].metrics.renderMs, 1.23); assert.equal(p.exportData().actions[0].serverMetrics.app, 2.12);
  f.tick(120001); assert.equal(p.mark(t, 'headers'), false);
});

test('duplicate projections cannot overwrite the slowest render, normalization and layout samples', () => {
  const f = fixture(), p = f.recorder, t = p.begin('raise');
  for (const metric of ['renderMs', 'normalizeMs', 'layoutMs']) {
    p.measure(t, metric, 25); p.measure(t, metric, 0); assert.equal(p.exportData().actions[0].metrics[metric], 25);
    p.measure(t, metric, 40); assert.equal(p.exportData().actions[0].metrics[metric], 40);
  }
  assert.match(p.exportData().limits.processing, /not additive/);
});

test('ring retains 50 rows and late completions cannot mutate evicted traces', () => {
  const f = fixture(), p = f.recorder, oldest = p.begin('fold');
  for (let i = 0; i < 55; i++) { const t = p.begin('check'); f.tick(2); p.confirm(t, { source: 'http' }); p.finish(t, 'ok'); }
  assert.equal(p.summary().count, 50); assert.equal(p.summary().completedCount, 50);
  assert.equal(p.mark(oldest, 'confirmed'), false); assert.equal(p.server(oldest, 'app;dur=900'), false);
  assert.equal(p.finish(oldest, 'ok'), false); assert.equal(p.paint(oldest), false);
  assert.equal(p.exportData().actions.some(row => row.type === 'fold'), false);
});

test('summary computes medians and nearest-rank p95 without treating missing samples as zeros', () => {
  const f = fixture(), p = f.recorder;
  for (const value of [10, 20, 30, 100]) {
    const t = p.begin('raise'); f.tick(value); p.confirm(t, { source: 'http' });
    p.server(t, `app;dur=${value / 2}`); p.measure(t, 'renderMs', value / 10); p.finish(t, 'ok');
  }
  p.begin('call');
  assert.deepEqual(p.summary().confirmation, { samples: 4, medianMs: 25, p95Ms: 100 });
  assert.deepEqual(p.summary().serverApp, { samples: 4, medianMs: 12.5, p95Ms: 50 });
  assert.equal(p.summary().maxRenderMs, 10); assert.equal(p.summary().pendingCount, 1);
});

test('background marks in-flight samples interrupted and excludes misleading large delays', () => {
  const f = fixture(), p = f.recorder, t = p.begin('call');
  f.tick(20); p.confirm(t, { source: 'sse' }); p.paint(t);
  const lateFrame = [...f.scheduled.values()][0]; f.visible(false); f.tick(60000); f.visible(true); lateFrame();
  assert.equal(p.finish(t, 'ok'), false); assert.equal(p.mark(t, 'parsed'), false); assert.equal(p.server(t, 'app;dur=8'), false);
  assert.equal(p.summary().interruptedCount, 1); assert.equal(p.summary().confirmation.samples, 0);
  assert.equal(p.exportData().actions[0].frameWaitMs, undefined);
  assert.equal(f.scheduled.size, 0);
  f.visible(false); const hidden = p.begin('fold'); f.visible(true);
  assert.equal(p.confirm(hidden, { source: 'http' }), false);
});

test('new action cancels a suspended frame and older asynchronous paint cannot cancel the new frame', () => {
  const f = fixture(), p = f.recorder, a = p.begin('fold'); p.paint(a);
  const oldFrame = [...f.scheduled.values()][0], b = p.begin('check'); p.paint(b);
  assert.equal(f.scheduled.size, 1); assert.equal(p.paint(a), false);
  oldFrame(); assert.equal(f.scheduled.size, 1);
  f.tick(16); f.frame(); assert.equal(p.exportData().actions[0].frameWaitMs, undefined);
  assert.equal(p.exportData().actions[1].frameWaitMs, 16);
  assert.ok(p.mark(a, 'headers'), 'older HTTP still measures its own retained action');
  assert.equal(p.exportData().actions[1].stages.headers, undefined);
});

test('HTTP completion without accepted state is still interrupted by backgrounding', () => {
  const f = fixture(), p = f.recorder, t = p.begin('raise');
  f.tick(30); p.finish(t, 'ok'); f.visible(false); f.tick(1000); f.visible(true);
  assert.equal(p.confirm(t, { source: 'recovery' }), false);
  assert.equal(p.summary().interruptedCount, 1); assert.equal(p.summary().confirmation.samples, 0);
});

test('clear invalidates old promises and callbacks while future records continue normally', () => {
  const f = fixture(), p = f.recorder, old = p.begin('raise'); p.paint(old);
  const lateFrame = [...f.scheduled.values()][0]; p.clear(); lateFrame();
  assert.equal(p.server(old, 'app;dur=9'), false); assert.equal(p.measure(old, 'renderMs', 9), false);
  assert.equal(p.summary().count, 0); assert.equal(f.scheduled.size, 0);
  const fresh = p.begin('check'); p.confirm(fresh, { source: 'http' }); assert.equal(p.summary().confirmation.samples, 1);
});

test('long-task observer keeps only bounded durations and never reads attribution or URL details', () => {
  const f = fixture(), p = f.recorder; p.begin('call');
  const entry = { startTime: f.time, duration: 85,
    get name() { throw Error('name leaked'); }, get attribution() { throw Error('attribution leaked'); } };
  f.tasks([entry]);
  assert.deepEqual(p.summary().longTasks, { supported: true, count: 1, totalMs: 85, maxMs: 85 });
  for (let i = 0; i < 110; i++) { f.tick(1); f.tasks([{ startTime: f.time, duration: 50 }]); }
  assert.equal(p.summary().longTasks.count, 100); assert.equal(p.summary().longTasks.totalMs, 5000);
  assert.equal(JSON.stringify(p.exportData()).includes('startTime'), false);
});

test('long-task samples from background, prior clear or before the retained action window are ignored', () => {
  const f = fixture(), p = f.recorder; p.begin('fold');
  f.tasks([{ startTime: f.time, duration: 80 }]); f.visible(false); f.tick(1000);
  f.tasks([{ startTime: f.time, duration: 90 }]); f.tick(100); f.visible(true);
  f.tasks([{ startTime: f.time - 50, duration: 100 }]);
  assert.equal(p.summary().longTasks.count, 1);
  p.clear(); f.tasks([{ startTime: f.time - 1, duration: 100 }]); assert.equal(p.summary().longTasks.count, 0);
  f.tick(1); p.begin('call'); f.tasks([{ startTime: f.time, duration: 60 }]);
  for (let i = 0; i < 51; i++) { f.tick(1); p.begin('check'); }
  assert.equal(p.summary().longTasks.count, 0);
});

test('missing long-task support is explicit and observation failure disconnects safely', () => {
  const unsupported = fixture({ supported: false }); assert.equal(unsupported.recorder.summary().longTasks.supported, false);
  const failed = fixture({ observerThrows: true }); assert.equal(failed.recorder.summary().longTasks.supported, false); assert.equal(failed.disconnected, 1);
  const frames = fixture({ frames: false }); assert.equal(frames.recorder.paint(frames.recorder.begin('fold')), false);
});

test('error and cancel outcomes are terminal; duplicate finish cannot overwrite their result', () => {
  const f = fixture(), p = f.recorder, t = p.begin('raise'); p.paint(t);
  assert.ok(p.finish(t, 'error')); assert.equal(p.finish(t, 'ok'), false); assert.equal(p.confirm(t, { source: 'sse' }), false);
  assert.equal(p.measure(t, 'renderMs', 12), false); assert.equal(f.scheduled.size, 0);
  const c = p.begin('call'); assert.ok(p.finish(c, 'cancelled')); assert.equal(p.mark(c, 'headers'), false);
});

test('dispose disconnects exactly once, removes listeners, cancels frames and rejects late work', () => {
  const f = fixture(), p = f.recorder, t = p.begin('fold'); p.paint(t);
  const lateFrame = [...f.scheduled.values()][0]; p.dispose(); p.dispose(); lateFrame();
  f.tasks([{ startTime: f.time, duration: 90 }]);
  assert.equal(f.disconnected, 1); assert.equal(f.listeners.size, 0); assert.equal(f.scheduled.size, 0);
  assert.equal(p.begin('call'), null); assert.equal(p.mark(t, 'headers'), false); assert.equal(p.finish(t, 'ok'), false);
  assert.equal(p.summary().longTasks.count, 0); assert.equal(p.exportData().actions[0].frameWaitMs, undefined);
});
