import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRefresh } from '../public/history-refresh.js';
function fixture(){
 let current={hand:{id:'h',roomCode:'123',rabbit:{active:true,board:['As','2h','3c']}}},visible=true;
 const jobs=new Map(),requests=[],applied=[];let next=0;
 const controller=createHistoryRefresh({getContext:()=>current,isVisible:()=>visible,fetchHand:ctx=>new Promise((resolve,reject)=>requests.push({ctx,resolve,reject})),apply(ctx,hand){ctx.hand=hand;applied.push(hand);},setTimer(fn){jobs.set(++next,fn);return next;},clearTimer(id){jobs.delete(id);}});
 return {controller,jobs,requests,applied,get current(){return current;},set current(v){current=v;},set visible(v){visible=v;},tick(){const [id,fn]=jobs.entries().next().value||[];if(fn){jobs.delete(id);fn();}},async flush(){await new Promise(resolve=>setImmediate(resolve));}};
}
test('an early-opened history reveals final two rabbit cards without reopening and stops polling',async()=>{
 const f=fixture();f.controller.watch();f.tick();assert.equal(f.requests.length,1);
 f.requests[0].resolve({...f.current.hand,rabbit:{active:false,board:['As','2h','3c','4s','5h']}});await f.flush();
 assert.equal(f.current.hand.rabbit.board.length,5);assert.equal(f.applied.length,1);assert.equal(f.jobs.size,0);
});
test('closing or switching hands rejects an inflight reveal response',async()=>{
 for(const stop of [true,false]){const f=fixture();f.controller.watch();f.tick();const old=f.current.hand;
 if(stop)f.controller.stop();else f.current={hand:{id:'other',roomCode:'123',rabbit:{active:false,board:[]}}};
 f.requests[0].resolve({...old,rabbit:{active:false,board:['As','2h','3c','4s','5h']}});await f.flush();assert.equal(f.applied.length,0);assert.equal(f.jobs.size,0);}
});
test('hidden pages make no requests, resume updates and bounded errors do not loop forever',async()=>{
 const f=fixture();f.visible=false;f.controller.watch();f.tick();assert.equal(f.requests.length,0);assert.equal(f.jobs.size,1);
 f.visible=true;
 for(let i=0;i<3;i++){f.tick();f.requests[i].reject(new Error('offline'));await f.flush();}
 assert.equal(f.requests.length,3);assert.equal(f.jobs.size,0);assert.equal(f.applied.length,0);
});
test('completed or malformed rabbit data does not trigger polling and wrong hands are ignored',async()=>{
 const f=fixture();f.current.hand.rabbit.active=false;f.controller.watch();assert.equal(f.jobs.size,0);
 f.current.hand.rabbit.active=true;f.controller.watch();f.tick();f.requests[0].resolve({id:'secret-other',roomCode:'123',rabbit:{active:false,board:['Ks']}});await f.flush();assert.equal(f.applied.length,0);
});
test('a stale reveal response keeps public cards and retries the final cards without reopening',async()=>{
 const f=fixture();f.current.hand.rabbit.board.push('4s');f.controller.watch();f.tick();
 f.requests[0].resolve({...f.current.hand,rabbit:{active:true,board:['As','2h','3c']}});await f.flush();
 assert.deepEqual(f.current.hand.rabbit.board,['As','2h','3c','4s']);assert.equal(f.applied.length,0);assert.equal(f.jobs.size,1);
 f.tick();f.requests[1].resolve({...f.current.hand,rabbit:{active:false,board:['As','2h','3c','4s','5h']}});await f.flush();
 assert.equal(f.current.hand.rabbit.board.length,5);assert.equal(f.applied.length,1);assert.equal(f.jobs.size,0);
});
test('repeated stale reveal responses are bounded and cannot roll the display backwards',async()=>{
 const f=fixture();f.current.hand.rabbit.board.push('4s');f.controller.watch();
 for(let i=0;i<3;i++){f.tick();f.requests[i].resolve({...f.current.hand,rabbit:{active:true,board:['As','2h','3c']}});await f.flush();}
 assert.equal(f.requests.length,3);assert.equal(f.jobs.size,0);assert.equal(f.applied.length,0);assert.equal(f.current.hand.rabbit.board.length,4);
});
