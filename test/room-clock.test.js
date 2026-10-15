import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import { actorClock } from '../public/table-scene.js';
import { RoomService } from '../src/room.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture() {
  let mono = 0, wall = 900000;
  const clock = createRoomClock({ monotonicNow: () => mono, wallNow: () => wall });
  const room = { code: 'room-a', meId: 'viewer', revision: 3, serverTime: 100000, deadline: 120000,
    settings: { actionSeconds: 20 }, hand: { id: 'h1', street: 'preflop', actionSeq: 5, status: 'playing',
      actingId: 'other', actionReadyAt: 100000, turnStartedAt: 100000 }, actions: { canAct: false } };
  return { clock, room, advance: ms => { mono += ms; wall += ms; }, wall: value => { wall = value; },
    monotonic: value => { mono = value; }, remaining: value => actorClock(value ?? room, clock.now())?.remaining };
}

test('a delayed higher-revision packet never turns twelve seconds back into eighteen', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(8000);
  assert.equal(f.remaining(), 12);
  const delayed = { ...f.room, revision: 4, serverTime: 102000 };
  assert.equal(isOlderRoomSnapshot(f.room, delayed), false);
  f.clock.accept(delayed);
  assert.equal(f.remaining(delayed), 12);
  f.advance(1000); assert.equal(f.remaining(delayed), 11);
});

test('equal-revision stale HTTP cannot replace a newer SSE ready snapshot', () => {
  const f = fixture(), ready = { ...f.room, serverTime: 108000, actions: { canAct: true } };
  const old = { ...f.room, serverTime: 102000, actions: { canAct: false } };
  assert.equal(isOlderRoomSnapshot(ready, old), true);
  assert.equal(isOlderRoomSnapshot(old, ready), false);
  assert.equal(isOlderRoomSnapshot(ready, { ...ready }), false);
});

test('lower business revisions are stale even with a newer timestamp', () => {
  const f = fixture();
  assert.equal(isOlderRoomSnapshot(f.room, { ...f.room, revision: 2, serverTime: 150000 }), true);
  assert.equal(isOlderRoomSnapshot(f.room, { ...f.room, revision: 4, serverTime: 90000 }), false);
});

