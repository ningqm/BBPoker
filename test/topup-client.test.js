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
  vm.runInContext([section('const esc=','const profitClass='),section('const btn=','const avatar='),section('function buyinModal(','function inviteModal('),section('async function command(','function stopStream('),section("document.addEventListener('submit'",'function resetPrivateView('),section('function roomView(){','function tableInfoModal('),'globalThis.testClient={buyinModal,roomView,refreshBuyinStatus,updateBuyinSummary};'].join('\n'),context);
  function form(amount=100){const submit={disabled:false,isConnected:true};return {id:'buyin-form',dataset:{seat:''},values:{amountBB:String(amount)},querySelector:()=>submit,submit};}
  return {state,modals,toasts,calls,...context.testClient,form,attachForm(form){activeForm=form;},submit:form=>listeners.get('submit')({target:form,preventDefault(){}}),resolve(next=state.room){pending.resolve({room:next});},reject(error){pending.reject(error);}};
}

test('top-up timing is immediate between hands and queued during a hand without changing squid entry guidance',()=>{
  for(const mode of ['normal','unlimited']){
    const r=room();r.mini={squid:{active:true,mode,participants:['old'],round:2}};
    assert.equal(lifecycle.buyinTiming(r,false,r.players[0]),'现在补码将于本手结束后到账，下一手可用，不增加本手可下注筹码。');
    assert.match(lifecycle.buyinTiming(r,true,{id:'new'}),/以 0 鱼加入，总鱼数加 1/);
    assert.match(lifecycle.buyinTiming(r,true,{id:'old'}),/重新入座不重复增加鱼数/);
    r.hand.status='complete';assert.equal(lifecycle.buyinTiming(r,false,r.players[0]),'立即到账，下次发牌前可用。');
    r.hand=null;assert.equal(lifecycle.buyinTiming(r,false,r.players[0]),'立即到账，下次发牌前可用。');
  }
});

test('two rapid confirmations enqueue one request and a delayed success does not close a newer dialog',async()=>{
  const h=harness();h.state.modal={kind:'buyin',owner:'original'};const original=h.form(150);
  const first=h.submit(original);assert.equal(original.submit.disabled,true);assert.equal(h.state.busy,true);
  await h.submit(original);await h.submit(h.form(150));assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].body.type,'buyin');assert.equal(h.calls[0].body.amountBB,150);assert.ok(h.calls[0].body.commandId);
  const newer={kind:'buyin',owner:'new'};h.state.modal=newer;const response=structuredClone(h.state.room);response.players[0].pendingBuyIn=1500;h.resolve(response);await first;
  assert.equal(h.state.modal,newer);assert.equal(h.state.busy,false);assert.equal(h.calls.length,1);
  assert.equal(h.state.room.players[0].stack,1200);assert.equal(h.state.room.players[0].totalBuyIn,6000);assert.equal(h.state.room.players[0].pendingBuyIn,1500);
});

test('uncertain queued top-up closes its confirmation and resynchronizes instead of resubmitting',async()=>{
  const h=harness();h.state.modal={kind:'buyin'};const pending=h.submit(h.form(100));assert.equal(h.calls.length,1);
  h.reject(Object.assign(new Error('响应丢失'),{resync:true}));await pending;
  assert.equal(h.state.modal,null);assert.equal(h.state.feedbackResync,true);assert.equal(h.state.connected,false);assert.equal(h.calls.length,1);assert.equal(h.state.busy,false);
});

test('server rejection keeps the selected top-up editable without optimistic balance changes',async()=>{
  const h=harness();h.state.modal={kind:'buyin'};const modal=h.state.modal,form=h.form(500),before=JSON.stringify(h.state.room.players[0]);
  const pending=h.submit(form);h.reject(Object.assign(new Error('超过本场累计带入上限'),{status:400}));await pending;
  assert.equal(h.state.modal,modal);assert.equal(form.values.amountBB,'500');assert.equal(form.submit.disabled,false);assert.equal(JSON.stringify(h.state.room.players[0]),before);assert.equal(h.calls.length,1);
});

test('disconnected or resynchronizing top-up forms cannot enqueue stale purchases',async()=>{
  for(const scenario of ['disconnected','resync']){const h=harness();h.state.modal={kind:'buyin'};if(scenario==='disconnected')h.state.connected=false;else h.state.feedbackResync=true;await h.submit(h.form(100));assert.equal(h.calls.length,0);assert.match(h.toasts.at(-1),/连接恢复后再确认带入/);}
});

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

