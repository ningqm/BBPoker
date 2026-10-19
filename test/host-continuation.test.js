import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { readyRoomAction } from './helpers/room-clock.js';

function fixture(t, settings = {}, count = 3) {
  let timestamp = 1800000000000;
  t.mock.method(Date, 'now', () => timestamp);
  const users = Array.from({ length: 6 }, (_, i) => ({ id: 'continuation-' + i, name: '朋友' + i, avatar: i }));
  const data = { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data });
  const room = service.create(users[0], { settings: { durationMinutes: 15, ...settings } });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, {
    type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra,
  });
  for (let i = 0; i < count; i++) {
    cmd(i, 'sit', { seat: i, amountBB: 100 });
    service.connections.set(room.code + ':' + users[i].id, 1);
  }
  service.connectionChanged(room, timestamp);
  return {
    users, data, service, room, cmd,
    get time() { return timestamp; },
    advance(ms) { timestamp += ms; },
    tick() { return service.tick(room, timestamp); },
    connect(i, connected) {
      service.connections.set(room.code + ':' + users[i].id, connected ? 1 : 0);
      return service.connectionChanged(room, timestamp, { reconnected: connected });
    },
    quote(i) {
      const projected = service.state(room, users[i].id), player = projected.players.find(p => p.id === users[i].id);
      return { expectedSquidRound: room.mini.squid.active && room.mini.squid.participants.includes(users[i].id) ? room.mini.squid.round : 0,
        expectedSquidCost: player.squidMaxLoss };
    },
    win(i) {
      for (let steps = 0; room.hand?.status === 'playing'; steps++) {
        assert.ok(steps < 100, 'a hand must eventually settle');
        if (!readyRoomAction(service, room, value => { timestamp = value; })) break;
        const actor = users.findIndex(u => u.id === room.hand.actingId);
        const actions = availableActions(room.hand, room.hand.actingId);
        cmd(actor, actor === i ? actions.canCheck ? 'check' : 'call' : 'fold');
      }
      service.completeRabbit(room, timestamp);
    },
  };
}
function conserved(f) {
  const members = Object.values(f.room.members);
  const committed = f.room.hand?.status === 'playing' ? f.room.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0;
  const reserve = Object.values(f.room.mini.squid.reserves).reduce((sum, x) => sum + x, 0);
  assert.equal(members.reduce((sum, m) => sum + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0) + committed + reserve + f.room.mini.mushroom.pool,
    members.reduce((sum, m) => sum + m.totalBuyIn, 0));
}
function nextHand(f) {
  assert.ok(Number.isFinite(f.room.nextHandAt), 'ready peers must receive an automatic next-hand deadline');
  assert.ok(f.room.nextHandAt >= f.time, 'the next-hand countdown must not be overdue');
  f.advance(f.room.nextHandAt - f.time); f.tick();
}

test('host continuation: standing during a hand cannot pause the remaining ready peers', t => {
  const f = fixture(t); f.cmd(0, 'start'); const original = f.room.hand.id;
  f.cmd(0, 'stand'); assert.equal(f.room.hand.id, original); assert.equal(f.room.members[f.users[0].id].pendingDeparture, 'stand');
  f.win(1); assert.equal(f.room.members[f.users[0].id].seat, null); assert.equal(f.room.autoDealPaused, false);
  nextHand(f); assert.equal(f.room.handNumber, 2);
  assert.deepEqual(f.room.hand.players.map(p => p.id).sort(), [f.users[1].id, f.users[2].id].sort()); conserved(f);
});

test('host continuation: explicit leave transfers management without cancelling the current hand or fish liability', t => {
  const f = fixture(t, { squid: true, squidMode: 'unlimited' }, 4); f.cmd(0, 'start');
  const handId = f.room.hand.id, participants = [...f.room.mini.squid.participants], budget = f.room.mini.squid.tokenBudget;
  const commandId = randomUUID(), quote = f.quote(0);
  f.cmd(0, 'leave', { ...quote, commandId });
  assert.equal(f.room.members[f.users[0].id].leftRoom, true);
  assert.equal(f.room.members[f.users[0].id].pendingDeparture, 'leave');
  assert.notEqual(f.room.hostId, f.users[0].id); assert.equal(f.service.online(f.room, f.room.hostId), true);
  assert.equal(f.room.hand.id, handId); assert.deepEqual(f.room.mini.squid.participants, participants);
  assert.equal(f.room.mini.squid.tokenBudget, budget); assert.equal(f.room.autoDealPaused, false);
  f.win(1); assert.equal(f.room.members[f.users[0].id].seat, null);
  assert.ok(f.room.members[f.users[0].id].cashedOut > 0); assert.equal(f.room.mini.squid.active, true);
  assert.deepEqual(f.room.mini.squid.participants, participants); assert.equal(f.data.ledger.filter(row => row.type === 'squidSettlement').length, 0);
  const ledger = structuredClone(f.data.ledger);
  f.cmd(0, 'leave', { ...quote, commandId }); assert.deepEqual(f.data.ledger, ledger, 'a retried leave must not cash out twice');
  nextHand(f); assert.equal(f.room.handNumber, 2); assert.ok(!f.room.hand.players.some(p => p.id === f.users[0].id)); conserved(f);
});

