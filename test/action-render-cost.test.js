import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequestGuard } from '../public/platform.js';
import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import { syncBetControls } from '../public/table-controls.js';
import { sameRoomSnapshot } from '../public/room-snapshot.js';

// Run the real command and snapshot entry points. This counts paint requests,
// not milliseconds: it is deterministic and makes no claim about phone speed.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function normalizeState('), source.indexOf('function stopStream('));
const clone = value => structuredClone(value);
const snapshot = (revision = 1, ids = []) => ({
  code: '123456', meId: 'me', revision, serverTime: 1800000000000 + revision,
  acceptedCommandIds: ids, settings: { bigBlind: 10 }, deadline: 1800000020000,
  hand: { id: 'h1', status: 'playing', actionSeq: revision, actingId: 'me', actionReadyAt: 1800000000000 },
  players: [{ id: 'me', name: 'QA', stack: 1000, connected: true }],
  actions: { canAct: true, turnAvailable: true, canCheck: true },
});

function harness() {
  const state = { clock: createRoomClock(), user: { id: 'me' }, room: snapshot(), busy: false,
    modal: null, page: 'room', connected: true, feedbackResync: false };
  const requests = createRequestGuard(), calls = [], renders = [], observed = [];
  let serial = 0;
  state.turnRecovery = { observed: room => observed.push(room.serverTime) };
  const context = vm.createContext({ state, requests, syncBetControls, isOlderRoomSnapshot, sameRoomSnapshot,
    document: { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [] },
    navigator: { onLine: true }, commandId: () => `synthetic-${++serial}`,
    captureRoomChanges() { state.feedbackResync = false; }, rememberCommitment: () => false,
    render() { renders.push({ revision: state.room.revision, busy: state.busy }); },
    toast() {}, closeModal() {}, connectStream() {},
    api: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
  });
  vm.runInContext(code, context);
  return { state, calls, renders, observed, command: context.command, apply: context.normalizeState };
}

test('one action acknowledged by SSE and repeated by HTTP only paints once', async () => {
  const h = harness(), job = h.command('call'), accepted = snapshot(2, ['synthetic-1']);
  h.apply(accepted);
  assert.equal(h.state.busy, false);
  h.calls[0].resolve({ room: clone(accepted) });
  assert.equal(await job, true);
  assert.equal(h.renders.length, 1, 'the same acceptance must not repaint the entire table');
});

test('an old HTTP response after a newer accepted SSE frame does not repaint that newer frame', async () => {
  const h = harness(), job = h.command('call');
  h.apply(snapshot(3, ['synthetic-1']));
  h.calls[0].resolve({ room: snapshot(2, ['synthetic-1']) });
  assert.equal(await job, true);
  assert.equal(h.state.room.revision, 3);
  assert.equal(h.renders.length, 1, 'already cleared busy state needs no stale-response cleanup paint');
});

test('the same projection with only a later server timestamp updates freshness without a second paint', () => {
  const h = harness(), first = snapshot(2);
  h.apply(first);
  const next = clone(first); next.serverTime += 1000;
  h.apply(next);
  assert.equal(h.observed.at(-1), next.serverTime);
  assert.equal(h.state.room.serverTime, next.serverTime);
  assert.equal(h.renders.length, 1);
});

for (const [label, change] of [
  ['readiness', room => { room.actions.canAct = false; }],
  ['deadline', room => { room.deadline += 30000; }],
  ['delivery grace', room => { room.hand.deliveryGrace = { acknowledged: true, seconds: 4 }; }],
  ['connection', room => { room.players[0].connected = false; }],
  ['buy-in', room => { room.players[0].pendingBuyIn = 1000; }],
  ['entry choice', room => { room.players[0].entryBlind = { required: true, mode: 'wait' }; }],
  ['new chat', room => { room.chat = [{ id: 'synthetic-chat', playerId: 'me', kind: 'text', text: 'test' }]; }],
]) test(`same revision still paints a changed ${label}`, () => {
  const h = harness(), first = snapshot(2);
  h.apply(first);
  const next = clone(first); next.serverTime++; change(next);
  h.apply(next);
  assert.equal(h.renders.length, 2, 'revision alone is not a safe presentation cache key');
});

test('reconnected identical state repaints controls and consumes the feedback resync flag', () => {
  const h = harness(), next = snapshot(2);
  h.apply(next);
  h.state.feedbackResync = true;
  h.apply(clone(next));
  assert.equal(h.renders.length, 2);
  assert.equal(h.state.feedbackResync, false);
});

test('HTTP still paints a new current projection if no SSE receipt has arrived', async () => {
  const h = harness(), job = h.command('check');
  h.calls[0].resolve({ room: snapshot(2, ['synthetic-1']) });
  assert.equal(await job, true);
  assert.deepEqual(h.renders, [{ revision: 2, busy: false }]);
});

test('an unacknowledged stale HTTP response still clears its own pending control lock', async () => {
  const h = harness(), job = h.command('call');
  h.apply(snapshot(3));
  assert.equal(h.state.busy, true);
  h.calls[0].resolve({ room: snapshot(2, ['synthetic-1']) });
  assert.equal(await job, true);
  assert.equal(h.state.busy, false);
  assert.equal(h.renders.at(-1).busy, false, 'a real lock change cannot be hidden by duplicate suppression');
});
