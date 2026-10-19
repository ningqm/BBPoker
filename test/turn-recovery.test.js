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

test('a missed early action is recovered before the previous players old deadline',async()=>{
  let time=2000;
  const old=room({deadline:22000,actions:{canAct:false,turnAvailable:false},hand:{id:'h1',status:'playing',actingId:'b',actionSeq:4,actionReadyAt:2000}});
  const context={room:old,page:'room',identity:'session',visible:true,online:true,connected:true,resync:false,busy:false};
  const probes=[],applied=[];
  const recovery=createTurnRecovery({getContext:()=>({...context,now:time}),clock:()=>time,
    fetchRoom:()=>{throw new Error('must use the lightweight probe');},
    probeRoom:async(code,known)=>{probes.push({code,known});return {room:room({revision:5,deadline:24000,actions:{canAct:true,turnAvailable:true}})};},
    apply:value=>{applied.push(value);context.room=value;},reconnect:()=>{throw new Error('unexpected reconnect');}});
  recovery.observed();
  for(time=2400;time<5000;time+=400)await recovery.check();
  assert.equal(probes.length,0);
  time=5000;await recovery.check();
  assert.equal(probes.length,1);assert.deepEqual(probes[0].known,{revision:4,canAct:false});
  assert.equal(applied[0].actions.canAct,true);assert.ok(applied[0].deadline-time>=19000);
});

test('fresh snapshots and unchanged probes suppress redundant snapshots, hidden clients stop probing',async()=>{
  let time=1000;
  const context={room:room({actions:{canAct:true,turnAvailable:true}}),page:'room',identity:'session',visible:true,online:true,connected:true,resync:false,busy:false};
  let probes=0,applied=0;
  const recovery=createTurnRecovery({getContext:()=>({...context,now:time}),clock:()=>time,
    probeRoom:async()=>{probes++;return {unchanged:true,code:context.room.code,meId:'a'};},apply:()=>applied++,fetchRoom:()=>{},reconnect:()=>{}});
  recovery.observed();time=3900;await recovery.check();assert.equal(probes,0);
  recovery.observed();time=5000;await recovery.check();assert.equal(probes,0);
  time=6900;await recovery.check();assert.equal(probes,1);assert.equal(applied,0);
  time=9700;await recovery.check();assert.equal(probes,1);
  context.visible=false;time=10000;await recovery.check();assert.equal(probes,1);
  context.visible=true;time=10400;await recovery.check();assert.equal(probes,2);
});

test('a trickle of buffered older snapshots cannot keep suppressing the independent freshness probe',async()=>{
  let time=1000,probes=0;
  const context={room:room({actions:{canAct:true,turnAvailable:true}}),page:'room',identity:'session',visible:true,online:true,connected:true,resync:false,busy:false};
  const recovery=createTurnRecovery({getContext:()=>({...context,now:time}),clock:()=>time,
    probeRoom:async()=>{probes++;return {unchanged:true,code:context.room.code,meId:'a',serverTime:time};},
    fetchRoom:()=>{},apply:()=>{},reconnect:()=>{}});
  assert.equal(recovery.observed({serverTime:1000}),true);
  for(time=1500;time<=4500;time+=500){
    assert.equal(recovery.observed({serverTime:time-4000}),false);
    await recovery.check();
  }
  assert.equal(probes,1,'old transport activity must not be treated as live table progress');
});

for (const fresh of [false,true]) test(`failed idle probes preserve a healthy stream; fresh response during failure=${fresh}`,async()=>{
 let time=1000,failures=[],reconnects=0;
 const context={room:room({actions:{canAct:true},deadline:90000}),page:'room',identity:'session',visible:true,online:true,connected:true,resync:false,busy:false};
 const recovery=createTurnRecovery({getContext:()=>({...context,now:time}),clock:()=>time,
  probeRoom:()=>new Promise((resolve,reject)=>failures.push(reject)),fetchRoom:()=>{},apply:()=>{},reconnect:()=>reconnects++});
 recovery.observed({serverTime:time});
 time=4000;const first=recovery.check();failures[0](new Error('timeout'));await first;assert.equal(reconnects,0);
 time=7000;const second=recovery.check();
 if(fresh)recovery.observed({serverTime:time});
 failures[1](new Error('timeout'));await second;assert.equal(reconnects,fresh?0:1);
});

