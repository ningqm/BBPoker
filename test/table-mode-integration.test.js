import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { createTableModeTracker } from '../public/table-mode-events.js';
import { readyRoomAction } from './helpers/room-clock.js';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function fixture(t, { mode = 'normal', count = 3, bomb = false } = {}) {
  let clock = 1800000000000;
  t.mock.method(Date, 'now', () => clock);
  const users = Array.from({ length: count }, (_, i) => ({ id: `mode-${i}`, name: `朋友${i + 1}` }));
  const data = { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data }), room = service.create(users[0], { settings: {
    squid: true, squidMode: mode, squidExtraTokens: 3, squidUnitBB: 2,
    bombPot: bomb, bombIntervalMinutes: 1, durationMinutes: 60,
  } });
  const command = (i, type, extra = {}) => service.command(users[i], room.code, {
    type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra,
  });
  for (const [seat, user] of users.entries()) {
    if (seat) service.join(user, room.code, room.invite);
    command(seat, 'sit', { seat, amountBB: 500 });
    service.connections.set(`${room.code}:${user.id}`, 1);
  }
  const tracker = createTableModeTracker();
  let presentation = {};
  const observe = (options = {}) => {
    // A UI transition may never edit the authoritative room, ledger, poker
    // result or time bank, including when its public snapshot is frozen.
    const before = structuredClone(data), view = freeze(service.state(room, users[0].id));
    const events = tracker.update(view, { now: clock, ...presentation, ...options });
    assert.deepEqual(data, before, 'observing mode changes does not mutate server state or deadlines');
    return events;
  };
  const start = () => { service.start(room, clock); return observe(); };
  const win = winner => {
    const events = [];
    for (let actions = 0; room.hand.status === 'playing'; actions++) {
      assert.ok(actions < 100, 'real room must finish within the action bound');
      if (!readyRoomAction(service, room, value => { clock = value; })) { events.push(...observe()); break; }
      events.push(...observe());
      const actor = room.hand.actingId, choices = availableActions(room.hand, actor);
      command(users.findIndex(u => u.id === actor), actor === users[winner].id ? choices.canCheck ? 'check' : 'call' : 'fold');
      events.push(...observe());
    }
    service.completeRabbit(room, clock); events.push(...observe());
    return events;
  };
  const conserved = () => {
    const members = Object.values(room.members);
    const pot = room.hand?.status === 'playing' ? room.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0;
    assert.equal(members.reduce((sum, m) => sum + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0) + pot,
      members.reduce((sum, m) => sum + m.totalBuyIn, 0));
  };
  return { users, data, service, room, command, tracker, observe, start, win, conserved,
    get now() { return clock; }, advance(ms) { clock += ms; },
    setPresentation(options) { presentation = options; },
  };
}

for (const mode of ['normal', 'unlimited']) test(`${mode} real room: round opening, settlement and next round are announced once without changing scores or timers`, t => {
  const f = fixture(t, { mode });
  assert.deepEqual(f.observe(), []);
  const opening = f.start();
  assert.equal(f.service.state(f.room, f.users[0].id).hand.at, f.room.hand.at, 'public event age uses the real hand timestamp');
  assert.deepEqual(opening.map(e => e.type), ['squid-start']);
  assert.equal(opening[0].mode, mode); assert.equal(opening[0].round, 1);
  assert.equal(opening[0].until, f.room.presentation.actionReadyAt);
  assert.equal(f.room.deadline, f.now + 21100, 'existing deal guard and twenty-second decision clock are unchanged');
  assert.deepEqual(f.win(0), []); f.conserved();
  assert.deepEqual(f.start(), [], 'another poker hand inside the same squid round has no new-round animation');
  const ended = f.win(1);
  assert.deepEqual(ended.map(e => e.type), ['squid-end']);
  assert.equal(ended[0].round, 1);
  assert.equal(ended[0].ownDelta, f.room.mini.squid.lastResult.changes[f.users[0].id]);
  assert.equal(ended[0].amount, f.room.mini.squid.lastResult.amount);
  assert.deepEqual(f.observe(), []); f.conserved();
  const settledLedger = structuredClone(f.data.ledger);
  const next = f.start();
  assert.deepEqual(next.map(e => e.type), ['squid-start']); assert.equal(next[0].round, 2);
  assert.deepEqual(f.data.ledger, settledLedger, 'displaying the next round never repeats the prior fish settlement');
  assert.deepEqual(f.observe(), []); f.conserved();
});

