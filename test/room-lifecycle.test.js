import test from 'node:test';
import { readyRoomAction } from './helpers/room-clock.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';

function fixture(t, settings = {}, count = 3) {
  let timestamp = Date.now(); t.mock.method(Date, 'now', () => timestamp);
  const users = Array.from({ length: 12 }, (_, i) => ({ id: `lifecycle-${i}`, name: `测试${i}`, avatar: 0 }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], { settings });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) { cmd(i, 'sit', { seat: i, amountBB: 100 }); service.connections.set(`${room.code}:${users[i].id}`, 1); }
  service.connectionChanged(room, timestamp);
  const connect = (i, connected) => { service.connections.set(`${room.code}:${users[i].id}`, connected ? 1 : 0); service.connectionChanged(room, timestamp, { reconnected: connected }); };
  const win = i => {
    for (let n = 0; room.hand.status === 'playing'; n++) {
      assert.ok(n < 100); if (!readyRoomAction(service, room, value => { timestamp = value; })) break; const actor = users.findIndex(u => u.id === room.hand.actingId), a = availableActions(room.hand, room.hand.actingId);
      cmd(actor, actor === i ? a.canCheck ? 'check' : 'call' : 'fold');
    }
    service.completeRabbit(room, timestamp);
  };
  const consent = i => ({ expectedSquidRound: room.mini.squid.active && room.mini.squid.participants.includes(users[i].id) ? room.mini.squid.round : 0,
    expectedSquidCost: room.mini.squid.active && room.mini.squid.participants.includes(users[i].id) && !room.mini.squid.won.includes(users[i].id) ? (room.mini.squid.participants.length - 1) * room.mini.squid.unit : 0 });
  return { users, store, service, room, cmd, connect, win, consent, get time() { return timestamp; }, advance(ms) { timestamp += ms; } };
}
function conserved(r) {
  const members = Object.values(r.members), pot = r.hand?.status === 'playing' ? r.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0;
  assert.equal(members.reduce((sum, m) => sum + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0) + Object.values(r.mini.squid.reserves).reduce((sum, x) => sum + x, 0) + r.mini.mushroom.pool + pot, members.reduce((sum, m) => sum + m.totalBuyIn, 0));
}

test('late seating preserves the current hand; departure is cancelable and occurs after settlement', t => {
  const f = fixture(t); f.cmd(0, 'start'); const ids = f.room.hand.players.map(p => p.id);
  f.cmd(3, 'sit', { seat: 3, amountBB: 100 }); f.connect(3, true);
  assert.deepEqual(f.room.hand.players.map(p => p.id), ids);
  assert.equal(f.service.state(f.room, f.users[3].id).players.find(p => p.id === f.users[3].id).waitingFor, 'hand');
  f.cmd(0, 'stand'); assert.equal(f.room.members[f.users[0].id].pendingDeparture, 'stand');
  f.cmd(0, 'cancelDeparture'); assert.equal(f.room.members[f.users[0].id].pendingDeparture, null);
  f.cmd(0, 'sitout', { value: true }); f.cmd(0, 'sitout', { value: false });
  assert.equal(f.room.members[f.users[0].id].pendingDeparture, null);
  f.cmd(0, 'stand'); f.win(1);
  assert.equal(f.room.members[f.users[0].id].seat, null); assert.ok(f.room.members[f.users[0].id].cashedOut > 0); conserved(f.room);
  assert.ok(f.room.hand.endingStacks[f.users[0].id] > 0, 'cashout must not erase the hand ending balance');
  f.service.start(f.room); assert.deepEqual(f.room.hand.players.map(p => p.id), [f.users[1].id, f.users[2].id, f.users[3].id]); conserved(f.room);
});

test('a squid entrant joins the next eligible hand and pays only the enlarged current round', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start'); const roster = [...f.room.mini.squid.participants];
  f.cmd(3, 'sit', { seat: 3, amountBB: 100 }); f.connect(3, true); f.win(0);
  assert.deepEqual(f.room.mini.squid.participants, roster);
  assert.equal(f.service.state(f.room, f.users[3].id).players.find(p => p.id === f.users[3].id).waitingFor, 'squid');
  f.service.start(f.room); assert.deepEqual(f.room.hand.players.map(p => p.id), [...roster,f.users[3].id]);
  assert.equal(f.room.mini.squid.tokenBudget,3); assert.equal(f.room.mini.squid.counts[f.users[3].id],0);
  assert.equal(f.room.mini.squid.reserves[f.users[0].id],undefined);
  for(const i of [1,2,3])assert.equal(f.room.mini.squid.reserves[f.users[i].id],undefined);
  f.win(1); assert.equal(f.room.mini.squid.active,true);conserved(f.room);
  f.service.start(f.room); f.win(2);
  assert.equal(f.room.mini.squid.round,1);assert.equal(f.room.mini.squid.active,false);
  assert.deepEqual(f.room.mini.squid.lastResult.changes,Object.fromEntries(f.users.slice(0,4).map((u,i)=>[u.id,i===3?-60:20])));conserved(f.room);
});

