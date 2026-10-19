import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { EncryptedStore } from '../src/store.js';
import { createApp } from '../server.js';
import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';

function fixture(t, { count = 3, settings = {}, encrypted = false } = {}) {
  let time = 1800000000000;
  t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: count + 1 }, (_, i) => ({ id: `round-timing-${i}`, name: `朋友${i}`, avatar: 0 }));
  let store;
  if (encrypted) {
    const directory = mkdtempSync(join(tmpdir(), 'bbpoker-round-timing-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    store = new EncryptedStore(directory);
  } else store = { data: { users: {}, rooms: {}, hands: [], ledger: [] } };
  for (const user of users) store.data.users[user.id] = user;
  const service = new RoomService(store), room = service.create(users[0], { settings });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const command = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) { command(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  command(0, 'start');
  const setTime = value => { time = value; };
  const ready = () => readyRoomAction(service, room, setTime);
  const step = () => advanceRoomEvent(service, room, setTime);
  const actor = () => users.findIndex(user => user.id === room.hand.actingId);
  const act = type => command(actor(), type);
  const checkCall = () => act(availableActions(room.hand, room.hand.actingId).canCheck ? 'check' : 'call');
  const closeBetting = () => { ready(); while (room.hand.actingId) checkCall(); };
  return { users, store, service, room, command, ready, step, actor, act, checkCall, closeBetting,
    state: (i = count) => service.state(room, users[i].id), at: setTime, advance(ms) { time += ms; }, get time() { return time; } };
}

test('raw actions and time cards cannot spend the initial deal or next-street presentation window', t => {
  const f = fixture(t);
  for (const stage of ['deal', 'flop', 'turn', 'river']) {
    if (stage !== 'deal') { f.closeBetting(); assert.equal(f.room.hand.transition.kind, 'street'); f.step(); }
    const readyAt = f.room.presentation.actionReadyAt, actor = f.actor(), frozen = structuredClone(f.store.data);
    assert.ok(readyAt > f.time);
    for (const type of ['fold', 'check', 'call', 'raise', 'allin', 'timebank']) {
      assert.throws(() => f.command(actor, type, { amount: 20 }), error => error.status === 409 && /发牌中/.test(error.message));
      assert.deepEqual(f.store.data, frozen);
    }
    f.at(readyAt - 1); assert.throws(() => f.command(actor, 'timebank'), /发牌中/);
    f.at(readyAt); const revision = f.room.revision;
    assert.equal(f.service.tick(f.room), true); assert.equal(f.room.revision, revision + 1);
    assert.equal(f.state(actor).actions.canAct, true); assert.equal(f.room.deadline - f.time, 20000);
    assert.equal(f.service.tick(f.room), false);
  }
});

test('closing a betting round retains the last wager, log and private deck until the authoritative timer', t => {
  const f = fixture(t); f.ready();
  f.command(f.actor(), 'raise', { amount: 30 }); f.act('call');
  const h = f.room.hand, lastActor = f.actor(), cursor = h.deckCursor, logLength = h.log.length;
  f.act('call'); const due = f.time + 300;
  assert.deepEqual(h.players.map(p => p.bet), [30, 30, 30]);
  assert.equal(h.deckCursor, cursor); assert.equal(h.log.length, logLength + 1);
  assert.equal(h.log.at(-1).type, 'call'); assert.equal(h.log.at(-1).street, 'preflop');
  const view = f.state(); assert.deepEqual(view.hand.board, []); assert.deepEqual(view.hand.proofs, []);
  assert.equal(view.hand.result, null); assert.equal(view.hand.pot, 90); assert.equal(view.hand.log.some(e => e.type === 'street'), false);
  assert.equal(Object.hasOwn(view.hand, 'deck'), false); assert.equal(view.players.some(p => p.handCategory !== null), false);
  assert.equal(view.hand.actionReadyAt, null); assert.equal(view.hand.actingId, null);
  const before = structuredClone(f.store.data);
  assert.throws(() => f.command(lastActor, 'check'), /本轮行动已结束/);
  assert.throws(() => f.command(lastActor, 'timebank'), /当前行动/);
  assert.deepEqual(f.store.data, before);
  f.command(lastActor, 'buyin', { amountBB: 100 });
  f.service.chat(f.users[lastActor], f.room.code, { kind: 'text', text: '下一街见', messageId: randomUUID() });
  assert.equal(h.transition.nextAt, due); assert.deepEqual(h.players.map(p => p.bet), [30, 30, 30]);
  f.at(due - 1); assert.equal(f.service.tick(f.room), false); assert.equal(h.deckCursor, cursor);
  f.at(due); assert.equal(f.service.tick(f.room), true);
  assert.equal(h.deckCursor, cursor + 4); assert.equal(h.board.length, 3); assert.deepEqual(h.players.map(p => p.bet), [0, 0, 0]);
  assert.equal(h.log.filter(e => e.type === 'street').length, 1);
  assert.equal(f.service.pendingBuyIn(f.room.members[f.users[lastActor].id]), 1000);
});

for (const phase of ['initial-deal', 'street-tail', 'board-flip', 'active-turn']) test(`chat, top-up and table controls preserve the exact running clock (${phase})`, t => {
  const f = fixture(t);
  if (phase === 'street-tail' || phase === 'board-flip') { f.closeBetting(); if (phase === 'board-flip') f.step(); }
  if (phase === 'active-turn') f.ready();
  const clock = () => ({ deadline: f.room.deadline, presentation: structuredClone(f.room.presentation),
    transition: structuredClone(f.room.hand.transition), actor: f.room.hand.actingId, logLength: f.room.hand.log.length });
  const expected = clock(), topupId = randomUUID();
  const operations = [
    () => f.service.chat(f.users[0], f.room.code, { kind: 'text', text: '这手慢慢想', messageId: randomUUID() }),
    () => f.service.chat(f.users[1], f.room.code, { kind: 'emote', emote: 'nice', messageId: randomUUID() }),
    () => f.command(0, 'buyin', { amountBB: 100, commandId: topupId }),
    () => f.command(0, 'buyin', { amountBB: 100, commandId: topupId }),
    () => f.command(1, 'sitout', { value: true }),
    () => f.command(1, 'cancelDeparture'),
    () => f.command(2, 'stand'),
    () => f.command(2, 'cancelDeparture'),
    () => f.command(0, 'autoDeal', { paused: true }),
    () => f.command(0, 'autoDeal', { paused: false }),
    () => f.service.join(f.users[0], f.room.code, f.room.invite),
    () => { f.service.connections.set(`${f.room.code}:${f.users[1].id}`, 0); f.service.connectionChanged(f.room); },
    () => { f.service.connections.set(`${f.room.code}:${f.users[1].id}`, 1); f.service.connectionChanged(f.room, f.time, { reconnected: true }); },
    () => f.state(),
  ];
  for (const operation of operations) { operation(); assert.deepEqual(clock(), expected); }
  assert.equal(f.service.pendingBuyIn(f.room.members[f.users[0].id]), 1000);
});

test('ordinary streets open at 900ms total and same-street next actors have no artificial pause', t => {
  const f = fixture(t); f.ready();
  for (const count of [3, 4, 5]) {
    f.closeBetting(); const lastActionAt = f.time;
    assert.equal(f.room.hand.transition.nextAt, lastActionAt + 300);
    f.step(); assert.equal(f.room.hand.board.length, count);
    assert.equal(f.room.presentation.actionReadyAt, lastActionAt + 900);
    f.step(); assert.equal(f.time, lastActionAt + 900); assert.equal(f.room.deadline, f.time + 20000);
    const actor = f.room.hand.actingId;
    f.act('check'); assert.notEqual(f.room.hand.actingId, actor);
    assert.equal(f.room.presentation.actionReadyAt, f.time);
    assert.equal(f.room.deadline, f.time + 20000);
    assert.equal(f.state(f.actor()).actions.canAct, true);
  }
});

test('a time card extends only the deadline; unrelated updates cannot restart its turn baseline', t => {
  const f = fixture(t); f.ready(); f.advance(2500);
  const deadline = f.room.deadline, baseline = structuredClone(f.room.presentation), actor = f.actor();
  f.command(actor, 'timebank');
  assert.equal(f.room.deadline, deadline + 30000); assert.deepEqual(f.room.presentation, baseline);
  f.service.chat(f.users[actor], f.room.code, { kind: 'text', text: '再想一下', messageId: randomUUID() });
  f.command(actor, 'buyin', { amountBB: 100 }); f.state(actor);
  assert.equal(f.room.deadline, deadline + 30000); assert.deepEqual(f.room.presentation, baseline);
});

test('ordinary river call shows the last action, then the contenders, then pays exactly once', t => {
  const f = fixture(t), folded = f.users[0].id;
  f.ready(); f.act('fold');
  while (f.room.hand.street !== 'river') { f.closeBetting(); f.step(); }
  f.ready(); const bettor = f.actor(); f.command(bettor, 'raise', { amount: 20 });
  const caller = f.actor(); f.command(caller, 'call');
  const h = f.room.hand, before = f.time;
  assert.deepEqual(f.state().hand.transition, { kind: 'showdown', nextAt: before + 900, revealed: false });
  assert.equal(h.result, null); assert.equal(f.room.deadline, null); assert.equal(h.actingId, null);
  assert.ok(f.state().players.filter(p => p.inHand).every(p => p.cards.every(c => c === null)));
  f.command(caller, 'buyin', { amountBB: 100 }); const stack = f.room.members[f.users[caller].id].stack;
  f.at(before + 899); assert.equal(f.service.tick(f.room), false);
  f.advance(1); assert.equal(f.service.tick(f.room), true);
  assert.equal(h.status, 'playing'); assert.equal(h.result, null); assert.equal(f.store.data.hands.length, 0);
  assert.equal(f.state().hand.transition.revealed, true); assert.equal(h.transition.nextAt, f.time + 700);
  for (const p of f.state().players.filter(p => p.inHand)) {
    assert.equal(p.cards.every(c => c === null), p.id === folded);
    assert.equal(p.handCategory === null, p.id === folded);
  }
  assert.equal(f.room.members[f.users[caller].id].stack, stack);
  f.advance(699); assert.equal(f.service.tick(f.room), false);
  f.advance(1); assert.equal(f.service.tick(f.room), true);
  assert.equal(h.status, 'complete'); assert.equal(h.result.showdown, true); assert.equal(h.transition, null);
  assert.equal(f.store.data.hands.length, 1); assert.equal(f.room.nextHandAt, f.time + 5000);
  assert.equal(f.room.members[f.users[caller].id].stack, h.endingStacks[f.users[caller].id] + 1000);
  const finished = structuredClone(f.store.data); assert.equal(f.service.tick(f.room), false); assert.deepEqual(f.store.data, finished);
});

test('all-in keeps its existing runout spacing and displays the final river before awarding chips', t => {
  const f = fixture(t, { count: 2 }); f.ready(); f.act('allin'); f.act('call');
  const h = f.room.hand, lockedAt = f.time;
  assert.equal(h.transition, null); assert.equal(h.runout.nextAt, lockedAt + 1800);
  // Keep both players funded regardless of the random winner so the ordinary
  // next-hand hold, rather than an insufficient-player wait, is under test.
  f.command(0, 'buyin', { amountBB: 100 });
  f.command(1, 'buyin', { amountBB: 100 });
  for (const count of [3, 4, 5]) {
    const due = h.runout.nextAt;
    f.at(due - 1); assert.equal(f.service.tick(f.room), false); assert.equal(h.board.length, count === 3 ? 0 : count - 1);
    f.at(due); assert.equal(f.service.tick(f.room), true); assert.equal(h.board.length, count);
    assert.equal(h.status, 'playing'); assert.equal(h.result, null);
    if (count < 5) { assert.equal(h.runout.nextAt, f.time + 1500); assert.equal(h.transition, null); }
  }
  assert.equal(h.runout.active, false); assert.deepEqual(f.state().hand.transition, { kind: 'showdown', nextAt: f.time + 700, revealed: true });
  assert.equal(f.service.pendingBuyIn(f.room.members[f.users[1].id]), 1000);
  f.advance(700); assert.equal(f.service.tick(f.room), true);
  assert.equal(h.status, 'complete'); assert.equal(f.room.nextHandAt, f.time + 5000);
  assert.equal(f.service.pendingBuyIn(f.room.members[f.users[1].id]), 0);
});

test('the last fold stays visible before an uncontested award and never forces private cards open', t => {
  const f = fixture(t, { count: 2 }); f.ready(); const loser = f.actor(); f.act('fold');
  const h = f.room.hand, due = f.time + 650;
  assert.deepEqual(f.state().hand.transition, { kind: 'award', nextAt: due, revealed: false });
  assert.equal(h.status, 'playing'); assert.equal(h.result, null); assert.equal(h.rabbit, undefined);
  f.command(loser, 'buyin', { amountBB: 100 });
  f.at(due - 1); assert.equal(f.service.tick(f.room), false);
  f.at(due); assert.equal(f.service.tick(f.room), true); assert.equal(h.result.showdown, false);
  assert.ok(f.state().players.filter(p => p.inHand).every(p => p.cards.every(c => c === null)));
  assert.equal(h.rabbit.nextAt, due + 1000); assert.equal(f.room.nextHandAt, due + 5000);
  f.at(due + 1000); f.service.tick(f.room); assert.equal(f.room.nextHandAt, f.time + 5000);
  assert.equal(f.room.members[f.users[loser].id].stack, h.endingStacks[f.users[loser].id] + 1000);
});

test('a late transition tick publishes one stage and anchors a complete new turn instead of catching up', t => {
  const f = fixture(t); f.closeBetting(); const due = f.room.hand.transition.nextAt, cursor = f.room.hand.deckCursor;
  f.at(due + 60000); assert.equal(f.service.tick(f.room), true);
  assert.equal(f.room.hand.street, 'flop'); assert.equal(f.room.hand.deckCursor, cursor + 4);
  assert.equal(f.room.presentation.actionReadyAt, f.time + 600); assert.equal(f.room.deadline, f.time + 20600);
  assert.equal(f.room.hand.log.filter(e => e.type === 'timeout').length, 0);
  const before = structuredClone(f.room.hand); assert.equal(f.service.tick(f.room), false); assert.deepEqual(f.room.hand, before);
});

test('a timed-out final check waits before drawing and records the timeout on the correct street', t => {
  const f = fixture(t); f.ready(); f.act('call'); f.act('call');
  const actor = f.room.hand.actingId, deadline = f.room.deadline; f.at(deadline);
  assert.equal(f.service.tick(f.room), true);
  assert.equal(f.room.hand.board.length, 0); assert.equal(f.room.hand.transition.nextAt, deadline + 300);
  assert.deepEqual(f.room.hand.log.at(-1), { seq: f.room.hand.log.length, street: 'preflop', playerId: actor, type: 'timeout', amount: 0 });
  f.step(); assert.equal(f.room.hand.street, 'flop'); assert.equal(f.room.deadline, f.time + 20600);
});

for (const kind of ['street', 'showdown', 'showdown-revealed', 'runout-showdown', 'award']) test(`encrypted server restart preserves the pending ${kind} deadline without replacing it by an actor clock`, async t => {
  const f = fixture(t, { count: 2, encrypted: true }); f.ready();
  if (kind === 'award') f.act('fold');
  else if (kind === 'runout-showdown') { f.act('allin'); f.act('call'); while (f.room.hand.runout.active) f.step(); }
  else {
    f.closeBetting();
    if (kind.startsWith('showdown')) {
      while (f.room.hand.street !== 'river') { f.step(); f.closeBetting(); }
      if (kind === 'showdown-revealed') f.step();
    }
  }
  assert.equal(f.room.hand.transition.kind, kind.includes('showdown') ? 'showdown' : kind);
  const saved = structuredClone(f.room.hand), due = f.room.hand.transition.nextAt; f.store.save();
  const app = createApp({ dataDir: f.store.directory, actionTickMs: 1000000 }); t.after(() => app.close());
  const room = app.service.room(f.room.code);
  assert.deepEqual(room.hand, saved); assert.equal(room.deadline, null); assert.equal(room.hand.transition.nextAt, due);
  // The first post-restart tick observes the disconnected host; this is
  // metadata only and must not advance any poker state before its deadline.
  const beforeObservation = structuredClone(app.store.data), observationWallTime = new Date().getTime();
  f.at(due - 1); assert.equal(app.service.tick(room), true);
  assert.ok(Date.parse(room.updatedAt) >= observationWallTime && Date.parse(room.updatedAt) <= new Date().getTime());
  const expectedObservation = structuredClone(beforeObservation), expectedRoom = expectedObservation.rooms[room.code];
  Object.assign(expectedRoom, { hostAbsentSince: due - 1, hostAbsentEpoch: app.service.observationId,
    hostAbsentId: room.hostId, revision: expectedRoom.revision + 1, updatedAt: room.updatedAt });
  assert.deepEqual(app.store.data, expectedObservation, 'only host-observation metadata and its revision may change');
  assert.deepEqual(room.hand, saved); assert.equal(room.deadline, null); assert.equal(room.hand.transition.nextAt, due);
  assert.equal(app.service.tick(room), false, 'a stable observation cannot cause repeated writes');
  assert.deepEqual(app.store.data, expectedObservation);
  f.at(due); assert.equal(app.service.tick(room), true);
  assert.equal(room.hand.transition?.revealed ?? false, kind === 'showdown');
  assert.equal(room.hand.status === 'complete', ['award', 'showdown-revealed', 'runout-showdown'].includes(kind));
});

test('expiry during an award wait settles the hand and queued money before closing, with no early cashout', t => {
  const f = fixture(t, { count: 2 }); f.ready(); const loser = f.actor(); f.act('fold');
  f.command(loser, 'buyin', { amountBB: 100 });
  f.room.endsAt = f.time + 100; const before = structuredClone(f.room.members);
  f.advance(100); f.service.tick(f.room);
  assert.equal(f.room.status, 'playing'); assert.deepEqual(f.room.members, before); assert.equal(f.store.data.hands.length, 0);
  f.step(); assert.equal(f.room.status, 'closed'); assert.equal(f.store.data.hands.length, 1);
  const m = f.room.members[f.users[loser].id];
  assert.equal(m.totalBuyIn, 2000); assert.equal(m.stack, 0); assert.equal(m.cashedOut, f.room.hand.endingStacks[m.id] + 1000);
  const settled = structuredClone(f.store.data); assert.equal(f.service.tick(f.room), false); assert.deepEqual(f.store.data, settled);
});

test('a failed server timer save rolls back the draw and retry advances the same committed street once', async t => {
  const f = fixture(t, { encrypted: true }); f.closeBetting(); f.store.save();
  const app = createApp({ dataDir: f.store.directory, actionTickMs: 5 }); t.after(() => app.close());
  const code = f.room.code, before = structuredClone(app.store.data), save = app.store.save;
  const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args));
  app.store.save = () => { throw new Error('synthetic transition save failure'); };
  f.at(f.room.hand.transition.nextAt);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(errors.length > 0); assert.deepEqual(app.store.data, before); assert.deepEqual(app.store.read(), before);
  app.store.save = save;
  for (let i = 0; i < 100 && app.store.data.rooms[code].hand.board.length !== 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const room = app.store.data.rooms[code];
  assert.equal(room.hand.board.length, 3); assert.equal(room.hand.log.filter(e => e.type === 'street').length, 1);
  assert.equal(room.presentation.actionReadyAt, f.time + 600); assert.equal(room.deadline, f.time + 20600);
  assert.deepEqual(app.store.read(), app.store.data);
});
