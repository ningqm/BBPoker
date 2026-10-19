import { sameRoomSnapshot } from '../public/room-snapshot.js';
import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('function normalizeState('),end=source.indexOf('// A delayed room response',start);
assert.ok(start>=0&&end>start);
function room(){return {code:'menu-ux',meId:'me',hostId:'me',revision:1,status:'playing',startedAt:100,settings:{smallBlind:5,bigBlind:10},players:[{id:'me',name:'Me',seat:0,stack:1000,inHand:true}],hand:{id:'h1',status:'playing',actionSeq:1},actions:{},autoDeal:{paused:false}};}
function harness(){
  let menuRenders=0;
  const state={clock:createRoomClock(),user:{id:'me'},room:room(),modal:{kind:'room-menu'}};
  const context=vm.createContext({sameRoomSnapshot,createRoomClock,isOlderRoomSnapshot,state,Date,captureRoomChanges(){},rememberCommitment:()=>false,toast(){},render(){},roomMenu(){menuRenders++;},
    syncBetControls:()=>({amount:0,preset:null,panelOpen:false,key:null})});
  vm.runInContext(source.slice(start,end)+'\nglobalThis.applyRoom=normalizeState;',context);
  return {state,apply:next=>context.applyRoom(next),get menuRenders(){return menuRenders;}};
}
for(const [name,change] of [
  ['hand ending enables between-hand controls',r=>r.hand.status='complete'],
  ['host transfer refreshes owner controls',r=>r.hostId='other'],
  ['pause from another device refreshes toggle label',r=>r.autoDeal.paused=true],
  ['settings update refreshes displayed blind amounts',r=>r.settings.bigBlind=20],
])test('an open room menu updates when '+name,()=>{
  const h=harness(),next=structuredClone(h.state.room);next.revision++;change(next);h.apply(next);
  assert.equal(h.menuRenders,1);
});
test('routine action updates do not replace an open room menu',()=>{
  const h=harness(),next=structuredClone(h.state.room);next.revision++;next.hand.actionSeq++;h.apply(next);
  assert.equal(h.menuRenders,0);
});

test('explicitly leaving on another device refreshes the old host menu even if no successor exists',()=>{
  const h=harness(),next=structuredClone(h.state.room);next.revision++;next.players[0].leftRoom=true;h.apply(next);
  assert.equal(h.menuRenders,1);
});

test('the menu separates keeping a seat from leaving and hides former host authority',()=>{
  const state={room:room()},context=vm.createContext({state,seatActions:()=>'',chips:value=>String(value),num:String,esc:String,
    btn:(label,action)=>`<button data-action="${action}">${label}</button>`,openModal:(title,body,kind)=>{state.modal={title,body,kind};}});
  const a=source.indexOf('function roomMenu(){'),b=source.indexOf('function performanceModal()',a);
  vm.runInContext(source.slice(a,b)+'\nglobalThis.showMenu=roomMenu;',context);context.showMenu();
  assert.match(state.modal.body,/data-action="lobby"/);assert.match(state.modal.body,/data-action="leave-table"/);
  assert.match(state.modal.body,/返回大厅保留座位/);assert.match(state.modal.body,/不暂停或结束其他人的牌局/);
  assert.match(state.modal.body,/data-action="toggle-autodeal"/);assert.match(state.modal.body,/data-action="close-room-confirm"/);
  state.room.players[0].leftRoom=true;context.showMenu();assert.doesNotMatch(state.modal.body,/data-action="(?:toggle-autodeal|close-room-confirm|transfer-host|leave-table)"/);
  assert.match(state.modal.body,/data-action="lobby"/);
});

test('host transfer offers online spectators but not departed, departing or disconnected players',async()=>{
  const state={room:room()};state.room.players=[
    {id:'me',name:'owner',connected:true},
    {id:'seated',name:'seated',seat:1,connected:true},
    {id:'spectator',name:'spectator',seat:null,connected:true},
    {id:'left',name:'left',seat:null,leftRoom:true,connected:true},
    {id:'pending',name:'pending',seat:2,pendingDeparture:'leave',connected:true},
    {id:'offline',name:'offline',seat:3,connected:false},
  ];
  const context=vm.createContext({state,esc:String,
    btn:(label,action,cls,attrs)=>`<button data-action="${action}" ${attrs}>${label}</button>`,openModal:(title,body)=>{state.modal={title,body};}});
  const a=source.indexOf('async function handleAction('),b=source.indexOf('function setRaise(',a);
  vm.runInContext(source.slice(a,b)+'\nglobalThis.act=handleAction;',context);
  await context.act({dataset:{action:'transfer-host'},disabled:false});
  assert.match(state.modal.body,/data-player="seated"/);assert.match(state.modal.body,/data-player="spectator"/);
  assert.doesNotMatch(state.modal.body,/data-player="(?:me|left|pending|offline)"/);
});
