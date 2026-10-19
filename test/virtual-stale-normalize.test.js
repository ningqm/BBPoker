import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import { createTurnRecovery } from '../public/turn-recovery.js';
import { sameRoomSnapshot } from '../public/room-snapshot.js';
import { syncBetControls, betActionEnabled } from '../public/table-controls.js';

// Exercise the actual normalization and connection-control functions together:
// existing isolated stream fixtures replace normalizeState with a small stub.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const normalization = source.slice(source.indexOf('function captureRoomChanges('), source.indexOf('// A delayed room response'));
const connectionControls = source.slice(source.indexOf('function updateConnection(){'), source.indexOf('\n', source.indexOf('function updateConnection(){')));

function fixture({ start = 1000 } = {}) {
  let time = start, monotonic = 0;
  const snapshot = (revision, serverTime, extra = {}) => ({
    code: '123456', meId: 'viewer', revision, serverTime, status: 'playing', deadline: serverTime + 20000,
    settings: { bigBlind: 10 },
    players: [{ id: 'viewer', name: 'Local test player', stack: 1000, seat: 0, inHand: true }],
    hand: { id: 'local-hand', status: 'playing', board: [], actionSeq: revision, actingId: 'viewer', actionReadyAt: 1000 },
    actions: { canAct: true, turnAvailable: true, canCheck: true, canFold: true },
    chat: [], ...extra,
  });
  const initial = snapshot(1, time);
  const state = {
    page: 'room', token: 'local-session', user: { id: 'viewer' }, room: initial, connected: true, feedbackResync: true,
    clock: createRoomClock({ monotonicNow: () => monotonic, wallNow: () => time }),
    stream: { diagnostic: { freshSequence: 0 } },
    busy: false, animations: false, funEffects: [], modeEffects: [], handCategoryMotion: [],
    raise: 0, raisePreset: null, raisePanelOpen: false, raiseTurnKey: null,
  };
  state.clock.accept(initial);
  const calls = [], reconnects = []; let context;
  state.turnRecovery = createTurnRecovery({
    getContext: () => ({ room: state.room, page: state.page, identity: state.token, visible: true, online: true,
      connected: state.connected, resync: state.feedbackResync, staleSnapshot: state.snapshotStale,
      foregroundPending: Boolean(state.foregroundSync), busy: state.busy, now: state.clock.now() }), clock: () => time,
    monotonicClock: () => monotonic,
    fetchRoom: (code, signal) => new Promise((resolve, reject) => {
      calls.push({ method: 'GET', code, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    apply(room, options) { context.normalizeState(room, options); context.updateConnection(); },
    reconnect: (code, reason) => reconnects.push({ code, reason }),
  });
  const button = { dataset: { action: 'check' }, disabled: true };
  context = vm.createContext({
    state, isOlderRoomSnapshot, sameRoomSnapshot, syncBetControls, betActionEnabled,
    Date: class extends Date { static now() { return time; } },
    document: { visibilityState: 'visible', querySelectorAll: selector => selector === '[data-game-action]' ? [button] : [] },
    funTracker: { update: () => ({ effects: [] }) }, feedback: { update: () => ({ animations: [] }) },
    updateHandCategoryMotion: () => [], liveReactions: () => [], rememberCommitment: () => false,
    render() {}, syncInteractionPanel() {}, setRaisePanel() {},
  });
  vm.runInContext(normalization + '\n' + connectionControls, context);
  return {
    state, button, calls, reconnects, snapshot,
    at(value) { monotonic += value - time; time = value; },
    advance(delta) { monotonic += delta; time += delta; },
    jumpWall(value) { time = value; },
    apply(revision, serverTime, extra, options = {}) {
      context.normalizeState(snapshot(revision, serverTime, extra), { source: 'sse', ...options });
      context.updateConnection();
    },
  };
}

test('a newer but six-second buffered snapshot must not reopen betting during foreground synchronization', () => {
  const f = fixture();
  f.at(10000); f.apply(2, 4000);
  assert.equal(f.state.room.revision, 2, 'the business revision can still update the displayed table');
  assert.equal(f.state.stream.diagnostic.freshSequence, 0, 'the actual freshness checker rejects the old frame');
  assert.equal(f.button.disabled, true, 'an old canAct projection must not enable the check button');
  assert.equal(f.state.snapshotStale, true);
  assert.equal(f.state.clock.now(), 10000, 'late server time must not rewind the countdown');
});

test('a current authoritative snapshot reopens controls after synchronization', () => {
  const f = fixture();
  f.at(10000); f.apply(2, 10000);
  assert.equal(f.state.stream.diagnostic.freshSequence, 1);
  assert.equal(f.state.feedbackResync, false);
  assert.equal(f.button.disabled, false);
});

test('stale-gated controls automatically fetch one full snapshot and unlock without touching the page', async () => {
  const f = fixture(); f.at(10000); f.apply(2, 4000);
  const pending = f.state.turnRecovery.check();
  assert.equal(f.calls.length, 1);
  f.at(10400); assert.equal(await f.state.turnRecovery.check(), false);
  assert.equal(f.calls.length, 1, 'one recovery request is in flight');
  f.calls[0].resolve(f.snapshot(3, 10400)); await pending;
  assert.equal(f.button.disabled, false); assert.equal(f.state.snapshotStale, false);
  assert.equal(f.state.feedbackResync, false); assert.equal(f.state.connection, '实时连接');
  assert.equal(f.state.clock.now(), 10400); assert.deepEqual(f.reconnects, []);
  assert.ok(f.calls.every(call => call.method === 'GET'), 'recovery never replays a poker action');
});

test('another buffered HTTP snapshot stays gated and retries at a bounded pace without reconnecting SSE', async () => {
  const f = fixture(); f.at(10000); f.apply(2, 4000);
  let pending = f.state.turnRecovery.check();
  f.calls[0].resolve(f.snapshot(3, 5000)); await pending;
  assert.equal(f.button.disabled, true); assert.deepEqual(f.reconnects, []);
  f.at(11000); assert.equal(await f.state.turnRecovery.check(), false);
  f.at(12500); pending = f.state.turnRecovery.check(); assert.equal(f.calls.length, 2);
  f.calls[1].resolve(f.snapshot(4, 12500)); await pending;
  assert.equal(f.button.disabled, false); assert.deepEqual(f.reconnects, []);
});

test('fresh SSE supersedes a failed stale-snapshot recovery request', async () => {
  const f = fixture(); f.at(10000); f.apply(2, 4000);
  const pending = f.state.turnRecovery.check();
  f.at(10500); f.apply(3, 10500);
  f.calls[0].reject(new Error('late HTTP failure')); await pending;
  assert.equal(f.button.disabled, false); assert.deepEqual(f.reconnects, []);
});

test('one failed stale recovery leaves the stream intact; two failures reconnect once', async () => {
  const f = fixture(); f.at(10000); f.apply(2, 4000);
  let pending = f.state.turnRecovery.check(); f.calls[0].reject(new Error('first')); await pending;
  assert.deepEqual(f.reconnects, []); assert.equal(f.button.disabled, true);
  f.at(12500); pending = f.state.turnRecovery.check(); f.calls[1].reject(new Error('second')); await pending;
  assert.deepEqual(f.reconnects, [{ code: '123456', reason: 'stalled_refresh_failed' }]);
  assert.equal(f.calls.length, 2);
});

test('an existing foreground GET owns synchronization instead of launching a competing recovery GET', async () => {
  const f = fixture(); f.at(10000); f.apply(2, 4000); f.state.foregroundSync = {};
  assert.equal(await f.state.turnRecovery.check(), false); assert.equal(f.calls.length, 0);
});

test('an old receipt can confirm the saved wager without reopening another action from stale permissions', () => {
  const f = fixture();
  const command = { id: 'local-command', code: '123456', userId: 'viewer', fast: true, guard: { valid: () => true } };
  f.state.pendingCommand = command; f.state.busy = true;
  f.at(10000); f.apply(2, 4000, { acceptedCommandIds: ['local-command'] });
  assert.equal(command.acknowledged, true); assert.equal(f.state.pendingCommand, null); assert.equal(f.state.busy, false);
  assert.equal(f.button.disabled, true, 'a confirmed past wager is not permission for a new one');
  f.at(10500); f.apply(3, 10500); assert.equal(f.button.disabled, false);
});

test('an older revision arriving after a fresh snapshot cannot re-lock current controls', () => {
  const f = fixture(); f.at(10000); f.apply(3, 10000); f.apply(2, 4000);
  assert.equal(f.state.room.revision, 3); assert.equal(f.state.snapshotStale, false); assert.equal(f.button.disabled, false);
});

for (const changedRevision of [false, true]) test(`two advancing fast GETs recover a ten-second server clock rollback at ${changedRevision ? 'higher' : 'equal'} revision`, async () => {
  const start = 1000000, f = fixture({ start }), revision = changedRevision ? 2 : 1;
  f.at(start + 100);
  f.apply(revision, start - 9900, {}, { httpRequest: { durationMs: 100, revision: 1 } });
  assert.equal(f.button.disabled, true, 'one fast response cannot recalibrate the transport clock');
  assert.equal(f.state.turnRecovery.needsFullSnapshot(), true);
  if (!changedRevision) assert.equal(f.state.room.serverTime, start, 'an unverified equal-revision clock step remains rejected');
  f.at(start + 2700); const pending = f.state.turnRecovery.check();
  assert.equal(f.calls.length, 1, 'calibration has a recovery path even while resync gates controls');
  f.at(start + 2800); f.calls[0].resolve(f.snapshot(revision, start - 7200)); await pending;
  assert.equal(f.state.room.serverTime, start - 7200);
  assert.equal(f.button.disabled, false); assert.equal(f.state.feedbackResync, false);
  assert.equal(f.state.clock.now(), start + 2800, 'display time does not rewind with server transport time');
  assert.deepEqual(f.reconnects, []);
  // Display time will pass this server deadline ten seconds earlier. Recovery
  // uses calibrated transport time and must not falsely poll an expired turn.
  for (let i = 0; i < 33; i++) { f.advance(400); assert.equal(await f.state.turnRecovery.check(), false); }
  assert.equal(f.calls.length, 1);
  f.apply(revision + 1, start + 6000);
  assert.equal(f.state.snapshotStale, false); assert.equal(f.button.disabled, false);
});

for (const invalid of ['slow-body', 'unchanged-cache', 'old-revision', 'oversized-clock-step']) test(`clock calibration rejects ${invalid} HTTP evidence`, () => {
  const start = 1000000, f = fixture({ start }), correction = invalid === 'oversized-clock-step' ? 70000 : 10000;
  if (invalid === 'old-revision') f.apply(3, start);
  const revision = invalid === 'old-revision' ? 2 : 1;
  f.at(start + 100);
  f.apply(revision, start + 100 - correction, {}, { httpRequest: { durationMs: invalid === 'slow-body' ? 1600 : 100, revision: f.state.room.revision } });
  f.at(start + 2800);
  f.apply(revision, start + (invalid === 'unchanged-cache' ? 100 : 2800) - correction, {}, { httpRequest: { durationMs: 100, revision: f.state.room.revision } });
  if (invalid === 'old-revision') {
    assert.equal(f.state.room.revision, 3); assert.equal(f.state.room.serverTime, start);
  } else {
    assert.equal(f.button.disabled, true); assert.equal(f.state.room.serverTime, start);
  }
  assert.equal(f.state.clock.now(), start + 2800);
});

test('calibration progression follows a monotonic clock even if the device wall clock changes', () => {
  const start = 1000000, f = fixture({ start });
  f.at(start + 100);
  f.apply(1, start - 9900, {}, { httpRequest: { durationMs: 100, revision: 1 } });
  f.advance(2700); f.jumpWall(start - 3600000);
  f.apply(1, start - 7200, {}, { httpRequest: { durationMs: 100, revision: 1 } });
  assert.equal(f.button.disabled, false); assert.equal(f.state.room.serverTime, start - 7200);
  assert.equal(f.state.clock.now(), start + 2800);
});

test('a fresh SSE cancels contradictory clock-correction evidence before a second old GET arrives', () => {
  const start = 1000000, f = fixture({ start });
  f.at(start + 100);
  f.apply(1, start - 9900, {}, { httpRequest: { durationMs: 100, revision: 1 } });
  assert.equal(f.state.turnRecovery.needsFullSnapshot(), true);
  f.at(start + 1500); f.apply(1, start + 1500);
  assert.equal(f.state.turnRecovery.needsFullSnapshot(), false); assert.equal(f.button.disabled, false);
  f.at(start + 2800);
  f.apply(1, start - 7200, {}, { httpRequest: { durationMs: 100, revision: 1 } });
  assert.equal(f.state.room.serverTime, start + 1500, 'the stale equal-revision response must not replace proven current state');
  assert.equal(f.button.disabled, false);
});
