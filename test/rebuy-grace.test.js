import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService, settingsFor } from '../src/room.js';
import { createHand } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';

function fixture(t, { count = 4, settings = {} } = {}) {
  let time = 1800000000000;
  t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: 6 }, (_, i) => ({ id: `rebuy-${i}`, name: `朋友${i}`, avatar: i }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], { settings });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const command = (i, type, extra = {}) => service.command(users[i], room.code, { type, handId: room.hand?.id, actionSeq: room.hand?.log.length, commandId: randomUUID(), ...extra });
  for (let i = 0; i < count; i++) { command(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  const advance = milliseconds => { time += milliseconds; };
  // Deterministic test-only deck: seat 0 has AA and wins on a dry low board.
  function start() {
    command(0, 'start'); const h = room.hand, deck = Array(52), holes = [['As','Ah'],['Kd','Kc'],['Qd','Qc'],['Jd','Jc'],['Td','Tc']];
    for (const p of h.players) for (const [i, index] of p.cardIndices.entries()) deck[index] = holes[p.seat][i];
    for (const [offset, card] of [[1,'2h'],[2,'4d'],[3,'7s'],[5,'9c'],[7,'3h']]) deck[h.players.length * 2 + offset] = card;
    const rest = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s)).filter(card => !deck.includes(card));
    for (let i = 0; i < deck.length; i++) if (!deck[i]) deck[i] = rest.shift();
    Object.assign(h, createHand({ id: h.id, players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, stack: p.startingStack })),
      buttonSeat: h.buttonSeat, smallBlind: h.smallBlind, bigBlind: h.bigBlind, deck, deferredRunout: true }));
    h.audit = commitDeck(h);
  }
  function bust(indices = [1], onRunout = () => {}) {
    start(); let steps = 0, notified = false;
    while (room.hand.status === 'playing') {
      assert.ok(++steps < 30);
      if (room.hand.runout?.active) { if (!notified) { onRunout(); notified = true; } time = room.hand.runout.nextAt; service.tick(room, time); }
      else { const i = users.findIndex(u => u.id === room.hand.actingId); command(i, i === 0 || indices.includes(i) ? 'allin' : 'fold'); }
    }
    assert.deepEqual(room.hand.players.filter(p => p.stack === 0).map(p => p.seat), indices);
    return time;
  }
  const connect = (i, online) => { service.connections.set(`${room.code}:${users[i].id}`, online ? 1 : 0); service.connectionChanged(room, time, { reconnected: online }); };
  const state = i => service.state(room, users[i].id);
  return { users, store, service, room, command, advance, start, bust, connect, state, get time() { return time; } };
}

test('new and copied table settings use fixed 20-second actions', t => {
  assert.equal(settingsFor().actionSeconds, 20);
  for (const value of [15, 20, 30, 90, 14, 91, 30.5]) assert.equal(settingsFor({ actionSeconds: value }).actionSeconds, 20);
  assert.equal(settingsFor({}, { ...settingsFor(), actionSeconds: 30 }).actionSeconds, 20);
  assert.equal(settingsFor({}, { ...settingsFor(), actionSeconds: 15 }).actionSeconds, 20);
  const f = fixture(t, { settings: { actionSeconds: 15 } }); f.start(); assert.equal(f.room.deadline, f.time + 20000);
});

test('a freshly busted seated player gets exactly one shared extra five seconds and is skipped after its deadline', t => {
  const f = fixture(t), ended = f.bust(), hand = f.room.hand.id, loser = f.users[1].id;
  assert.deepEqual(f.state(1).autoDeal.rebuyGrace, { handId: hand, eligibleIds: [loser], pendingIds: [loser], startsAt: ended + 5000, endsAt: ended + 10000, active: false });
  assert.equal(f.room.nextHandAt, ended + 5000);
  f.advance(4999); assert.equal(f.service.tick(f.room), false); assert.equal(f.room.hand.id, hand);
  f.advance(1); f.service.tick(f.room); assert.equal(f.room.nextHandAt, ended + 10000); assert.equal(f.state(1).autoDeal.rebuyGrace.active, true);
  f.advance(4999); assert.equal(f.service.tick(f.room), false); assert.equal(f.room.hand.id, hand);
  f.advance(1); f.service.tick(f.room); assert.equal(f.room.handNumber, 2); assert.equal(f.room.hand.players.some(p => p.id === loser), false);
  assert.equal(f.state(1).autoDeal.rebuyGrace, null); assert.equal(f.service.tick(f.room), false);
  assert.equal(f.store.data.hands.length, 1);
});

