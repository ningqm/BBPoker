import test from 'node:test';
import assert from 'node:assert/strict';
import {createTurnRecovery,stalledTurnReason} from '../public/turn-recovery.js';

function room(overrides={}) {
  return {code:'123456',meId:'a',revision:4,status:'playing',deadline:22000,
    hand:{id:'h1',status:'playing',actingId:'a',actionSeq:4,actionReadyAt:2000},
    actions:{turnAvailable:true,canAct:false},...overrides};
}
function harness() {
  let time=2000,context={room:room(),page:'room',identity:'test-session',visible:true,online:true,connected:true,resync:false,busy:false};
  const calls=[],applied=[],reconnected=[],timers=new Map();let timerId=0;
  const recovery=createTurnRecovery({getContext:()=>({...context,now:time}),clock:()=>time,
    fetchRoom:(code,signal)=>new Promise((resolve,reject)=>{calls.push({code,signal,resolve,reject});signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}),
    apply:state=>{applied.push(state);context.room=state;},reconnect:code=>reconnected.push(code),
    setTimer:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,at:time+delay});return id;},clearTimer:id=>timers.delete(id)});
  return {recovery,calls,applied,reconnected,context,
    at(value){time=value;for(const [id,t] of timers)if(t.at<=time){timers.delete(id);t.fn();}},
    resolve(value){calls.at(-1).resolve(value??{...context.room,actions:{turnAvailable:true,canAct:true}});},
  };
}

test('waits for the deal gate and a short delivery grace before fetching authoritative permissions',async()=>{
  const h=harness();h.at(2499);assert.equal(await h.recovery.check(),false);assert.equal(h.calls.length,0);
  h.at(2500);const pending=h.recovery.check();assert.equal(h.calls.length,1);assert.equal(h.calls[0].code,'123456');
  assert.equal(h.context.room.actions.canAct,false,'the clock must never enable betting locally');
  h.resolve();await pending;assert.equal(h.applied.length,1);assert.equal(h.context.room.actions.canAct,true);
  h.at(9000);const resumed=h.recovery.check();h.resolve();await resumed;
  assert.equal(h.calls.length,2,'a suspended page timer also resynchronizes without needing a tap');
});

test('normal visible ticks and not-yet-due server turns do not poll',async()=>{
  const h=harness();h.context.room.actions.canAct=true;
  for(let i=2000;i<22000;i+=400){h.at(i);assert.equal(await h.recovery.check(),false);}
  assert.equal(h.calls.length,0);
  assert.equal(stalledTurnReason(h.context.room,23199),null);
  assert.equal(stalledTurnReason(h.context.room,23200),'deadline');
});

test('an expired turn refreshes automatically and never resubmits the last action',async()=>{
  const h=harness();h.context.room.actions.canAct=true;h.at(23200);
  const pending=h.recovery.check();assert.equal(h.calls.length,1);
  const next=room({revision:5,deadline:44000,hand:{id:'h1',status:'playing',actingId:'b',actionSeq:5,actionReadyAt:24000},actions:{canAct:false,turnAvailable:false}});
  h.resolve(next);await pending;assert.equal(h.context.room,next);assert.equal(h.calls.length,1);
});

test('repeated ticks make one in-flight request and retry at most once every 2.5 seconds',async()=>{
  const h=harness();h.at(2500);const first=h.recovery.check();
  for(const time of [2700,3300,4000]){h.at(time);assert.equal(await h.recovery.check(),false);}
  h.resolve(h.context.room);await first;
  h.at(4999);assert.equal(await h.recovery.check(),false);assert.equal(h.calls.length,1);
  h.at(5000);const second=h.recovery.check();assert.equal(h.calls.length,2);h.resolve();await second;
});

for(const [name,patch] of [['hidden',{visible:false}],['offline',{online:false}],['not a table',{page:'lobby'}],['disconnected',{connected:false}],['resync',{resync:true}],['action pending',{busy:true}]]) {
  test(`${name} cannot trigger or apply a speculative turn refresh`,async()=>{
    const h=harness();h.at(2500);Object.assign(h.context,patch);assert.equal(await h.recovery.check(),false);assert.equal(h.calls.length,0);
  });
}

for(const change of ['room','identity','hidden','busy']) {
  test(`a response after ${change} changes is ignored`,async()=>{
    const h=harness();h.at(2500);const pending=h.recovery.check();
    if(change==='room')h.context.room={...h.context.room,code:'654321'};
    if(change==='identity')h.context.identity='another-session';
    if(change==='hidden')h.context.visible=false;
    if(change==='busy')h.context.busy=true;
    h.resolve(room({actions:{canAct:true}}));await pending;assert.equal(h.applied.length,0);assert.equal(h.reconnected.length,0);
  });
}

test('stopping a stream cancels a pending refresh and does not revive it',async()=>{
  const h=harness();h.at(2500);const pending=h.recovery.check();h.recovery.reset();await pending;
  assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.applied.length,0);assert.equal(h.reconnected.length,0);
});

test('a bounded refresh timeout requests a new stream without a notification or command retry',async()=>{
  const h=harness();h.at(2500);const pending=h.recovery.check();h.at(6500);await pending;
  assert.equal(h.calls[0].signal.aborted,true);assert.deepEqual(h.reconnected,['123456']);assert.equal(h.calls.length,1);
});

test('wrong room or viewer payload cannot be applied',async()=>{
  for(const patch of [{code:'654321'},{meId:'b'}]) {
    const h=harness();h.at(2500);const pending=h.recovery.check();h.resolve(room(patch));await pending;assert.equal(h.applied.length,0);
  }
});

test('presentation recovery covers stalled runout and transitions, never completed tables',()=>{
  const r=room({actions:{canAct:false,turnAvailable:false},deadline:null});
  r.hand.transition={nextAt:3000};assert.equal(stalledTurnReason(r,4200),'presentation');
  delete r.hand.transition;r.hand.runout={active:true,nextAt:4000};assert.equal(stalledTurnReason(r,5200),'presentation');
  r.hand.status='complete';assert.equal(stalledTurnReason(r,30000),null);
});
