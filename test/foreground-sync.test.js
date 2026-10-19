import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function fixture(){
 const state={page:'room',token:'token',connected:true,stream:new AbortController(),room:{code:'123456',meId:'a'}};
 state.stream.diagnostic={freshSequence:0};
 const events=[];state.connectionDiagnostics={record:(type,detail)=>events.push({type,...detail}),query:()=>''};
 const calls=[],applied=[],reconnects=[];let valid=true;
 const context=vm.createContext({state,AbortController,document:{visibilityState:'visible'},requests:{capture:()=>({valid:()=>valid})},setTimeout,clearTimeout,
 updateConnection(){},normalizeState:r=>{applied.push(r);state.feedbackResync=false;},connectStream:c=>reconnects.push(c),
 api:(path,body,options)=>new Promise((resolve,reject)=>{calls.push({path,resolve,reject,signal:options.signal});options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})});
 vm.runInContext(src.slice(src.indexOf('async function refreshForegroundTable(){'),src.indexOf('function resumeTable(){')),context);
 return {state,calls,applied,reconnects,events,context,run:()=>context.refreshForegroundTable(),invalidate(){valid=false;}};
}
test('foreground refresh reuses the stream and coalesces duplicate resume events',async()=>{
 const f=fixture(),stream=f.state.stream,p=f.run();await f.run();assert.equal(f.calls.length,1);assert.equal(f.state.feedbackResync,true);
 f.calls[0].resolve({code:'123456',meId:'a'});await p;
 assert.equal(f.state.stream,stream);assert.equal(f.applied.length,1);assert.deepEqual(f.reconnects,[]);assert.equal(f.state.feedbackResync,false);
});
test('foreground failure reconnects without submitting any poker command',async()=>{
 const f=fixture(),p=f.run();f.calls[0].reject(new Error('offline'));await p;
 assert.deepEqual(f.reconnects,['123456']);assert.equal(f.calls[0].path,'/api/rooms/123456');
});
test('late foreground snapshots cannot cross account, room, stream or visibility changes',async()=>{
 for(const change of [f=>f.invalidate(),f=>f.state.room={code:'999999',meId:'a'},f=>f.state.stream=new AbortController(),f=>f.context.document.visibilityState='hidden']){
 const f=fixture(),p=f.run();change(f);f.calls[0].resolve({code:'123456',meId:'a'});await p;
 assert.equal(f.applied.length,0);assert.equal(f.reconnects.length,0);
 }
});
test('foreground response must belong to the requesting player',async()=>{
 const f=fixture(),p=f.run();f.calls[0].resolve({code:'123456',meId:'b'});await p;assert.equal(f.applied.length,0);
});

test('backgrounding does not schedule a disconnect and returning requests synchronization',()=>{
 const callbacks=[],cleared=[],stream=new AbortController();
 const state={page:'room',stream,connected:true,feedbackResync:false,clock:{},funEffects:[]};
 let listener,stops=0,resumes=0;
 const document={visibilityState:'hidden',querySelector:()=>null,addEventListener:(type,fn)=>{listener=fn;}};
 const context=vm.createContext({state,document,finishComposition(){},stopReplay(){},stopLobbyPolling(){},funTracker:{reset(){}},feedback:{reset(){}},tableSounds:{suspend(){}},updateConnection(){},resumeTable(){resumes++;},stopStream(){stops++;stream.abort();},clearTimeout:id=>cleared.push(id),setTimeout:(fn,ms)=>{callbacks.push({fn,ms});return callbacks.length;}});
 const start=src.indexOf("document.addEventListener('visibilitychange',()=>{");
 vm.runInContext(src.slice(start,src.indexOf("window.addEventListener('pageshow'",start)),context);
 listener();assert.equal(stops,0);assert.equal(state.feedbackResync,true);assert.equal(callbacks.length,0);assert.equal(stream.signal.aborted,false);
 document.visibilityState='visible';listener();assert.equal(resumes,1);assert.equal(stops,0);
 document.visibilityState='hidden';listener();assert.equal(callbacks.length,0);assert.equal(stream.signal.aborted,false);
});


test('an older projection that cannot clear resync triggers recovery instead of permanently locked controls',async()=>{
 const f=fixture();f.context.normalizeState=()=>false;
 const p=f.run();f.calls[0].resolve({code:'123456',meId:'a'});await p;
 assert.deepEqual(f.reconnects,['123456']);assert.equal(f.state.foregroundSync,null);
});

test('a buffered foreground projection keeps controls gated and leaves the stream for bounded recovery',async()=>{
 const f=fixture();f.context.normalizeState=()=>{f.state.snapshotStale=true;f.state.feedbackResync=true;};
 const p=f.run();f.calls[0].resolve({code:'123456',meId:'a'});await p;
 assert.deepEqual(f.reconnects,[]);assert.equal(f.state.foregroundSync,null);
 assert.equal(f.state.feedbackResync,true);assert.equal(f.events.at(-1).reason,'foreground_stale');
});

test('an equal-revision clock calibration candidate keeps its full-GET recovery path instead of restarting SSE',async()=>{
 const f=fixture();f.context.normalizeState=()=>false;f.state.turnRecovery={needsFullSnapshot:()=>true};
 const p=f.run();f.calls[0].resolve({code:'123456',meId:'a'});await p;
 assert.deepEqual(f.reconnects,[]);assert.equal(f.state.foregroundSync,null);assert.equal(f.state.feedbackResync,true);
});

test('foreground HTTP failure after an accepted fresh SSE does not tear down the healthy stream',async()=>{
 const f=fixture(),stream=f.state.stream,p=f.run();
 f.state.stream.diagnostic.freshSequence++;f.state.feedbackResync=false;
 f.calls[0].reject(new Error('late HTTP failure'));await p;
 assert.equal(f.state.stream,stream);assert.deepEqual(f.reconnects,[]);assert.equal(f.events.at(-1).reason,'superseded');
});
test('a stale SSE that does not advance accepted freshness cannot suppress foreground recovery',async()=>{
 const f=fixture(),p=f.run();f.state.feedbackResync=false;
 f.calls[0].reject(new Error('HTTP failure'));await p;
 assert.deepEqual(f.reconnects,['123456']);assert.equal(f.events.at(-1).reason,'foreground_failed');
});
test('a rendering failure during foreground response is not mistaken for live-stream recovery',async()=>{
 const f=fixture(),p=f.run();f.context.normalizeState=()=>{f.state.stream.diagnostic.freshSequence++;f.state.feedbackResync=false;throw new Error('render failed');};
 f.calls[0].resolve({code:'123456',meId:'a'});await p;
 assert.deepEqual(f.reconnects,['123456']);assert.equal(f.events.at(-1).reason,'client_apply_error');
});
