import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { verifyProof } from '../src/fairness.js';
import { aggregateAnalytics } from '../src/analytics.js';
import { exportPhh } from '../src/phh.js';
import { replaySnapshot } from '../public/replay.js';

function fixture(count, settings = {}) {
  const store = { data: { version: 1, users: {}, rooms: {}, hands: [], ledger: [] } };
  const users = Array.from({ length: count + 1 }, (_, i) => ({ id: `rabbit-oracle-${i}`, name: `验算朋友${i}`, avatar: 0 }));
  for (const user of users) store.data.users[user.id] = user;
  const service = new RoomService(store), room = service.create(users[0], { settings });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const command = (index, type, extra = {}) => service.command(users[index], room.code, {
    type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra,
  });
  for (let i = 0; i < count; i++) {
    command(i, 'sit', { seat: i, amountBB: 100 });
    service.connections.set(`${room.code}:${users[i].id}`, 1);
  }
  const act = type => command(users.findIndex(user => user.id === room.hand.actingId), type);
  command(0, 'start');
  return { store, users, service, room, command, act, observer: users.at(-1).id };
}

function foldAt(f, boardCount) {
  for (let guard = 0; f.room.hand.board.length < boardCount; guard++) {
    assert.ok(guard < 100);
    const choices = availableActions(f.room.hand, f.room.hand.actingId);
    f.act(choices.canCheck ? 'check' : 'call');
  }
  while (f.room.hand.status === 'playing') f.act('fold');
  return f.room.hand;
}

function actualOnly(hand) {
  const actual = structuredClone(hand); delete actual.rabbit;
  return actual;
}

test('independent deal-position oracle covers 2–9 players and all fold streets without changing settlement, stats or PHH', t => {
  let timestamp = 1800000000000;
  t.mock.method(Date, 'now', () => timestamp);
  for (let count = 2; count <= 9; count++) for (const originalCount of [0, 3, 4, 5]) {
    const f = fixture(count), h = foldAt(f, originalCount);
    // Deal two rounds of hole cards, then burn/flop/flop/flop/burn/turn/burn/river.
    // This positional oracle deliberately never uses the implementation cursor.
    const firstBurn = 2 * count;
    const boardPositions = [firstBurn + 1, firstBurn + 2, firstBurn + 3, firstBurn + 5, firstBurn + 7];
    const expected = boardPositions.map(position => h.deck[position]);
    assert.deepEqual(h.board, expected.slice(0, originalCount));
    const actual = actualOnly(h), ledger = structuredClone(f.store.data.ledger);
    const stats = aggregateAnalytics(f.store.data, f.users[0].id);
    const historyBefore = f.service.handFor(f.observer, f.room.code, h.id);
    const phh = exportPhh([historyBefore], [], f.observer);
    if (originalCount === 5) { assert.equal(h.rabbit ?? null, null); continue; }
    assert.equal(h.rabbit.nextAt, timestamp + 1000);
    for (let exposed = originalCount; exposed <= 5; exposed++) {
      if (exposed > originalCount) {
        const next = h.rabbit.nextAt;
        assert.equal(f.service.tick(f.room, next - 1), false);
        timestamp = next;
        assert.equal(f.service.tick(f.room, timestamp), true);
        assert.equal(f.room.hand.id, h.id, 'revealing the last preview card cannot start a new hand');
      }
      const state = f.service.state(f.room, f.observer), history = f.service.handFor(f.observer, f.room.code, h.id);
      assert.deepEqual(state.hand.rabbit.board, expected.slice(0, exposed));
      assert.deepEqual(history.rabbit, state.hand.rabbit);
      assert.deepEqual(state.hand.board, expected.slice(0, originalCount));
      assert.deepEqual(state.hand.proofs.map(proof => proof.position), boardPositions.slice(0, originalCount));
      assert.deepEqual(state.hand.rabbit.proofs.map(proof => proof.position), boardPositions.slice(originalCount, exposed));
      assert.ok(state.hand.rabbit.proofs.every(proof => verifyProof(h.id, h.audit.root, proof)));
      for (const key of ['cursor', 'indices', 'deck', 'deckCursor', 'burnIndices', 'futureBoard']) assert.equal(Object.hasOwn(state.hand.rabbit, key), false);
      assert.ok(state.players.filter(player => player.inHand).every(player => player.cards.every(card => card === null)));
      assert.deepEqual(actualOnly(h), actual);
      assert.deepEqual(actualOnly(f.store.data.hands[0]), actual);
      assert.deepEqual(f.store.data.ledger, ledger);
      assert.deepEqual(aggregateAnalytics(f.store.data, f.users[0].id), stats);
      assert.equal(exportPhh([history], [], f.observer), phh);
      assert.equal(replaySnapshot(history, Math.max(0, history.log.length - 1), f.observer).rabbit, null);
      const result = replaySnapshot(history, history.log.length, f.observer);
      assert.deepEqual(result.board, h.board); assert.deepEqual(result.rabbit, state.hand.rabbit);
      if (exposed < 5) { assert.equal(h.rabbit.active, true); if (exposed > originalCount) assert.equal(h.rabbit.nextAt, timestamp + 650); }
      else { assert.equal(h.rabbit.active, false); assert.ok(f.room.nextHandAt >= timestamp + 1300); }
    }
  }
});

test('bomb-pot flop fold follows the same original deck continuation without replaying synthetic preflop cards', t => {
  let timestamp = 1800000000000;
  t.mock.method(Date, 'now', () => timestamp);
  const f = fixture(5, { bombPot: true, bombEveryHands: 1, bombAnteBB: 2 });
  assert.equal(f.room.hand.bombPot, true);
  const h = foldAt(f, 3), expected = [11, 12, 13, 15, 17].map(index => h.deck[index]);
  const actual = actualOnly(h);
  while (h.rabbit.active) { timestamp = h.rabbit.nextAt; f.service.tick(f.room, timestamp); }
  assert.deepEqual(h.rabbit.board, expected);
  assert.deepEqual(actualOnly(h), actual);
  const history = f.service.handFor(f.observer, f.room.code, h.id);
  const clean = { ...history }; delete clean.rabbit;
  assert.equal(exportPhh([history], [], f.observer), exportPhh([clean], [], f.observer));
});
