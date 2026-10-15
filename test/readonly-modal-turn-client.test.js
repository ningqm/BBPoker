import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing ${start}`);
  return source.slice(first, last);
}
function harness(page = 'room') {
  const state = { page, timeOffset: 0, chatOpen: false, replayRequest: 0, connected: true, feedbackResync: false,
    room: { meId: 'me', settings: {}, hand: { status: 'playing', actingId: 'friend' },
      actions: { canAct: false }, deadline: Date.now() + 20000 } };
  let html = '', notices = [], clocks = [];
  const dialog = { open: false, shows: 0, get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      notices = Array.from(value.matchAll(/<div\b[^>]*\bdata-history-turn\b[^>]*>/g), () => ({ hidden: true }));
      clocks = notices.map(() => ({ textContent: '', classList: { toggle() {} } }));
    }, showModal() { this.open = true; this.shows++; }, close() { this.open = false; } };
  const document = { visibilityState: 'visible', querySelectorAll(selector) {
    return selector === '[data-history-turn]' ? notices : selector === '[data-turn-clock]' ? clocks : [];
  } };
  const context = vm.createContext({ state, dialog, document, Date, profileEditor: null,
    btn: (label, action, cls = '', attrs = '') => `<button class="${cls}" data-action="${action}" ${attrs}>${label}</button>`,
    moneyUnitToggle: () => '', render() {}, actorClock: () => null, syncRebuyPrompt() {},
    turnCountdown: { update: () => ({ sound: null, urgent: false }) }, tableSounds: { play() {} },
    historyRefresh: { stop() {} },
  });
  vm.runInContext([
    section('function historyTurnNotice(){', 'function handLibraryContent('),
    section('function finishComposition(', 'function flushTableFeedback('),
    section('function openModal(', "dialog.addEventListener('cancel'"),
    section('function tick(){', 'setInterval(tick,400);'),
    'globalThis.ui={openModal,closeModal,historyTurnNotice,tick};',
  ].join('\n'), context);
  return { state, dialog, ...context.ui, get notices() { return notices; }, get clocks() { return clocks; } };
}

const readOnlyKinds = ['career', 'session-list', 'session-detail', 'stats-metric', 'equity', 'table-info', 'fairness', 'verify'];

test('table read-only dialogs remind only the current actor and provide an immediate way back without replacing their content', () => {
  for (const kind of readOnlyKinds) {
    const c = harness();
    c.openModal('查看数据', '<section data-reading-content>正在查看的内容</section>', kind);
    assert.equal(c.notices.length, 1, kind);
    assert.match(c.dialog.innerHTML, /data-action="close-modal"[^>]*>返回牌桌/);
    c.tick(); assert.equal(c.notices[0].hidden, true, kind);
    const original = c.dialog.innerHTML, notice = c.notices[0];
    c.state.room.hand.actingId = 'me'; c.state.room.actions.canAct = true; c.tick();
    assert.equal(notice.hidden, false, kind); assert.match(c.clocks[0].textContent, /^(?:19|20)s$/);
    assert.equal(c.dialog.innerHTML, original, 'turn changes do not replace a reading panel or filter inputs');
    c.state.room.hand.actingId = 'friend'; c.state.room.actions.canAct = false; c.tick();
    assert.equal(notice.hidden, true, kind);
    c.state.room.hand.actingId = 'me'; c.state.room.hand.status = 'complete'; c.tick();
    assert.equal(notice.hidden, true, 'a finished hand cannot ask for an action');
    c.closeModal(); assert.equal(c.dialog.open, false); assert.equal(c.state.modal, null);
    assert.equal(c.state.room.hand.actingId, 'me', 'returning to the table must not perform a poker action');
  }
});

test('updating a read-only panel or using a panel with its own turn notice never duplicates the notice', () => {
  const c = harness(), body = c.historyTurnNotice() + '<p>原有内容</p>';
  for (const kind of [...readOnlyKinds, 'hand-library', 'hand-overview', 'replay', 'player-stats']) {
    c.openModal('查看数据', body, kind);
    assert.equal(c.notices.length, 1, kind);
    c.openModal('查看数据', body.replace('原有内容', '更新后的内容'), kind);
    assert.equal(c.notices.length, 1, kind); assert.match(c.dialog.innerHTML, /更新后的内容/);
  }
  assert.equal(c.dialog.shows, 1, 'an already-open dialog is updated without reopening the native modal');
});

test('lobby and standalone records do not receive table-action notices even if an old room snapshot exists', () => {
  for (const page of ['lobby', 'career', 'hands', 'sessions', 'opponents']) {
    const c = harness(page); c.state.room.hand.actingId = 'me';
    for (const kind of readOnlyKinds) {
      c.openModal('查看数据', '<p>大厅数据</p>', kind); c.tick();
      assert.equal(c.notices.length, 0, `${page}/${kind}`);
      assert.doesNotMatch(c.dialog.innerHTML, /返回牌桌/);
    }
  }
});

test('buy-in and other input forms retain their own actions without adding a competing return-to-table button', () => {
  const c = harness(); c.state.room.hand.actingId = 'me'; c.state.room.actions.canAct = true;
  for (const kind of ['buyin', 'settings', 'create', 'profile', 'join-invite', 'custom']) {
    const body = '<form><input name="amountBB" value="200"><button type="submit">确认</button></form>';
    c.openModal('填写信息', body, kind); c.tick();
    assert.equal(c.notices.length, 0, kind); assert.ok(c.dialog.innerHTML.includes(body));
    assert.doesNotMatch(c.dialog.innerHTML, /返回牌桌/);
  }
});

test('an upcoming first actor, expired local gate or disconnected client is not prompted until the server allows the action', () => {
  const c = harness(); c.state.room.hand.actingId = 'me';
  c.openModal('我的数据', '<p>数据内容</p>', 'career');
  c.state.room.hand.actionReadyAt = Date.now() + 1000;
  c.tick(); assert.equal(c.notices[0].hidden, true, 'upcoming action during dealing');
  c.state.room.hand.actionReadyAt = Date.now() - 1000;
  c.tick(); assert.equal(c.notices[0].hidden, true, 'local time passing is not server permission');
  c.state.room.actions.canAct = true; c.tick(); assert.equal(c.notices[0].hidden, false);
  c.state.connected = false; c.tick(); assert.equal(c.notices[0].hidden, true);
  c.state.connected = true; c.state.feedbackResync = true; c.tick(); assert.equal(c.notices[0].hidden, true);
  c.state.feedbackResync = false; c.tick(); assert.equal(c.notices[0].hidden, false);
});