test('host continuation: leaving while paused transfers to a ready peer and clears the abandoned pause', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.win(0); f.cmd(0, 'autoDeal', { paused: true });
  f.cmd(0, 'leave', f.quote(0));
  assert.notEqual(f.room.hostId, f.users[0].id); assert.equal(f.room.autoDealPaused, false);
  nextHand(f); assert.equal(f.room.handNumber, 2); conserved(f);
});

test('host continuation: short disconnect preserves the host and an intentional pause after reconnect', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.win(0); f.cmd(0, 'autoDeal', { paused: true });
  f.connect(0, false); f.advance(29999); f.tick();
  assert.equal(f.room.hostId, f.users[0].id); assert.equal(f.room.autoDealPaused, true);
  f.connect(0, true); f.advance(30001); f.tick();
  assert.equal(f.room.hostId, f.users[0].id); assert.equal(f.room.autoDealPaused, true);
  assert.equal(f.room.nextHandAt, null); conserved(f);
});

test('host continuation: sustained host absence transfers once and lets peers continue without a resume click', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.win(0); f.cmd(0, 'autoDeal', { paused: true });
  f.connect(0, false); f.advance(30000);
  assert.equal(f.service.needsTick(f.room, f.time), true); f.tick();
  const successor = f.room.hostId;
  assert.notEqual(successor, f.users[0].id); assert.equal(f.room.autoDealPaused, false);
  const due = f.room.nextHandAt;
  f.connect(0, true); assert.equal(f.room.hostId, successor, 'returning host cannot steal management back');
  assert.equal(f.room.nextHandAt, due, 'reconnection cannot prolong an existing countdown');
  assert.throws(() => f.cmd(0, 'autoDeal', { paused: true }), error => error.status === 403);
  nextHand(f); assert.equal(f.room.handNumber, 2); conserved(f);
});

test('host continuation: an abandoned pause is cleared even when every peer already hosts another table', t => {
  const f = fixture(t);
  f.service.create(f.users[1], {}); f.service.create(f.users[2], {});
  f.cmd(0, 'start'); f.win(0); f.cmd(0, 'autoDeal', { paused: true });
  f.connect(0, false); f.advance(30000); f.tick();
  assert.equal(f.room.autoDealPaused, false);
  assert.equal(f.room.hostId, f.users[0].id, 'do not violate the one active table per host rule');
  nextHand(f); assert.equal(f.room.handNumber, 2); conserved(f);
});

test('host continuation: all players offline waits and returning ready peers restart automatically', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.win(0);
  for (let i = 0; i < 3; i++) f.connect(i, false);
  f.advance(35000); f.tick(); assert.equal(f.room.handNumber, 1); assert.equal(f.room.nextHandAt, null);
  f.connect(1, true); assert.equal(f.room.nextHandAt, null);
  f.connect(2, true); assert.ok(f.room.nextHandAt >= f.time + 5000);
  nextHand(f); assert.equal(f.room.handNumber, 2);
  assert.deepEqual(f.room.hand.players.map(p => p.id).sort(), [f.users[1].id, f.users[2].id].sort()); conserved(f);
});

for (const mode of ['normal', 'unlimited']) test('host continuation: expired playable ' + mode + ' squid cannot remain permanently paused', t => {
  const f = fixture(t, { squid: true, squidMode: mode }); f.cmd(0, 'start'); f.win(0);
  const round = f.room.mini.squid.round; assert.equal(f.room.mini.squid.active, true);
  f.cmd(0, 'autoDeal', { paused: true }); f.advance(f.room.endsAt - f.time + 1);
  assert.equal(f.service.needsTick(f.room, f.time), true); f.tick();
  assert.equal(f.room.autoDealPaused, false); assert.equal(f.room.status, 'waiting');
  nextHand(f); assert.equal(f.room.mini.squid.round, round, 'finish the original fish round without beginning another');
  f.win(1); assert.equal(f.room.status, 'closed'); assert.equal(f.room.mini.squid.active, false);
  const rows = f.data.ledger.filter(row => row.type === 'squidSettlement');
  assert.equal(rows.length, 3); assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 0);
  const ledger = structuredClone(f.data.ledger); f.advance(60000); f.tick(); assert.deepEqual(f.data.ledger, ledger); conserved(f);
});