test('unmarked departure requires a current quote and retains its original reserve through rejoining', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start');
  assert.throws(() => f.cmd(0, 'stand'), /确认/);
  assert.throws(() => f.cmd(0, 'stand', { expectedSquidRound: 0, expectedSquidCost: 0 }), /重新确认/);
  const commandId = randomUUID(), quote = f.consent(0), reserve = f.room.mini.squid.reserves[f.users[0].id];
  f.cmd(0, 'stand', { ...quote, commandId }); f.cmd(0, 'stand', { ...quote, commandId }); f.win(1);
  assert.equal(f.room.members[f.users[0].id].seat, null); assert.equal(f.room.mini.squid.active, true);
  assert.equal(f.store.data.ledger.filter(row => row.type === 'squidSettlement').length, 0);
  assert.equal(f.room.mini.squid.reserves[f.users[0].id], reserve); conserved(f.room);
  f.cmd(0, 'sit', { seat: 0, amountBB: 100 });
  assert.equal(f.service.waitingFor(f.room, f.room.members[f.users[0].id]), null);
  assert.equal(f.room.mini.squid.round, quote.expectedSquidRound); assert.equal(f.room.mini.squid.reserves[f.users[0].id], reserve);
  assert.equal(f.service.stats(f.users[0].id).miniNet, 0);
  f.cmd(0, 'stand', { ...quote, commandId }); assert.equal(f.room.members[f.users[0].id].seat, 0, 'retry cannot stand the returning player a second time');
  f.service.start(f.room); assert.ok(f.room.hand.players.some(p => p.id === f.users[0].id)); f.win(2);
  const rows = f.store.data.ledger.filter(row => row.type === 'squidSettlement');
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map(row => row.roundSettlementId)).size, 1);
  assert.equal(rows.find(row => row.playerId === f.users[0].id).amount, -40); assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 0);
  assert.equal(f.service.stats(f.users[0].id).miniNet, -40); conserved(f.room);
});

test('a marked player may leave and receives the final settlement without joining the finishing hand', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start'); f.win(0); f.cmd(0, 'stand', f.consent(0));
  const before = f.room.members[f.users[0].id].cashedOut;
  assert.equal(f.room.mini.squid.reserves[f.users[0].id], undefined); f.service.start(f.room); f.win(1);
  assert.equal(f.room.hand.players.some(p => p.id === f.users[0].id), false);
  assert.equal(f.room.members[f.users[0].id].cashedOut, before + 20);
  assert.equal(f.service.stats(f.users[0].id).miniNet, 20);
  assert.equal(f.service.sessionFor(f.users[0].id, f.room.code).session.meMiniNet, 20);
  assert.equal(f.service.exportAdjustments(f.users[0].id, f.room.code).filter(row => row.type === 'squidSettlement').length, 1); conserved(f.room);
});

test('multiple pending departures retain liabilities and settle all absent unmarked players exactly once', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start');
  const firstId=randomUUID(), secondId=randomUUID(), firstQuote=f.consent(0), secondQuote=f.consent(1);
  f.cmd(0, 'stand', { ...firstQuote, commandId:firstId }); f.cmd(1, 'sitout', { value: true, ...secondQuote, commandId:secondId }); f.win(2);
  const q = f.room.mini.squid;
  assert.equal(q.active, true); assert.equal(f.store.data.ledger.filter(row => row.type === 'squidSettlement').length, 0);
  assert.equal(f.room.members[f.users[0].id].seat, null); assert.equal(f.room.members[f.users[1].id].sittingOut, true);
  assert.equal(q.absentSettlementAt, f.time+5000); f.advance(4999); f.service.tick(f.room,f.time); assert.equal(q.active,true);
  f.advance(1); f.service.tick(f.room,f.time);
  const rows=f.store.data.ledger.filter(row => row.type === 'squidSettlement');
  assert.equal(q.lastResult.reason,'absent'); assert.equal(rows.length,3); assert.equal(new Set(rows.map(row=>row.roundSettlementId)).size,1);
  assert.deepEqual(q.lastResult.changes,{[f.users[0].id]:-20,[f.users[1].id]:-20,[f.users[2].id]:40});
  assert.equal(f.room.hand.miniChanges[f.users[0].id],0,'between-hand settlement must not rewrite the finished hand');
  f.cmd(0,'stand',{...firstQuote,commandId:firstId});f.cmd(1,'sitout',{value:true,...secondQuote,commandId:secondId});
  assert.equal(f.store.data.ledger.filter(row=>row.type==='squidSettlement').length,3); conserved(f.room);
});

test('ordinary automatic dealing excludes offline players and requires two online players', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.win(0); f.connect(1, false); f.connect(2, false);
  assert.equal(f.room.nextHandAt, null); f.connect(1, true); const due = f.room.nextHandAt;
  f.advance(due - f.time); f.service.tick(f.room, f.time);
  assert.deepEqual(f.room.hand.players.map(p => p.id), [f.users[0].id, f.users[1].id]); conserved(f.room);
});

