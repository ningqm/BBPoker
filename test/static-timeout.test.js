import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
function fixture({cached,fetch}={}){
 const timers=[],events={},writes=[];
 const context=vm.createContext({URL,Response,Headers,AbortController,fetch:fetch||(()=>new Promise(()=>{})),caches:{open:async()=>({match:async()=>cached,put:async(...args)=>writes.push(args)})},setTimeout:(fn,ms)=>{timers.push({fn,ms});return 1;},clearTimeout(){},self:{location:{origin:'https://bbpoker.fun'},addEventListener:(name,fn)=>events[name]=fn}});
 vm.runInContext(source,context);
 return {context,timers,events,writes,run:()=>context.loadStatic({url:'https://bbpoker.fun/app.js'})};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('cached resources return after four seconds even if fetch never settles',async()=>{
 const f=fixture({cached:new Response('cached')}),p=f.run();await flush();assert.equal(f.timers[0].ms,4000);f.timers[0].fn();assert.equal(await (await p).text(),'cached');
});
test('an uncached hung response fails with 503 after 15 seconds, not minutes',async()=>{
 const f=fixture(),p=f.run();await flush();assert.equal(f.timers[0].ms,15000);f.timers[0].fn();assert.equal((await p).status,503);
});
test('headers alone cannot defeat the body download timeout',async()=>{
 const f=fixture({cached:new Response('old'),fetch:async()=>({ok:true,arrayBuffer:()=>new Promise(()=>{})})}),p=f.run();await flush();f.timers[0].fn();assert.equal(await (await p).text(),'old');
});
test('successful resources update the current cache and failed responses never overwrite it',async()=>{
 const f=fixture({fetch:async()=>new Response('new')});assert.equal(await (await f.run()).text(),'new');assert.equal(f.writes.length,1);
 const bad=fixture({cached:new Response('old'),fetch:async()=>new Response('bad',{status:500})});assert.equal(await (await bad.run()).text(),'old');assert.equal(bad.writes.length,0);
});
test('API, POST and third party requests are not cached or intercepted',()=>{
 const f=fixture();for(const [url,method] of [['https://bbpoker.fun/api/me','GET'],['https://bbpoker.fun/app.js','POST'],['https://other.test/app.js','GET']]){
 let intercepted=false;f.events.fetch({request:{url,method},respondWith:()=>intercepted=true});assert.equal(intercepted,false);
 }
});
test('installation does not fetch a full asset pack',async()=>{
 const f=fixture();let skipped=0,installation;
 f.context.self.skipWaiting=()=>{skipped++;return Promise.resolve();};
 f.events.install({waitUntil:p=>installation=p});await installation;assert.equal(skipped,1);assert.equal(f.writes.length,0);assert.equal(f.timers.length,0);
});
test('content-addressed bundles use cache immediately without waiting for the network',async()=>{
 let fetched=0;const f=fixture({cached:new Response('bundle'),fetch:()=>{fetched++;return new Promise(()=>{});}});
 const r=await f.context.loadStatic({url:'https://bbpoker.fun/app-entry.0123456789abcdef.js'});
 assert.equal(await r.text(),'bundle');assert.equal(fetched,0);assert.equal(f.timers.length,0);
});
