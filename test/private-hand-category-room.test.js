import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { createHand, availableActions } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';
import { readyRoomAction } from './helpers/room-clock.js';

function fixture(t, count = 3, { board = ['Kc', '2d', '7h', 'Qc', 'Kd'], holes = [['Ks', 'Qs'], ['As', 'Ah'], ['Js', 'Jh']] } = {}) {
  let time = 1800000000000;
  t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: count + 1 }, (_, seat) => ({ id: `own-category-${seat}`, name: `朋友${seat}`, avatar: 0 }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], {});
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const command = (id, type, extra = {}) => service.command(users.find(user => user.id === id), room.code, {
    type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra,
  });
  for (let seat = 0; seat < count; seat++) {
    command(users[seat].id, 'sit', { seat, amountBB: 100 });
    service.connections.set(`${room.code}:${users[seat].id}`, 1);
  }
  command(users[0].id, 'start');
  // KQ progresses from high card to a pair, two pair and a full house.
  const h = room.hand, deck = Array(52);
  for (const p of h.players) for (const [i, index] of p.cardIndices.entries()) deck[index] = holes[p.seat][i];
  for (const [index, offset] of [1, 2, 3, 5, 7].entries()) deck[count * 2 + offset] = board[index];
  const rest = [...'cdhs'].flatMap(suit => [...'23456789TJQKA'].map(rank => rank + suit)).filter(card => !deck.includes(card));
  for (let i = 0; i < deck.length; i++) if (!deck[i]) deck[i] = rest.shift();
  Object.assign(h, createHand({ id: h.id, players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, stack: p.startingStack })),
    buttonSeat: h.buttonSeat, smallBlind: 5, bigBlind: 10, deck, deferredRunout: true, deferredTransitions: true }));
  h.audit = commitDeck(h);
  const ready = () => readyRoomAction(service, room, value => { time = value; });
  const act = type => { assert.ok(ready()); return command(h.actingId, type); };
  const tick = () => { time = h.transition?.nextAt ?? h.runout?.nextAt ?? h.rabbit?.nextAt; assert.ok(Number.isFinite(time)); service.tick(room); };
  const finishStreet = () => {
    assert.ok(ready());
    while (h.actingId) act(availableActions(h, h.actingId).canCheck ? 'check' : 'call');
    tick();
  };
  const category = (owner = users[0].id, viewer = owner, targetService = service, targetRoom = room) =>
    targetService.state(targetRoom, viewer).players.find(p => p.id === owner).handCategory;
  const timeout = () => { time = room.deadline; assert.ok(Number.isFinite(time)); assert.equal(service.tick(room), true); };
  return { users, store, service, room, hand: h, command, ready, act, tick, finishStreet, category, timeout };
}

test('own category is private from the deal and progresses on ordinary streets before showdown', t => {
  const f = fixture(t), ownId = f.users[0].id, observerId = f.users[3].id;
  const assertPrivate = expected => {
    const frozen = structuredClone(f.store.data);
    assert.equal(f.category(ownId), expected);
    assert.equal(f.category(ownId, f.users[1].id), null);
    assert.equal(f.category(ownId, observerId), null);
    assert.deepEqual(f.store.data, frozen, 'reading categories cannot alter deal, result or log');
  };
  assertPrivate('高牌');
  assert.equal(f.category(f.users[1].id), '一对');
  for (const expected of ['一对', '两对', '葫芦']) { f.finishStreet(); assertPrivate(expected); }
  assert.equal(f.hand.result, null, 'private display does not require a completed showdown');
});

test('own folded category stays at the fold street while other players continue and after reconnect', t => {
  const f = fixture(t), ownId = f.users[0].id;
  f.finishStreet(); assert.equal(f.category(ownId), '一对');
  f.ready();
  while (f.hand.actingId !== ownId) f.act('check');
  f.act('fold'); f.tick();
  assert.equal(f.hand.street, 'turn'); assert.equal(f.category(ownId), '一对');
  f.finishStreet(); assert.equal(f.hand.street, 'river');
  assert.equal(f.category(ownId), '一对', 'future Q and K cannot turn a folded pair into a full house');
  for (const other of f.users.slice(1)) assert.equal(f.category(ownId, other.id), null);
  const data = structuredClone(f.store.data), restored = new RoomService({ data }), room = data.rooms[f.room.code];
  assert.equal(f.category(ownId, ownId, restored, room), '一对');
  f.service.connections.delete(`${f.room.code}:${ownId}`);
  f.service.join(f.users[0], f.room.code, f.room.invite);
  assert.equal(f.category(ownId), '一对');
});

