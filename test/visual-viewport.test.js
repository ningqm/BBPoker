import test from 'node:test';
import assert from 'node:assert/strict';
import { keyboardViewport, isTextEditing, bindKeyboardViewport, bindTableViewport } from '../public/visual-viewport.js';

test('an on-screen keyboard uses visible bounds including Safari viewport panning', () => {
  assert.deepEqual(keyboardViewport({ layoutHeight: 844, height: 480, top: 0, editing: true }),
    { top: 0, height: 480, bottom: 364 });
  assert.deepEqual(keyboardViewport({ layoutHeight: 844, height: 460, top: 52, editing: true }),
    { top: 52, height: 460, bottom: 332 });
});

test('normal browser chrome, browser zoom, and an unfocused table never move overlays', () => {
  const base = { layoutHeight: 844, height: 480, editing: true };
  for (const patch of [{ editing: false }, { height: 760 }, { scale: 1.5 }, { height: NaN },
    { top: Infinity }, { layoutHeight: 0 }, { height: -1 }, { top: 820 }]) {
    assert.equal(keyboardViewport({ ...base, ...patch }), null);
  }
  assert.deepEqual(keyboardViewport({ ...base, top: -10 }), { top: 0, height: 480, bottom: 364 });
});

test('only editable text fields imply a keyboard; bet ranges, read-only links and buttons do not', () => {
  for (const element of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT', type: 'number' },
    { tagName: 'INPUT', type: 'password' }, { isContentEditable: true }]) assert.ok(isTextEditing(element));
  for (const element of [null, { tagName: 'INPUT', type: 'range' }, { tagName: 'BUTTON' },
    { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'checkbox' },
    { tagName: 'TEXTAREA', readOnly: true }, { tagName: 'INPUT', type: 'text', disabled: true }]) {
    assert.equal(Boolean(isTextEditing(element)), false);
  }
});

function harness() {
  const values = new Map(), attributes = new Map(), frames = new Map(), timers = new Map(); let nextFrame = 0, nextTimer = 0, time = 0;
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  const win = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844, visualViewport: viewport,
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', activeElement: null,
    documentElement: { setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key), style: {
        setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key),
      } } });
  return { win, doc, viewport, values, attributes, frames, timers,
    advance(ms) { time += ms; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); } },
    flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); } };
}

test('keyboard resize and focus are coalesced, cleared on dismissal and cleaned up on disposal', () => {
  const h = harness(), dispose = bindKeyboardViewport(h);
  assert.equal(h.attributes.size, 0);
  h.doc.activeElement = { tagName: 'INPUT', type: 'text' };
  h.doc.dispatchEvent(new Event('focusin'));
  h.viewport.height = 420; h.viewport.offsetTop = 30;
  h.viewport.dispatchEvent(new Event('resize')); h.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(h.frames.size, 1); h.flush();
  assert.equal(h.attributes.get('data-keyboard-open'), 'true');
  assert.equal(h.values.get('--keyboard-viewport-top'), '30px');
  assert.equal(h.values.get('--keyboard-viewport-height'), '420px');
  assert.equal(h.values.get('--keyboard-viewport-bottom'), '394px');
  h.doc.activeElement = null; h.doc.dispatchEvent(new Event('focusout')); h.flush();
  assert.equal(h.attributes.size, 0); assert.equal(h.values.size, 0);
  h.doc.activeElement = { tagName: 'TEXTAREA' }; h.doc.dispatchEvent(new Event('focusin')); h.flush();
  assert.equal(h.attributes.size, 1);
  h.doc.visibilityState = 'hidden'; h.doc.dispatchEvent(new Event('visibilitychange')); h.flush();
  assert.equal(h.values.size, 0);
  h.viewport.dispatchEvent(new Event('resize')); assert.equal(h.frames.size, 1);
  dispose(); assert.equal(h.frames.size, 0); assert.equal(h.values.size, 0);
  h.viewport.dispatchEvent(new Event('resize')); assert.equal(h.frames.size, 0);
});

test('desktop or old browsers without VisualViewport remain usable', () => {
  assert.doesNotThrow(() => bindKeyboardViewport({ win: {}, doc: {} })());
});

