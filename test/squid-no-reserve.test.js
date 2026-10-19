import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { EncryptedStore } from '../src/store.js';
import { availableActions } from '../src/poker.js';
import { exportPhh } from '../src/phh.js';
import { readyRoomAction } from './helpers/room-clock.js';

function fixture(t, mode = 'unlimited', unitBB = 200) {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const users = ['A','B','C','D'].map(id => ({ id, name: id }));
  const f = { users, data: { users: Object.fromEntries(users.map(u => [u.id,u])), rooms: {}, hands: [], ledger: [] } };
  f.service = new RoomService({ data: f.data });
  f.room = f.service.create(users[0], { settings: { squid: true, squidMode: mode, squidUnitBB: unitBB, bombPot: true, durationMinutes: 30 } });
  f.cmd = (id, type, extra = {}) => f.service.command(f.data.users[id], f.room.code, { commandId: randomUUID(), type,
    handId: f.room.hand?.id, actionSeq: f.room.hand?.log.length, ...extra });
  for (const [seat,u] of users.entries()) {
    if (seat) f.service.join(u, f.room.code, f.room.invite);
    if (seat < 3) { f.cmd(u.id,'sit',{seat, amountBB:100}); f.service.connections.set(`${f.room.code}:${u.id}`,1); }
  }
  f.start = () => f.service.start(f.room, clock);
  f.win = id => {
    for(let count=0;f.room.hand.status==='playing';count++) {
      assert.ok(count < 100);
      if (!readyRoomAction(f.service, f.room, t => { clock=t; })) break;
      const actor=f.room.hand.actingId, a=availableActions(f.room.hand,actor);
      f.cmd(actor, actor===id ? a.canCheck?'check':'call' : 'fold');
    }
    f.service.completeRabbit(f.room,clock); conserved(f);
  };
  f.restart = () => {
    const dir=mkdtempSync(join(tmpdir(),'squid-no-reserve-'));
    try {
      const store=new EncryptedStore(dir);store.data=f.data;store.save();
      const next=new EncryptedStore(dir);f.data=next.data;f.service=new RoomService(next);f.room=f.data.rooms[f.room.code];
      f.service.releaseLegacySquidReserves(f.room,clock);next.save();
      for(const id of ['A','B','C'])f.service.connections.set(`${f.room.code}:${id}`,1);
    }finally{rmSync(dir,{recursive:true,force:true});}
  };
  return f;
}
function conserved(f) {
  const ms=Object.values(f.room.members), pot=f.room.hand?.status==='playing'?f.room.hand.players.reduce((s,p)=>s+p.contributed,0):0;
  for(const m of ms){assert.ok(Number.isSafeInteger(m.stack)&&m.stack>=0);assert.ok(Number.isSafeInteger(m.squidDebt??0)&&(m.squidDebt??0)>=0);}
  assert.equal(ms.reduce((s,m)=>s+m.stack+m.cashedOut-(m.squidDebt??0),0)+pot+Object.values(f.room.mini.squid.reserves).reduce((s,x)=>s+x,0),ms.reduce((s,m)=>s+m.totalBuyIn,0));
}

