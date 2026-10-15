import test from 'node:test';
import assert from 'node:assert/strict';
import { keyboardViewport, isTextEditing, bindKeyboardViewport } from '../public/visual-viewport.js';

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
  const values = new Map(), attributes = new Map(), frames = new Map(); let nextFrame = 0;
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const win = Object.assign(new EventTarget(), { innerHeight: 844, visualViewport: viewport,
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); } });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', activeElement: null,
    documentElement: { setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key), style: {
        setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key),
      } } });
  return { win, doc, viewport, values, attributes, frames,
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
