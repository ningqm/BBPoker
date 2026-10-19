import { seedLegacyAccount } from './helpers/accounts.js';
import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { createApp } from '../server.js';

// These expectations are the agreed rules, not values copied from the engine.
// Every fish-holder receives m units; every unmarked player pays k units.
function expectedFish(users, winnerIndices, unit = 20) {
  return Object.fromEntries(users.map((u, i) => [u.id,
    winnerIndices.includes(i) ? (users.length - winnerIndices.length) * unit : -winnerIndices.length * unit]));
}

function fixture(t, count = 6, settings = { squid: true, squidUnitBB: 2 }) {
  let timestamp = 1800000000000;
  t.mock.method(Date, 'now', () => timestamp);
  const users = Array.from({ length: 9 }, (_, i) => ({ id: `oracle-${i}`, name: `朋友${i}`, avatar: i }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  let service = new RoomService(store), room = service.create(users[0], { settings });
  for (const u of users.slice(1)) service.join(u, room.code, room.invite);
  const cmd = (i, type, extra = {}) => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && room.hand?.actingId) readyRoomAction(service, room, value => { timestamp = value; });
    const q = room.mini.squid, participating = q.active && q.participants.includes(users[i].id);
    const quote = ['stand', 'sitout'].includes(type) ? {
      expectedSquidRound: participating ? q.round : 0,
      expectedSquidCost: participating && !q.won.includes(users[i].id) ? (q.participants.length - 1) * q.unit : 0,
    } : {};
    const result = service.command(users[i], room.code, {
      type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...quote, ...extra,
    });
    if (action) while (room.hand?.transition) assert.ok(advanceRoomEvent(service, room, value => { timestamp = value; }));
    return result;
  };  const connect = (i, count) => {
    service.connections.set(`${room.code}:${users[i].id}`, Number(count));
    service.connectionChanged(room, timestamp, { reconnected: Boolean(count) });
  };
  for (let i = 0; i < count; i++) { cmd(i, 'sit', { seat: i, amountBB: 100 }); connect(i, 1); }
  const win = i => {
    assert.ok(room.hand.players.some(p => p.id === users[i].id), 'intended winner must have been dealt');
    for (let n = 0; room.hand.status === 'playing'; n++) {
      assert.ok(n < 100, 'hand must terminate');
      if (!room.hand.actingId) { assert.ok(advanceRoomEvent(service, room, value => { timestamp = value; })); continue; }
      const actor = users.findIndex(u => u.id === room.hand.actingId), a = availableActions(room.hand, room.hand.actingId);
      cmd(actor, actor === i ? a.canCheck ? 'check' : 'call' : 'fold');
    }
    service.completeRabbit(room, timestamp);
  };
  return {
    users, get store() { return store; }, get service() { return service; }, get room() { return room; }, cmd, connect, win,
    get time() { return timestamp; }, advance(ms) { timestamp += ms; },
    restart() { store.data = structuredClone(store.data); service = new RoomService(store); room = store.data.rooms[room.code]; },
  };
}

function conserved(room) {
  const members = Object.values(room.members), hand = room.hand;
  const pot = hand?.status === 'playing' ? hand.players.reduce((n, p) => n + p.contributed, 0) : 0;
  const reserves = Object.values(room.mini.squid.reserves).reduce((n, v) => n + v, 0);
  assert.equal(members.reduce((n, m) => n + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0) + reserves + pot + room.mini.mushroom.pool,
    members.reduce((n, m) => n + m.totalBuyIn, 0), 'cashouts + stacks + live pot + reserves equal all buy-ins');
}

function assertSettlement(f, expected) {
  const q = f.room.mini.squid, rows = f.store.data.ledger.filter(row => row.type === 'squidSettlement');
  assert.equal(q.active, false); assert.deepEqual(q.reserves, {});
  assert.deepEqual(q.lastResult.changes, expected);
  assert.equal(rows.length, Object.keys(expected).length, 'one adjustment per original player');
  assert.equal(new Set(rows.map(row => row.roundSettlementId)).size, 1, 'one settlement identity');
  assert.equal(rows.reduce((n, row) => n + row.amount, 0), 0);
  for (const [id, amount] of Object.entries(expected)) {
    assert.equal(rows.find(row => row.playerId === id).amount, amount);
    assert.equal(f.service.stats(id).miniNet, amount, 'career totals must include each settlement once');
    assert.equal(f.service.sessionFor(id, f.room.code).session.meMiniNet, amount, 'session totals must include each settlement once');
    assert.equal(f.service.exportAdjustments(id, f.room.code).filter(row => row.type === 'squidSettlement').length, 1);
  }
  conserved(f.room);
}

