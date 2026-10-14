import test from 'node:test';
import assert from 'node:assert/strict';
import { patchLobbyView } from '../public/lobby-view.js';

// Small DOM double: assertions track node identity, ordering and attachment,
// not just generated markup. Browser acceptance exercises the real DOM too.
class Element {
  constructor(tag, { className = '', dataset = {}, attributes = {}, text = '', children = [] } = {}) {
    this.tagName = tag; this.className = className; this.dataset = dataset; this.text = text;
    this.parentElement = null; this.children = []; this.open = false; this.attributes = attributes;
    for (const child of children) this.insertBefore(child, null);
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = value; for (const child of [...this.children]) child.remove(); }
  get outerHTML() { return JSON.stringify([this.tagName, this.className, this.dataset, this.attributes, this.open, this.text, this.children.map(child => child.outerHTML)]); }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() { const rows = this.parentElement?.children || []; return rows[rows.indexOf(this) + 1] || null; }
  remove() { if (!this.parentElement) return; const rows = this.parentElement.children; rows.splice(rows.indexOf(this), 1); this.parentElement = null; }
  insertBefore(node, anchor) { node.remove(); const index = anchor ? this.children.indexOf(anchor) : this.children.length; assert.ok(index >= 0); this.children.splice(index, 0, node); node.parentElement = this; }
  replaceWith(node) { const parent = this.parentElement, anchor = this.nextElementSibling; this.remove(); parent.insertBefore(node, anchor); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll(selector) { const result = []; for (const child of this.children) { if (selector === 'img[data-custom-avatar]' && child.tagName === 'img' && child.dataset.customAvatar) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  querySelector(selector) { for (const child of this.children) { if (selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) return child; const descendant = child.querySelector(selector); if (descendant) return descendant; } return null; }
}
const node = (tag, options) => new Element(tag, options);
const room = (code, text = code) => node('button', { dataset: { lobbyCode: code }, text });
function page({ user = 'me', past = ['p1', 'p2'], active = ['r1', 'r2'], changed = '', filter = 'all', error = '' } = {}) {
  const archive = past.length ? node('details', { className: 'past-rooms', dataset: { lobbyRegion: 'past' }, children: [node('summary', { text: `已结束 · ${past.length}` }), node('div', { className: 'room-list', children: past.map(code => room(code)) })] }) : null;
  const directory = node('div', { dataset: { lobbyRegion: 'directory' }, children: [error ? node('p', { className: 'directory-error', text: error }) : null, node('div', { className: 'directory-grid', children: active.map(code => room(code, code === changed ? 'updated' : code)) })].filter(Boolean) });
  return node('div', { children: [node('header', { className: 'topbar', text: user }), node('main', { className: 'lobby-shell', dataset: { user }, children: [node('div', { dataset: { lobbyRegion: 'heading' }, text: '大厅' }), node('div', { dataset: { lobbyRegion: 'filters' }, text: filter }), directory, archive, node('footer', { dataset: { lobbyRegion: 'footer' }, text: '规则' })].filter(Boolean) })] });
}

test('silent lobby refresh preserves expanded history, focused buttons and unchanged filters', () => {
  const app = page(), archive = app.querySelector('.past-rooms'), summary = archive.querySelector('summary');
  const first = archive.querySelector('.room-list').firstElementChild, live = app.querySelector('.directory-grid').firstElementChild;
  const filters = app.querySelector('.lobby-shell').children[1]; archive.open = true;
  for (let n = 0; n < 3; n++) assert.equal(patchLobbyView(app, page()), true);
  assert.equal(app.querySelector('.past-rooms'), archive); assert.equal(archive.open, true);
  assert.equal(archive.querySelector('summary'), summary); assert.equal(archive.querySelector('.room-list').firstElementChild, first);
  assert.equal(app.querySelector('.directory-grid').firstElementChild, live); assert.equal(app.querySelector('.lobby-shell').children[1], filters);
});

test('active table changes replace only the changed card and do not collapse past rooms', () => {
  const app = page(), archive = app.querySelector('.past-rooms'), cards = [...app.querySelector('.directory-grid').children]; archive.open = true;
  patchLobbyView(app, page({ changed: 'r2', filter: 'mine' }));
  assert.equal(app.querySelector('.directory-grid').children[0], cards[0]);
  assert.notEqual(app.querySelector('.directory-grid').children[1], cards[1]);
  assert.equal(app.querySelector('.directory-grid').children[1].textContent, 'updated');
  assert.equal(app.querySelector('.past-rooms'), archive); assert.equal(archive.open, true);
  assert.equal(app.querySelector('.lobby-shell').children[1].textContent, 'mine');
});

test('adding, removing and reordering rooms preserves surviving button identities and history disclosure', () => {
  const app = page(), archive = app.querySelector('.past-rooms'), first = archive.querySelector('.room-list').firstElementChild;
  const liveSecond = app.querySelector('.directory-grid').children[1]; archive.open = true;
  patchLobbyView(app, page({ past: ['p3', 'p1', 'p4'], active: ['r3', 'r2'] }));
  assert.equal(archive.open, true); assert.equal(archive.querySelector('summary').textContent, '已结束 · 3');
  assert.deepEqual(archive.querySelector('.room-list').children.map(child => child.dataset.lobbyCode), ['p3', 'p1', 'p4']);
  assert.equal(archive.querySelector('.room-list').children[1], first);
  assert.deepEqual(app.querySelector('.directory-grid').children.map(child => child.dataset.lobbyCode), ['r3', 'r2']);
  assert.equal(app.querySelector('.directory-grid').children[1], liveSecond);
});

test('identity changes reject incremental patching and cannot retain another account history', () => {
  const app = page(), html = app.outerHTML;
  assert.equal(patchLobbyView(app, page({ user: 'other' })), false); assert.equal(app.outerHTML, html);
  assert.equal(patchLobbyView(node('div'), page()), false);
});

test('history can appear or disappear without duplicating footer, while refresh errors recover', () => {
  const app = page({ past: [] });
  patchLobbyView(app, page({ error: '暂时离线' }));
  assert.ok(app.querySelector('.past-rooms')); assert.equal(app.querySelector('.directory-error').textContent, '暂时离线');
  patchLobbyView(app, page({ past: [] }));
  assert.equal(app.querySelector('.past-rooms'), null); assert.equal(app.querySelector('.directory-error'), null);
  assert.equal(app.querySelector('.lobby-shell').children.filter(child => child.tagName === 'footer').length, 1);
});

const avatarPage = ({ id = 'a'.repeat(32), src = '/avatars/ai-01.png', ...options } = {}) => {
  const app = page(options), header = app.querySelector('.topbar');
  header.insertBefore(node('button', { className: 'profile-btn', children: [node('img', { dataset: id ? { customAvatar: id } : {}, attributes: { src } })] }), null);
  return app;
};

test('a hydrated custom avatar never detaches the identical focused profile or navigation on refresh', () => {
  const app = avatarPage({ src: 'blob:https://bbpoker.fun/current-avatar' });
  const header = app.querySelector('.topbar'), profile = app.querySelector('.profile-btn'), image = profile.querySelector('img');
  for (let i = 0; i < 3; i++) assert.equal(patchLobbyView(app, avatarPage()), true);
  assert.equal(app.querySelector('.topbar'), header); assert.equal(app.querySelector('.profile-btn'), profile);
  assert.equal(profile.querySelector('img'), image); assert.equal(image.getAttribute('src'), 'blob:https://bbpoker.fun/current-avatar');
});

test('changing or removing a custom avatar never reuses the previous blob, and fallback changes still apply', () => {
  for (const options of [{ id: 'b'.repeat(32) }, { id: null, src: '/avatars/ai-04.png' }]) {
    const app = avatarPage({ src: 'blob:previous-avatar' }), header = app.querySelector('.topbar');
    assert.equal(patchLobbyView(app, avatarPage(options)), true); assert.notEqual(app.querySelector('.topbar'), header);
    assert.equal(app.querySelector('.profile-btn').querySelector('img').getAttribute('src'), options.src || '/avatars/ai-01.png');
  }
  const app = avatarPage({ src: '/avatars/ai-01.png' });
  patchLobbyView(app, avatarPage({ src: '/avatars/ai-02.png' }));
  assert.equal(app.querySelector('.profile-btn').querySelector('img').getAttribute('src'), '/avatars/ai-02.png');
});

test('a custom avatar blob cannot cross identities even when the image identifier is identical', () => {
  const app = avatarPage({ user: 'old-user', src: 'blob:old-session' }), incoming = avatarPage({ user: 'new-user' });
  assert.equal(patchLobbyView(app, incoming), false);
  assert.equal(incoming.querySelector('.profile-btn').querySelector('img').getAttribute('src'), '/avatars/ai-01.png');
});
