import test from 'node:test';
import { readyRoomAction } from './helpers/room-clock.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService, exportCsv } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { aggregateAnalytics } from '../src/analytics.js';

function fixture(t, count = 4) {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const users = Array.from({ length: count + 1 }, (_, i) => ({ id: `oracle-${i}`, name: `Synthetic ${i}`, avatar: 0 }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], { settings: { smallBlind: 1, bigBlind: 2, maxPlayers: count, squid: true, squidUnitBB: 1 } });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => {
    const q = room.mini.squid, id = users[i].id, inRound = q.active && q.participants.includes(id);
    return service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length,
      ...(['stand', 'sitout'].includes(type) ? { expectedSquidRound: inRound ? q.round : 0, expectedSquidCost: inRound && !q.won.includes(id) ? (q.participants.length - 1) * q.unit : 0 } : {}), ...extra });
  };
  for (let i = 0; i < count; i++) { service.connections.set(`${room.code}:${users[i].id}`, 1); cmd(i, 'sit', { seat: i, amountBB: 100 }); }
  service.start(room);
  return { users, store, service, room, cmd, ready: () => readyRoomAction(service, room, value => { clock = value; }) };
}
function finishTo(f, winner) {
  const id = f.users[winner].id;
  for (let i = 0; f.room.hand.status === 'playing'; i++) {
    assert.ok(i < 40); if (!f.ready()) break;
    const actor = f.room.hand.actingId, a = availableActions(f.room.hand, actor);
    f.cmd(f.users.findIndex(u => u.id === actor), actor === id ? a.canCheck ? 'check' : 'call' : 'fold');
  }
  assert.deepEqual(f.room.hand.result.mainWinnerIds, [id]);
}
function conserved(f) {
  const r = f.room, members = Object.values(r.members);
  const actual = members.reduce((sum, m) => sum + m.stack + m.cashedOut, 0) + Object.values(r.mini.squid.reserves).reduce((a, b) => a + b, 0)
    + (r.hand?.status === 'playing' ? r.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0);
  assert.equal(actual, members.reduce((sum, m) => sum + m.totalBuyIn, 0));
}

test('independent oracle: queued leavers retain reserves and only marked players share multiple absent penalties', t => {
  const f=fixture(t);f.cmd(0,'stand');f.cmd(1,'stand');
  assert.equal(f.room.members['oracle-0'].seat,0);assert.equal(f.room.mini.squid.active,true);conserved(f);
  finishTo(f,2);assert.equal(f.store.data.ledger.filter(row=>row.type==='squidSettlement').length,0);
  assert.equal(f.room.members['oracle-0'].seat,null);assert.equal(f.room.members['oracle-1'].seat,null);
  assert.equal(f.room.mini.squid.reserves['oracle-0'],6);assert.equal(f.room.mini.squid.reserves['oracle-1'],6);
  f.service.start(f.room);assert.deepEqual(f.room.hand.players.map(p=>p.id),['oracle-2','oracle-3']);finishTo(f,3);
  const due=f.room.mini.squid.absentSettlementAt;assert.ok(Number.isFinite(due));assert.equal(f.room.mini.squid.active,true);
  f.service.completeRabbit(f.room,due);f.service.tick(f.room,due);
  const rows=f.store.data.ledger.filter(row=>row.type==='squidSettlement');
  assert.equal(rows.length,4);assert.equal(new Set(rows.map(row=>row.roundSettlementId)).size,1);
  assert.deepEqual(Object.fromEntries(rows.map(row=>[row.playerId,row.amount])),{'oracle-0':-4,'oracle-1':-4,'oracle-2':4,'oracle-3':4});
  assert.ok(rows.every(row=>row.reason==='absent'));assert.equal(f.room.mini.squid.active,false);conserved(f);
  f.service.finish(f.room);f.cmd(0,'stand');assert.equal(f.store.data.ledger.filter(row=>row.type==='squidSettlement').length,4);
  for(const row of rows)assert.equal(aggregateAnalytics(f.store.data,row.playerId).miniNet,row.amount);
});

test('independent oracle: returning a marked original player preserves its token and re-enters the same round without a second reserve', t => {
  const f=fixture(t);f.cmd(0,'stand');finishTo(f,0);
  assert.equal(f.room.members['oracle-0'].seat,null);assert.deepEqual(f.room.mini.squid.won,['oracle-0']);
  const reserves=structuredClone(f.room.mini.squid.reserves);assert.equal(reserves['oracle-0'],6);conserved(f);
  f.cmd(0,'sit',{seat:0,amountBB:100});assert.equal(f.service.waitingFor(f.room,f.room.members['oracle-0']),null);
  assert.deepEqual(f.room.mini.squid.reserves,reserves);assert.deepEqual(f.room.mini.squid.won,['oracle-0']);
  f.service.start(f.room);assert.ok(f.room.hand.players.some(p=>p.id==='oracle-0'));assert.equal(f.room.hand.squidRound,1);finishTo(f,1);
  f.service.start(f.room);finishTo(f,2);conserved(f);
  const stats=aggregateAnalytics(f.store.data,'oracle-0');assert.equal(stats.hands,3);assert.equal(stats.miniNet,2);assert.equal(stats.squidSettlementCount,1);
  assert.equal(f.service.waitingFor(f.room,f.room.members['oracle-0']),null);
  f.service.start(f.room);assert.ok(f.room.hand.players.some(p=>p.id==='oracle-0'));assert.equal(f.room.mini.squid.round,2);conserved(f);
});