test('oracle: host cannot start the first squid hand with players who seated then went offline', t => {
  const f = fixture(t, 3); f.connect(1, 0); f.connect(2, 0);
  const balances = f.users.slice(0, 3).map(u => f.room.members[u.id].stack);
  assert.throws(() => f.cmd(0, 'start'), /至少|在线|回到/);
  assert.equal(f.room.hand, null); assert.equal(f.room.mini.squid.active, false);
  assert.deepEqual(f.room.mini.squid.reserves, {});
  assert.deepEqual(f.users.slice(0, 3).map(u => f.room.members[u.id].stack), balances);
  f.connect(1, 1); f.connect(2, 1); f.cmd(0, 'start');
  assert.equal(f.room.hand.players.length, 3); assert.equal(f.room.mini.squid.active, true); conserved(f.room);
});

for (let k = 1; k <= 5; k++) {
  test(`oracle: six players, ${k} fish holders and ${6 - k} absent losers settle the exact k/m matrix once`, t => {
    const f = fixture(t), roster = f.users.slice(0, 6);
    f.cmd(0, 'start'); f.cmd(0, 'autoDeal', { paused: true });
    for (let i = 0; i < k - 1; i++) { f.win(i); f.service.start(f.room); }
    // Leave while a real hand is running: losing players' existing bets stay in.
    const priorContributions = f.room.hand.players.map(p => [p.id, p.contributed]);
    for (let i = k; i < 6; i++) f.connect(i, 0);
    assert.equal(f.room.mini.squid.active, true, 'presence updates must not settle an active hand');
    for (const [id, value] of priorContributions) assert.equal(f.room.hand.players.find(p => p.id === id).contributed, value);
    f.win(k - 1);
    if (f.room.mini.squid.active) { f.advance(5000); f.service.tick(f.room, f.time); }
    assertSettlement(f, expectedFish(roster, Array.from({ length: k }, (_, i) => i)));
    const adjustments = structuredClone(f.store.data.ledger.filter(row => row.type === 'squidSettlement'));
    f.service.finish(f.room); f.service.tick(f.room, f.time); f.connect(k, 1);
    assert.deepEqual(f.store.data.ledger.filter(row => row.type === 'squidSettlement'), adjustments, 'finish/reconnect retries cannot transfer again');
  });
}

test('oracle: offline fish holders retain rewards while the remaining original players finish', t => {
  const f = fixture(t, 5); f.cmd(0, 'start'); f.win(0); f.connect(0, 0);
  const reserve = f.room.mini.squid.reserves[f.users[0].id], stack = f.room.members[f.users[0].id].stack;
  for (let winner = 1; winner <= 3; winner++) {
    f.service.start(f.room, f.time, { automatic: true });
    assert.equal(f.room.hand.players.some(p => p.id === f.users[0].id), false);
    if (winner < 3) assert.equal(f.room.mini.squid.reserves[f.users[0].id], reserve);
    f.win(winner);
  }
  assertSettlement(f, expectedFish(f.users.slice(0, 5), [0, 1, 2, 3]));
  assert.equal(f.room.members[f.users[0].id].stack, stack + 20);
});

test('oracle: two offline unmarked players pay no new blinds while two or more others continue the same squid round', t => {
  const f = fixture(t, 5); f.cmd(0, 'start'); f.win(0);
  const round = f.room.mini.squid.round, reserves = structuredClone(f.room.mini.squid.reserves);
  f.connect(3, 0); f.connect(4, 0);
  const balances = [3, 4].map(i => f.room.members[f.users[i].id].stack);
  f.service.start(f.room, f.time, { automatic: true });
  assert.deepEqual(f.room.hand.players.map(p => p.id), f.users.slice(0, 3).map(u => u.id));
  assert.equal(f.room.hand.squidRound, round);
  assert.deepEqual(f.room.mini.squid.reserves, reserves);
  for (let j = 0; j < 2; j++) assert.equal(f.room.members[f.users[j + 3].id].stack, balances[j]);
  f.win(1); assert.equal(f.room.mini.squid.active, true, 'online unmarked player still has a chance');
  assert.deepEqual(f.room.mini.squid.won.sort(), [f.users[0].id, f.users[1].id].sort());
  conserved(f.room);
});