test('post-hand rabbit reveal never improves a private or voluntarily exposed actual category', t => {
  const f = fixture(t, 2), ownId = f.users[0].id, observerId = f.users[2].id;
  f.finishStreet(); assert.equal(f.category(ownId), '一对');
  f.ready();
  while (f.hand.actingId !== ownId) f.act('check');
  f.act('fold'); f.tick();
  assert.equal(f.hand.status, 'complete'); assert.equal(f.hand.board.length, 3);
  f.command(ownId, 'show', { indices: [0] });
  assert.equal(f.category(ownId), '一对'); assert.equal(f.category(ownId, observerId), null);
  f.tick();
  assert.equal(f.hand.rabbit.board.length, 5); assert.equal(f.hand.board.length, 3);
  assert.equal(f.category(ownId), '一对');
  f.command(ownId, 'show', { indices: [0, 1] });
  assert.equal(f.category(ownId), '一对'); assert.equal(f.category(ownId, observerId), null);
});

test('own category resets for a new hand and cannot reconstruct missing legacy fold context from future cards', t => {
  const f = fixture(t), own = f.hand.players.find(p => p.id === f.users[0].id);
  f.finishStreet(); assert.equal(f.category(own.id), '一对');
  const next = createHand({ id: 'next-private-category', players: f.hand.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, stack: 1000 })),
    buttonSeat: 1, smallBlind: 5, bigBlind: 10, deferredRunout: true });
  const nextOwn = next.players.find(p => p.id === own.id);
  assert.equal(f.service.handCategoryFor(next, nextOwn, own.id), nextOwn.cards[0][0] === nextOwn.cards[1][0] ? '一对' : '高牌');
  own.folded = true; assert.equal(f.category(own.id), null, 'legacy missing fold context must not expose hypothetical improvements');
});

for (const [street, expected] of [['preflop', '高牌'], ['turn', '两对'], ['river', '葫芦']]) {
  test(`a private ${street} fold retains its actual category through the remaining showdown`, t => {
    const f = fixture(t), ownId = f.users[0].id;
    while (f.hand.street !== street) f.finishStreet();
    f.ready();
    while (f.hand.actingId !== ownId) f.act(availableActions(f.hand, f.hand.actingId).canCheck ? 'check' : 'call');
    f.act('fold');
    while (f.hand.status !== 'complete') {
      if (f.hand.transition) f.tick();
      else f.finishStreet();
      assert.equal(f.category(ownId), expected);
    }
    assert.equal(f.hand.result.showdown, true);
    assert.equal(f.category(ownId, f.users[3].id), null);
  });
}

test('a disconnected player timing out facing a flop bet freezes the pair at the real fold street', t => {
  const f = fixture(t), ownId = f.users[0].id;
  f.finishStreet(); f.ready();
  f.command(f.hand.actingId, 'raise', { amount: 20 });
  f.act('call'); assert.equal(f.hand.actingId, ownId);
  f.service.connections.delete(`${f.room.code}:${ownId}`);
  f.timeout();
  assert.equal(f.hand.players.find(p => p.id === ownId).folded, true);
  assert.equal(f.hand.log.find(event => event.playerId === ownId && event.type === 'fold').street, 'flop');
  f.tick(); f.finishStreet();
  assert.equal(f.hand.street, 'river'); assert.equal(f.category(ownId), '一对');
});

test('omitting a viewer never grants private access, and a single public card cannot reveal the missing card category', t => {
  const f = fixture(t, 2), winner = f.hand.players.find(p => p.id === f.users[1].id);
  assert.equal(f.service.handCategoryFor(f.hand, winner), null);
  assert.equal(f.service.handCategoryFor(f.hand, winner, 'unrelated-user'), null);
  assert.throws(() => f.service.state(f.room), error => error.status === 403);
  assert.throws(() => f.service.state(f.room, 'unrelated-user'), error => error.status === 403);
  f.act('fold'); f.tick();
  f.command(winner.id, 'show', { indices: [0] });
  const view = f.service.state(f.room, f.users[2].id).players.find(p => p.id === winner.id);
  assert.deepEqual(view.cards, ['As', null]); assert.equal(view.handCategory, null);
  assert.equal(f.category(winner.id), '一对');
  assert.equal(f.service.handCategoryFor(f.hand, winner), null);
  f.command(winner.id, 'show', { indices: [0, 1] });
  assert.equal(f.category(winner.id, f.users[2].id), '一对');
  assert.equal(f.service.handCategoryFor(f.hand, winner), '一对', 'fully public cards need no private viewer identity');
});

