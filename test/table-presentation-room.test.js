import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { createHand, applyAction, availableActions, potPreview, evaluate } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';
import { PracticeBotClient } from '../scripts/practice-bot-client.mjs';
import { readyRoomAction } from './helpers/room-clock.js';

function fixture(t, count = 3) {
  let time = 1800000000000;
  t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: count + 1 }, (_, i) => ({ id: `table-timing-${i}`, name: `朋友${i}`, avatar: 0 }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], {});
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const command = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) { command(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  command(0, 'start');
  const ready = () => readyRoomAction(service, room, value => { time = value; });
  const act = type => { assert.ok(ready(), 'fixture has a legal action'); return command(users.findIndex(user => user.id === room.hand.actingId), type); };
  const state = (id = room.hand.actingId || users[0].id) => service.state(room, id);
  return { users, store, service, room, command, act, ready, state, advance(ms) { time += ms; }, at(value) { time = value; }, get time() { return time; } };
}

function foldFinish(f) { while (f.ready()) f.act('fold'); }

// Room timers enforce the same boundaries for first-party clients and raw API commands.
test('fresh deal and each visible street reserve animation time before a full twenty-second turn and publish ready once', t => {
  const f = fixture(t), started = f.time;
  assert.equal(f.state().hand.actionReadyAt, started + 1100);
  assert.equal(f.room.deadline, started + 21100);
  assert.equal(f.state().actions.turnAvailable, true); assert.equal(f.state().actions.canAct, false);
  const before = structuredClone(f.room.hand);
  f.advance(1099); assert.equal(f.service.tick(f.room), false);
  f.advance(1); const revision = f.room.revision; assert.equal(f.service.tick(f.room), true);
  assert.equal(f.room.revision, revision + 1); assert.equal(f.state().actions.canAct, true);
  assert.equal(f.service.tick(f.room), false); assert.deepEqual(f.room.hand, before);
  for (const boardCount of [3, 4, 5]) {
    while (!f.room.hand.transition) {
      const choices = availableActions(f.room.hand, f.room.hand.actingId);
      f.act(choices.canCheck ? 'check' : 'call');
    }
    assert.equal(f.room.hand.transition.kind, 'street');
    assert.equal(f.room.hand.board.length, boardCount === 3 ? 0 : boardCount - 1);
    assert.equal(f.room.hand.actingId, null); assert.equal(f.room.deadline, null);
    f.advance(899); assert.equal(f.service.tick(f.room), false);
    f.advance(1); assert.equal(f.service.tick(f.room), true);
    assert.equal(f.room.hand.board.length, boardCount);
    const delay = boardCount === 3 ? 900 : 700;
    assert.equal(f.state().hand.actionReadyAt, f.time + delay);
    assert.equal(f.state().hand.turnStartedAt, f.time + delay);
    assert.equal(f.room.deadline, f.time + delay + 20000);
    assert.equal(f.state().actions.canAct, false);
    f.advance(delay); assert.equal(f.service.tick(f.room), true); assert.equal(f.state().actions.canAct, true);
    const oldActor = f.room.hand.actingId; f.act('check');
    assert.notEqual(f.room.hand.actingId, oldActor);
    assert.equal(f.state().actions.canAct, true, 'same-street next player has no repeated card delay');
  }
});

test('a late rabbit timer cannot reveal and replace the result in one tick; a complete five-second hold follows reveal', t => {
  const f = fixture(t); foldFinish(f);
  const handId = f.room.hand.id, settled = f.time;
  assert.equal(f.room.nextHandAt, settled + 5000);
  f.advance(9000); assert.equal(f.service.tick(f.room), true);
  assert.equal(f.room.hand.id, handId); assert.equal(f.room.hand.rabbit.active, false);
  assert.equal(f.room.nextHandAt, f.time + 5000);
  const frozen = structuredClone(f.store.data.hands);
  for (let i = 0; i < 4; i++) { f.advance(1000); assert.equal(f.service.tick(f.room), false); }
  assert.deepEqual(f.store.data.hands, frozen); assert.equal(f.room.hand.id, handId);
  f.advance(999); assert.equal(f.service.tick(f.room), false);
  f.advance(1); assert.equal(f.service.tick(f.room), true); assert.equal(f.room.handNumber, 2);
});

test('normal rabbit reveal gives five seconds and pause/resume cannot skip that minimum', t => {
  const f = fixture(t); foldFinish(f); const id = f.room.hand.id;
  f.advance(1000); f.service.tick(f.room);
  assert.equal(f.room.nextHandAt, f.time + 5000);
  f.command(0, 'autoDeal', { paused: true }); f.advance(4000);
  assert.equal(f.room.nextHandAt, null);
  f.command(0, 'autoDeal', { paused: false });
  assert.ok(f.room.nextHandAt >= f.room.resultReadyAt + 5000);
  f.at(f.room.nextHandAt - 1); f.service.tick(f.room); assert.equal(f.room.hand.id, id);
  f.advance(1); f.service.tick(f.room); assert.equal(f.room.handNumber, 2);
});

test('persisted reveal-ready clock survives restart, without an endlessly sliding deadline', t => {
  const f = fixture(t); foldFinish(f); f.advance(1000); f.service.tick(f.room);
  const data = structuredClone(f.store.data), room = data.rooms[f.room.code], service = new RoomService({ data });
  for (const user of f.users.slice(0, 3)) service.connections.set(`${room.code}:${user.id}`, 1);
  const deadline = room.nextHandAt; f.advance(1000);
  service.connectionChanged(room, f.time, { reconnected: true }); assert.equal(room.nextHandAt, deadline);
  for (let i = 0; i < 3; i++) { f.advance(1000); service.tick(room); assert.equal(room.nextHandAt, deadline); }
  f.at(deadline); service.tick(room); assert.equal(room.handNumber, 2);
});

test('private and public hand categories use only authorized hole cards and the currently dealt board', t => {
  const f = fixture(t, 3), h = f.room.hand;
  for (const viewer of f.users) {
    for (const p of f.service.state(f.room, viewer.id).players) {
      if (p.id === viewer.id && p.inHand) assert.equal(p.handCategory, p.cards[0][0] === p.cards[1][0] ? '一对' : '高牌');
      else assert.equal(p.handCategory, null);
    }
  }
  // Deterministic isolated deal: AA versus KK; third player folds and stays private.
  const original = structuredClone(h), holes = [['As', 'Ah'], ['Ks', 'Kh'], ['Qs', 'Qh']], deck = Array(52);
  for (const p of h.players) for (const [i, index] of p.cardIndices.entries()) deck[index] = holes[p.seat][i];
  for (const [offset, card] of [[1, '2c'], [2, '7d'], [3, '9s'], [5, 'Kd'], [7, 'Ac']]) deck[h.players.length * 2 + offset] = card;
  const rest = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s)).filter(card => !deck.includes(card));
  for (let i = 0; i < 52; i++) if (!deck[i]) deck[i] = rest.shift();
  Object.assign(h, createHand({ id: original.id, players: original.players.map(p => ({ id: p.id, seat: p.seat, name: p.name, stack: p.startingStack })), buttonSeat: original.buttonSeat, smallBlind: 5, bigBlind: 10, deck, deferredRunout: true, deferredTransitions: true }));
  h.audit = commitDeck(h);
  while (!h.runout?.active) f.act(h.actingId === f.users[2].id ? 'fold' : 'allin');
  const check = () => {
    const view = f.state(f.users[3].id), frozen = structuredClone(f.store.data);
    for (const p of view.players.filter(p => p.inHand)) {
      if (p.id === f.users[2].id) { assert.equal(p.handCategory, null); assert.ok(p.cards.every(card => card === null)); }
      else {
        const cards = [...p.cards, ...view.hand.board];
        assert.equal(p.handCategory, cards.length < 5 ? '一对' : evaluate(cards).name);
      }
    }
    for (const user of f.users.slice(0, 3)) {
      const own = f.state(user.id).players.find(p => p.id === user.id);
      const cards = [...own.cards, ...view.hand.board];
      assert.equal(own.handCategory, own.folded || cards.length < 5 ? '一对' : evaluate(cards).name);
    }
    assert.deepEqual(f.store.data, frozen, 'projection never mutates the real hand');
    return view;
  };
  assert.equal(check().hand.board.length, 0);
  while (h.runout.active) { f.at(h.runout.nextAt); f.service.tick(f.room); check(); }
  assert.equal(h.transition.kind, 'showdown'); f.at(h.transition.nextAt); f.service.tick(f.room);
  assert.equal(check().players.find(p => p.id === f.users[0].id).handCategory, '三条');
});

