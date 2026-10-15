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

// Use the actual visible web area when mobile browser chrome changes height.
// A keyboard changes overlays only; retain the pre-keyboard playing surface.
export function bindTableViewport({ win = globalThis.window, doc = globalThis.document } = {}) {
  const root = doc?.documentElement;
  if (!win || !root) return () => {};
  const setTimer = win.setTimeout?.bind(win) ?? globalThis.setTimeout;
  const clearTimer = win.clearTimeout?.bind(win) ?? globalThis.clearTimeout;
  let frame = null, disposed = false, lastHeight = null, lastWidth = null;
  let keyboardHeld = false, orientationChanged = false, blurTimer = null, blurSettled = false;
  let wasEditing = false, focusHeight = null;
  const clearBlur = () => { if (blurTimer !== null) clearTimer(blurTimer); blurTimer = null; blurSettled = false; };
  const writeHeight = height => {
    if (height === lastHeight) return;
    lastHeight = height; root.style.setProperty('--table-viewport-height', `${height}px`);
  };
  const update = () => {
    frame = null;
    if (disposed || doc.visibilityState === 'hidden') return;
    const viewport = win.visualViewport;
    if (viewport && (viewport.scale < .9 || viewport.scale > 1.1)) return;
    const layoutHeight = Number(win.innerHeight), viewportHeight = Number(viewport?.height ?? layoutHeight);
    if (!Number.isFinite(layoutHeight) || !Number.isFinite(viewportHeight) || layoutHeight <= 0 || viewportHeight <= 0) return;
    const height = Math.floor(Math.min(layoutHeight, viewportHeight));
    const measuredWidth = Number(win.innerWidth ?? viewport?.width), width = Number.isFinite(measuredWidth) ? measuredWidth : null;
    const turned = orientationChanged || lastWidth !== null && width !== null && Math.abs(width - lastWidth) > 32;
    orientationChanged = false; lastWidth = width;
    const editing = isTextEditing(doc.activeElement);
    if (turned) { keyboardHeld = false; clearBlur(); focusHeight = editing ? layoutHeight : null; }
    if (editing && !wasEditing && !turned) focusHeight = lastHeight ?? layoutHeight;
    wasEditing = editing;
    // Keyboard animation often arrives as many small (<120px) resize steps.
    // Keep its focus-time baseline instead of following each shrinking frame.
    const baseline = turned ? layoutHeight : editing ? focusHeight ?? lastHeight ?? layoutHeight : lastHeight ?? layoutHeight;
    const visualGap = layoutHeight - height, shrunk = visualGap > 120 || baseline - height > 120;
    if (editing) clearBlur();
    if (editing && shrunk) {
      keyboardHeld = true;
      // Some Android webviews shrink both viewports, so compare against the
      // last unobscured table as well. On rotation a layout viewport that is
      // still above the keyboard provides the new landscape baseline.
      writeHeight(Math.floor(baseline));
      return;
    }
    if (keyboardHeld && shrunk) {
      // focusout commonly arrives before the keyboard's closing animation.
      // Keep the table steady until its visible height comes back. If a browser
      // resizes both viewports and settles at a genuinely smaller window, a
      // bounded blur settle prevents permanently freezing the old geometry.
      if (!editing && blurTimer === null && !blurSettled) blurTimer = setTimer(() => {
        blurTimer = null; blurSettled = true; schedule();
      }, 800);
      if (!blurSettled || visualGap > 120) return;
    }
    if (keyboardHeld && editing) focusHeight = height;
    if (!editing) focusHeight = null;
    keyboardHeld = false; clearBlur(); writeHeight(height);
  };
  const schedule = () => { if (!disposed && frame === null) frame = win.requestAnimationFrame(update); };
  const rotate = () => { orientationChanged = true; schedule(); };
  const listeners = [[win, 'resize'], [win, 'pageshow'], [doc, 'focusin'], [doc, 'focusout'], [doc, 'visibilitychange']];
  if (win.visualViewport) listeners.push([win.visualViewport, 'resize']);
  for (const [target, event] of listeners) target.addEventListener(event, schedule, { passive: true });
  win.addEventListener('orientationchange', rotate, { passive: true });
  update();
  return () => {
    if (disposed) return;
    disposed = true; clearBlur();
    if (frame !== null) win.cancelAnimationFrame(frame);
    for (const [target, event] of listeners) target.removeEventListener(event, schedule);
    win.removeEventListener('orientationchange', rotate);
    root.style.removeProperty('--table-viewport-height');
  };
}
