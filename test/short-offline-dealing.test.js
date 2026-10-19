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
      return service.connectionChanged(room, timestamp, { reconnected: connected, disconnectedId: connected ? null : users[i].id });
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


for (const settings of [{}, {squid:true,squidMode:'normal'}, {squid:true,squidMode:'unlimited'}]) {
 test(`short offline keeps dealing and pays natural blind once: ${JSON.stringify(settings)}`, t => {
  const f=fixture(t,settings,5);f.cmd(0,'start');f.win(0);f.connect(3,false);
  const id=f.users[3].id, since=f.time, before=f.room.members[id].stack;
  assert.equal(f.service.canReceiveHand(f.room,id),true);
  assert.ok(f.service.prepareStart(f.room,f.time,{requireOnline:true}).players.some(p=>p.id===id));
  nextHand(f);
  const p=f.room.hand.players.find(p=>p.id===id);
  assert.ok(p);assert.equal(f.room.hand.bigBlindSeat,3);assert.equal(p.contributed,f.room.settings.bigBlind);
  assert.equal(p.stack,before-f.room.settings.bigBlind);
  const current=structuredClone(f.room.hand), cash=f.room.members[id].stack;
  f.connect(3,true);f.connect(3,true);
  assert.deepEqual(f.room.hand,current);assert.equal(f.room.members[id].stack,cash);
  assert.equal(f.room.members[id].blindEntry.missedBig,false);conserved(f);
  f.connect(3,false);const newSince=f.time;
  assert.equal(f.service.canReceiveHand(f.room,id,newSince+89999),true);
  assert.equal(f.service.canReceiveHand(f.room,id,newSince+90000),false);
  f.advance(90000);f.service.syncOfflinePause(f.room,f.time);
  assert.equal(f.room.members[id].sittingOut,true);assert.deepEqual(f.room.hand,current);
  f.connect(3,true);assert.equal(f.room.members[id].sittingOut,true);
  assert.ok(!f.service.prepareStart(f.room,f.time,{requireOnline:true}).players.some(p=>p.id===id));conserved(f);
 });
}
for(const mode of ['normal','unlimited'])test(`${mode}: short offline zero-fish players do not cause premature settlement`,t=>{
 const f=fixture(t,{squid:true,squidMode:mode},5);f.cmd(0,'start');f.win(0);
 for(let i=1;i<5;i++)f.connect(i,false);
 assert.equal(f.service.squidAbsentResult(f.room,f.time),false);
 assert.equal(f.service.squidReady(f.room).length,5);
 const rows=f.data.ledger.filter(x=>x.type==='squidSettlement').length;
 nextHand(f);assert.equal(f.room.hand.players.length,5);
 assert.equal(f.data.ledger.filter(x=>x.type==='squidSettlement').length,rows);conserved(f);
});
test('unknown absence, restart, explicit pause and all-offline table do not acquire unintended play',t=>{
 const f=fixture(t,{},5);f.cmd(0,'start');f.win(0);
 f.service.connections.delete(f.room.code+':'+f.users[3].id);f.service.connectionChanged(f.room,f.time);
 assert.equal(f.service.canReceiveHand(f.room,f.users[3].id),false,'no known stream close');
 f.connect(3,true);f.connect(3,false);assert.equal(f.service.canReceiveHand(f.room,f.users[3].id),true);
 const restored=new RoomService({data:f.data});restored.syncOfflinePause(f.room,f.time);
 assert.equal(restored.canReceiveHand(f.room,f.users[3].id),false,'restart cannot infer permission');
 f.cmd(2,'sitout',{value:true});f.connect(2,false);
 assert.equal(f.service.canReceiveHand(f.room,f.users[2].id),false);
 for(let i=0;i<5;i++)f.connect(i,false);
 assert.equal(f.service.autoBlockReason(f.room),null);conserved(f);
});
test('a newly dealt offline player times out with check or fold, never an automatic call',t=>{
 const f=fixture(t,{},5);f.cmd(0,'start');f.win(0);f.connect(3,false);nextHand(f);
 for(let n=0;f.room.hand.actingId!==f.users[3].id;n++){
  assert.ok(n<10);readyRoomAction(f.service,f.room,v=>f.advance(v-f.time));
  const i=f.users.findIndex(u=>u.id===f.room.hand.actingId);f.cmd(i,'call');
 }
 readyRoomAction(f.service,f.room,v=>f.advance(v-f.time));
 const p=f.room.hand.players.find(p=>p.id===f.users[3].id), before=p.contributed;
 f.advance(f.room.deadline-f.time);assert.equal(f.service.timeout(f.room,f.time),true);
 assert.equal(p.contributed,before);assert.ok(f.room.hand.log.some(x=>x.playerId===p.id&&x.type==='check'));
 conserved(f);
});

for(const mode of ['normal','unlimited'])test(`${mode}: due bomb pot includes short-offline player and charges one ante`,t=>{
 const f=fixture(t,{squid:true,squidMode:mode,bombPot:true},5);f.cmd(0,'start');f.win(0);
 f.connect(3,false);f.room.nextBombAt=f.time;const before=f.room.members[f.users[3].id].stack;
 nextHand(f);assert.equal(f.room.hand.bombPot,true);
 const p=f.room.hand.players.find(p=>p.id===f.users[3].id);assert.ok(p);
 const antes=f.room.hand.log.filter(x=>x.playerId===p.id&&x.type==='ante');
 assert.equal(antes.length,1);assert.equal(before-p.stack,p.contributed);assert.ok(p.contributed>0);
 const contribution=p.contributed;f.connect(3,true);assert.equal(p.contributed,contribution);conserved(f);
});

for(const mode of [null,'normal','unlimited'])test(`whole table short disconnect retains seats and deals: ${mode}`,t=>{
 const f=fixture(t,mode?{squid:true,squidMode:mode,bombPot:true}:{},5);f.cmd(0,'start');f.win(0);
 const seats=f.users.slice(0,5).map(u=>f.room.members[u.id].seat);
 for(let i=0;i<5;i++)f.connect(i,false);
 assert.equal(f.service.autoBlockReason(f.room),null);nextHand(f);assert.equal(f.room.hand.players.length,5);conserved(f);
 f.advance(90000);f.service.syncOfflinePause(f.room,f.time);
 for(let i=0;i<5;i++){const m=f.room.members[f.users[i].id];assert.equal(m.seat,seats[i]);assert.equal(m.sittingOut,true);assert.equal(Boolean(m.leftRoom),false);}
 const snapshot=structuredClone(f.room.hand);f.connect(0,true);f.connect(0,true);assert.deepEqual(f.room.hand,snapshot);conserved(f);
});