for(const mode of ['normal','unlimited'])test(`${mode}: all chips remain available; short loser gets a conserved debt cleared by replay-safe top-ups`,t=>{
  const f=fixture(t,mode);f.start();
  assert.deepEqual(f.room.mini.squid.reserves,{});
  assert.deepEqual(f.room.hand.players.map(p=>p.startingStack),[1000,1000,1000]);
  f.win('A');f.start();f.win('B');
  const q=f.room.mini.squid;
  assert.equal(q.active,false);assert.deepEqual(q.lastResult.changes,{A:2000,B:2000,C:-4000});
  assert.deepEqual(q.history,[q.lastResult]);
  assert.notEqual(q.history[0],q.lastResult,'history is an independent snapshot');
  assert.deepEqual(f.service.state(f.room,'C').mini.squid.history,q.history);
  const history=structuredClone(q.history);
  const m=f.room.members.C, debt=m.squidDebt;
  assert.ok(debt>3000&&debt<=4000);assert.equal(m.stack,0);
  const view=f.service.state(f.room,'C').players.find(p=>p.id==='C');
  assert.equal(view.squidDebt,debt);assert.equal(view.sessionProfit,-debt-1000);
  assert.equal(f.service.stats('C').miniNet,-4000);
  const before=structuredClone(f.data.hands), commandId=randomUUID();
  f.cmd('C','buyin',{amountBB:100,commandId});f.cmd('C','buyin',{amountBB:100,commandId});
  assert.equal(m.stack,0);assert.equal(m.squidDebt,debt-1000);assert.equal(m.totalBuyIn,2000);conserved(f);
  f.restart();assert.deepEqual(f.room.mini.squid.history,history);f.cmd('C','buyin',{amountBB:100,commandId});
  assert.equal(f.room.members.C.squidDebt,debt-1000);assert.equal(f.room.members.C.totalBuyIn,2000);
  f.cmd('C','buyin',{amountBB:400});
  assert.equal(f.room.members.C.squidDebt,0);assert.equal(f.room.members.C.stack,5000-debt);
  assert.deepEqual(f.data.hands,before);conserved(f);
});

test('departed loser keeps cashout history plus debt; returning with chips clears debt before entry, then closing is exact',t=>{
  const f=fixture(t);f.start();f.win('A');
  f.cmd('C','stand',{expectedSquidRound:1,expectedSquidCost:12000});
  const returned=f.room.members.C.cashedOut;
  f.start();f.win('B');
  assert.equal(f.room.members.C.cashedOut,returned);assert.equal(f.room.members.C.squidDebt,4000);conserved(f);
  const sitId=randomUUID();f.cmd('C','sit',{seat:2,amountBB:500,entryMode:'post',commandId:sitId});
  f.cmd('C','sit',{seat:2,amountBB:500,entryMode:'post',commandId:sitId});
  assert.equal(f.room.members.C.stack,1000);assert.equal(f.room.members.C.squidDebt,0);assert.equal(f.room.members.C.totalBuyIn,6000);
  f.cmd('A','close');conserved(f);
  const v=f.service.state(f.room,'C').players.find(p=>p.id==='C');
  assert.equal(v.cashedOut,returned+1000);assert.equal(v.sessionProfit,returned-5000);
});

test('close with an unpaid loser settles once without negative poker chips or disappearing losses',t=>{
  const f=fixture(t);f.start();f.win('A');
  const closeId=randomUUID();f.cmd('A','close',{commandId:closeId});
  const snapshot=structuredClone(f.data);f.restart();f.cmd('A','close',{commandId:closeId});
  assert.deepEqual(f.data.ledger,snapshot.ledger);assert.deepEqual(f.data.hands,snapshot.hands);
  assert.ok(f.room.members.B.squidDebt>0);assert.ok(f.room.members.C.squidDebt>0);
  assert.equal(Object.values(f.room.members).reduce((s,m)=>s+m.cashedOut-(m.squidDebt??0)-m.totalBuyIn,0),0);
  for(const id of ['A','B','C'])assert.equal(f.service.state(f.room,id).players.find(p=>p.id===id).sessionProfit,f.service.stats(id).net);
  conserved(f);
});