test('an absent squid player does not block two peers; insufficient players require continuous observed 90-second waiting', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start'); f.win(0); f.connect(1, false);
  assert.equal(f.room.mini.squid.blockerSince,null);assert.ok(Number.isFinite(f.room.nextHandAt));assert.equal(f.service.state(f.room,f.users[2].id).mini.squid.paused,false);
  f.connect(0,false); // Leave one unmarked player online, so nobody can finish the round by themselves.
  const since=f.room.mini.squid.blockerSince;assert.equal(since,f.time);assert.equal(f.room.nextHandAt,null);
  assert.throws(() => f.cmd(2,'settleSquid',{timestamp:f.time+90000}),/90 秒/);
  f.advance(89999);assert.equal(f.service.state(f.room,f.users[2].id).mini.squid.canSettle,false);
  f.connect(1,true);assert.equal(f.room.members[f.users[1].id].sittingOut,false,'return before 90 seconds remains active');assert.equal(f.room.mini.squid.blockerSince,null);f.connect(1,false);
  assert.equal(f.room.mini.squid.blockerSince,f.time);f.advance(90000);f.service.tick(f.room,f.time);
  f.connect(3,true);assert.throws(()=>f.cmd(3,'settleSquid'),/90 秒/);
  assert.equal(f.service.state(f.room,f.users[2].id).mini.squid.canSettle,true);f.cmd(2,'settleSquid');
  assert.deepEqual(f.room.mini.squid.lastResult.changes,{[f.users[0].id]:40,[f.users[1].id]:-20,[f.users[2].id]:-20});conserved(f.room);
});

test('restart resets the observation grace and GET projections never mutate saved lifecycle state', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start'); f.win(0); f.connect(0, false); f.connect(1, false); f.advance(90000);
  const data = structuredClone(f.store.data), r = data.rooms[f.room.code], recovered = new RoomService({ data });
  recovered.connections.set(`${r.code}:${f.users[2].id}`, 1); const before = structuredClone(data);
  assert.equal(recovered.state(r, f.users[2].id).mini.squid.canSettle, false); assert.deepEqual(data, before);
  recovered.connectionChanged(r, f.time, { reconnected: true }); assert.equal(r.mini.squid.blockerSince, f.time);
  assert.equal(recovered.canSettleSquid(r, f.users[2].id, f.time + 89999), false); assert.equal(recovered.canSettleSquid(r, f.users[2].id, f.time + 90000), true); conserved(r);
});

test('closing an unfinished round preserves earned markers and returns the unused reserve exactly once', t => {
  const f = fixture(t, { squid: true }); f.cmd(0, 'start'); f.win(0); const commandId = randomUUID();
  f.cmd(0, 'close', { commandId }); f.cmd(0, 'close', { commandId });
  assert.equal(f.room.status, 'closed'); assert.deepEqual(f.room.mini.squid.reserves, {});
  const rows = f.store.data.ledger.filter(row => row.type === 'squidSettlement'); assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.playerId === f.users[0].id).amount, 40);
  assert.equal(f.service.stats(f.users[0].id).miniNet, 40); assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 0); conserved(f.room);
});

test('public access, ten-room limit, per-host limit, and one seated table do not leak private room access', t => {
  const f = fixture(t, {}, 0);
  assert.throws(() => f.service.create(f.users[0], {}), /已有一桌/);
  const second = f.service.create(f.users[1], { access: 'public' }); f.service.join(f.users[2], second.code);
  assert.equal(f.service.state(second, f.users[2].id).access, 'public');
  f.cmd(2, 'sit', { seat: 2, amountBB: 100 });
  assert.throws(() => f.service.command(f.users[2], second.code, { type: 'sit', commandId: randomUUID(), seat: 0, amountBB: 100 }), /另一桌/);
  f.cmd(2, 'stand'); f.service.command(f.users[2], second.code, { type: 'sit', commandId: randomUUID(), seat: 0, amountBB: 100 });
  for (let i = 2; i < 10; i++) f.service.create(f.users[i], {});
  assert.throws(() => f.service.create(f.users[10], {}), /10 桌/);
  delete f.room.access;
  const outsider = { id: 'outsider', name: '外部' }; f.store.data.users.outsider = outsider;
  assert.throws(() => f.service.join(outsider, f.room.code), /邀请/); conserved(f.room); conserved(second);
});

test('unstarted rooms close after 30 offline minutes, but online rooms remain open', t => {
  const f = fixture(t, {}, 0), second = f.service.create(f.users[1], {});
  f.connect(0, true); f.advance(30 * 60000);
  f.service.tick(f.room, f.time); f.service.tick(second, f.time);
  assert.equal(f.room.status, 'waiting'); assert.equal(second.status, 'closed');
  f.connect(0, false); f.advance(30 * 60000 - 1); assert.equal(f.service.tick(f.room, f.time), false);
  f.advance(1); f.service.tick(f.room, f.time); assert.equal(f.room.status, 'closed');
});