test('pot display conserves matched chips and unmatched bet, including folded money, without mutating rules state', () => {
  const h = createHand({ id: 'pot-preview-independent', players: [
    { id: 'a', seat: 0, stack: 50 }, { id: 'b', seat: 1, stack: 100 }, { id: 'c', seat: 2, stack: 200 }, { id: 'd', seat: 3, stack: 200 },
  ], buttonSeat: 0, smallBlind: 5, bigBlind: 10, deferredRunout: true });
  // Independent contribution fixture: 50/100/200/100, last player folded.
  for (const [i, p] of h.players.entries()) { p.contributed = [50, 100, 200, 100][i]; p.deadContribution = 0; p.folded = i === 3; }
  const before = structuredClone(h), view = potPreview(h);
  assert.deepEqual(view, { pots: [{ amount: 200, eligibleIds: ['a', 'b', 'c'] }, { amount: 150, eligibleIds: ['b', 'c'] }], uncalledBets: [{ playerId: 'c', amount: 100 }] });
  assert.equal(view.pots.reduce((n, p) => n + p.amount, 0) + view.uncalledBets.reduce((n, p) => n + p.amount, 0), 450);
  assert.deepEqual(h, before);
  const dead = structuredClone(h); dead.players[3].deadContribution = 10;
  const deadBefore = structuredClone(dead), deadView = potPreview(dead);
  assert.equal(deadView.pots.reduce((n, p) => n + p.amount, 0) + deadView.uncalledBets.reduce((n, p) => n + p.amount, 0), 450);
  assert.deepEqual(dead, deadBefore);
});