for(const live of [false,true])test(`legacy reserve refunds once at a safe boundary (live=${live}) and never changes archived hands`,t=>{
  const f=fixture(t,'unlimited',2);f.start();f.win('A');
  const prior=structuredClone(f.data.hands), q=f.room.mini.squid;
  // Construct the immediately preceding release's saved financial model.
  q.rulesVersion=6;delete q.accounting;q.reserves={A:120,B:120,C:120};
  for(const m of Object.values(f.room.members))if(q.participants.includes(m.id))m.stack-=120;
  if(live){
    // An old process started the next hand before the update. New construction
    // here intentionally uses pre-refund stacks and preserves the old metadata.
    const savedRelease=f.service.releaseLegacySquidReserves;f.service.releaseLegacySquidReserves=()=>false;
    f.start();f.service.releaseLegacySquidReserves=savedRelease;
  }
  const hand=structuredClone(f.room.hand), before=Object.fromEntries(q.participants.map(id=>[id,f.room.members[id].stack]));
  f.restart();
  assert.deepEqual(f.data.hands,prior);
  if(live){assert.deepEqual(f.room.hand,hand);for(const id of q.participants)assert.equal(f.room.members[id].stack,before[id]);f.win('A');}
  else for(const id of q.participants)assert.equal(f.room.members[id].stack,before[id]+120);
  assert.deepEqual(f.room.mini.squid.reserves,{});assert.equal(f.room.mini.squid.accounting,'settle-at-end');
  assert.deepEqual(f.room.mini.squid.reserveRelease.amounts,{A:120,B:120,C:120});
  const balances=structuredClone(f.room.members);f.restart();assert.deepEqual(f.room.members,balances);
  assert.deepEqual(f.data.hands.slice(0,prior.length),prior);conserved(f);
});


test('a live-hand queued top-up pays newly settled squid debt only after poker history is frozen',t=>{
  const f=fixture(t);f.start();f.win('A');f.start();
  const commandId=randomUUID();f.cmd('C','buyin',{amountBB:500,commandId});
  assert.equal(f.room.members.C.totalBuyIn,1000);
  const old=f.room.members.C.stack;f.cmd('C','buyin',{amountBB:500,commandId});assert.equal(f.room.members.C.stack,old);
  f.win('B');
  const m=f.room.members.C,p=f.room.hand.players.find(p=>p.id==='C');
  assert.equal(m.squidDebt,0);assert.equal(m.totalBuyIn,6000);assert.equal(m.stack,p.stack+1000);
  assert.equal(f.room.hand.endingStacks.C,p.stack-4000,'stored hand ending excludes later 5000-point buy-in');
  assert.equal(f.service.stats('C').miniNet,-4000);conserved(f);
});


test('PHH exports signed room net debt separately from nonnegative poker finishing stacks',t=>{
  const f=fixture(t);f.start();f.win('A');f.start();f.win('B');
  const hand=f.service.handFor('C',f.room.code,f.room.hand.id);
  assert.ok(hand.players.find(p=>p.id==='C').endingStack<0);
  const phh=exportPhh([hand],[],'C');
  const poker=/^finishing_stacks = \[(.*)\]$/m.exec(phh)[1].split(',').map(Number);
  const net=/^_tongzhuo_room_ending_stacks = \[(.*)\]$/m.exec(phh)[1].split(',').map(Number);
  assert.ok(poker.every(n=>n>=0));assert.ok(net.some(n=>n<0));
  assert.equal(poker.reduce((s,n)=>s+n,0),hand.players.reduce((s,p)=>s+p.startingStack,0));
  assert.equal(net.reduce((s,n)=>s+n,0),poker.reduce((s,n)=>s+n,0),'squid transfers preserve total net despite an individual debt');
});

test('squid result history retains thirty independent rounds without changing settlement or duplicating retries',t=>{
 const f=fixture(t,'normal',1);f.start();f.win('A');
 const q=f.room.mini.squid;
 q.history=Array.from({length:30},(_,i)=>({round:i-29,changes:{A:0,B:0,C:0}}));
 f.start();f.win('B');
 assert.equal(q.history.length,30);assert.equal(q.history.at(-1).round,q.round);
 const ledgerLength=f.data.ledger.length,history=structuredClone(q.history);
 assert.equal(f.service.settleSquid(f.room,{reason:'partial'}),null);
 assert.equal(f.data.ledger.length,ledgerLength);assert.deepEqual(q.history,history);conserved(f);
});
