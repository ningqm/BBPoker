import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomEnding, ROOM_ENDING_MS} from '../public/room-ending.js';
import {playerSquidCount,squidProgress} from '../public/lifecycle.js';
const before = () => ({code:'r',meId:'me',status:'playing',settings:{squidMode:'unlimited'},hand:{id:'h',status:'playing'},players:[
 {id:'me',seat:0,stack:100,cashedOut:20,cards:['As','Ah']},{id:'other',seat:1,stack:100,cashedOut:0,cards:[null,null]},
 {id:'left',seat:null,stack:0,cashedOut:100,cards:[null,null]}],mini:{squid:{active:true,round:2,participants:['me','other'],counts:{me:1,other:0}}}});
function closed(r=before()) { const n=structuredClone(r);n.status='closed';n.hand.status='complete';n.players=n.players.map(p=>({...p,seat:null,stack:0,cashedOut:p.cashedOut+(p.id==='me'?150:p.id==='other'?50:0)}));n.mini.squid.active=false;n.mini.squid.lastResult={round:2,changes:{me:20,other:-20}};return n; }
test('a fresh live close retains public final seats and recovery amounts for five seconds without mutating canonical state',()=>{
 const tracker=createRoomEnding(),prev=before(),final=closed(prev),copy=structuredClone(final);tracker.update(prev,final,{now:100});
 const view=tracker.view(final,100);assert.equal(view.remaining,5);assert.equal(view.squidDelta,20);
 assert.deepEqual(view.room.players.map(p=>[p.seat,p.stack]),[[0,150],[1,50],[null,0]]);
 assert.deepEqual(final,copy);assert.deepEqual(prev,before());
 assert.equal(tracker.view(final,5099).remaining,1);assert.equal(tracker.view(final,100+ROOM_ENDING_MS),null);
});
test('only final authorized cards survive; a previous hidden/revealed face is never recovered',()=>{
 const tracker=createRoomEnding(),prev=before(),final=closed(prev);prev.players[1].cards=['Ks','Kd'];final.players[0].cards=['As','Ah'];
 tracker.update(prev,final,{now:100});assert.deepEqual(tracker.view(final,200).room.players[1].cards,[null,null]);
 final.players[1].cards=['2s','2d'];assert.deepEqual(tracker.view(final,300).room.players[1].cards,['2s','2d']);
});
test('duplicate and reconnect snapshots never restart or extend the ending interval',()=>{
 const tracker=createRoomEnding(),prev=before(),final=closed(prev);tracker.update(prev,final,{now:100});
 tracker.update(final,structuredClone(final),{now:4000});assert.equal(tracker.view(final,4099).remaining,2);
 tracker.update(final,final,{now:7000});assert.equal(tracker.view(final,7001),null);
});
test('first load, hidden/deferred close, another identity/table, and a room without a hand skip the final-hand animation',()=>{
 for(const setup of [()=>[null,closed(),true],()=>[before(),closed(),false],()=>[{...before(),meId:'someone'},closed(),true],()=>[{...before(),code:'elsewhere'},closed(),true],()=>[{...before(),hand:null},{...closed(),hand:null},true]]){
  const tracker=createRoomEnding(),[prev,final,live]=setup();tracker.update(prev,final,{live,now:100});assert.equal(tracker.view(final,100),null);
 }
});
test('a close during the ordinary result hold only waits for its remaining time',()=>{
 const tracker=createRoomEnding(),playing=before(),prev=before();prev.hand.status='complete';
 tracker.update(playing,prev,{now:100});const final=closed(prev);tracker.update(prev,final,{now:2100});
 assert.equal(tracker.view(final,2100).remaining,3);assert.equal(tracker.view(final,5099).remaining,1);
 assert.equal(tracker.view(final,5100),null);
});
test('a completed result already seen for five seconds does not start another hold on manual close',()=>{
 const tracker=createRoomEnding(),playing=before(),prev=before();prev.hand.status='complete';
 tracker.update(playing,prev,{now:100});const final=closed(prev);tracker.update(prev,final,{now:6100});
 assert.equal(tracker.view(final,6100),null);
});
test('between-hand chatter and unchanged result snapshots do not restart the ordinary hold',()=>{
 const tracker=createRoomEnding(),playing=before(),prev=before();prev.hand.status='complete';
 tracker.update(playing,prev,{now:100});const chatted={...prev,chat:[{id:'msg'}],revision:40};
 tracker.update(prev,chatted,{now:3900});const final=closed(chatted);tracker.update(chatted,final,{now:4100});
 assert.equal(tracker.view(final,4100).remaining,1);assert.equal(tracker.view(final,5100),null);
});
test('a close publishing the remaining public cards gives those newly visible cards five seconds',()=>{
 const tracker=createRoomEnding(),playing=before(),prev=before();prev.hand.status='complete';prev.hand.board=['2s','3s','4s'];
 prev.hand.rabbit={active:true,board:['2s','3s','4s']};tracker.update(playing,prev,{now:100});
 const final=closed(prev);final.hand.rabbit={active:false,board:['2s','3s','4s','5d','6h']};tracker.update(prev,final,{now:4000});
 assert.equal(tracker.view(final,4000).remaining,5);assert.equal(tracker.view(final,8999).remaining,1);
 assert.equal(tracker.view(final,9000),null);
});
test('a normal supplementary reveal resets result visibility once before a later close',()=>{
 const tracker=createRoomEnding(),playing=before(),prev=before();prev.hand.status='complete';prev.hand.board=['2s','3s','4s'];
 tracker.update(playing,prev,{now:100});const revealed=structuredClone(prev);revealed.hand.rabbit={active:false,board:['2s','3s','4s','5d','6h']};
 tracker.update(prev,revealed,{now:1000});const final=closed(revealed);tracker.update(revealed,final,{now:3000});
 assert.equal(tracker.view(final,3000).remaining,3);assert.equal(tracker.view(final,6000),null);
});
test('manual closing an old result with no live observation skips a review and reset clears an active hold',()=>{
 const tracker=createRoomEnding(),prev=before(),final=closed(prev);prev.hand.status='complete';
 tracker.update(prev,final,{now:100});assert.equal(tracker.view(final,100),null);
 tracker.update(before(),final,{now:200});assert.ok(tracker.view(final,200));tracker.reset();assert.equal(tracker.view(final,200),null);
});
test('leaving the table or changing hand cannot reuse an older result visibility timestamp',()=>{
 const tracker=createRoomEnding(),playing=before(),prev=before();prev.hand.status='complete';tracker.update(playing,prev,{now:100});
 tracker.update(prev,prev,{live:false,now:200});tracker.update(prev,closed(prev),{now:300});assert.equal(tracker.view(closed(prev),300),null);
 const next=before();next.hand.id='next';tracker.update(prev,next,{now:400});
 const final=closed(next);tracker.update(next,final,{now:450});assert.equal(tracker.view(final,450).remaining,5);
});
test('last-round counts are retained for history but inactive/closed seat marks are hidden',()=>{
 const r=before(),p={id:'me',squidCount:2,squidWon:true};r.mini.squid.counts={me:2,other:0};r.mini.squid.mode='unlimited';
 assert.equal(playerSquidCount(r,p),2);r.mini.squid.active=false;assert.equal(playerSquidCount(r,p),0);assert.equal(squidProgress(r).counts.me,2);
 r.mini.squid.active=true;r.status='closed';assert.equal(playerSquidCount(r,p),0);
});

test('the injected monotonic clock drives expiry and reconnect cancels a partially seen ending',()=>{let now=100;const tracker=createRoomEnding({now:()=>now}),prev=before(),final=closed(prev);tracker.update(prev,final);assert.equal(tracker.view(final).remaining,5);now+=4999;assert.equal(tracker.view(final).remaining,1);now++;assert.equal(tracker.view(final),null);tracker.reset();tracker.update(prev,final);tracker.update(final,final,{live:false});assert.equal(tracker.view(final),null);tracker.update(final,final);assert.equal(tracker.view(final),null);});