test('a buy-in during the original result hold never shortens five seconds or adds a fresh five seconds', t => {
  const f = fixture(t), ended = f.bust(), hand = f.room.hand.id;
  f.advance(3000); f.command(1, 'buyin', { amountBB: 100 });
  assert.equal(f.room.hand.id, hand); assert.equal(f.room.nextHandAt, ended + 5000); assert.deepEqual(f.state(1).autoDeal.rebuyGrace.pendingIds, []);
  f.advance(1999); assert.equal(f.service.tick(f.room), false); f.advance(1); f.service.tick(f.room);
  assert.equal(f.room.handNumber, 2); assert.equal(f.room.hand.players.some(p => p.id === f.users[1].id), true);
});

test('several busted players share one deadline; the last buy-in starts immediately and its retry cannot credit twice', t => {
  const f = fixture(t, { count: 5 }), ended = f.bust([1, 2]), hand = f.room.hand.id;
  assert.equal(f.state(0).autoDeal.rebuyGrace.eligibleIds.length, 2);
  f.advance(6000); f.service.tick(f.room); const deadline = f.room.nextHandAt;
  f.command(1, 'buyin', { amountBB: 100 }); assert.equal(f.room.hand.id, hand); assert.equal(f.room.nextHandAt, deadline);
  assert.deepEqual(f.state(2).autoDeal.rebuyGrace.pendingIds, [f.users[2].id]);
  f.advance(1000); const commandId = randomUUID(); f.command(2, 'buyin', { amountBB: 100, commandId });
  assert.equal(f.room.handNumber, 2); assert.ok(f.time < ended + 10000);
  const before = structuredClone(f.store.data); f.command(2, 'buyin', { amountBB: 100, commandId }); assert.deepEqual(f.store.data, before);
  assert.equal(f.store.data.ledger.filter(row => row.type === 'buyin' && row.playerId === f.users[2].id).length, 2);
});

test('leaving or explicitly sitting out completes the extra wait without forcing unavailable players into the next hand', t => {
  const f = fixture(t, { count: 5 }); f.bust([1, 2]); f.advance(6000); f.service.tick(f.room);
  f.command(1, 'stand'); assert.equal(f.room.handNumber, 1);
  f.command(2, 'sitout', { value: true }); assert.equal(f.room.handNumber, 2);
  assert.ok(f.room.hand.players.every(p => ![f.users[1].id, f.users[2].id].includes(p.id)));
});

test('buy-in cap, prior zero stacks and observers do not create grace candidates', t => {
  const f = fixture(t, { settings: { maxTotalBuyInBB: 150 } });
  f.room.members[f.users[4].id].seat = 8; f.room.members[f.users[4].id].totalBuyIn = 1000;
  const ended = f.bust(); assert.equal(f.state(1).autoDeal.rebuyGrace, null);
  assert.throws(() => f.command(1, 'buyin', { amountBB: 100 }), /累计带入/);
  f.advance(5000); f.service.tick(f.room); assert.equal(f.room.handNumber, 2); assert.equal(f.time, ended + 5000);
  assert.ok(f.room.hand.players.every(p => ![f.users[1].id, f.users[4].id, f.users[5].id].includes(p.id)));
});

test('departures declared during all-in runout are applied before finding fresh rebuy candidates', t => {
  const f = fixture(t, { count: 5 }), ended = f.bust([1, 2], () => {
    f.command(1, 'stand'); f.command(2, 'sitout', { value: true });
    assert.equal(f.room.members[f.users[1].id].pendingDeparture, 'stand');
    assert.equal(f.room.members[f.users[2].id].pendingDeparture, 'sitout');
    assert.equal(f.state(1).autoDeal.rebuyGrace, null);
  });
  assert.equal(f.state(1).autoDeal.rebuyGrace, null);
  assert.equal(f.room.members[f.users[1].id].seat, null); assert.equal(f.room.members[f.users[2].id].sittingOut, true);
  f.advance(5000); f.service.tick(f.room); assert.equal(f.time, ended + 5000); assert.equal(f.room.handNumber, 2);
});

