import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService, settingsFor } from '../src/room.js';
import { availableActions } from '../src/poker.js';

// Independent rule oracle: expectations below are the user-facing contract,
// not a duplicate of the implementation's scheduling or validation functions.
function table(t, settings = {}, count = 3) {
  let timestamp = 1800000000000;
  t.mock.method(Date, 'now', () => timestamp);
  const users = Array.from({ length: 7 }, (_, i) => ({ id: `v013-oracle-${i}`, name: `朋友${i}`, avatar: i }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  let service = new RoomService(store), room = service.create(users[0], { settings });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && room.hand?.actingId) readyRoomAction(service, room, value => { timestamp = value; });
    const result = service.command(users[i], room.code, {
    type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra,
  });
    if (action) while (room.hand?.transition) assert.ok(advanceRoomEvent(service, room, value => { timestamp = value; }));
    return result;
  };
  const connect = (i, online = true) => service.connections.set(`${room.code}:${users[i].id}`, Number(online));
  for (let i = 0; i < count; i++) { cmd(i, 'sit', { seat: i, amountBB: 100 }); connect(i); }
  function finish(winner = 0) {
    for (let n = 0; room.hand?.status === 'playing'; n++) {
      assert.ok(n < 100, 'a normal hand must finish');
      if (!room.hand.actingId) { assert.ok(advanceRoomEvent(service, room, value => { timestamp = value; })); continue; }
      const i = users.findIndex(user => user.id === room.hand.actingId);
      const action = availableActions(room.hand, users[i].id);
      cmd(i, i === winner ? action.canCheck ? 'check' : 'call' : 'fold');
    }
    service.completeRabbit(room, timestamp);
  }
  return {
    users, store, cmd, connect, finish,
    get service() { return service; }, get room() { return room; }, get time() { return timestamp; },
    advance(ms) { timestamp += ms; },
    start() { service.start(room, timestamp, { automatic: true }); },
    restart() { store.data = structuredClone(store.data); service = new RoomService(store); room = store.data.rooms[room.code]; },
  };
}

function balanced(f) {
  const r = f.room, members = Object.values(r.members);
  const livePot = r.hand?.status === 'playing' ? r.hand.players.reduce((n, p) => n + p.contributed, 0) : 0;
  const reserves = Object.values(r.mini.squid.reserves).reduce((n, value) => n + value, 0);
  assert.equal(members.reduce((n, m) => n + m.stack + m.cashedOut, 0) + reserves + livePot + r.mini.mushroom.pool,
    members.reduce((n, m) => n + m.totalBuyIn, 0), 'all credited points remain in stacks, cashouts, pots or reserves');
  for (const m of members) {
    assert.equal(f.store.data.ledger.filter(row => row.playerId === m.id && row.type === 'buyin').reduce((n, row) => n + row.amount, 0),
      m.totalBuyIn, 'recorded buy-ins and lifetime room totals agree');
  }
}

test('v013 oracle: legacy settings cannot relax the new per-transaction rule; cumulative cap is independent', () => {
  const s = settingsFor({ minBuyInBB: 20, maxBuyInBB: null, minBuyIn: 1, maxBuyIn: null, buyInStepBB: 1 });
  assert.equal(s.minBuyInBB, 100); assert.equal(s.maxBuyInBB, 1000); assert.equal(s.buyInStepBB, 50);
  assert.equal(s.minBuyIn, 1000); assert.equal(s.maxBuyIn, 10000); assert.equal(s.maxTotalBuyInBB, null);
  for (const n of [100, 150, 1000, 2500]) assert.equal(settingsFor({ maxTotalBuyInBB: n }).maxTotalBuyInBB, n);
  for (const n of [0, 50, 125, -1, 100.5, Infinity, NaN, '150']) assert.throws(() => settingsFor({ maxTotalBuyInBB: n }));
});

