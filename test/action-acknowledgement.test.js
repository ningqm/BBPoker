import { sameRoomSnapshot } from '../public/room-snapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequestGuard } from '../public/platform.js';
import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import { syncBetControls } from '../public/table-controls.js';
import { RoomService } from '../src/room.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function normalizeState('),source.indexOf('function stopStream('));
const snapshot=(revision=1,ids=[])=>({code:'123456',meId:'me',revision,serverTime:1800000000000+revision,
  acceptedCommandIds:ids,settings:{bigBlind:10},hand:{id:'h1',status:'playing',actionSeq:revision,actingId:'me'},
  players:[{id:'me',name:'QA',stack:1000}],actions:{canAct:true,canCheck:true}});
function harness(){
  const state={clock:createRoomClock(),user:{id:'me'},room:snapshot(),busy:false,modal:null,page:'room',connected:true},requests=createRequestGuard();
  const calls=[],notices=[],streams=[],renders=[];let id=0;
  const bottom={renderedMarkup:'before'};
  const status={textContent:'可过牌',setAttribute(){}},classes=new Set(),dock={closest:()=>bottom,setAttribute(){},classList:{add:k=>classes.add(k)},querySelector:()=>status};
  const buttons=[{disabled:false},{disabled:false}];
  const panel={hidden:false},toggle={hidden:true,setAttribute(){}},submit={hidden:false};
  const context=vm.createContext({sameRoomSnapshot,state,requests,syncBetControls,isOlderRoomSnapshot,
    document:{visibilityState:'visible',querySelector:s=>s==='.action-dock'?dock:s==='#raise-panel'?panel:s==='#raise-toggle'?toggle:s==='#raise-button'?submit:null,querySelectorAll:()=>buttons},navigator:{onLine:true},
    commandId:()=>`synthetic-${++id}`,captureRoomChanges(){},rememberCommitment:()=>false,render(){renders.push(state.room.revision);},toast:m=>notices.push(m),closeModal(){state.modal=null;},connectStream:code=>streams.push(code),
    api:(path,body)=>new Promise((resolve,reject)=>calls.push({path,body,resolve,reject})),
  });
  vm.runInContext(code,context);
  return {state,requests,bottom,calls,notices,streams,renders,status,buttons,panel,toggle,submit,command:context.command,apply:context.normalizeState};
}
test('press gives inline feedback without rebuilding the table or speculating chips',async()=>{
  const h=harness(),before=JSON.stringify(h.state.room),job=h.command('raise',{amount:40});
  assert.equal(h.status.textContent,'正在下注…');assert.ok(h.buttons.every(b=>b.disabled));assert.equal(h.panel.hidden,true);assert.equal(h.toggle.hidden,false);assert.equal(h.submit.hidden,true);
  assert.equal(h.renders.length,0);assert.equal(h.bottom.renderedMarkup,null,'direct DOM changes invalidate the render cache');assert.equal(JSON.stringify(h.state.room),before);
  await h.command('raise',{amount:40});assert.equal(h.calls.length,1);
  h.calls[0].resolve({room:snapshot(2,['synthetic-1'])});assert.equal(await job,true);assert.equal(h.state.busy,false);assert.equal(h.renders.length,1);
});
test('SSE confirms exactly this action before slow HTTP, and old HTTP cannot unlock a new action',async()=>{
  const h=harness(),first=h.command('check');h.apply(snapshot(2,['synthetic-1']));
  assert.equal(h.state.busy,false);assert.equal(h.state.pendingCommand,null);
  const second=h.command('check');assert.equal(h.state.busy,true);
  h.calls[0].resolve({room:snapshot(2,['synthetic-1'])});assert.equal(await first,true);
  assert.equal(h.state.busy,true);assert.equal(h.state.pendingCommand.id,'synthetic-2');
  h.apply(snapshot(3,['synthetic-1','synthetic-2']));assert.equal(h.state.busy,false);
  h.calls[1].resolve({room:snapshot(3,['synthetic-1','synthetic-2'])});assert.equal(await second,true);
});
test('a lost old HTTP response after SSE acceptance does not reconnect, toast, or interrupt the next action',async()=>{
  const h=harness(),first=h.command('call');h.apply(snapshot(2,['synthetic-1']));
  const second=h.command('raise',{amount:80});h.calls[0].reject(Object.assign(new Error('late timeout'),{resync:true}));
  assert.equal(await first,true);assert.equal(h.state.busy,true);assert.equal(h.state.pendingCommand.id,'synthetic-2');
  assert.deepEqual(h.streams,[]);assert.deepEqual(h.notices,[]);
  h.calls[1].resolve({room:snapshot(3)});await second;
});
for(const kind of ['other-command','new-turn','other-user','other-room','old-frame'])test(`${kind} is not an acknowledgement of this action`,async()=>{
  const h=harness(),job=h.command('call');let next=snapshot(2,['synthetic-1']);
  if(kind==='other-command')next.acceptedCommandIds=['different'];
  if(kind==='new-turn'){next.acceptedCommandIds=[];next.hand.actingId='other';next.hand.actionSeq=99;}
  if(kind==='other-user')next.meId='other';
  if(kind==='other-room')next.code='987654';
  if(kind==='old-frame')next.revision=0;
  h.apply(next);assert.equal(h.state.busy,true);
  h.calls[0].resolve({room:snapshot(3,['synthetic-1'])});await job;
});
test('without confirmed receipt a transport failure resynchronizes once and never retries the wager',async()=>{
  const h=harness(),job=h.command('raise',{amount:60});h.apply(snapshot(2));
  h.calls[0].reject(Object.assign(new Error('unconfirmed'),{resync:true}));assert.equal(await job,false);
  assert.deepEqual(h.streams,['123456']);assert.deepEqual(h.notices,['unconfirmed']);assert.equal(h.calls.length,1);assert.equal(h.state.busy,false);
});
test('identity invalidation prevents an old receipt or response from releasing the new lock',async()=>{
  const h=harness(),old=h.command('check');h.requests.invalidate();h.state.busy=false;h.state.pendingCommand=null;
  const current=h.command('check');h.apply(snapshot(2,['synthetic-1']));assert.equal(h.state.busy,true);
  h.calls[0].resolve({room:snapshot(99,['synthetic-1'])});assert.equal(await old,false);assert.equal(h.state.busy,true);
  h.calls[1].resolve({room:snapshot(3,['synthetic-2'])});await current;assert.equal(h.state.busy,false);
});
test('room projection returns only the viewer’s latest bounded command receipts, including after reconnect',()=>{
  const users=[{id:'me',name:'Me'},{id:'other',name:'Other'},{id:'spectator',name:'Spectator'}];
  const data={users:Object.fromEntries(users.map(u=>[u.id,u])),rooms:{},hands:[],ledger:[]};
  const service=new RoomService({data}),r=service.create(users[0],{});
  users.slice(1).forEach(u=>service.join(u,r.code,r.invite));
  for(let i=0;i<24;i++){r.commandIds[`me:command-${i}`]=i+1;r.commandIds[`other:private-${i}`]=i+1;}
  const mine=service.state(r,'me'),other=service.state(r,'other'),spectator=service.state(r,'spectator');
  assert.deepEqual(mine.acceptedCommandIds,Array.from({length:16},(_,i)=>`command-${i+8}`));
  assert.ok(other.acceptedCommandIds.every(s=>s.startsWith('private-')));assert.deepEqual(spectator.acceptedCommandIds,[]);
  const restored=new RoomService({data:structuredClone(data)});
  assert.deepEqual(restored.state(restored.room(r.code),'me').acceptedCommandIds,mine.acceptedCommandIds);
  assert.equal(mine.commandIds,undefined);
});