test('insufficient players remain waiting, but topping up during grace resumes immediately after the original hold', t => {
  const f = fixture(t, { count: 2 }), ended = f.bust(); assert.equal(f.room.nextHandAt, null);
  f.advance(5000); assert.equal(f.service.tick(f.room), true); assert.equal(f.state(1).autoDeal.rebuyGrace.active, true);
  assert.equal(f.room.handNumber, 1); f.advance(1000); f.command(1, 'buyin', { amountBB: 100 });
  assert.equal(f.room.handNumber, 2); assert.equal(f.time, ended + 6000);
});

test('expired insufficient-player grace never repeats, and a later top-up uses ordinary waiting rules', t => {
  const f = fixture(t, { count: 2 }); f.bust(); f.advance(10000); f.service.tick(f.room);
  assert.equal(f.room.handNumber, 1); assert.equal(f.room.nextHandAt, null); assert.equal(f.state(1).autoDeal.rebuyGrace.active, false);
  const snapshot = structuredClone(f.store.data); for (let i = 0; i < 10; i++) { f.advance(1000); assert.equal(f.service.tick(f.room), false); }
  assert.deepEqual(f.store.data, snapshot); f.command(1, 'buyin', { amountBB: 100 }); assert.equal(f.room.nextHandAt, f.time + 5000);
  f.advance(5000); f.service.tick(f.room); assert.equal(f.room.handNumber, 2);
});

test('disconnect and reconnect preserve the original deadline and do not renew grace', t => {
  const f = fixture(t), ended = f.bust(); f.connect(1, false); f.advance(5500); f.service.tick(f.room);
  f.connect(1, true); assert.equal(f.room.nextHandAt, ended + 10000); assert.equal(f.state(1).autoDeal.rebuyGrace.endsAt, ended + 10000);
  f.advance(500); f.connect(1, false); f.advance(500); f.connect(1, true);
  assert.equal(f.state(1).autoDeal.rebuyGrace.endsAt, ended + 10000);
  f.command(1, 'buyin', { amountBB: 100 }); assert.equal(f.room.handNumber, 2);
});

test('host pause suppresses dealing while grace expires; resume never grants another rebuy extension', t => {
  const f = fixture(t), ended = f.bust(); f.advance(6000); f.service.tick(f.room); f.command(0, 'autoDeal', { paused: true });
  assert.equal(f.room.nextHandAt, null); assert.equal(f.state(1).autoDeal.rebuyGrace.active, false);
  f.command(1, 'buyin', { amountBB: 100 }); assert.equal(f.room.handNumber, 1);
  f.advance(5000); f.service.tick(f.room); assert.equal(f.room.handNumber, 1); assert.equal(f.state(1).autoDeal.rebuyGrace.endsAt, ended + 10000);
  f.command(0, 'autoDeal', { paused: false }); assert.equal(f.room.nextHandAt, f.time + 5000);
  f.advance(5000); f.service.tick(f.room); assert.equal(f.room.handNumber, 2);
});

test('resuming within grace deals immediately only after pending players have all finished topping up', t => {
  const f = fixture(t); f.bust(); f.advance(6000); f.command(0, 'autoDeal', { paused: true });
  f.command(1, 'buyin', { amountBB: 100 }); assert.equal(f.room.handNumber, 1);
  f.advance(1000); f.command(0, 'autoDeal', { paused: false }); assert.equal(f.room.handNumber, 2);
});

test('persisted grace resumes with its exact original deadlines after restart and clears on room closure', t => {
  const f = fixture(t), ended = f.bust(); f.advance(5500); f.service.tick(f.room);
  const data = structuredClone(f.store.data), service = new RoomService({ data }), room = data.rooms[f.room.code];
  for (const user of f.users.slice(0, 4)) service.connections.set(`${room.code}:${user.id}`, 1);
  f.advance(500); service.connectionChanged(room, f.time, { reconnected: true });
  assert.equal(service.state(room, f.users[1].id).autoDeal.rebuyGrace.endsAt, ended + 10000); assert.equal(room.nextHandAt, ended + 10000);
  const commandId = randomUUID(); service.command(f.users[1], room.code, { type: 'buyin', amountBB: 100, commandId }); assert.equal(room.handNumber, 2);
  service.command(f.users[1], room.code, { type: 'buyin', amountBB: 100, commandId }); assert.equal(room.members[f.users[1].id].totalBuyIn, 2000);
  f.command(0, 'close'); assert.equal(f.state(1).autoDeal.rebuyGrace, null); assert.equal(f.room.rebuyGrace, null);
});