test('v013 oracle: every integer BB amount around both boundaries accepts only 100–1000 in steps of 50', t => {
  const f = table(t, {}, 0), user = f.room.members[f.users[1].id];
  for (let bb = 0; bb <= 1051; bb++) {
    const accepted = bb >= 100 && bb <= 1000 && bb % 50 === 0;
    const before = structuredClone({ user, pending: f.room.pending, ledger: f.store.data.ledger });
    if (accepted) {
      f.cmd(1, 'sit', { seat: 1, amountBB: bb });
      assert.equal(user.stack, bb * 10);
      f.cmd(1, 'stand');
    } else {
      assert.throws(() => f.cmd(1, 'sit', { seat: 1, amountBB: bb }), `must reject ${bb} BB`);
      assert.deepEqual({ user, pending: f.room.pending, ledger: f.store.data.ledger }, before, 'failed entry cannot credit or leave a pending request');
    }
  }
  balanced(f);
});

test('v013 oracle: raw points, top-ups and non-finite inputs cannot bypass the transaction grid', t => {
  const f = table(t, { smallBlind: 2, bigBlind: 5 }, 1), m = f.room.members[f.users[0].id];
  for (const input of [{ amount: 499 }, { amount: 505 }, { amount: 5250 }, { amountBB: 99 }, { amountBB: 125 },
    { amountBB: 1050 }, { amountBB: 150.5 }, { amountBB: '150' }, { amountBB: Infinity }, { amountBB: NaN }]) {
    const before = structuredClone({ m, ledger: f.store.data.ledger });
    assert.throws(() => f.cmd(0, 'buyin', input));
    assert.deepEqual({ m, ledger: f.store.data.ledger }, before);
  }
  f.cmd(0, 'buyin', { amount: 750 });
  assert.equal(m.totalBuyIn, 1250); balanced(f);
});

test('v013 oracle: one-off cap does not cap the table stack and retries credit once before and after restart', t => {
  const f = table(t, {}, 0), commandId = randomUUID();
  f.cmd(1, 'sit', { seat: 1, amountBB: 1000 });
  f.cmd(1, 'buyin', { amountBB: 1000, commandId }); f.cmd(1, 'buyin', { amountBB: 1000, commandId });
  assert.equal(f.room.members[f.users[1].id].stack, 20000);
  f.restart(); f.cmd(1, 'buyin', { amountBB: 1000, commandId });
  assert.equal(f.room.members[f.users[1].id].stack, 20000);
  assert.equal(f.store.data.ledger.filter(row => row.type === 'buyin').length, 2); balanced(f);
});

test('v013 oracle: cumulative cap survives cashout, changed seat, same identity join and persisted reload', t => {
  const f = table(t, { maxTotalBuyInBB: 250 }, 0), id = f.users[1].id;
  f.cmd(1, 'sit', { seat: 1, amountBB: 100 }); f.cmd(1, 'stand');
  f.service.join(f.users[1], f.room.code, f.room.invite);
  f.cmd(1, 'sit', { seat: 4, amountBB: 150 }); f.cmd(1, 'stand');
  f.restart();
  const before = structuredClone({ m: f.room.members[id], ledger: f.store.data.ledger, pending: f.room.pending });
  assert.throws(() => f.cmd(1, 'sit', { seat: 2, amountBB: 100 }), /累计|上限/);
  assert.deepEqual({ m: f.room.members[id], ledger: f.store.data.ledger, pending: f.room.pending }, before);
  assert.equal(f.room.members[id].totalBuyIn, 2500);
  assert.equal(f.room.members[id].cashedOut, 2500); balanced(f);
});

test('v013 oracle: remaining allowance below 100 BB cannot become an undersized last top-up', t => {
  const f = table(t, { maxTotalBuyInBB: 150 }, 1);
  assert.throws(() => f.cmd(0, 'buyin', { amountBB: 50 }));
  assert.throws(() => f.cmd(0, 'buyin', { amountBB: 100 }), /累计|上限/);
  assert.equal(f.room.members[f.users[0].id].totalBuyIn, 1000); balanced(f);
});

test('v013 oracle: legacy pending approvals must revalidate amount and cumulative ceiling', t => {
  const f = table(t, { maxTotalBuyInBB: 100 }, 1);
  for (const amount of [10, 1000]) {
    const row = { id: randomUUID(), playerId: f.users[0].id, seat: 0, amount };
    f.room.pending.push(row);
    const before = structuredClone({ m: f.room.members[f.users[0].id], ledger: f.store.data.ledger });
    assert.throws(() => f.cmd(0, 'approve', { requestId: row.id }));
    assert.deepEqual({ m: f.room.members[f.users[0].id], ledger: f.store.data.ledger }, before);
    f.room.pending = [];
  }
  balanced(f);
});