test('the readiness tie-break never rejects a new turn, newer authority or real deadline change', () => {
  const f = fixture(), ready = { ...f.room, actions: { turnAvailable: true, canAct: true } };
  const preparing = { ...ready, actions: { turnAvailable: true, canAct: false } };
  assert.equal(isOlderRoomSnapshot(ready, preparing), true);
  for (const patch of [{ revision: 4 }, { serverTime: 100001 }, { deadline: 150000 },
    { hand: { ...ready.hand, actionSeq: 8 } }, { hand: { ...ready.hand, street: 'flop' } },
    { hand: { ...ready.hand, id: 'h2' } }, { hand: { ...ready.hand, actingId: 'new-actor' } },
    { hand: { ...ready.hand, turnStartedAt: 100100 } }, { hand: { ...ready.hand, actionReadyAt: 100100 } }]) {
    assert.equal(isOlderRoomSnapshot(ready, { ...preparing, ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(isOlderRoomSnapshot(ready, { ...ready, actions: { ...ready.actions, canUseTimeBank: false } }), false,
    'expiring time-card permission is not the one-way deal-ready flag');
});

test('same-revision timestamp ordering supports ISO strings without rejecting incomplete fixtures', () => {
  const f = fixture(), previous = { ...f.room, serverTime: '2026-10-15T10:00:02Z' };
  assert.equal(isOlderRoomSnapshot(previous, { ...previous, serverTime: '2026-10-15T10:00:01Z' }), true);
  assert.equal(isOlderRoomSnapshot(previous, { ...previous, serverTime: null }), false);
  assert.equal(isOlderRoomSnapshot(previous, { ...previous, serverTime: 'invalid' }), false);
  assert.equal(isOlderRoomSnapshot(null, previous), false);
});

test('packets from a new room or viewer are not compared to an unrelated revision', () => {
  const f = fixture();
  for (const different of [{ code: 'room-b' }, { meId: 'new-viewer' }]) {
    assert.equal(isOlderRoomSnapshot(f.room, { ...f.room, revision: 1, serverTime: 1, ...different }), false);
  }
});

test('a faster subsequent sample corrects latency forward, duplicate chat packets do not add time', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(1000);
  f.clock.accept({ ...f.room, serverTime: 104000 }); assert.equal(f.remaining(), 16);
  for (let n = 0; n < 5; n++) {
    f.advance(1000); f.clock.accept({ ...f.room, revision: 4 + n, serverTime: 104000 });
    assert.equal(f.remaining(), 15 - n);
  }
});

test('real time-bank deadline extensions still add thirty seconds during the same action', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(8000); assert.equal(f.remaining(), 12);
  const extended = { ...f.room, revision: 4, serverTime: 108000, deadline: f.room.deadline + 30000,
    hand: { ...f.room.hand, timeBankUses: [{ playerId: 'other', actionSeq: 5, seconds: 30 }] } };
  f.clock.accept(extended); assert.equal(f.remaining(extended), 42);
  f.advance(2000); assert.equal(f.remaining(extended), 40);
  const stale = { ...f.room, serverTime: 109000 };
  assert.equal(isOlderRoomSnapshot(extended, stale), true, 'the older deadline may not erase time-bank usage');
});

test('a new turn or street resets normally, including the same actor in a later action', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(18000); assert.equal(f.remaining(), 2);
  for (const hand of [{ actingId: 'next', actionSeq: 6 }, { actingId: 'other', actionSeq: 12, street: 'flop' }, { id: 'h2', actionSeq: 5 }]) {
    const next = { ...f.room, revision: 5, serverTime: 118000, deadline: 138000,
      hand: { ...f.room.hand, ...hand, turnStartedAt: 118000, actionReadyAt: 118000 } };
    f.clock.accept(next); assert.equal(f.remaining(next), 20);
  }
});

test('a browser suspended in the background does not restart an expired clock on reconnection', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(35000);
  assert.equal(f.remaining(), 0);
  f.clock.accept({ ...f.room, serverTime: 102000 }); assert.equal(f.remaining(), 0);
  const next = { ...f.room, revision: 6, serverTime: 135000, deadline: 150000,
    hand: { ...f.room.hand, actionSeq: 6, actingId: 'next', turnStartedAt: 130000, actionReadyAt: 130000 } };
  f.clock.accept(next); assert.equal(f.remaining(next), 15);
});

test('if a platform pauses its monotonic clock during sleep, the fresh server snapshot catches it up', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(1000);
  f.wall(2000000); f.clock.accept({ ...f.room, serverTime: 135000 });
  assert.equal(f.remaining(), 0);
});

test('phone wall-clock changes cannot add thinking time or prematurely expire a synchronized turn', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(4000);
  f.wall(-1e12); assert.equal(f.remaining(), 16);
  f.wall(1e12); assert.equal(f.remaining(), 16);
  f.advance(1000); assert.equal(f.remaining(), 15);
});

test('first valid sample synchronizes independently of the phone clock; malformed samples are ignored', () => {
  const f = fixture(); assert.equal(f.clock.now(), 900000);
  assert.equal(f.clock.accept({ ...f.room, serverTime: null }), false);
  assert.equal(f.clock.accept({ ...f.room, serverTime: 'broken' }), false);
  f.clock.accept(f.room); assert.equal(f.clock.now(), 100000);
  f.advance(1000); f.clock.accept({ ...f.room, serverTime: null }); assert.equal(f.clock.now(), 101000);
});

test('changing room or identity can establish a fresh clock; reconnecting to the same room cannot rewind it', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(10000);
  f.clock.accept(f.room); assert.equal(f.clock.now(), 110000);
  f.clock.accept({ ...f.room, code: 'room-b' }); assert.equal(f.clock.now(), 100000);
  f.advance(5000); f.clock.accept({ ...f.room, code: 'room-b', meId: 'other' }); assert.equal(f.clock.now(), 100000);
  f.clock.reset(); assert.equal(f.clock.now(), 915000);
});

