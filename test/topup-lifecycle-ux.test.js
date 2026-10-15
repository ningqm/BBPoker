import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as lifecycle from '../public/lifecycle.js';
import * as money from '../public/money.js';
import * as controls from '../public/table-controls.js';
import * as scene from '../public/table-scene.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start+a.length);assert.ok(start>=0&&end>start);return source.slice(start,end);};
function room(){return {code:'topup-room',meId:'me',hostId:'me',status:'playing',settings:{bigBlind:10,maxPlayers:9,maxTotalBuyInBB:1000},players:[{id:'me',seat:0,stack:1200,totalBuyIn:6000,pendingBuyIn:0,inHand:true}],hand:{id:'hand-1',status:'playing',actionSeq:3},actions:{},autoDeal:{}};}
function harness(){
  money.setDisplayUnit('bb');const state={room:room(),connected:true,feedbackResync:false,busy:false,timeOffset:0,page:'room',chatUnread:0},modals=[],toasts=[],calls=[],listeners=new Map();let request=0,pending,activeForm=null;
  const context=vm.createContext({...money,...controls,...scene,lifecycle,state,Date,
    requests:{capture:()=>({valid:()=>true,check(){}})},commandId:()=>`topup-${++request}`,
    api:(path,body)=>{calls.push({path,body});return new Promise((resolve,reject)=>{pending={resolve,reject};});},
    render(){},normalizeState(next){state.room=next.room||next;},
    openModal(title,body,kind){state.modal={title,body,kind};modals.push(state.modal);},closeModal(){state.modal=null;},
    toast:text=>toasts.push(text),connectStream(){state.connected=false;state.feedbackResync=true;},
    dialog:{querySelector:selector=>selector==='#buyin-form'?activeForm:null},document:{visibilityState:'visible',addEventListener:(type,fn)=>listeners.set(type,fn)},navigator:{onLine:true},
    FormData:class{constructor(form){this.form=form;}get(key){return this.form.elements?.namedItem(key)?.value??this.form.values?.[key]??null;}},
    tableCenter:()=>'',seatView:()=>'',actionArea:()=>'',chatPanel:()=>'',errorPage:()=>'',
  });
  vm.runInContext([section('const esc=','const profitClass='),section('const btn=','const avatar='),section('function buyinModal(','function inviteModal('),section('async function command(','function stopStream('),section("document.addEventListener('submit'",'function resetPrivateView('),section('function roomView(){','function tableInfoModal('),section('function bombStatus(','function autoDealText('),section('function roomClock(','function tick('),'globalThis.testClient={buyinModal,roomView,refreshBuyinStatus,updateBuyinSummary};'].join('\n'),context);
  function form(amount=100){const submit={disabled:false,isConnected:true};return {id:'buyin-form',dataset:{seat:''},values:{amountBB:String(amount)},querySelector:()=>submit,submit};}
  return {state,modals,toasts,calls,...context.testClient,form,attachForm(form){activeForm=form;},submit:form=>listeners.get('submit')({target:form,preventDefault(){}}),resolve(next=state.room){pending.resolve({room:next});},reject(error){pending.reject(error);}};
}

function formFrom(html){
  const attr=(tag,name)=>tag.match(new RegExp('(?:^|\\s)'+name+'="([^"]*)"'))?.[1];
  const tag=html.match(/<form\b[^>]*>/)?.[0],fields=new Map(),nodes=new Map();assert.ok(tag);
  const form={id:'buyin-form',dataset:Object.fromEntries(['room','seat','big-blind','unit'].map(key=>[key.replace(/-([a-z])/g,(_,s)=>s.toUpperCase()),attr(tag,'data-'+key)])),
    elements:{namedItem:name=>fields.get(name)},querySelector:selector=>nodes.get(selector),querySelectorAll:()=>buttons};
  const buttons=[...html.matchAll(/<button\b[^>]*data-action="buyin-preset"[^>]*>/g)].map(([tag])=>({dataset:{value:attr(tag,'data-value')},disabled:/\sdisabled/.test(tag),classList:{toggle(){}},setAttribute(){}}));
  for(const [tag] of html.matchAll(/<input\b[^>]*>/g)){
    const input={id:attr(tag,'id'),name:attr(tag,'name'),type:attr(tag,'type'),value:attr(tag,'value')||'',min:attr(tag,'min'),max:attr(tag,'max'),disabled:/\sdisabled/.test(tag),validationMessage:'',setAttribute(key,value){this[key]=value;},setCustomValidity(message){this.validationMessage=message;}};
    if(input.id)nodes.set('#'+input.id,input);if(input.name)fields.set(input.name,input);
  }
  for(const key of ['timing','pending','budget','points'])nodes.set(`[data-buyin-${key}]`,{textContent:'',hidden:false});
  nodes.set('[type=submit]',{disabled:/type="submit" disabled/.test(html),isConnected:true,textContent:''});
  return form;
}


test('an open seat purchase cannot silently change its integral amount when the host changes blinds',()=>{
  const h=harness();money.setDisplayUnit('points');
  h.state.room.status='waiting';h.state.room.hand=null;h.state.room.players[0].seat=null;
  h.state.room.players[0].totalBuyIn=0;h.state.room.settings.maxTotalBuyInBB=null;
  h.buyinModal(3);const form=formFrom(h.modals.at(-1).body);h.attachForm(form);
  const shownBefore=Number(form.querySelector('#buyin-amount').value);
  assert.equal(shownBefore,2000);assert.equal(Number(form.elements.namedItem('amountBB').value),200);
  h.state.room.settings.bigBlind=20;h.refreshBuyinStatus(h.state.room);
  const input=form.querySelector('#buyin-amount'), amountBB=Number(form.elements.namedItem('amountBB').value);
  assert.equal(form.querySelector('[type=submit]').disabled,false);
  assert.equal(Number(form.dataset.bigBlind),20,'converter must use the same BB as the authoritative room');
  assert.equal(Number(input.value),amountBB*20,'displayed points must match the actual request amount');
  assert.equal(Number(input.value),shownBefore,'changing blind configuration must not silently spend more points');
});

test('an occupied seat is not still offered for purchase by an already-open confirmation',()=>{
  const h=harness();h.state.room.players[0].seat=null;h.buyinModal(3);
  const form=formFrom(h.modals.at(-1).body);h.attachForm(form);
  h.state.room.players.push({id:'other',seat:3,stack:1000});h.refreshBuyinStatus(h.state.room);
  assert.ok(h.state.modal===null || form.querySelector('[type=submit]').disabled,'disable or close the stale seat confirmation');
});

test('same-account seating on a second device invalidates an old seat confirmation',()=>{
  const h=harness();h.state.room.players[0].seat=null;h.buyinModal(3);
  const form=formFrom(h.modals.at(-1).body);h.attachForm(form);
  h.state.room.players[0].seat=4;h.refreshBuyinStatus(h.state.room);
  assert.ok(h.state.modal===null || form.querySelector('[type=submit]').disabled);
});

test('squid admission expiry invalidates an old new-player seat confirmation',()=>{
  const h=harness();h.state.room.players[0].seat=null;
  h.state.room.mini={squid:{active:true,mode:'unlimited',round:2,participants:['original'],tokenBudget:4,counts:{original:0}}};
  h.state.room.endsAt=Date.now()+60000;h.buyinModal(3);
  const form=formFrom(h.modals.at(-1).body);h.attachForm(form);
  h.state.room.expiryMode='wait-squid';h.refreshBuyinStatus(h.state.room);
  assert.ok(h.state.modal===null || form.querySelector('[type=submit]').disabled);
});
