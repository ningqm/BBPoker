import { sameRoomSnapshot } from '../public/room-snapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTableFeedback } from '../public/table-feedback.js';
import { createTableFunTracker } from '../public/table-fun.js';
import { updateHandCategoryMotion } from '../public/hand-category.js';
import { liveReactions, payoutAwards } from '../public/table-scene.js';
import { isOlderRoomSnapshot } from '../public/room-clock.js';
import { syncBetControls } from '../public/table-controls.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const clone = value => structuredClone(value);
const epoch = 1800000000000;
function room() {
  return { code: 'turn-ding-fixture', meId: 'me', revision: 1, status: 'playing', serverTime: epoch,
    settings: { bigBlind: 10 }, chat: [], players: [
      { id: 'me', seat: 0, stack: 2000, cards: ['As', 'Kd'], inHand: true },
      { id: 'other', seat: 1, stack: 2000, cards: [null, null], inHand: true },
    ], hand: { id: 'h1', number: 1, status: 'playing', board: [], actingId: 'other',
      actionSeq: 0, actionReadyAt: epoch, log: [] }, actions: { canAct: false } };
}
function next(previous, change = () => {}) {
  const current = clone(previous); current.revision++; current.serverTime += 100;
  change(current); return current;
}
function acted(previous, actor, type = 'call') {
  return next(previous, current => {
    const hand = current.hand;
    hand.log.push({ seq: hand.log.length + 1, type, playerId: hand.actingId, amount: 10 });
    hand.actionSeq = hand.log.length; hand.actingId = actor;
    hand.actionReadyAt = current.serverTime;
    current.actions.canAct = actor === current.meId;
  });
}

// Run the real capture, normalize and render entrypoint. Painting is a minimal
// test double; audio dispatch is observed rather than generating device audio.
function harness() {
  let time = epoch;
  const sounds = [];
  const state = { clock: { now: () => time, accept: r => { time = r.serverTime; } },
    user: { id: 'me' }, page: 'room', room: null, connected: true, feedbackResync: false,
    sound: true, animations: true, funEffects: [], chatDraft: '', chatUnread: 0, reactions: {},
    statsView: {}, library: {}, sessions: {}, opponents: {}, modal: null, composing: false };
  const doc = { visibilityState: 'visible', activeElement: null,
    body: { classList: { toggle() {} } }, getElementById: () => null };
  const app = { querySelector: () => null, contains: () => false, innerHTML: '' };
  const context = vm.createContext({sameRoomSnapshot, state, document: doc, app, Date,
    createTableFeedback, updateHandCategoryMotion, liveReactions, payoutAwards, isOlderRoomSnapshot, syncBetControls,
    feedback: createTableFeedback(), funTracker: createTableFunTracker(),
    tableSounds: { playFeedback: feedback => sounds.push(feedback) },
    rememberCommitment: () => false, closeModal() { state.modal = null; }, toast() {},
    statsUI: { captureStatsDraft() {}, restoreStatsDraft() {} },
    records: { captureRecordDraft() {}, restoreRecordDraft() {} }, recordFormSelector: () => '',
    header: () => '', roomView: () => '', welcome: () => '', recoveryPage: () => '', errorPage: () => '',
    lobby: () => '', career: () => '', handLibrary: () => '', sessionLibrary: () => '', opponentLibrary: () => '',
    patchRoomView: () => false, patchFocusedChat: () => false, patchFocusedRaise: () => false,
    patchLobby: () => false, $: () => null,
    avatarCache: { hydrate() {} }, layoutTableBubbles() {}, mountPotAwards() {}, mountFunEffects() {}, tick() {},
  });
  vm.runInContext(section('function captureRoomChanges(', 'function stopStream(') +
    section('function flushTableFeedback(', 'function usernameField('), context);
  return { state, doc, sounds, render: () => context.render(),
    receive: r => context.normalizeState(r), dings: () => sounds.filter(feedback => feedback.yourTurnId) };
}