test('v013 oracle: first deal anchors the timer even after a long lobby wait; due time cannot replace an active hand', t => {
  const f = table(t, { bombPot: true, bombIntervalMinutes: 10 });
  f.advance(8 * 60000); f.start();
  const firstId = f.room.hand.id, start = f.time;
  assert.equal(f.room.hand.bombPot, false); assert.equal(f.room.nextBombAt, start + 10 * 60000);
  f.advance(10 * 60000); f.room.deadline = f.time + 15000;
  f.service.tick(f.room, f.time);
  assert.equal(f.room.hand.id, firstId); assert.equal(f.room.hand.bombPot, false);
  assert.equal(f.service.state(f.room, f.users[0].id).bombDue, true);
  f.finish(); f.start();
  assert.equal(f.room.hand.bombPot, true); assert.equal(f.room.hand.street, 'flop');
  assert.equal(f.room.nextBombAt, f.time + 10 * 60000); balanced(f);
});

test('v013 oracle: paused elapsed periods cause one bomb, followed by a fresh full interval', t => {
  const f = table(t, { bombPot: true, bombIntervalMinutes: 10, durationMinutes: 120 });
  f.start(); f.finish(); f.cmd(0, 'autoDeal', { paused: true });
  const firstId = f.room.hand.id;
  f.advance(35 * 60000); f.service.tick(f.room, f.time);
  assert.equal(f.room.hand.id, firstId); assert.equal(f.room.handNumber, 1);
  f.start(); assert.equal(f.room.hand.bombPot, true);
  const due = f.time + 10 * 60000;
  assert.equal(f.room.nextBombAt, due); f.finish(); f.start();
  assert.equal(f.room.hand.bombPot, false); assert.equal(f.room.nextBombAt, due); balanced(f);
});

test('v013 oracle: a due bomb waits for entry blinds then triggers without waiting a second interval', t => {
  const f = table(t, { bombPot: true, bombIntervalMinutes: 10 });
  f.start(); f.finish(); f.advance(10 * 60000);
  const due = f.room.nextBombAt;
  f.cmd(3, 'sit', { seat: 3, amountBB: 100, entryMode: 'wait' }); f.connect(3);
  f.start();
  assert.equal(f.room.hand.bombPot, false, 'a natural blind hand must happen first');
  assert.equal(f.room.hand.bigBlindSeat, 3);
  assert.equal(f.room.nextBombAt, due, 'entry cannot lose the pending bomb');
  f.finish(); f.start();
  assert.equal(f.room.hand.bombPot, true);
  assert.equal(f.room.hand.players.length, 4);
  assert.equal(f.room.hand.log.filter(row => row.type === 'ante').length, 4); balanced(f);
});

test('v013 oracle: persistence before and after a bomb does not duplicate the hand or its ante', t => {
  const f = table(t, { bombPot: true, bombIntervalMinutes: 1 });
  f.start(); f.finish(); f.advance(60000); f.restart();
  for (let i = 0; i < 3; i++) f.connect(i);
  f.start(); assert.equal(f.room.hand.bombPot, true);
  const h = structuredClone(f.room.hand), due = f.room.nextBombAt;
  f.restart();
  for (let i = 0; i < 3; i++) f.connect(i);
  assert.equal(f.service.state(f.room, f.users[0].id).hand.id, h.id);
  assert.deepEqual(f.room.hand.log, h.log);
  assert.equal(f.room.nextBombAt, due);
  f.finish(); f.start(); assert.equal(f.room.hand.bombPot, false);
  assert.equal(f.store.data.hands.filter(hand => hand.bombPot).length, 1); balanced(f);
});

test('v013 oracle: no newly scheduled bomb at the exact last-five-minute boundary', t => {
  const f = table(t, { bombPot: true, bombIntervalMinutes: 1, durationMinutes: 30 });
  f.start(); f.finish(); f.advance(25 * 60000); f.start();
  assert.equal(f.room.hand.bombPot, false);
  // bombDue describes the elapsed clock; the cutoff separately gates dealing.
  f.finish(); f.advance(5 * 60000); f.start();
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.handNumber, 2); balanced(f);
});