test('displaying countdowns never rewrites deadlines, action permissions, or snapshot data', () => {
  const f = fixture(), before = structuredClone(f.room); f.clock.accept(f.room);
  for (let n = 0; n < 30; n++) { f.advance(1000); f.clock.accept(f.room); f.remaining(); }
  assert.deepEqual(f.room, before);
});

test('three devices with different delivery jitter never add time when chat and HTTP snapshots interleave', () => {
  for (const delay of [40, 500, 2000]) {
    const f = fixture(), packets = Array.from({ length: 12 }, (_, i) => {
      const sent = i * 800, lag = delay + [0, 4300, 80, 1600, 20, 300][i % 6];
      return { sent, arrived: sent + lag, room: { ...f.room, revision: i + 3, serverTime: 100000 + sent } };
    }).sort((a, b) => a.arrived - b.arrived);
    let previous = null, last = null;
    for (const packet of packets) {
      f.monotonic(packet.arrived);
      if (previous) assert.ok(f.remaining(previous) <= last, 'elapsed device time only decreases the counter');
      const before = previous ? f.remaining(previous) : null;
      if (!isOlderRoomSnapshot(previous, packet.room)) { previous = packet.room; f.clock.accept(previous); }
      const after = f.remaining(previous);
      if (before !== null) assert.ok(after <= before, `delivery lag ${delay} cannot reverse ${before} into ${after}`);
      last = after;
    }
    // Delayed timestamps are not an RTT measurement. A fresh authoritative
    // sample catches up every device without granting extra server action time.
    f.monotonic(25000);f.clock.accept({ ...previous, serverTime: 125000 });
    assert.equal(f.remaining(previous), 0);
  }
});

test('a paused monotonic clock still catches up after sleep even when buffered old frames precede the fresh snapshot', () => {
  const f = fixture(); f.clock.accept(f.room); f.advance(8000);
  f.wall(10000000);
  f.clock.accept({ ...f.room, revision: 4, serverTime: 102000 });
  assert.equal(f.remaining(), 12, 'an old frame cannot rewind the pre-sleep display');
  f.clock.accept({ ...f.room, revision: 5, serverTime: 140000 });
  assert.equal(f.remaining(), 0, 'fresh server authority accounts for sleep without trusting the phone wall clock');
  f.clock.accept({ ...f.room, revision: 6, serverTime: 103000 });
  assert.equal(f.remaining(), 0);
});