test('oracle: stand and sitout retries retain unpaid squid liability rather than immediately forfeiting', t => {
  const f = fixture(t, 6); f.cmd(0, 'start');
  const round = f.room.mini.squid.round, reserves = structuredClone(f.room.mini.squid.reserves);
  const standId = randomUUID(), sitoutId = randomUUID();
  f.cmd(4, 'stand', { commandId: standId }); f.cmd(4, 'stand', { commandId: standId });
  f.cmd(5, 'sitout', { value: true, commandId: sitoutId }); f.cmd(5, 'sitout', { value: true, commandId: sitoutId });
  f.win(0);
  assert.equal(f.room.mini.squid.active, true); assert.equal(f.room.mini.squid.round, round);
  assert.deepEqual(f.room.mini.squid.reserves, reserves);
  assert.equal(f.room.members[f.users[4].id].seat, null);
  assert.equal(f.room.members[f.users[5].id].sittingOut, true);
  assert.equal(f.store.data.ledger.filter(row => row.type === 'squidSettlement').length, 0);
  const cashouts = f.store.data.ledger.filter(row => row.type === 'cashout' && row.playerId === f.users[4].id);
  assert.equal(cashouts.length, 1);
  f.cmd(4, 'stand', { commandId: standId }); f.cmd(5, 'sitout', { value: true, commandId: sitoutId });
  assert.equal(f.store.data.ledger.filter(row => row.type === 'cashout' && row.playerId === f.users[4].id).length, 1);
  f.cmd(4, 'sit', { seat: 4, amountBB: 100 }); f.cmd(5, 'sitout', { value: false });
  assert.deepEqual(f.room.mini.squid.participants, f.users.slice(0, 6).map(u => u.id));
  assert.deepEqual(f.room.mini.squid.reserves, reserves, 'returning original players are not charged a second squid reserve');
  conserved(f.room);
});

test('oracle: a marked player leaves and receives the exact reward when another marked player remains online', t => {
  const f = fixture(t, 5); f.cmd(0, 'start'); f.win(0); f.cmd(0, 'stand');
  f.service.start(f.room); f.win(1); f.cmd(0, 'autoDeal', { paused: true });
  const oldCashout = f.room.members[f.users[0].id].cashedOut, reserve = f.room.mini.squid.reserves[f.users[0].id];
  // Keep one unmarked player present until the last transition, then no unmarked
  // player can contend. No synthetic hand is needed for an already finished hand.
  for (let i = 2; i < 5; i++) f.cmd(i, 'sitout', { value: true });
  f.advance(5000); f.service.tick(f.room, f.time);
  assertSettlement(f, expectedFish(f.users.slice(0, 5), [0, 1]));
  assert.equal(f.room.members[f.users[0].id].cashedOut, oldCashout + 60);
});

test('oracle: insufficient original players waits, restart resets grace, and early settlement preserves all earned fish', t => {
  const f = fixture(t, 5); f.cmd(0, 'start'); f.win(0);
  for (const i of [0, 2, 3, 4]) f.connect(i, 0);
  assert.equal(f.room.nextHandAt, null); assert.equal(f.room.mini.squid.active, true);
  f.advance(90000); f.restart(); f.connect(1, 1);
  assert.equal(f.service.canSettleSquid(f.room, f.users[1].id, f.time), false);
  assert.throws(() => f.cmd(1, 'settleSquid'), /90/);
  f.advance(89999); assert.equal(f.service.canSettleSquid(f.room, f.users[1].id, f.time), false);
  f.advance(1); f.service.tick(f.room, f.time);
  const commandId = randomUUID(); f.cmd(1, 'settleSquid', { commandId }); f.cmd(1, 'settleSquid', { commandId });
  assertSettlement(f, expectedFish(f.users.slice(0, 5), [0]));
});

