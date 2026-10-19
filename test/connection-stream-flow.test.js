import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const streamSource=src.slice(src.indexOf("function stopStream(reason="),src.indexOf('function updateConnection(){'));
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture({status=200,kind='fresh',throwApply=false}={}){
 let now=1000,waiting,intervalFn;const events=[],timers=[],requests=[];
 const state={page:'room',room:{code:'123456',meId:'user',revision:5},user:{id:'user'},token:'session',connected:false,feedbackResync:true};
 state.connectionDiagnostics={record:(type,detail)=>events.push({type,...detail}),newStreamId:()=>String(requests.length).padStart(32,'a'),query:()=>'?unused'};
 const frame=kind==='heartbeat'?': keepalive\n\n':`data: ${JSON.stringify({code:'123456',meId:'user',revision:kind==='stale'?4:5,serverTime:1000})}\n\n`;
 let reads=0;
 const context=vm.createContext({state,AbortController,TextDecoder,Date:class extends Date{static now(){return now;}},performance:{now:()=>now},document:{visibilityState:'visible'},navigator:{onLine:true},
  mountTableModeEffects(){},app:{},tableSounds:{stopPlayback(){}},turnCountdown:{reset(){}},updateConnection(){},expireIdentity(){},isOlderRoomSnapshot:(a,b)=>Boolean(a&&a.revision>b.revision),
  normalizeState:room=>{if(throwApply)throw new Error('render failed private');if(room.revision<state.room.revision||now-room.serverTime>3000)return false;state.stream.diagnostic.freshSequence++;state.stream.diagnostic.lastFresh=now;state.feedbackResync=false;state.room=room;return true;},
  setInterval:fn=>{intervalFn=fn;return 1;},clearInterval(){},setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimeout(){},apiUrl:p=>p,
  fetch:async(path,options)=>{requests.push({path,options});return {status,ok:status===200,body:{getReader:()=>({read:()=>{if(reads++===0)return Promise.resolve({done:false,value:new TextEncoder().encode(frame)});return new Promise((resolve,reject)=>{waiting={resolve,reject};options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});}})}};},
 });
 vm.runInContext(streamSource,context);
 return {state,events,timers,requests,context,at:value=>{now=value;},run:attempt=>context.connectStream('123456',attempt,'initial'),end:()=>waiting.resolve({done:true}),watchdog:()=>intervalFn()};
}
for(const kind of ['fresh','stale','heartbeat'])test(`retry history resets only after healthy accepted state: ${kind}`,async()=>{
 const f=fixture({kind}),p=f.run(5);await settle();f.at(11000);f.end();await p;
 assert.equal(f.timers.at(-1).delay,kind==='fresh'?1200:12000);
 assert.equal(f.events.filter(e=>e.type==='stream_first_fresh').length,kind==='fresh'?1:0);
 assert.equal(f.events.find(e=>e.type==='reconnect_scheduled').reason,'stream_eof');
 assert.equal(f.events.at(-1).type,'stream_close');assert.equal(f.events.at(-1).durationMs,10000);
});
test('short lived fresh stream retains backoff to avoid reconnect hot loops',async()=>{
 const f=fixture(),p=f.run(5);await settle();f.at(10999);f.end();await p;assert.equal(f.timers.at(-1).delay,12000);
});
test('HTTP errors, application errors and malformed transport end have distinct reasons',async()=>{
 const unavailable=fixture({status:503});await unavailable.run(0);assert.equal(unavailable.events.at(-1).reason,'http_error');assert.equal(unavailable.events.at(-1).status,503);
 const render=fixture({throwApply:true});await render.run(0);assert.equal(render.events.at(-1).reason,'client_apply_error');
});
test('watchdog keeps its eight second threshold and reports foreground timer lag',async()=>{
 const f=fixture(),p=f.run(0);await settle();f.at(9000);f.watchdog();assert.equal(f.events.filter(e=>e.type==='watchdog').length,0);
 f.at(12000);f.watchdog();await settle();
 const event=f.events.find(e=>e.type==='watchdog');assert.equal(event.reason,'watchdog_timeout');assert.equal(event.timerLagMs,1000);assert.equal(event.lastByteAgeMs,11000);
 assert.equal(f.events.some(e=>e.type==='stream_stop'&&e.reason==='watchdog_timeout'),true);await p;
 f.context.stopStream('route');
});
test('explicit route stop is logged separately from involuntary stream failure',async()=>{
 const f=fixture(),p=f.run(0);await settle();f.at(2000);f.context.stopStream('route');await p;
 assert.equal(f.events.at(-1).reason,'route');assert.equal(f.events.filter(e=>e.type==='reconnect_scheduled').length,0);
});
for(const kind of ['fresh','stale'])test(`watchdog reconnect also discards an old failure streak only after healthy stream: ${kind}`,async()=>{
 const f=fixture({kind}),p=f.run(5);await settle();f.at(12000);f.watchdog();await settle();await p;
 const starts=f.events.filter(e=>e.type==='connect_start');assert.equal(starts.at(-1).attempt,kind==='fresh'?1:6);
 if(kind==='stale')assert.equal(f.events.some(e=>e.type==='stream_snapshot'&&e.reason==='stale_snapshot'),true);
 f.context.stopStream('route');
});