function serverFixture(t) {
  let time = 1800000000000, mono = 0;
  t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: 4 }, (_, i) => ({ id: `clock-${i}`, name: `Clock ${i}`, avatar: 0 }));
  const data = { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data }), room = service.create(users[0], {});
  const command = (user, type, extra = {}) => service.command(user, room.code, { type,
    commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (const [i, user] of users.entries()) {
    if (i) service.join(user, room.code, room.invite);
    if (i < 3) { command(user, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${user.id}`, 1); }
  }
  command(users[0], 'start');
  mono += room.presentation.actionReadyAt - time; time = room.presentation.actionReadyAt; service.tick(room);
  const clock = createRoomClock({ monotonicNow: () => mono });
  const snapshot = () => service.state(room, users[0].id);
  clock.accept(snapshot());
  return { users, service, room, command, clock, snapshot, advance(ms) { time += ms; mono += ms; } };
}

test('real room chat, buy-in, mid-hand seating and reconnect retain the same action deadline', t => {
  const f = serverFixture(t), initial = f.snapshot(), deadline = f.room.deadline, actor = f.room.hand.actingId;
  f.advance(8000); assert.equal(actorClock(f.snapshot(), f.clock.now()).remaining, 12);
  f.service.chat(f.users[1], f.room.code, { messageId: randomUUID(), kind: 'text', text: '好牌' });
  f.command(f.users[1], 'buyin', { amountBB: 100 });
  f.command(f.users[3], 'sit', { seat: 3, amountBB: 100, entryMode: 'post' });
  f.service.connections.delete(`${f.room.code}:${actor}`); f.service.connectionChanged(f.room);
  f.service.connections.set(`${f.room.code}:${actor}`, 1); f.service.connectionChanged(f.room, Date.now(), { reconnected: true });
  const latest = f.snapshot(); f.clock.accept(latest);
  assert.equal(f.room.deadline, deadline);
  assert.equal(latest.hand.turnStartedAt, initial.hand.turnStartedAt);
  assert.equal(latest.hand.actionSeq, initial.hand.actionSeq);
  assert.equal(actorClock(latest, f.clock.now()).remaining, 12);
  assert.equal(isOlderRoomSnapshot(latest, initial), true);
});

test('a real ready-boundary snapshot cannot restore preparing when equal-millisecond responses arrive out of order', t => {
  const f = serverFixture(t), actor = f.room.hand.actingId, readyAt = Date.now() + 100;
  f.room.presentation.actionReadyAt = readyAt;
  f.room.presentation.turnStartedAt = readyAt;
  f.room.deadline = readyAt + 20000;
  // state() captures readiness at entry and stamps serverTime near the end.
  // A projection crossing readyAt can therefore share the next projection's
  // millisecond and business revision while still carrying pre-ready controls.
  let reads = 0;
  t.mock.method(Date, 'now', () => ++reads === 1 ? readyAt - 1 : readyAt);
  const old = f.service.state(f.room, actor), fresh = f.service.state(f.room, actor);
  assert.equal(old.revision, fresh.revision); assert.equal(old.serverTime, fresh.serverTime);
  assert.equal(old.actions.turnAvailable, true); assert.equal(old.actions.canAct, false);
  assert.equal(fresh.actions.canAct, true);
  assert.equal(isOlderRoomSnapshot(fresh, old), true);
  assert.equal(isOlderRoomSnapshot(old, fresh), false);
});

test('a real time card extends only its current actor, deadline and visible countdown by thirty seconds', t => {
  const f = serverFixture(t), deadline = f.room.deadline, actor = f.users.find(u => u.id === f.room.hand.actingId);
  const balance = f.room.members[actor.id].timeBank.remaining;
  f.advance(8000); const before = f.snapshot(); assert.equal(actorClock(before, f.clock.now()).remaining, 12);
  f.command(actor, 'timebank');
  const after = f.snapshot(); f.clock.accept(after);
  assert.equal(f.room.deadline, deadline + 30000);
  assert.equal(f.room.members[actor.id].timeBank.remaining, balance - 1);
  assert.equal(after.hand.actionSeq, before.hand.actionSeq);
  assert.equal(actorClock(after, f.clock.now()).remaining, 42);
  f.advance(1000); assert.equal(actorClock(after, f.clock.now()).remaining, 41);
});

test('real successive time cards survive reversed replies without losing or duplicating thirty seconds', t => {
  const f = serverFixture(t), actor = f.users.find(u => u.id === f.room.hand.actingId);
  f.advance(8000);const initial = f.snapshot();
  f.command(actor, 'timebank');const first = f.snapshot();
  f.command(actor, 'timebank');const second = f.snapshot();
  assert.equal(second.deadline, initial.deadline + 60000);
  assert.equal(second.hand.actionSeq, initial.hand.actionSeq);
  f.clock.accept(second);assert.equal(actorClock(second, f.clock.now()).remaining, 72);
  assert.equal(isOlderRoomSnapshot(second, first), true);assert.equal(isOlderRoomSnapshot(second, initial), true);
  f.advance(2000);f.clock.accept(second);assert.equal(actorClock(second, f.clock.now()).remaining, 70);
});

test('real calls, checks and street transitions grant a new twenty seconds even when the next street starts with the same actor', t => {
  const f = serverFixture(t);
  const act = () => { const user = f.users.find(u => u.id === f.room.hand.actingId), view = f.service.state(f.room, user.id);
    f.command(user, view.actions.canCheck ? 'check' : 'call'); };
  while (!f.room.hand.transition) act();
  f.advance(f.room.hand.transition.nextAt - Date.now());f.service.tick(f.room);
  f.advance(f.room.presentation.actionReadyAt - Date.now());f.service.tick(f.room);
  const flop = f.snapshot();f.clock.accept(flop);assert.equal(flop.hand.street, 'flop');
  f.advance(17000);assert.equal(actorClock(flop, f.clock.now()).remaining, 3);
  while (!f.room.hand.transition) act();
  f.advance(f.room.hand.transition.nextAt - Date.now());f.service.tick(f.room);
  f.advance(f.room.presentation.actionReadyAt - Date.now());f.service.tick(f.room);
  const turn = f.snapshot();f.clock.accept(turn);
  assert.equal(turn.hand.street, 'turn');assert.equal(turn.hand.actingId, flop.hand.actingId);
  assert.ok(turn.hand.actionSeq > flop.hand.actionSeq);assert.equal(actorClock(turn, f.clock.now()).remaining, 20);
  assert.equal(isOlderRoomSnapshot(turn, flop), true);
});

function applicationFixture() {
  const f = fixture(), paints = [], effects = [], state = { clock: f.clock, user: { id: f.room.meId },
    room: null, modal: null, revealed: new Set(), raise: 0 };
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function normalizeState('), end = source.indexOf('async function command(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ state, isOlderRoomSnapshot, Date,
    captureRoomChanges: (_, room) => effects.push({ room, now: state.clock.now() }),
    rememberCommitment: () => false, syncBetControls: () => ({ amount: 0, preset: null, panelOpen: false, key: null }),
    render: () => paints.push({ room: state.room, clock: actorClock(state.room, state.clock.now()) }),
    toast() {}, closeModal() {} });
  vm.runInContext(source.slice(start, end), context);
  return { ...f, state, paints, effects, apply: room => context.normalizeState(room) };
}

test('actual application accepts delayed business updates while its displayed clock keeps counting down', () => {
  const f = applicationFixture(); f.apply(f.room); assert.equal(f.paints.at(-1).clock.remaining, 20);
  f.advance(8000);
  const delayed = { ...f.room, revision: 4, serverTime: 102000, chat: [{ text: '稍后送达' }] };
  f.apply(delayed);
  assert.equal(f.state.room, delayed, 'the newer business update is not discarded to hide the clock problem');
  assert.equal(f.paints.at(-1).clock.remaining, 12);
  assert.equal(f.effects.at(-1).now, 108000, 'event freshness and countdown use the same updated clock');
});

test('actual application rejects same-revision stale permissions and retains a real time-card extension', () => {
  const f = applicationFixture(); f.apply(f.room); f.advance(8000);
  const ready = { ...f.room, serverTime: 108000, actions: { canAct: true } };
  f.apply(ready); const count = f.paints.length;
  f.apply({ ...f.room, serverTime: 102000, actions: { canAct: false } });
  assert.equal(f.paints.length, count); assert.equal(f.state.room.actions.canAct, true);
  const extension = { ...ready, revision: 4, deadline: ready.deadline + 30000 };
  f.apply(extension); assert.equal(f.paints.at(-1).clock.remaining, 42);
  f.apply(ready); assert.equal(f.state.room, extension);
});

test('actual application keeps enabled controls when the equal-time preparing snapshot is delivered last', () => {
  const f = applicationFixture(), ready = { ...f.room, actions: { turnAvailable: true, canAct: true } };
  f.apply(ready);const paintCount = f.paints.length;
  f.apply({ ...ready, actions: { turnAvailable: true, canAct: false } });
  assert.equal(f.paints.length, paintCount);assert.equal(f.state.room, ready);
});

test('actual application cannot move the shared clock with another viewer private snapshot', () => {
  const f = applicationFixture(); f.apply(f.room); f.advance(1000);
  f.apply({ ...f.room, meId: 'not-the-current-user', revision: 50, serverTime: 999999 });
  assert.equal(f.clock.now(), 101000); assert.equal(f.state.room, f.room);
});