test('table follows the visible browser area as mobile chrome expands and retracts', () => {
  const h = harness(), dispose = bindTableViewport(h), value = () => h.values.get('--table-viewport-height');
  assert.equal(value(), '844px');
  h.viewport.height = 728.8; h.viewport.dispatchEvent(new Event('resize'));
  h.win.dispatchEvent(new Event('resize')); assert.equal(h.frames.size, 1); h.flush();
  assert.equal(value(), '728px');
  h.viewport.height = 844; h.viewport.dispatchEvent(new Event('resize')); h.flush(); assert.equal(value(), '844px');
  h.win.innerHeight = 700; h.win.dispatchEvent(new Event('resize')); h.flush(); assert.equal(value(), '700px');
  dispose();
});

test('common mobile and desktop viewport sizes are measured without assuming a device model', () => {
  for (const [width, height] of [[320, 568], [360, 640], [375, 667], [390, 664], [393, 744], [412, 780], [430, 830], [768, 1024], [1440, 900]]) {
    const h = harness(); Object.assign(h.win, { innerWidth: width, innerHeight: height }); Object.assign(h.viewport, { width, height });
    const dispose = bindTableViewport(h); assert.equal(h.values.get('--table-viewport-height'), `${height}px`); dispose();
  }
});

test('keyboard overlays shrink while the underlying table retains its pre-keyboard height through blur', () => {
  const h = harness(), stopTable = bindTableViewport(h), stopKeyboard = bindKeyboardViewport(h);
  h.doc.activeElement = { tagName: 'INPUT', type: 'text' }; h.doc.dispatchEvent(new Event('focusin'));
  h.viewport.height = 420; h.viewport.offsetTop = 30; h.viewport.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '844px');
  assert.equal(h.values.get('--keyboard-viewport-height'), '420px');
  h.doc.activeElement = null; h.doc.dispatchEvent(new Event('focusout')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '844px', 'blur precedes the keyboard closing animation');
  h.advance(800); h.flush(); assert.equal(h.values.get('--table-viewport-height'), '844px', 'a visibly open keyboard remains excluded');
  h.viewport.height = 744; h.viewport.offsetTop = 0; h.viewport.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '744px');
  stopTable(); stopKeyboard(); assert.equal(h.values.size, 0);
});

test('Android resize-content keyboards cannot shrink both viewport measurements and the table together', () => {
  const h = harness(), dispose = bindTableViewport(h);
  h.doc.activeElement = { tagName: 'INPUT', type: 'number' }; h.doc.dispatchEvent(new Event('focusin')); h.flush();
  h.win.innerHeight = h.viewport.height = 420;
  h.win.dispatchEvent(new Event('resize')); h.viewport.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '844px');
  h.doc.activeElement = null; h.doc.dispatchEvent(new Event('focusout')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '844px');
  h.advance(300); h.win.innerHeight = h.viewport.height = 744; h.viewport.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '744px'); assert.equal(h.timers.size, 0);
  dispose();
});

test('a keyboard opening in many small animation steps retains the focus-time table height', () => {
  for (const shrinkLayout of [false, true]) {
    const h = harness(), dispose = bindTableViewport(h);
    h.doc.activeElement = { tagName: 'INPUT', type: 'number' }; h.doc.dispatchEvent(new Event('focusin')); h.flush();
    for (const height of [800, 760, 700, 650, 600, 550, 500, 420]) {
      h.viewport.height = height; if (shrinkLayout) h.win.innerHeight = height;
      h.viewport.dispatchEvent(new Event('resize')); h.flush();
      if (844 - height > 120) assert.equal(h.values.get('--table-viewport-height'), '844px');
    }
    h.doc.activeElement = null; h.doc.dispatchEvent(new Event('focusout')); h.flush();
    assert.equal(h.values.get('--table-viewport-height'), '844px');
    h.viewport.height = h.win.innerHeight = 744; h.viewport.dispatchEvent(new Event('resize')); h.flush();
    assert.equal(h.values.get('--table-viewport-height'), '744px'); dispose();
  }
});

test('a smaller window that remains after keyboard dismissal does not freeze the former height forever', () => {
  const h = harness(), dispose = bindTableViewport(h);
  h.doc.activeElement = { tagName: 'TEXTAREA' }; h.win.innerHeight = h.viewport.height = 420;
  h.viewport.dispatchEvent(new Event('resize')); h.flush();
  h.doc.activeElement = null; h.doc.dispatchEvent(new Event('focusout')); h.flush();
  h.advance(799); h.flush(); assert.equal(h.values.get('--table-viewport-height'), '844px');
  h.advance(1); h.flush(); assert.equal(h.values.get('--table-viewport-height'), '420px');
  h.win.innerHeight = h.viewport.height = 800; h.win.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '800px'); dispose();
});

