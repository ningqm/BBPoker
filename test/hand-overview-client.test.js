import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import * as tableScene from '../public/table-scene.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createReplayPlayback} from '../public/replay.js';
import {createTurnCountdown} from '../public/table-feedback.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function harness(){
  const state={clock:createRoomClock(),room:{code:'123456'},user:{id:'me'},page:'room',modal:{kind:'hand-library'},library:{hands:[]},replayRequest:0,replaySpeed:1};
  const renders=[],timers=new Map();let next=0,resolve,reject,valid=true;
  const hand={id:'safe-hand',log:[{type:'check',playerId:'me'}],players:[{id:'me',cards:['As','Kh']}]};
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,...tableScene,historyRefresh:{watch(){},stop(){}},state,records:{captureRecordDraft(){return null;}},dialog:{scrollTop:12},document:{visibilityState:'visible',querySelector(){return null;}},requests:{capture:()=>({valid:()=>valid,check(){if(!valid)throw Object.assign(new Error('stale'),{stale:true});}})},api:()=>new Promise((r,j)=>{resolve=r;reject=j;}),openModal(title,body,kind){state.modal={kind,title};},renderOverview(){renders.push('overview');state.modal={kind:'hand-overview'};},renderReplay(){renders.push('replay');state.modal={kind:'replay'};},playReplay(){state.replayPlayback.play();},tick(){},toast(){},closeModal(){state.modal=null;},createReplayPlayback:opts=>createReplayPlayback({...opts,setTimer(fn){const id=++next;timers.set(id,fn);return id;},clearTimer(id){timers.delete(id);}})});
  vm.runInContext(section('async function replayModal(', 'function overviewBackButton(')+section('function startOverviewReplay(){','function renderReplay(){')+';globalThis.ui={replayModal,startOverviewReplay}',context);
  return {state,renders,timers,hand,document:context.document,...context.ui,reply(){resolve({hand});},fail(){reject(new Error('late request'));},invalidate(){valid=false;}};
}
test('opening a hand overview is static, retains table history origin and only starts playback on request',async()=>{
  const c=harness(),pending=c.replayModal('safe-hand','123456','overview');c.reply();await pending;
  assert.deepEqual(c.renders,['overview']);assert.equal(c.state.replay.origin,'library-modal');assert.equal(c.timers.size,0);
  c.startOverviewReplay();assert.equal(c.state.replay.index,0);assert.equal(c.state.modal.kind,'replay');assert.equal(c.timers.size,1);
  const callback=[...c.timers.values()][0];c.invalidate();callback();assert.equal(c.state.replay.index,0);
});
test('a closed or superseded hand request never opens private hand content later',async()=>{
  for(const cancel of ['close','superseded','identity']){const c=harness(),pending=c.replayModal('safe-hand','123456','overview');if(cancel==='close')c.state.modal=null;if(cancel==='superseded')c.state.replayRequest++;if(cancel==='identity')c.invalidate();c.reply();await pending;assert.equal(c.renders.length,0);assert.equal(c.state.replay,undefined);}
});
test('explicit replay remains available and hidden pages never start its timer',async()=>{
  for(const visibility of ['visible','hidden']){const c=harness();c.document.visibilityState=visibility;const pending=c.replayModal('safe-hand','123456');c.reply();await pending;assert.ok(c.renders.length>0&&c.renders.every(x=>x==='replay'));assert.equal(c.timers.size,visibility==='visible'?1:0);}
});
test('current turn notice follows actual table actor without replacing filter inputs',()=>{
  const notice={hidden:true},clock={textContent:'',classList:{toggle(){}}};
  const state={clock:createRoomClock(),room:{hand:{status:'playing',actingId:'me'},meId:'me',actions:{canAct:true},deadline:Date.now()+15000,settings:{}},connected:true,feedbackResync:false};
  const document={querySelectorAll(selector){return selector==='[data-history-turn]'?[notice]:selector==='[data-turn-clock]'?[clock]:[];}};
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,...tableScene,state,document,Date,turnCountdown:createTurnCountdown(),tableSounds:{play(){}},syncRebuyPrompt(){}});vm.runInContext(section('function tick(){','setInterval(tick,400);')+';globalThis.tick=tick',context);
  context.tick();assert.equal(notice.hidden,false);assert.match(clock.textContent,/1[45]s/);
  state.room.hand.actingId='friend';context.tick();assert.equal(notice.hidden,true);
  state.room.hand.actingId='me';state.room.hand.status='complete';context.tick();assert.equal(notice.hidden,true);
});

