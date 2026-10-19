import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {patchStableControls} from '../public/stable-controls.js';
import {readFileSync} from 'node:fs';
import {betTurnKey,betSubmission,betSliderFromAmount,syncBetControls} from '../public/table-controls.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('function patchFocusedRaise('),end=source.indexOf('function patchLobby(',start);
function node(properties={}){return {...properties,get outerHTML(){return JSON.stringify({dataset:this.dataset,textContent:this.textContent,disabled:this.disabled,hidden:this.hidden,quotePot:this.quotePot});},replaceWith(next){this.parent.nodes.set(this.selector,next);next.parent=this.parent;next.selector=this.selector;this.detached=true;},setAttribute(name,value){this[name]=value;},getAttribute(name){return this[name];}};}
function tree(nodes={}){
  const root={nodes:new Map(Object.entries(nodes)),dataset:{},style:{},querySelector(selector){return this.nodes.get(selector)||null;},querySelectorAll(){return [];},insertBefore(){}};
  for(const [selector,child] of root.nodes){child.parent=root;child.selector=selector;}
  return root;
}
function room(){return {code:'r1',status:'playing',meId:'hero',settings:{bigBlind:10},players:[{id:'hero',bet:20}],hand:{id:'h1',status:'playing',actionSeq:4,actingId:'hero',currentBet:50,pot:105},actions:{canAct:true,canRaise:true,minRaiseTo:100,maxRaiseTo:2000,callAmount:30}};}
function dom(r,amount){
  const range=node({dataset:{unit:'points'},value:String(betSliderFromAmount(r,amount)),disabled:false,style:`--raise-fill:${betSliderFromAmount(r,amount)/10}%`,'aria-valuetext':`加至 ${amount} 积分`});
  const submit=node({dataset:{action:'raise',amount:String(amount),betTurn:betTurnKey(r)},textContent:`加至 ${amount} 积分`});
  const dock=tree({'.turn-row':node(),'.raise-shortcuts':node({quotePot:r.hand.pot}),'#raise-button':submit,'#raise-amount':node({textContent:`加至 ${amount} 积分`}),'#raise-range':range,'#raise-panel':node({hidden:false,style:`--raise-progress:${betSliderFromAmount(r,amount)/1000};--raise-fill:${betSliderFromAmount(r,amount)/10}%`}),'.raise-stack-cap':node({textContent:`加至 ${amount} 积分`})});
  dock.dataset.turn=betTurnKey(r);
  const shell=tree({'.table-bottom':dock,'.room-head':node(),'.table-stage':node(),'.table-column':node({style:{cssText:''}}),'.game-grid':node()});shell.dataset.room=r.code;
  const root=tree({'.room-shell':shell,'.topbar':node()});return {root,dock,range,submit,shell};
}
function patch(old,fresh){
  const context=vm.createContext({patchStableControls,app:old.root,document:{createElement:()=>fresh.root},patchRoomToolbar(){}});
  vm.runInContext(source.slice(source.indexOf('function patchTableRegion('),source.indexOf('function patchTableColumn('))+source.slice(start,end),context);return context.patchFocusedRaise('new-room-render');
}
test('a chat snapshot preserves the focused range and unchanged clickable quotes',()=>{
  const r=room(),old=dom(r,190),fresh=dom({...r,chat:[{text:'hi'}]},190),oldShortcuts=old.dock.querySelector('.raise-shortcuts');
  assert.equal(patch(old,fresh),true);assert.equal(old.dock.querySelector('#raise-range'),old.range);assert.equal(old.range.value,String(betSliderFromAmount(r,190)));
  assert.equal(old.dock.querySelector('.turn-row').detached,undefined,'the row containing the focused picker remains attached');assert.equal(old.dock.querySelector('#raise-button'),old.submit);assert.equal(old.submit.detached,undefined);assert.equal(old.dock.querySelector('.raise-shortcuts'),oldShortcuts);
  assert.deepEqual(betSubmission(r,{turnKey:old.submit.dataset.betTurn,amount:old.submit.dataset.amount}),{type:'raise',amount:190});
});
test('a changed bound while dragging updates the displayed quote and rejects the detached old amount',()=>{
  const before=room(),old=dom(before,190),after=structuredClone(before);after.actions.maxRaiseTo=150;after.hand.pot=200;
  const selection=syncBetControls(after,{key:betTurnKey(before),amount:190,panelOpen:true}),fresh=dom(after,selection.amount);
  assert.equal(selection.amount,150);assert.equal(patch(old,fresh),true);assert.equal(old.dock.querySelector('#raise-range'),old.range);
  assert.equal(old.range.value,String(betSliderFromAmount(after,150)));assert.equal(old.range['aria-valuetext'],'加至 150 积分');
  assert.equal(old.range.style,'--raise-fill:100%');assert.equal(old.dock.querySelector('#raise-panel').style,'--raise-progress:1;--raise-fill:100%');assert.equal(old.dock.querySelector('.raise-stack-cap').textContent,'加至 150 积分');
  assert.equal(old.dock.querySelector('#raise-button').dataset.amount,'150');assert.equal(old.dock.querySelector('.raise-shortcuts').quotePot,200);
  assert.equal(old.submit.dataset.amount,'190','a pointer down on the removed old quote does not acquire a new amount');
  assert.equal(betSubmission(after,{turnKey:old.submit.dataset.betTurn,amount:old.submit.dataset.amount}),null);
});
test('an action advance cannot reuse a focused slider or its old submit quote',()=>{
  const before=room(),old=dom(before,190),after=structuredClone(before);after.hand.actionSeq++;
  const fresh=dom(after,100);assert.equal(patch(old,fresh),false);assert.equal(old.submit.detached,undefined);
  assert.equal(betSubmission(after,{turnKey:old.submit.dataset.betTurn,amount:old.submit.dataset.amount}),null);
});
