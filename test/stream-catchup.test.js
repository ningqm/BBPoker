import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isOlderRoomSnapshot } from '../public/room-clock.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function connectStream('), source.indexOf('function updateConnection('));
const frame = room => `data: ${JSON.stringify(room)}\n\n`;
const snapshot = (revision, patch = {}) => ({ code: '123456', meId: 'a', revision, serverTime: 2000 + revision,
  deadline: 22000, hand: { id: 'h1', status: 'playing', actingId: 'a', street: 'flop', actionSeq: revision, actionReadyAt: 2000, turnStartedAt: 2000 },
  actions: { turnAvailable: true, canAct: true }, ...patch });
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let time = 1000, nextTimer = 0;
  const state = { page: 'room', token: 'synthetic-session', user: { id: 'a' }, room: snapshot(1), connected: false };
  const connections = [], painted = [], expired = [], intervals = new Map(), retries = [];
  class Clock extends Date { static now() { return time; } }
  const context = vm.createContext({ state, Date: Clock, AbortController, TextDecoder, isOlderRoomSnapshot,
    stopStream() { state.stream?.abort(); state.connected = false; }, updateConnection() {}, apiUrl: path => path,
    normalizeState: room => { if (!isOlderRoomSnapshot(state.room, room)) { painted.push(room); state.room = room; } },
    expireIdentity: async token => { expired.push(token); state.page = 'welcome'; },
    document:{visibilityState:'visible'},navigator: { onLine: true }, tableSounds: { stopPlayback() {} },
    setInterval: (fn, delay) => { const id = ++nextTimer; intervals.set(id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id), setTimeout: (fn, delay) => { retries.push({ fn, delay }); return 99; },
    fetch: async () => {
      const queue = []; let waiting = null;
      const connection = { push(value) { if (waiting) { const resolve = waiting; waiting = null; resolve(value); } else queue.push(value); } };
      connections.push(connection);
      return { status: 200, ok: true, body: { getReader: () => ({ read: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { waiting = resolve; }) }) } };
    } });
  vm.runInContext(code, context);
  const job = context.connectStream('123456');
  return { context,state, connections, painted, expired, intervals, retries, job,reconnect:context.connectStream,
    async push(text) { connections.at(-1).push({ done: false, value: new TextEncoder().encode(text) }); await settle(); },
    async at(value) { time = value; for (const interval of [...intervals.values()]) interval.fn(); await settle(); },
    async close() { state.stream?.abort(); for (const connection of connections) connection.push({ done: true }); await job; await settle(); } };
}

test('a buffered chunk paints the newest authoritative room only once, skipping intermediate old actors', async () => {
  const h = harness(); await settle();
  await h.push(frame(snapshot(2)) + frame(snapshot(4)) + frame(snapshot(3)));
  assert.equal(h.painted.length, 1); assert.equal(h.painted[0].revision, 4);
  assert.equal(h.state.connected, true); await h.close();
});

test('same-millisecond ready and preparing frames preserve ready in either arrival order', async () => {
  for (const reverse of [false, true]) {
    const h = harness(); await settle();
    const ready = snapshot(2), preparing = { ...ready, actions: { turnAvailable: true, canAct: false } };
    await h.push((reverse ? [ready, preparing] : [preparing, ready]).map(frame).join(''));
    assert.equal(h.painted.length, 1); assert.equal(h.painted[0].actions.canAct, true); await h.close();
  }
});

test('session expiry in the same buffered chunk wins before any private room is rendered', async () => {
  for (const tail of [false, true]) {
    const h = harness(); await settle();
    const expiry = 'event: session-expired\ndata: {"error":"expired"}\n\n';
    await h.push(tail ? frame(snapshot(2)) + expiry : expiry + frame(snapshot(2)));
    await h.job; assert.equal(h.painted.length, 0); assert.equal(h.expired.length, 1); assert.equal(h.state.page, 'welcome');
    await h.close();
  }
});

test('split frames are buffered and other rooms or viewers cannot replace the users private state', async () => {
  const h = harness(); await settle(); const text = frame(snapshot(2));
  await h.push(': heartbeat\n\n' + text.slice(0, 31)); assert.equal(h.painted.length, 0);
  await h.push(text.slice(31) + frame(snapshot(8, { code: '654321' })) + frame(snapshot(9, { meId: 'b' })));
  assert.equal(h.painted.length, 1); assert.equal(h.painted[0].revision, 2); await h.close();
});

test('stream watchdog is bounded before a normal twenty-second action can expire', async () => {
  const h = harness(); await settle();
  assert.equal([...h.intervals.values()][0].delay, 2000);
  await h.at(9000); assert.equal(h.connections.length, 1);
  await h.at(9001); assert.equal(h.connections.length, 2, 'an eight-second quiet stream is reopened');
  await h.close();
});

test('a queued reconnect from the old account cannot start a stream for the new account',async()=>{
  const h=harness();await settle();h.connections[0].push({done:true});await h.job;
  assert.equal(h.retries.length,1);
  h.state.token='new-session';h.state.user={id:'b'};
  h.retries[0].fn();await settle();assert.equal(h.connections.length,1);
  await h.close();
});
test('queued reconnect cannot resurrect a table after returning to lobby',async()=>{
  const h=harness();await settle();h.connections[0].push({done:true});await h.job;
  h.state.page='lobby';h.state.room=null;
  h.retries[0].fn();await settle();assert.equal(h.connections.length,1);
  await h.reconnect('123456');assert.equal(h.connections.length,1);await h.close();
});
test('current account queued reconnect still restores its current table',async()=>{
  const h=harness();await settle();h.connections[0].push({done:true});await h.job;
  h.retries[0].fn();await settle();assert.equal(h.connections.length,2);await h.close();
});


test('hidden pages do not repaint buffered hands or repeatedly reopen a sleeping stream', async () => {
 const h=harness();await settle();h.context.document.visibilityState='hidden';
 await h.push(frame(snapshot(2)));assert.equal(h.painted.length,0);
 await h.at(12000);assert.equal(h.connections.length,1);
 h.context.document.visibilityState='visible';
 await h.push(frame(snapshot(3)));assert.equal(h.painted.length,1);assert.equal(h.painted[0].revision,3);
 await h.close();
});