test('oracle: an all-in player disconnecting during runout stays eligible and cannot erase committed points', t => {
  const f = fixture(t, 3); f.cmd(0, 'start');
  const allInId = f.room.hand.actingId, allInIndex = f.users.findIndex(u => u.id === allInId);
  f.cmd(allInIndex, 'allin'); f.connect(allInIndex, 0);
  const contribution = f.room.hand.players.find(p => p.id === allInId).contributed;
  while (!f.room.hand.runout?.active && f.room.hand.status === 'playing') {
    f.cmd(f.users.findIndex(u => u.id === f.room.hand.actingId), 'call');
  }
  assert.equal(f.room.hand.runout.active, true);
  assert.equal(f.room.hand.players.find(p => p.id === allInId).folded, false);
  while (f.room.hand.status === 'playing') { f.advance(2000); f.service.tick(f.room, f.time); }
  assert.equal(f.room.hand.players.find(p => p.id === allInId).folded, false);
  assert.equal(f.room.hand.players.find(p => p.id === allInId).contributed, contribution);
  assert.equal(f.store.data.hands.length, 1); conserved(f.room);
});

test('oracle: simultaneous newcomers post exactly one live BB each and duplicate entry commands never debit on click', t => {
  const f = fixture(t, 6, { squid: false }); f.cmd(0, 'start');
  const currentHand = structuredClone(f.room.hand);
  for (const i of [6, 7]) {
    f.cmd(i, 'sit', { seat: i, amountBB: 100, entryMode: 'post' }); f.connect(i, 1);
    const commandId = randomUUID(); f.cmd(i, 'entryBlind', { mode: 'post', commandId }); f.cmd(i, 'entryBlind', { mode: 'post', commandId });
    assert.equal(f.room.members[f.users[i].id].stack, 1000, 'entry selection is not a debit');
  }
  assert.deepEqual(f.room.hand, currentHand, 'mid-hand arrivals must not change this hand');
  f.win(0); f.service.start(f.room, f.time, { automatic: true });
  for (const i of [6, 7]) {
    const p = f.room.hand.players.find(p => p.id === f.users[i].id);
    assert.ok(p, 'post-mode newcomers away from the protected arc join together');
    assert.equal(p.bet, 10); assert.equal(p.contributed, 10); assert.equal(p.stack, 990);
    assert.equal(f.room.hand.log.filter(e => e.playerId === p.id && e.type === 'entryBlind').length, 1);
    assert.equal(f.room.hand.log.filter(e => e.playerId === p.id && ['smallBlind', 'bigBlind', 'deadBlind'].includes(e.type)).length, 0);
  }
  conserved(f.room); f.win(1); f.service.start(f.room, f.time, { automatic: true });
  for (const i of [6, 7]) assert.equal(f.room.hand.log.filter(e => e.playerId === f.users[i].id && e.type === 'entryBlind').length, 0);
  conserved(f.room);
});

test('oracle: three simultaneous wait-BB newcomers enter on successive natural blinds, never as SB or with duplicate BBs', t => {
  const f = fixture(t, 3, { squid: false }); f.cmd(0, 'start');
  for (const i of [3, 4, 5]) { f.cmd(i, 'sit', { seat: i, amountBB: 100 }); f.connect(i, 1); }
  f.win(0);
  for (const entering of [3, 4, 5]) {
    f.service.start(f.room, f.time, { automatic: true });
    assert.equal(f.room.hand.bigBlindSeat, entering);
    assert.ok(f.room.hand.players.some(p => p.id === f.users[entering].id));
    for (let waiting = entering + 1; waiting < 6; waiting++) {
      assert.equal(f.room.hand.players.some(p => p.id === f.users[waiting].id), false);
      assert.equal(f.room.members[f.users[waiting].id].stack, 1000);
    }
    const blindLogs = f.room.hand.log.filter(e => e.playerId === f.users[entering].id && ['smallBlind', 'bigBlind', 'entryBlind', 'deadBlind'].includes(e.type));
    assert.equal(blindLogs.length, 1); assert.equal(blindLogs[0].type, 'bigBlind'); assert.equal(blindLogs[0].amount, 10);
    conserved(f.room); f.win(0);
  }
});