for (const [river, expected] of [['9s', '同花顺'], ['As', '同花顺']]) {
  test(`four-suit draw is not a made flush and upgrades only on dealt streets through ${river} (${expected})`, t => {
    const f = fixture(t, 3, { board: ['Js', '2s', '7d', 'Ts', river], holes: [['Ks', 'Qs'], ['Ac', 'Ah'], ['Jc', 'Jh']] });
    assert.equal(f.category(), '高牌');
    f.finishStreet(); assert.equal(f.category(), '高牌', 'four spades is still only a draw');
    f.finishStreet(); assert.equal(f.category(), '同花');
    f.finishStreet(); assert.equal(f.category(), expected);
    assert.equal(f.category(f.users[0].id, f.users[3].id), null, 'strong private category remains private');
  });
}

test('legacy result labels normalize for live views, history and exports without rewriting archives or exposing folded cards', t => {
  const f = fixture(t, 3, { board: ['Ts', 'Js', 'Qs', 'Ks', 'As'], holes: [['2c', '3c'], ['4d', '5d'], ['6h', '7h']] });
  const foldedId = f.hand.actingId;
  f.act('fold');
  while (f.hand.status === 'playing') {
    if (!f.ready()) break;
    f.act(availableActions(f.hand, f.hand.actingId).canCheck ? 'check' : 'call');
  }
  assert.equal(f.hand.status, 'complete');
  const archived = f.store.data.hands[0], viewerId = f.hand.players.find(p => !p.folded).id;
  // Simulate pre-update records, including an untrusted stale folded-player label.
  for (const h of [f.hand, archived]) for (const p of h.players) h.result.handNames[p.id] = '皇家同花顺';
  const frozen = structuredClone(f.store.data);
  const live = f.service.state(f.room, viewerId);
  const history = f.service.handFor(viewerId, f.room.code, archived.id);
  const exported = f.service.exports(viewerId, f.room.code)[0];
  for (const result of [live.hand.result, history.result, exported.result]) {
    assert.deepEqual(Object.values(result.handNames), ['同花顺', '同花顺']);
    assert.equal(Object.hasOwn(result.handNames, foldedId), false);
  }
  for (const hand of [history, exported]) assert.deepEqual(hand.players.find(p => p.id === foldedId).cards, [null, null]);
  assert.deepEqual(f.store.data, frozen, 'display normalization must not rewrite persistent cards, results or balances');
  assert.equal(archived.result.handNames[viewerId], '皇家同花顺');
});

function completedFlopFold(f) {
  const ownId = f.users[0].id;
  f.finishStreet(); f.ready();
  while (f.hand.actingId !== ownId) f.act('check');
  f.act('fold'); f.tick();
  assert.equal(f.hand.status, 'complete');
  assert.equal(f.hand.result.showdown, false);
  assert.equal(f.hand.board.length, 3);
  return ownId;
}

const displayedCategory = (f, owner = f.users[0].id, viewer = owner, service = f.service, room = f.room) =>
  service.state(room, viewer).players.find(p => p.id === owner).displayHandCategory;

test('a folded owner sees the improved rabbit category only after public reveal; actual category and hidden opponents stay unchanged', t => {
  const f = fixture(t, 2), observerId = f.users[2].id;
  assert.equal(displayedCategory(f), null, 'the initial deal has no supplemental category');
  const ownId = completedFlopFold(f);
  assert.equal(f.category(ownId), '一对');
  assert.equal(displayedCategory(f), null, 'pending rabbit cards must not be evaluated ahead of their reveal');
  assert.deepEqual(f.hand.rabbit.board, f.hand.board);
  f.tick();
  assert.equal(displayedCategory(f), '葫芦');
  assert.equal(f.category(ownId), '一对');
  assert.deepEqual(f.hand.board, ['Kc', '2d', '7h']);
  for (const viewer of f.users.slice(1)) assert.equal(displayedCategory(f, ownId, viewer.id), null);
  f.command(ownId, 'show', { indices: [0] });
  assert.equal(displayedCategory(f, ownId, observerId), null);
  f.command(ownId, 'show', { indices: [0, 1] });
  assert.equal(displayedCategory(f, ownId, observerId), null, 'folded opponents retain the existing category privacy gate even after voluntary reveal');
  assert.equal(displayedCategory(f), '葫芦');
});

