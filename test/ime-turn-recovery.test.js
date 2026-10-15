import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { syncBetControls } from '../public/table-controls.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}

// Execute the real composition events, render gate, incoming-state application
// and foreground callback. Only DOM painting and the network transport are fake.
function harness() {
  const documentEvents = new Map(), windowEvents = new Map(), network = [];
  const listen = registry => (name, fn) => {
    if (!registry.has(name)) registry.set(name, []);
    registry.get(name).push(fn);
  };
  const doc = { visibilityState: 'visible', activeElement: null,
    addEventListener: listen(documentEvents), querySelector: () => null,
    getElementById: () => null, body: { classList: { toggle() {} } } };
  const app = { innerHTML: '', querySelector: () => null,
    contains: target => Boolean(target?.app && target.isConnected) };
  const context = vm.createContext({createRoomClock,isOlderRoomSnapshot, document: doc, window: { addEventListener: listen(windowEvents) },
    navigator: { onLine: true }, app, syncBetControls,
    statsUI: { defaultStatsFilters: () => ({}), captureStatsDraft() {}, restoreStatsDraft() {} },
    records: { captureRecordDraft() {}, restoreRecordDraft() {} },
    recordFormSelector: () => '', header: () => '',
    patchFocusedChat: () => true, patchFocusedRaise: () => false, patchRoomView: () => false, patchLobby: () => false,
    avatarCache: { hydrate() {} }, layoutTableBubbles() {}, mountPotAwards() {}, mountFunEffects() {}, tick() {},
    captureRoomChanges() {}, rememberCommitment: () => false, toast() {},
    tableSounds: { playFeedback() {}, suspend() {} }, feedback: { reset() {} }, funTracker: { reset() {} },
    abortPendingTableRequests: () => network.push('abort-pending'), connectStream: code => network.push(`stream:${code}`),
    stopReplay() {}, stopLobbyPolling() {}, stopStream() {}, updateConnection() {},
    route() {}, loadLobby() {}, historyRefresh: { stop() {} }, profileEditor: null,
    dialog: { open: false, innerHTML: '', close() { this.open = false; } },
    renderHandLibrary() {}, renderOpponents() {}, renderSessions() {},
    $: () => null, setTimeout, clearTimeout, queueMicrotask,
  });
  for (const name of ['welcome', 'recoveryPage', 'errorPage', 'lobby', 'career', 'handLibrary', 'sessionLibrary', 'opponentLibrary']) context[name] = () => '';
  const cleanup = source.includes('function finishComposition(') ? section('function finishComposition(', 'function flushTableFeedback(') : '';
  vm.runInContext([
    section('const state=', 'const esc='), cleanup,
    section('function flushTableFeedback(', 'function usernameField('),
    section('function normalizeState(', '// A delayed room response'),
    section('function closeModal(', "dialog.addEventListener('cancel'"),
    section("document.addEventListener('compositionstart'", "document.addEventListener('input'"),
    section('function resumeTable(', 'bindNativeLifecycle('),
    'globalThis.client={state,normalizeState,render,closeModal,resumeTable};',
  ].join('\n'), context);
  const client = context.client;
  context.roomView = () => `<button ${client.state.room?.actions?.canAct ? '' : 'disabled'}>操作</button>`;
  Object.assign(client.state, { token: 'synthetic-token', user: { id: 'me' }, page: 'room',
    connected: true, feedbackResync: false, room: room(1, false) });
  client.render();
  const dispatch = (name, target, extra = {}) => (documentEvents.get(name) || []).forEach(fn => fn({ target, ...extra }));
  const input = { id: 'chat-input', app: true, isConnected: true, value: '还在输入', form: null };
  return { ...client, doc, app, network, input, dispatch,
    start() { doc.activeElement = input; dispatch('compositionstart', input); },
    show() { doc.visibilityState = 'visible'; dispatch('visibilitychange', doc); },
    hide() { doc.visibilityState = 'hidden'; dispatch('visibilitychange', doc); },
  };
}

