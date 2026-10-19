import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardRevealController } from '../public/lifecycle.js';
function fixture(){
 const shown=new Set(),calls=[],applied=[],errors=[];
 let live={userId:'u',code:'123456',handId:'h1',valid:()=>true,canReveal:i=>!shown.has(i),isShown:i=>shown.has(i)};
 const c=createCardRevealController({current:()=>live,send:(scope,index)=>new Promise((resolve,reject)=>calls.push({scope,index,resolve,reject})),apply:r=>applied.push(r),failed:e=>errors.push(e),changed:()=>{}});
 return {c,shown,calls,applied,errors,get live(){return live;},set live(v){live=v;}};
}
test('a slow first reveal does not serialize the second or allow duplicate taps',async()=>{
 const f=fixture(),first=f.c.reveal(0),second=f.c.reveal(1);
 assert.equal(f.calls.length,2); assert.equal(await f.c.reveal(0),false);
 assert.deepEqual(f.calls.map(c=>c.index),[0,1]);
 assert.ok(f.c.pending(f.live,0)); assert.ok(f.c.pending(f.live,1));
 f.calls[1].resolve('second');await second;assert.deepEqual(f.applied,['second']);
 f.calls[0].resolve('first');await first;assert.deepEqual(f.applied,['second','first']);
 assert.equal(f.c.pending(f.live,0),false); assert.equal(f.c.pending(f.live,1),false);
});
test('new hand or account discards late reveal results and does not lock new controls',async()=>{
 for(const field of ['handId','userId','code']){
  const f=fixture(),p=f.c.reveal(0); f.live={...f.live,[field]:'new'};
  assert.equal(f.c.pending(f.live,0),false);
  f.calls[0].resolve('old');await p;assert.deepEqual(f.applied,[]);
 }
});
test('lost HTTP after event confirmation does not show an erroneous failure',async()=>{
 const f=fixture(),p=f.c.reveal(0);f.shown.add(0);f.calls[0].reject(new Error('timeout'));await p;
 assert.deepEqual(f.errors,[]);assert.equal(await f.c.reveal(0),false);
});
test('failed unconfirmed card is retryable without revealing its neighbor',async()=>{
 const f=fixture(),p=f.c.reveal(1);f.calls[0].reject(new Error('offline'));await p;
 assert.equal(f.errors.length,1);assert.equal(f.c.pending(f.live,1),false);
 const retry=f.c.reveal(1);assert.deepEqual(f.calls.map(x=>x.index),[1,1]);
 f.calls[1].resolve('ok');await retry;
});
test('invalidated session ignores late response even if identifiers match',async()=>{
 const f=fixture();let valid=true;f.live.valid=()=>valid;
 const p=f.c.reveal(0);valid=false;f.calls[0].resolve('late');await p;
 assert.deepEqual(f.applied,[]);
});