test('a rabbit winner exposes a supplemental category to others only when both hole cards are public', t => {
  const f = fixture(t, 2), winnerId = f.users[1].id, observerId = f.users[2].id;
  completedFlopFold(f); f.tick();
  assert.equal(f.category(winnerId), '一对');
  assert.equal(displayedCategory(f, winnerId), '两对');
  assert.equal(displayedCategory(f, winnerId, observerId), null);
  f.command(winnerId, 'show', { indices: [0] });
  const single = f.service.state(f.room, observerId).players.find(p => p.id === winnerId);
  assert.deepEqual(single.cards, ['As', null]);
  assert.equal(single.handCategory, null);
  assert.equal(single.displayHandCategory, null, 'a category must not reveal information about the second hidden card');
  f.command(winnerId, 'show', { indices: [1] });
  assert.equal(displayedCategory(f, winnerId, observerId), '两对');
  assert.equal(f.category(winnerId, observerId), '一对');
});

test('legacy partial rabbit reveals and service reconstruction use only the persisted visible prefix', t => {
  const f = fixture(t, 2), ownId = completedFlopFold(f);
  // Simulate a persisted v1 record that had revealed the turn, but not the river.
  Object.assign(f.hand.rabbit, { version: 1, board: [...f.hand.board, 'Qc'], indices: [f.hand.deck.indexOf('Qc')], active: true });
  assert.equal(displayedCategory(f), '两对', 'the hidden king on the river must not turn this into a full house yet');
  assert.equal(f.category(ownId), '一对');
  const partialData = structuredClone(f.store.data), restored = new RoomService({ data: partialData });
  assert.equal(displayedCategory(f, ownId, ownId, restored, partialData.rooms[f.room.code]), '两对');
  f.tick();
  assert.equal(f.hand.rabbit.board.length, 5);
  assert.equal(displayedCategory(f), '葫芦');
  const fullData = structuredClone(f.store.data), restoredFull = new RoomService({ data: fullData });
  assert.equal(displayedCategory(f, ownId, ownId, restoredFull, fullData.rooms[f.room.code]), '葫芦');
  assert.equal(f.category(ownId, ownId, restoredFull, fullData.rooms[f.room.code]), '一对');
});

test('supplemental category projections cannot rewrite settlement, ledger, equities or archived categories', t => {
  const f = fixture(t, 2), ownId = completedFlopFold(f);
  const immutableResult = structuredClone({ board: f.hand.board, log: f.hand.log, result: f.hand.result,
    equityFrames: f.hand.equityFrames, endingStacks: f.hand.endingStacks, ledger: f.store.data.ledger });
  f.tick();
  const before = structuredClone(f.store.data);
  for (const viewer of f.users) {
    const view = f.service.state(f.room, viewer.id);
    assert.equal(view.players.find(p => p.id === ownId).displayHandCategory, viewer.id === ownId ? '葫芦' : null);
  }
  assert.deepEqual(f.store.data, before, 'reading display-only categories must be a pure projection');
  assert.deepEqual({ board: f.hand.board, log: f.hand.log, result: f.hand.result,
    equityFrames: f.hand.equityFrames, endingStacks: f.hand.endingStacks, ledger: f.store.data.ledger }, immutableResult);
  for (const h of [f.hand, ...f.store.data.hands]) for (const p of h.players)
    assert.equal(Object.hasOwn(p, 'displayHandCategory'), false, 'hypothetical display categories must never become persisted hand data');
});

test('supplemental categories reject mismatched, unextended and non-rabbit boards', t => {
  const f = fixture(t, 2);
  completedFlopFold(f); f.tick();
  const rabbit = structuredClone(f.hand.rabbit);
  for (const changed of [
    { ...rabbit, originalCount: 0 },
    { ...rabbit, board: ['Ac', ...rabbit.board.slice(1)] },
    { ...rabbit, board: [...f.hand.board] },
    { ...rabbit, board: rabbit.board.slice(0, 2) },
    { ...rabbit, board: [...rabbit.board, '3d'] },
  ]) {
    f.hand.rabbit = changed;
    assert.equal(displayedCategory(f), null);
  }
  f.hand.rabbit = rabbit;
  f.hand.result.showdown = true;
  assert.equal(displayedCategory(f), null, 'a real showdown cannot acquire a hypothetical rabbit category');
});