test('active-hand top-up opens immediately with queued-only guidance and cap accounts for pending chips once',()=>{
  const h=harness(),p=h.state.room.players[0];p.pendingBuyIn=2500;h.buyinModal();assert.equal(h.toasts.length,0);
  const modal=h.modals.at(-1),form=formFrom(modal.body);assert.equal(modal.title,'补充筹码');assert.equal(form.dataset.room,'topup-room');
  assert.match(modal.body,/本手结束后到账.*不增加本手可下注筹码/);assert.match(modal.body,/已排队 \+250 BB/);
  assert.equal(form.querySelector('#buyin-range').max,'150');assert.equal(form.elements.namedItem('amountBB').value,'150');
  assert.match(modal.body,/已占额度 850 BB.*剩余 150 BB/);assert.match(modal.body,/包含待到账补码/);
  assert.equal(p.stack,1200);assert.equal(p.totalBuyIn,6000);assert.equal(p.pendingBuyIn,2500);
  p.pendingBuyIn=3500;h.buyinModal();assert.match(h.modals.at(-1).body,/剩余额度不足/);assert.equal(formFrom(h.modals.at(-1).body).querySelector('[type=submit]').disabled,true);
  h.state.room.settings.maxTotalBuyInBB=null;h.buyinModal();assert.equal(formFrom(h.modals.at(-1).body).querySelector('#buyin-range').max,'1000');
});

test('header top-up remains available while playing, shows pending separately, and protects unavailable states',()=>{
  const h=harness();let html=h.roomView();assert.match(html,/data-topup-button[^>]*>.*?补码/);assert.match(html,/筹码 120 BB/);assert.doesNotMatch(html,/data-topup-button[^>]*disabled/);
  h.state.room.players[0].pendingBuyIn=1500;html=h.roomView();assert.match(html,/待加 150 BB · 下一手/);assert.doesNotMatch(html,/筹码 270 BB/);
  for(const status of ['busy','offline','resync','departure']){const x=harness();if(status==='busy')x.state.busy=true;if(status==='offline')x.state.connected=false;if(status==='resync')x.state.feedbackResync=true;if(status==='departure')x.state.room.players[0].pendingDeparture='stand';assert.match(x.roomView(),/data-topup-button[^>]*disabled/);}
  h.state.room.players[0].seat=null;assert.doesNotMatch(h.roomView(),/data-topup-button/);h.state.room.players[0].seat=0;h.state.room.status='closed';assert.doesNotMatch(h.roomView(),/data-topup-button/);
});

test('settling queued chips refreshes timing without replacing the typed amount or double-counting occupied cap',()=>{
  const h=harness(),p=h.state.room.players[0];p.pendingBuyIn=1000;h.buyinModal();const form=formFrom(h.modals.at(-1).body);h.attachForm(form);
  const input=form.querySelector('#buyin-amount');input.value='250';h.updateBuyinSummary(form);const initialInput=input;
  h.refreshBuyinStatus(h.state.room);assert.equal(input.value,'250');assert.equal(form.querySelector('#buyin-range').max,'300');assert.match(form.querySelector('[data-buyin-pending]').textContent,/100 BB/);
  p.totalBuyIn+=p.pendingBuyIn;p.stack+=p.pendingBuyIn;p.pendingBuyIn=0;h.state.room.hand.status='complete';h.refreshBuyinStatus(h.state.room);
  assert.equal(form.querySelector('#buyin-amount'),initialInput);assert.equal(input.value,'250');assert.equal(form.elements.namedItem('amountBB').value,'250');assert.equal(form.querySelector('#buyin-range').max,'300');
  assert.equal(form.querySelector('[data-buyin-pending]').hidden,true);assert.match(form.querySelector('[data-buyin-timing]').textContent,/立即到账/);assert.match(form.querySelector('[data-buyin-budget]').textContent,/已占额度 700 BB.*剩余 300 BB/);assert.equal(form.querySelector('[type=submit]').textContent,'确认补码');
});

test('a second device consuming cap marks an oversized draft invalid and editing it valid enables confirmation',()=>{
  const h=harness();h.buyinModal();const form=formFrom(h.modals.at(-1).body);h.attachForm(form);const input=form.querySelector('#buyin-amount');input.value='300';h.updateBuyinSummary(form);
  h.state.room.players[0].pendingBuyIn=2000;h.refreshBuyinStatus(h.state.room);
  assert.equal(input.value,'300','never silently reduce the amount that the player chose');assert.equal(form.querySelector('#buyin-range').max,'200');assert.equal(form.elements.namedItem('amountBB').value,'');assert.equal(form.querySelector('[type=submit]').disabled,true);assert.notEqual(input.validationMessage,'');
  input.value='150';h.updateBuyinSummary(form,input);assert.equal(form.elements.namedItem('amountBB').value,'150');assert.equal(input.validationMessage,'');assert.equal(form.querySelector('[type=submit]').disabled,false);
});

test('seat departure and table closure close only the matching top-up dialog',()=>{
  for(const reason of ['stand','gone','closed']){const h=harness();h.buyinModal();const form=formFrom(h.modals.at(-1).body);h.attachForm(form);if(reason==='stand')h.state.room.players[0].pendingDeparture='stand';if(reason==='gone')h.state.room.players[0].seat=null;if(reason==='closed')h.state.room.status='closed';h.refreshBuyinStatus(h.state.room);assert.equal(h.state.modal,null);assert.equal(h.calls.length,0);}
  const h=harness();h.buyinModal();const modal=h.state.modal,form=formFrom(modal.body);h.attachForm(form);h.refreshBuyinStatus({...h.state.room,code:'other-room',status:'closed'});assert.equal(h.state.modal,modal);
});