test('nine-player unlimited + bomb: combined opening and exhausted-fish settlement come from committed real room values', t => {
  const f = fixture(t, { mode: 'unlimited', count: 9, bomb: true });
  f.room.startedAt = f.now - 60000; f.room.endsAt = f.now + 3600000; f.room.nextBombAt = f.now;
  assert.deepEqual(f.observe(), []);
  const opening = f.start();
  assert.deepEqual(opening.map(e => e.type), ['bomb-start', 'squid-start']);
  assert.equal(opening[0].ante, 20); assert.equal(opening[1].tokenBudget, 12);
  assert.equal(opening[1].participantCount, 9);
  assert.equal(opening[0].until, opening[1].until);
  assert.equal(f.room.hand.bombPot, true); assert.equal(f.room.hand.board.length, 3);
  const ledgerBefore = f.data.ledger.filter(row => row.type === 'squidSettlement').length;
  for (let hand = 1; hand <= 12; hand++) {
    const events = f.win(0); f.conserved();
    if (hand < 12) {
      assert.deepEqual(events, []); assert.deepEqual(f.start(), []);
    } else {
      assert.deepEqual(events.map(e => e.type), ['squid-end']);
      assert.equal(events[0].tokensAwarded, 12); assert.equal(events[0].ownDelta, 12 * 8 * 20);
      assert.equal(events[0].participantCount, 9);
    }
  }
  assert.equal(f.room.mini.squid.lastResult.tokensExhausted, true);
  assert.equal(f.data.ledger.filter(row => row.type === 'squidSettlement').length - ledgerBefore, 9);
  assert.deepEqual(f.observe(), []); f.conserved();
});

test('chat, queued top-up, ready-state refresh and repeated snapshots cannot restart mode intros', t => {
  const f = fixture(t, { mode: 'unlimited', bomb: true });
  f.room.startedAt = f.now - 60000; f.room.endsAt = f.now + 3600000; f.room.nextBombAt = f.now;
  f.observe(); assert.equal(f.start().length, 2);
  const deadline = f.room.deadline;
  f.service.chat(f.users[0], f.room.code, { messageId: randomUUID(), kind: 'text', text: '准备好了' });
  assert.deepEqual(f.observe(), []);
  f.command(0, 'buyin', { amountBB: 100 });
  assert.deepEqual(f.observe(), []); assert.ok(f.service.pendingBuyIn(f.room.members[f.users[0].id]));
  assert.equal(f.room.deadline, deadline);
  for (let i = 0; i < 3; i++) assert.deepEqual(f.observe(), []);
  f.advance(1100); f.service.tick(f.room, f.now);
  assert.deepEqual(f.observe(), []); assert.equal(f.room.deadline, deadline);
  f.conserved();
});

test('disconnection and a background settlement establish quiet baselines; the next genuine round still animates', t => {
  const f = fixture(t);
  f.observe(); f.setPresentation({ connected: false }); f.observe();
  assert.deepEqual(f.start(), []);
  f.setPresentation({ connected: true }); assert.deepEqual(f.observe(), []);
  assert.deepEqual(f.win(0), []); assert.deepEqual(f.start(), []);
  f.setPresentation({ visible: false }); assert.deepEqual(f.win(1), []);
  assert.equal(f.room.mini.squid.active, false);
  f.setPresentation({ visible: true }); assert.deepEqual(f.observe(), []);
  assert.deepEqual(f.observe(), []);
  assert.deepEqual(f.start().map(e => e.type), ['squid-start']); f.conserved();
});

test('reconnected or first-loaded live tables never replay an in-flight mode intro', t => {
  const f = fixture(t, { mode: 'unlimited' });
  f.observe(); f.service.start(f.room, f.now);
  assert.deepEqual(f.observe({ reconnected: true }), []);
  assert.deepEqual(f.observe(), []);
  f.tracker.reset(); assert.deepEqual(f.observe(), []);
  assert.deepEqual(f.observe(), []); f.conserved();
});