test('oracle: waiting newcomers incur no current-round reserve until their first legal entry hand', t => {
  const f = fixture(t, 3); f.cmd(0, 'start');
  for (const i of [3, 4, 5]) { f.cmd(i, 'sit', { seat: i, amountBB: 100 }); f.connect(i, 1); }
  f.win(0);
  let allJoined = false;
  for (let step = 0; step < 9; step++) {
    f.service.start(f.room, f.time, { automatic: true });
    const dealt = new Set(f.room.hand.players.map(p => p.id));
    assert.equal(f.room.mini.squid.round,1);assert.equal(f.room.hand.squidRound,1);
    for (const i of [3, 4, 5]) if (!dealt.has(f.users[i].id) && !f.store.data.hands.some(h => h.players.some(p => p.id === f.users[i].id))) {
      assert.equal(f.room.members[f.users[i].id].stack, 1000);
      assert.equal(f.room.mini.squid.reserves[f.users[i].id],undefined);
      assert.equal(f.room.mini.squid.participants.includes(f.users[i].id),false);
      assert.equal(f.service.stats(f.users[i].id).miniNet, 0);
    }
    conserved(f.room);f.win(0);
    if(f.room.mini.squid.participants.length===6){allJoined=true;break;}
  }
  assert.equal(allJoined,true,'natural BB must eventually admit each newcomer to the same round');
  assert.equal(f.room.mini.squid.tokenBudget,5);
  assert.equal(f.room.mini.squid.reserves[f.users[0].id],undefined);
  for(const user of f.users.slice(1,6))assert.equal(f.room.mini.squid.reserves[user.id],undefined);
});

test('oracle: original unmarked player reconnects mid-hand then returns to that round without a second reserve', t => {
  const f = fixture(t, 6); f.cmd(0, 'start'); f.win(0);
  const round = f.room.mini.squid.round, roster = [...f.room.mini.squid.participants], reserves = structuredClone(f.room.mini.squid.reserves);
  f.connect(3, 0); f.service.start(f.room, f.time, { automatic: true });
  assert.equal(f.room.hand.players.some(p => p.id === f.users[3].id), false);
  const beforeReconnect = structuredClone(f.room.hand);
  f.connect(3, 1); f.cmd(3, 'entryBlind', { mode: 'post' });
  assert.deepEqual(f.room.hand, beforeReconnect, 'reconnection must never insert cards into a hand in progress');
  f.win(1);
  let returned = false;
  for (let step = 0; step < 7; step++) {
    f.service.start(f.room, f.time, { automatic: true });
    assert.equal(f.room.mini.squid.round, round); assert.deepEqual(f.room.mini.squid.participants, roster);
    assert.deepEqual(f.room.mini.squid.reserves, reserves);
    if (f.room.hand.players.some(p => p.id === f.users[3].id)) { returned = true; f.win(3); break; }
    f.win(0);
  }
  assert.equal(returned, true);
  assert.ok(f.room.mini.squid.won.includes(f.users[3].id));
  assert.equal(f.store.data.ledger.filter(row => row.type === 'squidSettlement').length, 0);
  conserved(f.room);
});

test('oracle: final-five-minute newcomer waiting does not start another squid or lock a normal table', t => {
  const f = fixture(t, 3); f.cmd(0, 'start'); f.win(0); f.service.start(f.room); f.win(1);
  f.advance(f.room.endsAt - 4 * 60000 - f.time);
  f.cmd(3, 'sit', { seat: 3, amountBB: 100 }); f.connect(3, 1);
  f.service.start(f.room, f.time, { automatic: true });
  assert.equal(f.room.mini.squid.active, false); assert.equal(f.room.mini.squid.round, 1);
  assert.equal(f.room.hand.squidRound, null); assert.deepEqual(f.room.mini.squid.reserves, {});
  conserved(f.room);
});