test('host continuation: paused expired squid with insufficient players settles only once after bounded recovery', t => {
  const f = fixture(t, { squid: true, squidMode: 'unlimited' }); f.cmd(0, 'start'); f.win(0); f.cmd(0, 'autoDeal', { paused: true });
  for (let i = 0; i < 3; i++) f.connect(i, false);
  f.advance(f.room.endsAt - f.time); f.tick();
  const deadline = f.service.state(f.room, f.users[0].id).mini.squid.expiryGraceEndsAt;
  assert.equal(deadline, f.time + 90000); f.advance(89999); f.tick(); assert.notEqual(f.room.status, 'closed');
  f.advance(1); f.tick(); assert.equal(f.room.status, 'closed');
  assert.equal(f.data.ledger.filter(row => row.type === 'squidSettlement').length, 3);
  const ledger = structuredClone(f.data.ledger); f.advance(10000); f.tick(); assert.deepEqual(f.data.ledger, ledger); conserved(f);
});

test('host continuation: explicitly reseating after departure preserves identity, fish and prior cashout', t => {
  const f = fixture(t, { squid: true, squidMode: 'unlimited' }, 4); f.cmd(0, 'start'); f.win(0);
  const round = f.room.mini.squid.round, fish = f.room.mini.squid.counts[f.users[0].id];
  f.cmd(0, 'leave', f.quote(0)); const successor = f.room.hostId, member = f.room.members[f.users[0].id], cashedOut = member.cashedOut;
  f.service.join(f.users[0], f.room.code, f.room.invite);
  assert.equal(f.room.members[f.users[0].id], member); assert.equal(member.leftRoom, true, 'viewing an old invite must not undo a confirmed leave');
  assert.equal(member.cashedOut, cashedOut); assert.equal(f.room.hostId, successor); assert.equal(f.room.mini.squid.round, round);
  assert.equal(f.room.mini.squid.counts[f.users[0].id], fish);
  f.cmd(0, 'sit', { seat: 0, amountBB: 100, entryMode: 'post' });
  assert.equal(Boolean(member.leftRoom), false); assert.equal(f.room.hostId, successor, 'reseating cannot steal the host role back');
  nextHand(f); assert.equal(f.room.hand.players.some(p => p.id === f.users[0].id), true);
  assert.equal(f.room.mini.squid.participants.filter(id => id === f.users[0].id).length, 1);
  assert.equal(f.room.mini.squid.counts[f.users[0].id], fish); conserved(f);
});

test('host continuation: legacy completed rooms without a pause field resume automatically when peers are ready', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.win(0);
  delete f.room.autoDealPaused; delete f.room.nextHandAt; delete f.room.autoWaitReason;
  f.advance(1000); assert.equal(f.service.needsTick(f.room, f.time), true); f.tick();
  assert.equal(Boolean(f.room.autoDealPaused), false); nextHand(f);
  assert.equal(f.room.handNumber, 2); conserved(f);
});

test('host continuation: another live browser connection keeps the host online', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.win(0); f.cmd(0, 'autoDeal', { paused: true });
  const key = f.room.code + ':' + f.users[0].id;
  f.service.connections.set(key, 2); f.service.connectionChanged(f.room, f.time);
  f.service.connections.set(key, 1); f.service.connectionChanged(f.room, f.time);
  f.advance(60000); f.tick();
  assert.equal(f.room.hostId, f.users[0].id); assert.equal(f.room.autoDealPaused, true);
  f.connect(0, false); f.advance(29999); f.tick(); assert.equal(f.room.hostId, f.users[0].id);
  f.advance(1); f.tick(); assert.notEqual(f.room.hostId, f.users[0].id); assert.equal(f.room.autoDealPaused, false);
});