function room(revision, canAct) {
  return { code: '123456', revision, meId: 'me', status: 'playing', settings: { bigBlind: 10 },
    players: [{ id: 'me', seat: 0, inHand: true, stack: 1000 }],
    hand: { id: 'h1', status: 'playing', actionSeq: revision, actingId: canAct ? 'me' : 'opponent' },
    actions: { canAct, canCheck: canAct, canFold: canAct, canRaise: canAct, minRaiseTo: 10, maxRaiseTo: 1000 } };
}

test('a lost compositionend after focus leaves cannot freeze the next authorized betting turn', async () => {
  const c = harness(); c.start();
  c.doc.activeElement = null; c.dispatch('focusout', c.input); await Promise.resolve();
  c.normalizeState(room(2, true));
  assert.equal(c.state.room.actions.canAct, true, 'the server state arrived');
  assert.doesNotMatch(c.app.innerHTML, /disabled/, 'the same incoming state paints controls without a tap');
  assert.equal(c.state.composing, false);
  assert.equal(c.state.chatDraft, '还在输入');
});

test('returning from background clears abandoned IME, synchronizes the room, and never repeats a wager', () => {
  const c = harness(); c.start(); c.hide(); c.doc.activeElement = null; c.show();
  assert.equal(c.state.composing, false);
  assert.deepEqual(c.network, ['abort-pending', 'stream:123456']);
  c.normalizeState(room(2, true));
  assert.doesNotMatch(c.app.innerHTML, /disabled/);
  assert.equal(c.state.chatDraft, '还在输入');
});

test('removing the composing chat input without a blur event cannot leave a global render lock', () => {
  const c = harness(); c.start(); c.input.isConnected = false; c.doc.activeElement = null;
  c.normalizeState(room(2, true));
  assert.equal(c.state.composing, false);
  assert.doesNotMatch(c.app.innerHTML, /disabled/);
  assert.equal(c.state.chatDraft, '还在输入');
});

test('ongoing focused Chinese input survives snapshots and finishes with its draft intact', () => {
  const c = harness(); c.start(); const currentInput = c.doc.activeElement;
  c.normalizeState(room(2, true));
  assert.equal(c.state.composing, true);
  assert.equal(c.doc.activeElement, currentInput);
  assert.equal(c.input.value, '还在输入');
  c.input.value = '中文输入完成'; c.dispatch('compositionend', c.input);
  assert.equal(c.state.composing, false);
  assert.equal(c.state.chatDraft, '中文输入完成');
});

test('closing a dialog clears composition metadata instead of blocking later table rendering', () => {
  const c = harness(); c.start(); c.state.recordComposition = { form: { isConnected: false } };
  c.state.recordRenderDeferred = true; c.closeModal(); c.doc.activeElement = null;
  assert.equal(c.state.composing, false); assert.equal(c.state.recordComposition, null);
  c.normalizeState(room(2, true)); assert.doesNotMatch(c.app.innerHTML, /disabled/);
});

for (const sameRecordForm of [false, true]) {
  test(`a delayed compositionend cannot end a newer input session${sameRecordForm ? ' in the same record form' : ''}`, () => {
    const c = harness();
    if (sameRecordForm) c.input.form = { dataset: { recordKind: 'hands' }, isConnected: true };
    c.start();
    const replacement = { ...c.input, value: '新的草稿' };
    c.doc.activeElement = replacement; c.dispatch('compositionstart', replacement);
    c.dispatch('compositionend', c.input);
    assert.equal(c.state.composing, true); assert.equal(c.state.compositionTarget, replacement);
    if (sameRecordForm) assert.equal(c.state.recordComposition.form, replacement.form);
    c.dispatch('compositionend', replacement); assert.equal(c.state.chatDraft, '新的草稿');
  });
}

test('a network recovery while genuinely typing preserves composition and never clears an outstanding action', () => {
  const c = harness(); c.start(); c.state.busy = true; c.resumeTable();
  assert.equal(c.state.composing, true); assert.equal(c.state.compositionTarget, c.input);
  assert.equal(c.state.busy, true, 'only the action lifecycle can release its pending command');
  assert.equal(c.input.value, '还在输入');
});