test('oracle: when all remaining original players wait for missed blinds, a stalled round still exposes the recovery settlement', t => {
  const f = fixture(t, 6); f.cmd(0, 'start'); f.win(0);
  f.connect(1, 0); f.connect(2, 0);
  for (let orbit = 0; orbit < 6; orbit++) { f.service.start(f.room, f.time, { automatic: true }); f.win(0); }
  for (const i of [0, 3, 4, 5]) f.connect(i, 0);
  f.connect(1, 1); f.connect(2, 1);
  const view = f.service.state(f.room, f.users[1].id);
  for (const i of [1, 2]) assert.equal(view.players.find(p => p.id === f.users[i].id).entryBlind.required, true);
  assert.equal(f.room.nextHandAt, null, 'both players chose wait; neither is silently charged an entry post');
  assert.ok(f.service.squidBlock(f.room), 'two connected people are not two dealable players when everyone waits for a blind');
  assert.equal(f.service.canSettleSquid(f.room, f.users[1].id, f.time), false);
  f.advance(90000); f.service.tick(f.room, f.time);
  assert.equal(f.service.canSettleSquid(f.room, f.users[1].id, f.time), true);
  f.cmd(1, 'settleSquid'); assertSettlement(f, expectedFish(f.users.slice(0, 6), [0]));
});

test('oracle: actual SSE tabs, reconnect and encrypted restart do not duplicate the current hand blinds', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-continuity-oracle-'));
  let app = createApp({ dataDir: dir, actionTickMs: 1000000 });
  const controllers = [];
  t.after(async () => { for (const c of controllers) c.abort(); await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const listen = () => new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await listen();
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, data, token) => {
    const res = await fetch(base() + path, { method: data === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await res.json(); assert.equal(res.ok, true, JSON.stringify(body)); return body;
  };
  const users = [];
  for (const name of ['连接测试甲', '连接测试乙', '连接测试丙']) users.push(seedLegacyAccount(app, { name }));
  const created = (await api('/api/rooms', { settings: { squid: true } }, users[0].token)).room;
  for (const user of users.slice(1)) await api(`/api/rooms/${created.code}/join`, { invite: created.invite }, user.token);
  const room = () => app.store.data.rooms[created.code];
  const cmd = (i, type, extra = {}) => api(`/api/rooms/${created.code}/action`, { type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra }, users[i].token);
  const stream = async i => {
    const controller = new AbortController(); controllers.push(controller);
    const res = await fetch(`${base()}/api/events?room=${created.code}`, { headers: { Authorization: `Bearer ${users[i].token}` }, signal: controller.signal });
    assert.equal(res.status, 200); const reader = res.body.getReader(); await reader.read();
    return controller;
  };
  const waitConnections = async (i, count) => {
    const key = `${created.code}:${users[i].user.id}`, deadline = Date.now() + 3000;
    while ((app.service.connections.get(key) ?? 0) !== count) {
      assert.ok(Date.now() < deadline, `SSE count should become ${count}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  for (let i = 0; i < 3; i++) { await cmd(i, 'sit', { seat: i, amountBB: 100 }); await stream(i); }
  const extraTab = await stream(1); await waitConnections(1, 2);
  await cmd(0, 'start');
  const prior = structuredClone(room().hand), reserves = structuredClone(room().mini.squid.reserves);
  extraTab.abort(); await waitConnections(1, 1);
  assert.deepEqual(room().hand, prior); assert.deepEqual(room().mini.squid.reserves, reserves);
  // Close the other tab for the same identity, then reconnect within this hand.
  controllers[1].abort(); await waitConnections(1, 0); await stream(1); await waitConnections(1, 1);
  assert.deepEqual(room().hand, prior); assert.deepEqual(room().mini.squid.reserves, reserves);
  const stored = structuredClone(app.store.data); await app.close();
  app = createApp({ dataDir: dir, actionTickMs: 1000000 }); await listen();
  assert.deepEqual(app.store.data.rooms, stored.rooms);
  for (let i = 0; i < 3; i++) await stream(i);
  assert.deepEqual(room().hand, prior); assert.deepEqual(room().mini.squid.reserves, reserves);
  assert.equal(room().hand.log.filter(e => ['smallBlind', 'bigBlind'].includes(e.type)).length, 2);
  assert.equal(app.store.data.hands.length, 0, 'an unfinished hand is not archived by connection changes');
  const view = await api(`/api/rooms/${created.code}`, undefined, users[0].token);
  assert.equal(view.hand.deck, undefined);
  assert.equal(view.players.find(p => p.id === users[1].user.id).cards.filter(Boolean).length, 0);
  conserved(room());
});