test('host continuation: hand-in-progress handover changes no cards, action deadline or money', t => {
  const f = fixture(t); f.cmd(0, 'start');
  readyRoomAction(f.service, f.room, value => f.advance(value - f.time));
  const actor = f.users.findIndex(u => u.id === f.room.hand.actingId);
  f.cmd(actor, 'timebank');
  const hand = structuredClone(f.room.hand), deadline = f.room.deadline;
  const accounting = Object.values(f.room.members).map(m => [m.id, m.stack, m.totalBuyIn, m.cashedOut]);
  f.connect(0, false); f.advance(30000); f.tick();
  assert.notEqual(f.room.hostId, f.users[0].id);
  assert.deepEqual(f.room.hand, hand); assert.equal(f.room.deadline, deadline);
  assert.deepEqual(Object.values(f.room.members).map(m => [m.id, m.stack, m.totalBuyIn, m.cashedOut]), accounting); conserved(f);
});

test('host continuation: reopening an invite before pending leave settles does not cancel the departure', t => {
  const f = fixture(t, { squid: true, squidMode: 'unlimited' }, 4); f.cmd(0, 'start');
  f.cmd(0, 'leave', f.quote(0)); const successor = f.room.hostId;
  f.service.join(f.users[0], f.room.code, f.room.invite);
  assert.equal(f.room.members[f.users[0].id].leftRoom, true);
  assert.equal(f.room.members[f.users[0].id].pendingDeparture, 'leave');
  assert.equal(f.room.hostId, successor); f.win(1);
  assert.equal(f.room.members[f.users[0].id].seat, null);
  assert.equal(f.room.mini.squid.participants.includes(f.users[0].id), true); conserved(f);
});

test('host continuation: restart observes a fresh offline grace and state reads do not transfer ownership', t => {
  const f = fixture(t); f.cmd(0, 'start'); f.win(0); f.cmd(0, 'autoDeal', { paused: true }); f.connect(0, false); f.advance(29000);
  const data = structuredClone(f.data), room = data.rooms[f.room.code], recovered = new RoomService({ data });
  for (const user of f.users.slice(1, 3)) recovered.connections.set(room.code + ':' + user.id, 1);
  const before = structuredClone(data);
  recovered.state(room, f.users[1].id); assert.deepEqual(data, before);
  recovered.connectionChanged(room, f.time, { reconnected: true });
  f.advance(1000); recovered.tick(room, f.time); assert.equal(room.hostId, f.users[0].id);
  f.advance(29000); recovered.tick(room, f.time); assert.notEqual(room.hostId, f.users[0].id);
  assert.equal(room.autoDealPaused, false); assert.ok(Number.isFinite(room.nextHandAt));
});

test('host continuation: explicit departure chooses an online seated successor rather than a spectator', t => {
  const f = fixture(t); f.connect(3, true); f.cmd(0, 'leave', f.quote(0));
  assert.notEqual(f.room.hostId, f.users[0].id); assert.notEqual(f.room.hostId, f.users[3].id);
  assert.notEqual(f.room.members[f.room.hostId].seat, null); assert.equal(f.service.online(f.room, f.room.hostId), true);
  assert.equal(f.room.hand, null); assert.equal(f.room.startedAt, null);
  const successor = f.users.findIndex(u => u.id === f.room.hostId);
  f.cmd(successor, 'start'); assert.equal(f.room.handNumber, 1); conserved(f);
});




test('host continuation: backgrounding before the first hand preserves start authority beyond 30 seconds', t => {
  const f = fixture(t);
  const ledger = structuredClone(f.data.ledger);
  f.connect(0, false); f.advance(120000); f.tick();
  assert.equal(f.room.hostId, f.users[0].id);
  assert.equal(f.room.hand, null);
  assert.equal(f.room.startedAt, null);
  assert.equal(f.room.hostAbsentSince ?? null, null);
  assert.deepEqual(f.data.ledger, ledger);
  assert.throws(() => f.cmd(1, 'start'));
  f.connect(0, true);
  assert.equal(f.service.state(f.room, f.users[0].id).hostId, f.users[0].id);
  f.cmd(0, 'start');
  assert.equal(f.room.handNumber, 1); conserved(f);
});

test('host continuation: pre-start reconnect and server restart do not silently transfer the host', t => {
  const f = fixture(t); f.connect(0, false);
  // Old snapshots may already carry an absence deadline from the old policy.
  f.room.hostAbsentSince = f.time - 60000;
  f.room.hostAbsentEpoch = f.service.observationId;
  f.room.hostAbsentId = f.users[0].id;
  f.tick(); assert.equal(f.room.hostAbsentSince, null);
  const data = structuredClone(f.data), room = data.rooms[f.room.code];
  const service = new RoomService({ data });
  service.connections.set(room.code + ':' + f.users[1].id, 1);
  service.connectionChanged(room, f.time);
  f.advance(120000); service.tick(room, f.time);
  assert.equal(room.hostId, f.users[0].id); assert.equal(room.hand, null);
  f.connect(0, true); f.connect(0, false); f.advance(60000); f.tick();
  assert.equal(f.room.hostId, f.users[0].id);
});

