import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('function normalizeState('),end=source.indexOf('\n',start);
assert.ok(start>=0&&end>start);
function room(){return {code:'menu-ux',meId:'me',hostId:'me',revision:1,status:'playing',startedAt:100,settings:{smallBlind:5,bigBlind:10},players:[{id:'me',name:'Me',seat:0,stack:1000,inHand:true}],hand:{id:'h1',status:'playing',actionSeq:1},actions:{},autoDeal:{paused:false}};}
function harness(){
  let menuRenders=0;
  const state={user:{id:'me'},room:room(),modal:{kind:'room-menu'}};
  const context=vm.createContext({state,Date,captureRoomChanges(){},rememberCommitment:()=>false,toast(){},render(){},roomMenu(){menuRenders++;},
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