test('squid absence settlement waits for the same fixed grace, and rebuy keeps the original fish roster', t => {
  const f = fixture(t, { count: 3, settings: { squid: true } }), ended = f.bust([1, 2]), round = f.room.mini.squid.round;
  assert.equal(f.room.mini.squid.active, true); assert.equal(f.room.mini.squid.absentSettlementAt, ended + 10000);
  f.advance(6000); f.service.tick(f.room); assert.equal(f.room.mini.squid.active, true);
  f.command(1, 'buyin', { amountBB: 100 }); assert.equal(f.room.handNumber, 1);
  f.command(2, 'buyin', { amountBB: 100 }); assert.equal(f.room.handNumber, 2);
  assert.equal(f.room.mini.squid.round, round); assert.deepEqual(f.room.mini.squid.participants, f.users.slice(0, 3).map(u => u.id));
  assert.equal(f.store.data.ledger.filter(row => row.type === 'squidSettlement').length, 0);
});

test('unfilled squid grace settles absence once at its deadline rather than extending indefinitely', t => {
  const f = fixture(t, { count: 3, settings: { squid: true } }); f.bust([1, 2]); f.advance(9999); f.service.tick(f.room);
  assert.equal(f.room.mini.squid.active, true); f.advance(1); f.service.tick(f.room);
  assert.equal(f.room.mini.squid.active, false); assert.equal(f.store.data.ledger.filter(row => row.type === 'squidSettlement').length, 3);
  f.service.tick(f.room); const snapshot = structuredClone(f.store.data); f.advance(1000); assert.equal(f.service.tick(f.room), false); assert.deepEqual(f.store.data, snapshot);
});

test('a server restart during squid rebuy grace cannot move its shared absence deadline', t => {
  const f = fixture(t, { count: 3, settings: { squid: true } }), ended = f.bust([1, 2]);
  f.advance(8000);
  const data = structuredClone(f.store.data), service = new RoomService({ data }), room = data.rooms[f.room.code];
  service.connections.set(`${room.code}:${f.users[0].id}`, 1); service.connectionChanged(room, f.time, { reconnected: true });
  assert.equal(room.mini.squid.absentSettlementAt, ended + 10000);
  f.advance(2000); service.tick(room, f.time); assert.equal(room.mini.squid.active, false);
  assert.equal(data.ledger.filter(row => row.type === 'squidSettlement').length, 3);
});

test('showdown reveals only dealt live contenders and repeated public projections never mutate the saved hand', t => {
  const f = fixture(t); f.bust([1], () => {
    for (const p of f.state(5).players.filter(p => p.inHand)) {
      const contender = [f.users[0].id, f.users[1].id].includes(p.id);
      assert.deepEqual(p.shownIndices, contender ? [0, 1] : []);
      assert.equal(p.cards.every(Boolean), contender);
    }
  });
  const before = structuredClone(f.store.data); f.advance(6000);
  f.state(1); f.state(5); assert.deepEqual(f.store.data, before);
});

test('shownIndices reports only authoritative reveals, never a viewer merely seeing their own cards', t => {
  const f = fixture(t); f.start();
  for (const i of [0, 1]) assert.deepEqual(f.state(i).players.find(p => p.id === f.users[i].id).shownIndices, []);
  while (f.room.hand.status === 'playing') f.command(f.users.findIndex(u => u.id === f.room.hand.actingId), 'fold');
  const folder = f.room.hand.players.find(p => p.folded), i = f.users.findIndex(u => u.id === folder.id);
  f.command(i, 'show', { indices: [1] });
  const own = f.state(i).players.find(p => p.id === folder.id), peer = f.state(5).players.find(p => p.id === folder.id);
  assert.deepEqual(own.shownIndices, [1]); assert.deepEqual(peer.shownIndices, [1]); assert.equal(peer.cards[0], null); assert.equal(peer.cards[1], folder.cards[1]);
  const recovered = new RoomService({ data: structuredClone(f.store.data) });
  assert.deepEqual(recovered.state(recovered.room(f.room.code), f.users[i].id).players.find(p => p.id === folder.id).shownIndices, [1]);
});