test('host continuation: voluntary pre-start transfer remains authoritative after original host returns', t => {
  const f = fixture(t);
  f.cmd(0, 'transferHost', { playerId: f.users[1].id });
  f.connect(0, false); f.advance(60000); f.tick(); f.connect(0, true);
  assert.equal(f.room.hostId, f.users[1].id);
  assert.throws(() => f.cmd(0, 'start'));
  f.cmd(1, 'start'); assert.equal(f.room.handNumber, 1); conserved(f);
});

for (const settings of [{}, {squid:true}, {squid:true,squidMode:'unlimited',bombPot:true}]) {
 test(`offline protection: 90-second pause preserves hand, funds and frozen fish ${JSON.stringify(settings)}`,t=>{
  const f=fixture(t,settings);f.cmd(0,'start');
  const m=f.room.members[f.users[1].id],hand=f.room.hand.id,stack=m.stack;
  const participants=[...f.room.mini.squid.participants];
  f.connect(1,false);f.advance(89999);f.tick();assert.equal(m.sittingOut,false);
  f.advance(1);f.tick();assert.equal(m.sittingOut,true);assert.equal(m.autoSitOut,true);
  assert.equal(f.room.hand.id,hand);assert.equal(m.stack,stack);
  assert.deepEqual(f.room.mini.squid.participants,participants);conserved(f);
  f.connect(1,true);assert.equal(m.sittingOut,true,'reconnect cannot silently re-enter');
  f.win(0);conserved(f);
  const before=m.stack,ledger=f.data.ledger.length;
  f.cmd(1,'sitout',{value:false,entryMode:'post'});
  assert.equal(m.sittingOut,false);assert.equal(m.stack,before,'choosing entry cannot charge blinds');
  assert.equal(f.data.ledger.length,ledger);
  f.connect(1,true);f.connect(1,true);assert.equal(m.stack,before);conserved(f);
 });
}
test('offline protection: short interruption and another live tab do not pause',t=>{
 const f=fixture(t);const m=f.room.members[f.users[1].id];
 f.connect(1,false);f.advance(89000);f.connect(1,true);f.advance(2000);f.tick();assert.equal(m.sittingOut,false);
 f.service.connections.set(f.room.code+':'+m.id,1);f.service.connectionChanged(f.room,f.time);
 f.advance(91000);f.tick();assert.equal(m.sittingOut,false);
});
test('offline protection: reconnect at threshold pauses even before scheduled tick',t=>{
 const f=fixture(t);const m=f.room.members[f.users[1].id];
 f.connect(1,false);f.advance(90000);f.connect(1,true);assert.equal(m.sittingOut,true);
 const stack=m.stack;for(let i=0;i<3;i++){f.connect(1,true);f.tick();}assert.equal(m.stack,stack);
});
test('offline protection: missing player is excluded from next hand, returns on explicit command and duplicate command cannot charge',t=>{
 const f=fixture(t,{},4);f.cmd(0,'start');f.connect(2,false);f.advance(90000);f.tick();f.win(0);
 const m=f.room.members[f.users[2].id],before=m.stack;nextHand(f);
 assert.ok(!f.room.hand.players.some(p=>p.id===m.id));assert.equal(m.stack,before);f.win(0);
 f.connect(2,true);const cmd={type:'sitout',value:false,entryMode:'post',commandId:randomUUID()};
 f.service.command(f.users[2],f.room.code,cmd);f.service.command(f.users[2],f.room.code,cmd);
 assert.equal(m.stack,before);conserved(f);
});
for(const mode of ['normal','unlimited'])test(`offline protection: ${mode} fish settlement survives absence and cannot repeat`,t=>{
 const f=fixture(t,{squid:true,squidMode:mode},4);f.cmd(0,'start');f.connect(1,false);f.advance(90000);f.tick();f.win(0);
 assert.equal(f.room.members[f.users[1].id].sittingOut,true);conserved(f);
 f.service.settleSquid(f.room,{reason:'partial',timestamp:f.time});conserved(f);
 const balances=Object.values(f.room.members).map(m=>[m.stack,m.squidDebt]),rows=f.data.ledger.length;
 f.connect(1,true);f.service.settleSquid(f.room,{reason:'partial',timestamp:f.time});
 assert.deepEqual(Object.values(f.room.members).map(m=>[m.stack,m.squidDebt]),balances);assert.equal(f.data.ledger.length,rows);conserved(f);
});