test('independent oracle: normal completion takes precedence over queued exit without a second penalty', t => {
  const f = fixture(t, 3); finishTo(f, 0); f.service.start(f.room);
  f.cmd(1, 'stand'); f.cmd(2, 'stand'); finishTo(f, 2);
  const rows = f.store.data.ledger.filter(row => row.type === 'squidSettlement');
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.reason === 'normal'));
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.playerId, row.amount])), { 'oracle-0': 2, 'oracle-1': -4, 'oracle-2': 2 });
  assert.equal(f.room.members['oracle-1'].seat, null); assert.equal(f.room.members['oracle-2'].seat, null); conserved(f);
});

test('independent oracle: a full table rejects another seat, then admits a newcomer without changing current squid participants or reserves', t => {
  const f = fixture(t), participants = [...f.room.mini.squid.participants], reserves = structuredClone(f.room.mini.squid.reserves);
  assert.throws(() => f.cmd(4, 'sit', { seat: 0, amountBB: 100 }));
  assert.equal(f.room.members['oracle-4'].totalBuyIn, 0);
  finishTo(f, 0); f.cmd(0, 'stand'); f.cmd(4, 'sit', { seat: 0, amountBB: 100 });
  assert.deepEqual(f.room.mini.squid.participants, participants); assert.deepEqual(f.room.mini.squid.reserves, reserves);
  assert.equal(f.service.waitingFor(f.room, f.room.members['oracle-4']), 'squid');
  f.service.start(f.room); assert.ok(!f.room.hand.players.some(p => p.id === 'oracle-4'));
  assert.deepEqual(f.service.state(f.room, 'oracle-4').players.find(p => p.id === 'oracle-4').cards, []); conserved(f);
});

test('independent oracle: grace begins only below two available players and resets on recovery or restart', t => {
  const f=fixture(t);finishTo(f,0);const now=Date.now();
  f.service.connections.set(`${f.room.code}:oracle-1`,0);f.service.connectionChanged(f.room,t);
  assert.equal(f.service.canSettleSquid(f.room,'oracle-2',now+90000),false,'one absent player does not block the original round');
  for(const i of [0,3])f.service.connections.set(`${f.room.code}:oracle-${i}`,0);f.service.connectionChanged(f.room,now+1);
  assert.equal(f.service.canSettleSquid(f.room,'oracle-2',now+90000),false);assert.equal(f.service.canSettleSquid(f.room,'oracle-2',now+90001),true);
  assert.equal(f.service.canSettleSquid(f.room,'oracle-4',now+90001),false);
  f.service.connections.set(`${f.room.code}:oracle-1`,1);f.service.connectionChanged(f.room,now+90002);
  assert.equal(f.service.canSettleSquid(f.room,'oracle-2',now+90002),false);
  f.service.connections.set(`${f.room.code}:oracle-1`,0);f.service.connectionChanged(f.room,now+90003);
  assert.equal(f.service.canSettleSquid(f.room,'oracle-2',now+100000),false);
  const restored=new RoomService(f.store);restored.connections.set(`${f.room.code}:oracle-2`,1);restored.syncLifecycle(f.room,now+200000);
  assert.equal(restored.canSettleSquid(f.room,'oracle-2',now+200001),false);assert.equal(restored.canSettleSquid(f.room,'oracle-2',now+290000),true);
  assert.equal(f.store.data.ledger.filter(row=>row.type==='squidSettlement').length,0);conserved(f);
});

test('independent oracle: date-bounded exports split a cross-midnight squid settlement from its hand once', t => {
  const f = fixture(t, 3); finishTo(f, 0); f.service.start(f.room); finishTo(f, 1);
  const squidHand = f.store.data.hands.find(h => h.squidSettlementId);
  for (const h of f.store.data.hands) h.at = '2026-10-12T23:59:59.000Z';
  for (const row of f.store.data.ledger) if (row.type === 'squidSettlement') row.at = '2026-10-13T00:00:01.000Z';
  const id = 'oracle-0', sum = (hands, adjustments) => hands.reduce((n, h) => n + h.players.find(p => p.id === id).miniNet, 0) + adjustments.reduce((n, r) => n + r.amount, 0);
  const before = f.service.exports(id, f.room.code, '2026-10-12', '2026-10-12');
  const beforeAdjustments = f.service.exportAdjustments(id, f.room.code, '2026-10-12', '2026-10-12');
  const after = f.service.exports(id, f.room.code, '2026-10-13', '2026-10-13');
  const afterAdjustments = f.service.exportAdjustments(id, f.room.code, '2026-10-13', '2026-10-13');
  assert.equal(sum(before, beforeAdjustments), 0); assert.equal(sum(after, afterAdjustments), 2);
  assert.equal(after.length, 0); assert.equal(afterAdjustments.length, 1);
  assert.equal(f.service.handFor(id, f.room.code, squidHand.id).players.find(p => p.id === id).miniNet, 2);
  assert.equal(sum(f.service.exports(id), f.service.exportAdjustments(id)), 2);
  assert.match(exportCsv(after, id, afterAdjustments), /鱿鱼结算/);
});