test('practice bot cannot act during deal or board presentation even if a stale canAct flag is true', t => {
  let time = 1800000000000; t.mock.method(Date, 'now', () => time);
  const bot = new PracticeBotClient({ baseUrl: 'http://127.0.0.1', token: 'isolated-token', roomCode: '123456', decideAction: () => ({ action: 'check' }) });
  bot.accept({ code: '123456', meId: 'a', hostId: 'a', access: 'invite', settings: { maxPlayers: 2 }, status: 'playing', revision: 1,
    serverTime: time, deadline: time + 20900, actions: { canAct: true }, players: [{ id: 'a', seat: 0 }, { id: 'b', seat: 1 }],
    hand: { id: 'h', number: 1, status: 'playing', actingId: 'a', actionSeq: 5, actionReadyAt: time + 900 } });
  assert.equal(bot.canAct('h:5'), false); time += 899; assert.equal(bot.canAct('h:5'), false);
  time++; assert.equal(bot.canAct('h:5'), true); assert.equal(bot.canAct('h:4'), false);
});

test('one revealed card, folded cards and rabbit cards never upgrade the public live-hand category', t => {
  const f = fixture(t, 2); foldFinish(f);
  const winner = f.room.hand.players.find(p => !p.folded), folder = f.room.hand.players.find(p => p.folded);
  const wi = f.users.findIndex(u => u.id === winner.id), fi = f.users.findIndex(u => u.id === folder.id);
  f.command(wi, 'show', { indices: [0] });
  assert.equal(f.state(f.users[2].id).players.find(p => p.id === winner.id).handCategory, null);
  const expected = winner.cards[0][0] === winner.cards[1][0] ? '一对' : '高牌';
  assert.equal(f.state(winner.id).players.find(p => p.id === winner.id).handCategory, expected);
  f.command(wi, 'show', { indices: [0, 1] }); f.command(fi, 'show', { indices: [0, 1] });
  assert.equal(f.state(f.users[2].id).players.find(p => p.id === winner.id).handCategory, expected);
  assert.equal(f.state(f.users[2].id).players.find(p => p.id === folder.id).handCategory, null);
  f.advance(1000); f.service.tick(f.room);
  assert.equal(f.room.hand.rabbit.board.length, 5); assert.equal(f.room.hand.board.length, 0);
  assert.equal(f.state(f.users[2].id).players.find(p => p.id === winner.id).handCategory, expected);
});