test('real client dispatches the own-turn ding with the previous player action and preserves its chips and speech', () => {
  const c = harness(), initial = room(); c.receive(initial);
  const mine = acted(initial, 'me'); c.receive(mine);
  assert.equal(c.dings().length, 1);
  assert.equal(c.dings()[0].speech, 'call');
  assert.equal(c.dings()[0].sound, 'chip');
  assert.equal(c.dings()[0].chips, true);
  const id = c.dings()[0].yourTurnId;
  for (const update of [clone(mine), next(mine, r => { r.chat = [{ id: 'chat', kind: 'text', playerId: 'other', text: '你好' }]; }),
    next(mine, r => { r.deadline = epoch + 50000; }), next(mine, r => { r.players[0].pendingTopUp = 1000; })]) c.receive(update);
  c.render();
  assert.equal(c.dings().length, 1, 'chat, time cards, top-up and paints cannot repeat the cue');
  const opponent = acted(mine, 'other', 'check'); c.receive(opponent);
  c.receive(acted(opponent, 'me', 'check'));
  assert.equal(c.dings().length, 2);
  assert.notEqual(c.dings()[1].yourTurnId, id);
});

test('fresh-hand first actor sounds only when the authoritative deal-ready snapshot arrives', () => {
  const c = harness(), initial = room(); initial.hand.status = 'complete'; initial.hand.actingId = null; c.receive(initial);
  const dealt = next(initial, r => {
    Object.assign(r.hand, { id: 'h2', number: 2, status: 'playing', actingId: 'me', actionReadyAt: r.serverTime + 1100 });
    r.actions.canAct = false;
  });
  c.receive(dealt); assert.equal(c.dings().length, 0);
  const ready = next(dealt, r => { r.serverTime = r.hand.actionReadyAt; r.actions.canAct = true; });
  c.receive(ready); assert.equal(c.dings().length, 1);
  c.receive(next(ready)); assert.equal(c.dings().length, 1);
});

for (const coalesced of [false, true]) {
  test(`own first flop turn survives ${coalesced ? 'coalesced board and ready' : 'separate board and ready'} delivery`, () => {
    const c = harness(), initial = room(); c.receive(initial);
    const flop = next(initial, r => {
      Object.assign(r.hand, { board: ['2s', '3h', '4d'], actingId: 'me', actionReadyAt: r.serverTime + 600,
        actionSeq: 1, log: [{ seq: 1, type: 'street', street: 'flop' }] });
      r.actions.canAct = false;
    });
    if (!coalesced) { c.receive(flop); assert.equal(c.dings().length, 0); }
    const ready = next(flop, r => { r.serverTime = r.hand.actionReadyAt; r.actions.canAct = true; });
    c.receive(ready); assert.equal(c.dings().length, 1);
    if (coalesced) assert.equal(c.dings()[0].sound, 'board', 'turn notification does not replace the board cue');
  });
}

for (const deferred of [false, true]) {
  test(`a player-stats modal${deferred ? ' with composing input' : ''} does not swallow a new own-turn sound`, () => {
    const c = harness(), initial = room(); c.receive(initial);
    c.state.modal = { kind: 'player-stats' };
    if (deferred) { c.state.composing = true; c.doc.activeElement = { id: 'stats-filter' }; }
    c.receive(acted(initial, 'me'));
    assert.equal(c.dings().length, 1);
    if (deferred) assert.equal(c.state.renderDeferred, true, 'audio is flushed before painting is deferred');
    c.state.composing = false; c.render(); assert.equal(c.dings().length, 1);
  });
}

for (const mode of ['initial', 'reconnected', 'hidden', 'muted']) {
  test(`${mode} delivery is a silent baseline and cannot queue an old ding for a later render`, () => {
    const c = harness(), initial = room(), mine = acted(initial, 'me');
    if (mode !== 'initial') c.receive(initial);
    if (mode === 'reconnected') c.state.feedbackResync = true;
    if (mode === 'hidden') c.doc.visibilityState = 'hidden';
    if (mode === 'muted') c.state.sound = false;
    c.receive(mine);
    c.state.sound = true; c.doc.visibilityState = 'visible'; c.render(); c.receive(next(mine));
    assert.equal(c.dings().length, 0);
    const opponent = acted(next(mine), 'other', 'check'); c.receive(opponent);
    c.receive(acted(opponent, 'me', 'check'));
    assert.equal(c.dings().length, 1, 'a subsequent genuine live turn still rings');
  });
}

test('spectator, opponent turns and all-in runout never produce an own-action notification', () => {
  const c = harness(), initial = room(); initial.meId = 'spectator'; c.state.user.id = 'spectator'; c.receive(initial);
  c.receive(acted(initial, 'other', 'check'));
  const runout = next(initial, r => { r.hand.actingId = null; r.hand.runout = { active: true }; });
  c.receive(runout); assert.equal(c.dings().length, 0);
});
