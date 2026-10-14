// Polling must not replace the control a player is reading, focusing or clicking.
function syncRooms(current, fresh) {
  const keyed = new Map([...current.children].map(node => [node.dataset.lobbyCode, node]));
  let previous = null;
  for (const next of [...fresh.children]) {
    let node = keyed.get(next.dataset.lobbyCode);
    keyed.delete(next.dataset.lobbyCode);
    if (!node) node = next;
    else if (node.outerHTML !== next.outerHTML) { node.replaceWith(next); node = next; }
    const anchor = previous ? previous.nextElementSibling : current.firstElementChild;
    if (node !== anchor) current.insertBefore(node, anchor);
    previous = node;
  }
  for (const node of keyed.values()) node.remove();
}

export function patchLobbyView(app, incoming) {
  const current = app.querySelector('.lobby-shell'), fresh = incoming.querySelector('.lobby-shell');
  if (!current || !fresh || current.dataset.user !== fresh.dataset.user) return false;
  const oldHeader = app.querySelector('.topbar'), newHeader = incoming.querySelector('.topbar');
  // Avatar hydration replaces the generated fallback src with a session-only
  // blob URL. Keep that value for the same image, after the identity check, so
  // it does not look like a profile edit and detach the focused navigation.
  if (oldHeader && newHeader) {
    const hydrated = new Map([...oldHeader.querySelectorAll('img[data-custom-avatar]')]
      .map(image => [image.dataset.customAvatar, image.getAttribute('src')]));
    for (const image of newHeader.querySelectorAll('img[data-custom-avatar]')) {
      const id = image.dataset.customAvatar, src = hydrated.get(id);
      if (/^[a-f0-9]{32}$/.test(id) && typeof src === 'string' && src.startsWith('blob:')) image.setAttribute('src', src);
    }
  }
  if (oldHeader && newHeader && oldHeader.outerHTML !== newHeader.outerHTML) oldHeader.replaceWith(newHeader);
  const oldRegions = new Map([...current.children].map(node => [node.dataset.lobbyRegion, node]));
  let previous = null;
  for (const next of [...fresh.children]) {
    const key = next.dataset.lobbyRegion;
    let node = oldRegions.get(key);
    oldRegions.delete(key);
    if (!node) node = next;
    else if (key === 'past') {
      const summary = node.querySelector('summary'), nextSummary = next.querySelector('summary');
      if (summary.textContent !== nextSummary.textContent) summary.textContent = nextSummary.textContent;
      syncRooms(node.querySelector('.room-list'), next.querySelector('.room-list'));
    } else if (key === 'directory' && node.querySelector('.directory-grid') && next.querySelector('.directory-grid')
      && !node.querySelector('.directory-error') && !next.querySelector('.directory-error')) {
      syncRooms(node.querySelector('.directory-grid'), next.querySelector('.directory-grid'));
    } else if (node.outerHTML !== next.outerHTML) { node.replaceWith(next); node = next; }
    const anchor = previous ? previous.nextElementSibling : current.firstElementChild;
    if (node !== anchor) current.insertBefore(node, anchor);
    previous = node;
  }
  for (const node of oldRegions.values()) node.remove();
  return true;
}