test('landscape rotation clears a keyboard hold and continues tracking the new orientation', () => {
  const h = harness(), dispose = bindTableViewport(h);
  h.doc.activeElement = { tagName: 'TEXTAREA' }; h.viewport.height = 420; h.viewport.dispatchEvent(new Event('resize')); h.flush();
  h.doc.activeElement = null;
  Object.assign(h.win, { innerWidth: 844, innerHeight: 390 }); Object.assign(h.viewport, { width: 844, height: 390 });
  h.win.dispatchEvent(new Event('orientationchange')); h.win.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '390px'); assert.equal(h.timers.size, 0);
  h.viewport.height = 340; h.viewport.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '340px'); dispose();
});

test('rotating with a visual-only keyboard uses the new unobscured layout baseline', () => {
  const h = harness(), dispose = bindTableViewport(h);
  h.doc.activeElement = { tagName: 'TEXTAREA' }; h.viewport.height = 420; h.viewport.dispatchEvent(new Event('resize')); h.flush();
  Object.assign(h.win, { innerWidth: 844, innerHeight: 390 }); Object.assign(h.viewport, { width: 844, height: 180 });
  h.win.dispatchEvent(new Event('orientationchange')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '390px');
  h.doc.activeElement = null; h.doc.dispatchEvent(new Event('focusout')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '390px');
  h.viewport.height = 390; h.viewport.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '390px'); dispose();
});

test('pinch zoom does not resize the base table and reset zoom resumes browser-chrome measurement', () => {
  const h = harness(), dispose = bindTableViewport(h);
  for (const scale of [1.5, 2, .7]) {
    h.viewport.scale = scale; h.viewport.height = 420; h.viewport.dispatchEvent(new Event('resize')); h.flush();
    assert.equal(h.values.get('--table-viewport-height'), '844px');
  }
  h.viewport.scale = 1; h.viewport.height = 744; h.viewport.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '744px'); dispose();
});

test('a focused bet range and small browser chrome changes do not create a keyboard hold', () => {
  const h = harness(), dispose = bindTableViewport(h);
  h.doc.activeElement = { tagName: 'INPUT', type: 'text' }; h.viewport.height = 780;
  h.viewport.dispatchEvent(new Event('resize')); h.flush(); assert.equal(h.values.get('--table-viewport-height'), '780px');
  h.doc.activeElement = { tagName: 'INPUT', type: 'range' }; h.viewport.height = 500;
  h.viewport.dispatchEvent(new Event('resize')); h.flush(); assert.equal(h.values.get('--table-viewport-height'), '500px');
  dispose();
});

test('hidden or zero-size snapshots preserve geometry and pageshow restores the visible measurement', () => {
  const h = harness(), dispose = bindTableViewport(h);
  h.doc.visibilityState = 'hidden'; h.viewport.height = 400; h.doc.dispatchEvent(new Event('visibilitychange')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '844px');
  h.doc.visibilityState = 'visible'; h.viewport.height = 0; h.win.dispatchEvent(new Event('pageshow')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '844px');
  h.viewport.height = 720; h.win.dispatchEvent(new Event('pageshow')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '720px'); dispose();
});

test('table viewport falls back to window height without VisualViewport', () => {
  const h = harness(); delete h.win.visualViewport;
  const dispose = bindTableViewport(h); assert.equal(h.values.get('--table-viewport-height'), '844px');
  h.win.innerHeight = 700; h.win.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(h.values.get('--table-viewport-height'), '700px'); dispose();
  assert.doesNotThrow(() => bindTableViewport({ win: null, doc: null })());
});

test('disposing cancels table frames, blur timers, listeners and stale callbacks', () => {
  const h = harness(), dispose = bindTableViewport(h);
  h.doc.activeElement = { tagName: 'TEXTAREA' }; h.win.innerHeight = h.viewport.height = 420;
  h.viewport.dispatchEvent(new Event('resize')); h.flush();
  h.doc.activeElement = null; h.doc.dispatchEvent(new Event('focusout')); h.flush();
  assert.equal(h.timers.size, 1); const lateTimer = [...h.timers.values()][0].fn;
  h.viewport.dispatchEvent(new Event('resize')); const lateFrame = [...h.frames.values()][0];
  dispose(); dispose(); assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0); assert.equal(h.values.size, 0);
  lateTimer(); lateFrame(); h.win.dispatchEvent(new Event('resize')); h.win.dispatchEvent(new Event('orientationchange'));
  h.doc.dispatchEvent(new Event('focusout')); h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(h.frames.size, 0); assert.equal(h.values.size, 0);
});