test('fresh stream state supersedes a failed stalled-turn refresh',async()=>{
 const h=harness();h.at(2500);const pending=h.recovery.check();
 h.recovery.observed({serverTime:2500});h.calls[0].reject(new Error('timeout'));await pending;
 assert.equal(h.reconnected.length,0);
});
test('probe diagnostics distinguish suppressed failure from repeated-failure reconnect and never report credentials',async()=>{
 let time=1000;const events=[],rejects=[],reconnects=[];
 const context={room:room({actions:{canAct:true},deadline:90000}),page:'room',identity:'SECRET',visible:true,online:true,connected:true,resync:false,busy:false};
 const recovery=createTurnRecovery({getContext:()=>({...context,now:time}),clock:()=>time,diagnose:(type,event)=>events.push({type,...event}),
  probeRoom:()=>new Promise((_,reject)=>rejects.push(reject)),apply(){},fetchRoom(){},reconnect:(code,reason)=>reconnects.push({code,reason})});
 recovery.observed({serverTime:time});time=4000;let p=recovery.check();recovery.observed({serverTime:time});rejects.shift()(Object.assign(new Error('secret'),{status:503}));await p;
 assert.equal(events.at(-1).reason,'superseded');assert.equal(events.at(-1).status,503);assert.equal(reconnects.length,0);
 for(time of [7000,10000]){p=recovery.check();rejects.shift()(Object.assign(new Error('private'),{status:429}));await p;}
 assert.deepEqual(reconnects,[{code:'123456',reason:'probe_failures'}]);assert.equal(events.at(-1).reason,'probe_failures');assert.equal(JSON.stringify(events).includes('SECRET'),false);assert.equal(JSON.stringify(events).includes('private'),false);
});
test('diagnostic callback failures cannot block authoritative turn recovery',async()=>{
 const context={room:room(),page:'room',identity:'session',visible:true,online:true,connected:true,resync:false,busy:false,now:2500};let applied=false;
 const recovery=createTurnRecovery({getContext:()=>context,clock:()=>2500,diagnose:()=>{throw new Error('telemetry');},fetchRoom:async()=>context.room,apply:()=>{applied=true;},reconnect(){}});
 await recovery.check();assert.equal(applied,true);
});
test('a cancelled previous stream probe never borrows the replacement stream correlation',async()=>{
 const h=harness(),events=[];let rejectPending;h.context.streamId='a'.repeat(32);
 const recovery=createTurnRecovery({getContext:()=>({...h.context,now:2500}),clock:()=>2500,diagnose:(type,detail)=>events.push({type,...detail}),
  fetchRoom:()=>new Promise((_,reject)=>{rejectPending=reject;}),apply(){},reconnect(){}});
 const pending=recovery.check();recovery.reset();h.context.streamId='b'.repeat(32);rejectPending(new Error('old abort'));await pending;
 assert.equal(events.length,1);assert.equal(events[0].streamId,'a'.repeat(32));assert.equal(events[0].type,'probe_start');
});
for(const probe of [false,true])test(`application failure during ${probe?'idle probe':'full recovery'} reconnects once without mistaking its own observed state for success`,async()=>{
 let time=1000;const requests=[],reconnects=[],events=[];
 const context={room:room({actions:{canAct:probe,turnAvailable:true},deadline:90000}),page:'room',identity:'session',visible:true,online:true,connected:true,resync:false,busy:false};
 const recovery=createTurnRecovery({getContext:()=>({...context,now:time}),clock:()=>time,
  fetchRoom:async code=>{requests.push({method:'GET',code});return {...context.room,serverTime:time};},
  ...(probe?{probeRoom:async code=>{requests.push({method:'GET',code});return {room:{...context.room,serverTime:time}};}}:{}),
  diagnose:(type,detail)=>events.push({type,...detail}),apply:()=>{throw new Error('render failure');},reconnect:(code,reason)=>reconnects.push({code,reason})});
 recovery.observed({serverTime:time});time=4000;await recovery.check();
 assert.deepEqual(reconnects,[{code:'123456',reason:'client_apply_error'}]);assert.equal(events.at(-1).reason,'client_apply_error');
 assert.deepEqual(requests,[{method:'GET',code:'123456'}],'diagnostic recovery never replays a poker action');
});