test('a late hand failure cannot close another modal opened while loading',async()=>{
  const c=harness(),pending=c.replayModal('safe-hand','123456','overview');c.state.modal={kind:'room-menu'};c.fail();await pending;assert.equal(c.state.modal.kind,'room-menu');assert.equal(c.renders.length,0);
});

test('the last-hand shortcut cannot interrupt a newer modal or room after its list request',async()=>{
  for(const change of ['modal','request','room','none']){
    const initialModal=null,state={clock:createRoomClock(),room:{code:'123456'},modal:initialModal,replayRequest:2},opened=[];let resolve;
    const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,...tableScene,state,requests:{capture:()=>({check(){},valid:()=>true})},api:()=>new Promise(r=>resolve=r),replayModal(...args){opened.push(args);},toast(){}});
    vm.runInContext(section('async function replayLastHand(){','function exportModal(){')+';globalThis.run=replayLastHand',context);
    const pending=context.run();if(change==='modal')state.modal={kind:'room-menu'};if(change==='request')state.replayRequest++;if(change==='room')state.room.code='654321';
    resolve({hands:[{id:'latest',number:9}]});await pending;
    assert.equal(opened.length,change==='none'?1:0);if(opened.length)assert.deepEqual(opened[0],['latest','123456','overview']);
  }
});

test('a completed favorite update reloads a favorite-only list even if the new item was absent from a racing GET',async()=>{
  for(const favorite of [true,false]){
    const state={clock:createRoomClock(),library:{favorites:true,hands:[]},modal:{kind:'hand-library'}},button={disabled:false,isConnected:true};let refreshed=0,resolve;
    const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,...tableScene,state,requests:{capture:()=>({check(){}})},api:()=>new Promise(r=>resolve=r),loadLibrary(reset){assert.equal(reset,true);refreshed++;},renderHandLibrary(){throw Error('Must load the missing favorite from server');},toast(){}});
    vm.runInContext(section('async function favoriteHand(', 'function sessionLibraryContent(')+';globalThis.run=favoriteHand',context);
    const pending=context.run('hand-a',favorite,button);resolve({favorite});await pending;assert.equal(refreshed,1);assert.equal(button.disabled,false);
  }
});

test('compact mode loads a static hand, keeps navigation and does not start playback',async()=>{
 const c=harness(),navigation=[{id:'older',number:1},{id:'safe-hand',number:2}];
 const pending=c.replayModal('safe-hand','123456','compact',navigation);c.reply();await pending;
 assert.equal(c.state.replay.compact,true);assert.deepEqual(c.state.replay.navigation,navigation);assert.deepEqual(c.renders,['overview']);assert.equal(c.timers.size,0);
});
test('table quick history opens latest hand, and stale room or closed modal cannot replace the screen',async()=>{
 for(const stale of [null,'close','room']){
  let resolve;const opened=[];const state={room:{code:'123456'},replayRequest:0};
  const c=vm.createContext({state,requests:{capture:()=>({check(){},valid:()=>true})},api:()=>new Promise(r=>resolve=r),openModal(title,body,kind){state.modal={kind};},closeModal(){state.modal=null;},toast(){},replayModal(...args){opened.push(args);}});
  vm.runInContext(section('async function historyModal(){','async function replayModal('),c);
  const pending=c.historyModal();if(stale==='close')state.modal=null;if(stale==='room')state.room={code:'654321'};
  resolve({hands:[{id:'h2',number:2},{id:'h1',number:1}]});await pending;
  if(stale){assert.equal(opened.length,0);continue;}
  assert.equal(opened[0][0],'h2');assert.equal(opened[0][2],'compact');assert.deepEqual(Array.from(opened[0][3],h=>h.id),['h1','h2']);
 }
});

test('quick-history arrows stay inside the same table and stop at either boundary',async()=>{
 const opened=[],navigation=[{id:'h1'},{id:'h2'}];const state={modal:{kind:'hand-overview'},replay:{hand:{id:'h2',roomCode:'123456'},compact:true,navigation}};
 const c=vm.createContext({state,replayModal(...args){opened.push(args);}});
 vm.runInContext(section('async function compactHandStep(','async function replayModal('),c);
 await c.compactHandStep(1);assert.equal(opened.length,0);
 await c.compactHandStep(-1);assert.deepEqual(opened[0],['h1','123456','compact',navigation]);
 state.modal={kind:'room-menu'};await c.compactHandStep(-1);assert.equal(opened.length,1);
});