test('v013 oracle: bomb hand history, exports, total buy-in and per-session net agree', t => {
  const f = table(t, { bombPot: true, bombIntervalMinutes: 1 });
  f.start(); f.finish(); f.advance(60000); f.start(); f.finish(1);
  assert.equal(f.store.data.hands.length, 2);
  for (const user of f.users.slice(0, 3)) {
    const archive = f.service.exports(user.id, f.room.code);
    assert.equal(archive.filter(hand => hand.bombPot).length, 1);
    const roomMember = f.room.members[user.id];
    const net = roomMember.stack + roomMember.cashedOut - roomMember.totalBuyIn;
    assert.equal(f.service.sessionFor(user.id, f.room.code).session.meNet, net);
    assert.equal(f.service.stats(user.id).net, net);
  }
  balanced(f);
});

test('v013 oracle: old active rooms project new rules without rewriting saved records or inventing a hand', t => {
  const f = table(t, { bombPot: true });
  f.start(); f.finish();
  delete f.room.nextBombAt; delete f.room.settings.bombIntervalMinutes;
  delete f.room.settings.maxTotalBuyInBB; delete f.room.settings.buyInStepBB;
  Object.assign(f.room.settings, { bombEveryHands: 1, minBuyInBB: 20, maxBuyInBB: null, minBuyIn: 200, maxBuyIn: null });
  f.room.rulesVersion = 4; f.advance(10 * 60000);
  const before = structuredClone(f.store.data);
  const view = f.service.state(f.room, f.users[0].id);
  assert.equal(view.settings.minBuyInBB, 100); assert.equal(view.settings.maxBuyInBB, 1000);
  assert.equal(view.settings.bombIntervalMinutes, 10); assert.equal(view.bombDue, true);
  assert.equal(view.nextBombAt, f.room.startedAt + 10 * 60000);
  assert.deepEqual(f.store.data, before, 'reading old state must not migrate stored data');
  f.start(); assert.equal(f.room.hand.bombPot, true);
  assert.equal(f.room.nextBombAt, f.time + 10 * 60000);
  assert.deepEqual(f.store.data.hands, before.hands, 'already settled archives remain identical');
  balanced(f);
});

test('v013 oracle: finished rooms keep their historical rules and never advertise another bomb', t => {
  const f = table(t, { bombPot: true });
  f.start(); f.finish(); f.cmd(0, 'close');
  Object.assign(f.room.settings, { minBuyInBB: 20, maxBuyInBB: 200, minBuyIn: 200, maxBuyIn: 2000, bombEveryHands: 10 });
  delete f.room.settings.bombIntervalMinutes;
  const before = structuredClone(f.store.data);
  const view = f.service.state(f.room, f.users[0].id);
  assert.equal(view.settings.minBuyInBB, 20); assert.equal(view.settings.bombEveryHands, 10);
  assert.equal(view.nextBombAt, null); assert.equal(view.bombDue, false);
  assert.deepEqual(f.store.data, before); balanced(f);
});

test('v013 oracle: timed bomb shares the original squid round and does not charge its reserve twice', t => {
  const f = table(t, { squid: true, squidUnitBB: 2, bombPot: true, bombIntervalMinutes: 1 }, 5);
  f.start(); f.finish(0);
  const round = f.room.mini.squid.round, participants = [...f.room.mini.squid.participants];
  const reserves = structuredClone(f.room.mini.squid.reserves);
  f.advance(60000); f.start();
  assert.equal(f.room.hand.bombPot, true); assert.equal(f.room.hand.squidRound, round);
  assert.deepEqual(f.room.mini.squid.participants, participants);
  assert.deepEqual(f.room.mini.squid.reserves, reserves);
  f.finish(1);
  assert.equal(f.room.mini.squid.active, true);
  assert.deepEqual(f.room.mini.squid.won.sort(), [f.users[0].id, f.users[1].id].sort());
  assert.equal(f.store.data.ledger.filter(row => row.type === 'squidSettlement').length, 0);
  balanced(f);
});
