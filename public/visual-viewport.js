// Mobile keyboards often shrink only the visual viewport. Keep overlays in
// that visible region without resizing the table or submitting an action.
const textInputTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export function keyboardViewport({ layoutHeight, height, top = 0, scale = 1, editing = false } = {}) {
  if (!editing || !Number.isFinite(layoutHeight) || !Number.isFinite(height) ||
      !Number.isFinite(top) || !Number.isFinite(scale) || layoutHeight <= 0 || height <= 0 ||
      scale < 0.9 || scale > 1.1 || layoutHeight - height < 120) return null;
  const visibleTop = Math.max(0, Math.min(top, layoutHeight));
  const visibleHeight = Math.min(height, layoutHeight - visibleTop);
  if (visibleHeight < 100) return null;
  return { top: Math.round(visibleTop), height: Math.floor(visibleHeight),
    bottom: Math.max(0, Math.round(layoutHeight - visibleTop - visibleHeight)) };
}

export function isTextEditing(element) {
  if (!element || element.disabled || element.readOnly) return false;
  return element.isContentEditable || element.tagName === 'TEXTAREA' ||
    element.tagName === 'INPUT' && textInputTypes.has(element.type || 'text');
}

export function bindKeyboardViewport({ win = globalThis.window, doc = globalThis.document } = {}) {
  const viewport = win?.visualViewport, root = doc?.documentElement;
  if (!viewport || !root) return () => {};
  const properties = ['--keyboard-viewport-top', '--keyboard-viewport-height', '--keyboard-viewport-bottom'];
  let disposed = false, frame = null, last = null;
  function update() {
    frame = null;
    if (disposed) return;
    const geometry = keyboardViewport({ layoutHeight: win.innerHeight, height: viewport.height,
      top: viewport.offsetTop, scale: viewport.scale,
      editing: doc.visibilityState !== 'hidden' && isTextEditing(doc.activeElement) });
    const next = geometry && `${geometry.top}:${geometry.height}:${geometry.bottom}`;
    if (next === last) return;
    last = next;
    if (!geometry) {
      root.removeAttribute('data-keyboard-open');
      for (const property of properties) root.style.removeProperty(property);
      return;
    }
    root.setAttribute('data-keyboard-open', 'true');
    properties.forEach((property, index) => root.style.setProperty(property,
      `${[geometry.top, geometry.height, geometry.bottom][index]}px`));
  }
  function schedule() {
    if (!disposed && frame === null) frame = win.requestAnimationFrame(update);
  }
  const listeners = [[viewport, 'resize'], [viewport, 'scroll'], [win, 'resize'],
    [win, 'pageshow'], [doc, 'focusin'], [doc, 'focusout'], [doc, 'visibilitychange']];
  for (const [target, event] of listeners) target.addEventListener(event, schedule, { passive: true });
  update();
  return () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    for (const [target, event] of listeners) target.removeEventListener(event, schedule);
    root.removeAttribute('data-keyboard-open');
    for (const property of properties) root.style.removeProperty(property);
  };
}
