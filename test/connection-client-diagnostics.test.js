import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionDiagnostics} from '../public/connection-diagnostics.js';
function fixture(){
 let now=1000,id=0,identity={key:'user-a',token:'SECRET_A'},context={room:'123456',visible:true,online:true,connected:true,resync:false};
 const timers=new Map(),uploads=[];let timerId=0;
 const diagnostics=createConnectionDiagnostics({getIdentity:()=>identity,getContext:()=>context,clock:()=>now,makeId:()=>String(++id).padStart(32,'0'),
  setTimer:(fn,ms)=>{const key=++timerId;timers.set(key,{fn,at:now+ms});return key;},clearTimer:key=>timers.delete(key),
  fetcher:(url,options)=>new Promise((resolve,reject)=>uploads.push({url,options,resolve,reject})),});
 return {diagnostics,uploads,timers,setIdentity:value=>{identity=value;},setContext:value=>{context=value;},at:time=>{now=time;for(const [key,t] of [...timers])if(t.at<=now){timers.delete(key);t.fn();}}};
}
test('connection metadata has a strict field and reason allowlist, bounded queue and payload',async()=>{
 const f=fixture();for(let i=0;i<150;i++)f.diagnostics.record('watchdog',{reason:'watchdog_timeout',timerLagMs:1234.2,hand:{cards:['As','Ah']},token:'secret',error:'private URL',userId:'someone',streamId:'a'.repeat(32)});
 assert.equal(f.diagnostics.snapshot().queued.length,120);assert.equal(f.diagnostics.snapshot().queued[0].seq,31);
 assert.equal(f.diagnostics.record('raw_error',{reason:'secret'}),false);
 const upload=f.diagnostics.flush(),body=JSON.parse(f.uploads[0].options.body);
 assert.equal(body.events.length,20);assert.equal(body.events[0].timerLagMs,1234);assert.ok(f.uploads[0].options.body.length<16000);
 for(const privateValue of ['As','Ah','secret','someone','private URL','user-a'])assert.equal(f.uploads[0].options.body.includes(privateValue),false);
 assert.equal(f.uploads[0].options.headers.Authorization,'Bearer SECRET_A');f.uploads[0].resolve({ok:true});assert.equal(await upload,true);
 assert.equal(f.diagnostics.snapshot().queued.length,100);
});
test('failed upload is independent, keeps events and backs off without recursively generating events',async()=>{
 const f=fixture();f.diagnostics.record('probe_result',{reason:'timeout'});
 const upload=f.diagnostics.flush();f.uploads[0].reject(new Error('secret failure'));assert.equal(await upload,false);
 assert.equal(f.diagnostics.snapshot().queued.length,1);assert.equal(f.uploads.length,1);
 assert.ok([...f.timers.values()].some(timer=>timer.at===21000));f.diagnostics.reset();
});
test('upload has its own deadline even if a transport never honors abort',async()=>{
 const f=fixture();f.diagnostics.record('lifecycle',{reason:'visible'});const upload=f.diagnostics.flush();f.at(5000);
 assert.equal(await upload,false);assert.equal(f.uploads[0].options.signal.aborted,true);assert.equal(f.diagnostics.snapshot().pending,false);assert.equal(f.diagnostics.snapshot().queued.length,1);
});
test('account switch clears old events, rotates correlation, aborts old upload and late completion cannot clear new upload',async()=>{
 const f=fixture();f.diagnostics.record('connect_start',{reason:'initial'});const a=f.diagnostics.snapshot().pageId,p1=f.diagnostics.flush();
 f.setIdentity({key:'user-b',token:'SECRET_B'});f.diagnostics.record('lifecycle',{reason:'visible'});
 assert.notEqual(f.diagnostics.snapshot().pageId,a);assert.equal(f.uploads[0].options.signal.aborted,true);assert.equal(f.diagnostics.snapshot().queued.length,1);
 const p2=f.diagnostics.flush();f.uploads[0].resolve({ok:true});await p1;
 assert.equal(f.diagnostics.snapshot().pending,true);assert.equal(f.diagnostics.snapshot().queued.length,1);
 assert.equal(f.uploads[1].options.headers.Authorization,'Bearer SECRET_B');
 f.uploads[1].resolve({ok:true});await p2;assert.equal(f.diagnostics.snapshot().queued.length,0);
});
test('late old upload failure never delays the new identity transport',async()=>{
 const f=fixture();f.diagnostics.record('connect_start',{reason:'initial'});const p1=f.diagnostics.flush();
 f.setIdentity({key:'user-b',token:'SECRET_B'});f.diagnostics.record('connect_start',{reason:'initial'});const p2=f.diagnostics.flush();
 f.uploads[0].reject(new Error('old'));await p1;f.uploads[1].resolve({ok:true});await p2;
 f.diagnostics.record('lifecycle',{reason:'visible'});assert.ok([...f.timers.values()].some(timer=>timer.at===11000));f.diagnostics.reset();
});
test('resync duration is scoped to the current room and IDs contain no identity',()=>{
 const f=fixture();f.diagnostics.gate(true);f.at(7000);f.setContext({room:'654321'});f.diagnostics.gate(true);f.at(8000);f.diagnostics.gate(false);
 assert.equal(f.diagnostics.snapshot().queued[0].durationMs,1000);assert.equal(f.diagnostics.snapshot().queued[0].room,'654321');
 assert.match(f.diagnostics.query('a'.repeat(32),'&'),/^&pageId=[0-9]{32}&streamId=a{32}$/);assert.equal(f.diagnostics.query('SECRET_A').includes('SECRET_A'),false);
 f.setIdentity(null);assert.equal(f.diagnostics.query('a'.repeat(32)),'');assert.equal(f.diagnostics.snapshot().queued.length,0);
});
test('broken diagnostic context or timer never escapes into gameplay',async()=>{
 const diagnostics=createConnectionDiagnostics({getIdentity:()=>{throw new Error('context');},setTimer:()=>{throw new Error('timer');}});
 assert.doesNotThrow(()=>diagnostics.record('connect_start',{reason:'initial'}));assert.doesNotThrow(()=>diagnostics.gate(true));assert.doesNotThrow(()=>diagnostics.reset());assert.equal(await diagnostics.flush(),false);
});
test('normal idle probes are sampled while every failure and reconnect remains visible',()=>{
 const f=fixture();
 const probe=reason=>{f.diagnostics.record('probe_start',{reason:'idle',phase:'idle'});f.diagnostics.record('probe_result',{reason,phase:'idle'});};
 probe('unchanged');f.at(4000);probe('unchanged');f.at(7000);probe('timeout');f.at(10000);probe('superseded');
 assert.deepEqual(f.diagnostics.snapshot().queued.map(e=>e.reason),['idle','unchanged','timeout','superseded']);
 f.at(31000);probe('unchanged');assert.deepEqual(f.diagnostics.snapshot().queued.slice(-2).map(e=>e.reason),['idle','unchanged']);f.diagnostics.reset();
});
test('all frontend event types and reasons are accepted by the production ingestion schema',async()=>{
 const client=await import('../public/connection-diagnostics.js'),server=await import('../src/connection-diagnostics.js');
 for(const type of client.CONNECTION_TYPES)assert.equal(server.CLIENT_CONNECTION_TYPES.has(type),true,type);
 for(const reason of client.CONNECTION_REASONS)assert.equal(server.CONNECTION_REASONS.has(reason),true,reason);
 const f=fixture();f.setContext({room:'123456',version:'0.25.4-diag1'});f.diagnostics.record('watchdog',{reason:'watchdog_timeout',timerLagMs:999,streamId:'c'.repeat(32)});
 const batch={v:1,pageId:f.diagnostics.snapshot().pageId,events:f.diagnostics.snapshot().queued},validated=server.validateConnectionReport(batch);
 assert.equal(validated.events[0].timerLagMs,999);assert.equal(validated.events[0].version,'0.25.4-diag1');f.diagnostics.reset();
});
