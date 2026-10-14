import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService, settingsFor } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { verifyProof } from '../src/fairness.js';

function fixture(t, settings = {}, count = 3) {
  let time = 1800000000000; t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: count + 1 }, (_, i) => ({ id: `clock-${i}`, name: `朋友${i}` }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  let service = new RoomService(store); const room = service.create(users[0], { settings });
  for (const u of users.slice(1)) service.join(u, room.code, room.invite);
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, { commandId: randomUUID(), type,
    handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) { cmd(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  cmd(0, 'start');
  const act = (type, extra) => cmd(users.findIndex(u => u.id === room.hand.actingId), type, extra);
  return { users, store, room, cmd, act, get service() { return service; }, get time() { return time; },
    advance(ms) { time += ms; }, restart() { const connections = service.connections; service = new RoomService(store); service.connections = connections; } };
}
function checkToRiver(f) {
  for (let n = 0; f.room.hand.street !== 'river'; n++) {
    assert.ok(n < 20); f.act(availableActions(f.room.hand, f.room.hand.actingId).canCheck ? 'check' : 'call');
  }
}

test('fixed timing rejects configuration influence and derives full-session cards from duration', () => {
  for (const [durationMinutes, expected] of [[30, 3], [45, 6], [60, 6], [90, 9], [720, 72]]) {
    for (const obsolete of [0, 99, -5, null, 'invalid']) {
      const settings = settingsFor({ durationMinutes, actionSeconds: obsolete, timeBankCards: obsolete, timeBankSeconds: obsolete });
      assert.equal(settings.actionSeconds, 20); assert.equal(settings.timeBankSeconds, 30); assert.equal(settings.timeBankCards, expected);
    }
  }
});

test('new members receive one grant, reseating/rejoining/restarting cannot replenish spent cards', t => {
  const f = fixture(t, { durationMinutes: 90 });
  const actor = f.room.hand.actingId, i = f.users.findIndex(u => u.id === actor);
  f.cmd(i, 'timebank'); assert.equal(f.room.members[actor].timeBank.remaining, 8);
  const deadline = f.room.deadline;
  f.restart(); f.service.refreshTimeBanks(f.room); f.service.join(f.users[i], f.room.code, f.room.invite);
  assert.equal(f.room.deadline, deadline); assert.equal(f.room.members[actor].timeBank.remaining, 8);
  const late = { id: 'late-friend', name: '新朋友' }; f.store.data.users[late.id] = late;
  f.advance(1800000); f.service.join(late, f.room.code, f.room.invite);
  assert.equal(f.room.members[late.id].timeBank.remaining, 9);
  assert.equal(f.room.members[actor].timeBank.remaining, 8);
  assert.equal(f.service.state(f.room, late.id).timeBankResetAt, null);
});

test('migration preserves legacy remaining cards and current deadline but next action is fixed 20 seconds', t => {
  const f = fixture(t), actor = f.room.hand.actingId;
  for (const m of Object.values(f.room.members)) m.timeBank = { window: 0, remaining: m.id === actor ? 0 : 2 };
  f.room.settings.actionSeconds = 90; f.room.settings.timeBankSeconds = 120;
  f.room.deadline = f.time + 90000; const deadline = f.room.deadline, before = structuredClone(f.store.data);
  const preview = f.service.state(f.room, actor);
  assert.equal(preview.actions.timeBankCards, 0); assert.equal(preview.actions.timeBankSeconds, 30);
  assert.deepEqual(f.store.data, before, 'read-only projections must not mutate persisted records');
  f.service.refreshTimeBanks(f.room);
  assert.equal(f.room.deadline, deadline); assert.equal(f.room.members[actor].timeBank.remaining, 0);
  f.act('call'); assert.equal(f.room.deadline, f.time + 20000);
  const nextActor = f.room.hand.actingId, next = f.users.findIndex(u => u.id === nextActor);
  f.cmd(next, 'timebank'); assert.equal(f.room.deadline, f.time + 50000); assert.equal(f.room.members[nextActor].timeBank.remaining, 1);
  f.restart(); f.service.refreshTimeBanks(f.room); assert.equal(f.room.members[nextActor].timeBank.remaining, 1);
});

test('legacy missing bank reconstructs spent cards from each hand once, including current unarchived usage', t => {
  const f = fixture(t), actor = f.room.hand.actingId, m = f.room.members[actor];
  delete m.timeBank;
  f.room.hand.timeBankUses = [{ playerId: actor }, { playerId: actor }];
  const duplicate = structuredClone(f.room.hand); f.store.data.hands.push(duplicate);
  f.store.data.hands.push({ id: 'past', roomCode: f.room.code, timeBankUses: [{ playerId: actor }] });
  f.store.data.hands.push({ id: 'elsewhere', roomCode: '000000', timeBankUses: [{ playerId: actor }] });
  f.service.refreshTimeBanks(f.room); assert.equal(m.timeBank.remaining, 3);
  f.service.refreshTimeBanks(f.room); assert.equal(m.timeBank.remaining, 3);
});

test('river bet and call exposes all live contenders including a player departing after settlement', t => {
  const f = fixture(t, {}, 2); checkToRiver(f);
  const bettor = f.room.hand.actingId, index = f.users.findIndex(u => u.id === bettor), originalSeat = f.room.members[bettor].seat;
  f.act('raise', { amount: 20 }); f.cmd(index, 'stand'); f.act('call');
  assert.equal(f.room.hand.status, 'complete'); assert.equal(f.room.hand.result.showdown, true);
  assert.equal(f.room.members[bettor].seat, null);
  const observer = f.users.at(-1).id, state = f.service.state(f.room, observer);
  const departed = state.players.find(p => p.id === bettor);
  assert.equal(departed.seat, null); assert.equal(departed.handSeat, originalSeat); assert.equal(departed.inHand, true);
  for (const p of state.players.filter(p => p.inHand)) { assert.equal(p.cards.filter(Boolean).length, 2); assert.deepEqual(p.shownIndices, [0, 1]); }
  const history = f.service.handFor(observer, f.room.code, f.room.hand.id);
  assert.ok(history.players.every(p => p.cards.every(Boolean)));
  assert.ok(history.proofs.every(proof => verifyProof(history.id, history.commitment, proof)));
});

test('archived mandatory showdown repairs absent shown markers without exposing folded hands or mutating archive', t => {
  const f = fixture(t); const folded = f.room.hand.actingId; f.act('fold'); checkToRiver(f);
  f.act('raise', { amount: 20 }); f.act('call');
  const archive = f.store.data.hands[0]; delete archive.shown; delete f.room.hand.shown;
  const before = structuredClone(f.store.data), observer = f.users.at(-1).id;
  for (const h of [f.service.handFor(observer, f.room.code, archive.id), f.service.exports(archive.players.find(p => !p.folded).id, f.room.code)[0]]) {
    assert.deepEqual(h.players.find(p => p.id === folded).cards, [null, null]);
    assert.ok(h.players.filter(p => p.id !== folded).every(p => p.cards.every(Boolean)));
    assert.equal(Object.keys(h.result.handNames).length, 2);
    assert.ok(h.proofs.every(proof => verifyProof(h.id, h.commitment, proof)));
    assert.equal(h.proofs.length, 9);
  }
  assert.deepEqual(f.service.state(f.room, observer).players.find(p => p.id === folded).cards, [null, null]);
  assert.deepEqual(f.store.data, before);
});

test('river fold stays private even with five public cards and known winner', t => {
  const f = fixture(t, {}, 2); checkToRiver(f); f.act('raise', { amount: 20 }); f.act('fold');
  assert.equal(f.room.hand.result.showdown, false); assert.equal(f.room.hand.board.length, 5);
  const h = f.service.handFor(f.users.at(-1).id, f.room.code, f.room.hand.id);
  assert.ok(h.players.every(p => p.cards.every(c => c === null))); assert.equal(h.proofs.length, 5);
});
