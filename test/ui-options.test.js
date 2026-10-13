import test from 'node:test';
import * as lifecycle from '../public/lifecycle.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {settingsFor} from '../src/room.js';
import {avatarMarkup,createAvatarCache} from '../public/avatar.js';
import {reusableRoomSettings} from '../public/room-config.js';
import * as money from '../public/money.js';
import {betPresetOptions,betActionLabel,revealOptions,rebuyPrompt} from '../public/table-controls.js';
import {createTurnCountdown} from '../public/table-feedback.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function harness({unit='points',...overrides}={}){
  money.setDisplayUnit(unit);
  const modals=[],listeners=new Map(),commands=[];
  const context=vm.createContext({...money,lifecycle,betPresetOptions,betActionLabel,revealOptions,rebuyPrompt,turnCountdown:createTurnCountdown(),tableSounds:{play(){}},avatarMarkup,createAvatarCache,reusableRoomSettings,apiUrl:path=>path,
    requests:{capture:()=>({valid:()=>true,check(){}})},
    FormData:class{constructor(form){this.form=form;}get(name){const field=this.form.elements.namedItem(name);return !field||field.disabled?null:field.type==='checkbox'?(field.checked?'on':null):field.value;}},
    state:{user:{name:'小鱼'},rooms:[],timeOffset:0,connected:true,feedbackResync:false},
    openModal(title,body,kind){modals.push({title,body,kind});context.state.modal={kind};},closeModal(){context.state.modal=null;},
    async command(type,payload){commands.push({type,...payload});return true;},toast(message){throw new Error(message);},...overrides,
    document:{querySelectorAll:()=>[],...overrides.document,addEventListener(type,fn){listeners.set(type,fn);}},
  });
  vm.runInContext([
    section('const defaults=','const state='),section('const esc=','const profitClass='),section('const btn=','const card='),section('const card=','const feedback='),
    section('function seatHoleCards(','function seatView('),section('function actionArea(','function career('),section('function participationNotice(','function rulesModal('),
    section('function seatActions(','function roomView('),section('function roomClock(','function tick('),section('function tick(){','setInterval(tick,'),section('function settingFields(','function joinInvite('),section('function buyinModal(','function inviteModal('),
    section("document.addEventListener('submit'",'function resetPrivateView('),
    'globalThis.client={defaults,state,settingFields,settingsOverview,readSettings,updateSettingConstraints,applySettingPreset,createModal,loadPreviousRoomSettings,buyinModal,updateBuyinSummary,roomClock,miniCutoff,tick,syncRebuyPrompt,avatar,seatActions,actionArea};',
  ].join('\n'),context);
  return {...context.client,document:context.document,modals,commands,submit(form){return listeners.get('submit')({target:form,preventDefault(){}});}};
}
// Form field adapter is built from the real rendered settings, so missing names,
// disabled controls, null caps and the user's actual typed values are exercised.
function formFrom(html){
  const fields=new Map();
  for(const tag of html.matchAll(/<input\b[^>]*>/g)){
    const attr=name=>tag[0].match(new RegExp('(?:^|\\s)'+name+'="([^"]*)"'))?.[1];
    const name=attr('name');if(!name)continue;
    fields.set(name,{name,type:attr('type')||'text',value:attr('value')||'',defaultValue:attr('value')||'',min:attr('min'),max:attr('max'),disabled:/\sdisabled(?:\s|>)/.test(tag[0]),checked:/\schecked(?:\s|>)/.test(tag[0])});
  }
  for(const tag of html.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
    const selected=[...tag[2].matchAll(/<option\b([^>]*)>/g)].find(x=>/\bselected\b/.test(x[1]));
    fields.set(tag[1],{value:selected?.[1].match(/value="([^"]+)"/)?.[1]||''});
  }
  return {fields,elements:{namedItem:name=>fields.get(name)},matches:()=>true,querySelector:()=>null};
}

function buyinFormFrom(html){
  const fields=new Map(),ids=new Map(),buttons=[];
  const formTag=html.match(/<form\b[^>]*>/)?.[0]||'';
  const attribute=(tag,name)=>tag.match(new RegExp('(?:^|\\s)'+name+'="([^"]*)"'))?.[1];
  const dataset=Object.fromEntries(['seat','big-blind','unit'].map(key=>[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),attribute(formTag,'data-'+key)]));
  for(const [tag] of html.matchAll(/<input\b[^>]*>/g)){
    const field={id:attribute(tag,'id'),name:attribute(tag,'name'),type:attribute(tag,'type'),value:attribute(tag,'value')||'',
      min:attribute(tag,'min'),max:attribute(tag,'max'),step:attribute(tag,'step'),disabled:/\sdisabled(?:\s|>)/.test(tag),
      checked:/\schecked(?:\s|>)/.test(tag),attributes:{},validationMessage:'',setAttribute(k,v){this.attributes[k]=v;},setCustomValidity(message){this.validationMessage=message;}};
    if(field.id)ids.set('#'+field.id,field);
    if(field.name&&(field.type!=='radio'||field.checked||!fields.has(field.name)))fields.set(field.name,field);
  }
  for(const [tag] of html.matchAll(/<button\b[^>]*data-action="buyin-preset"[^>]*>/g))buttons.push({dataset:{value:attribute(tag,'data-value')},classList:{toggle(){}},setAttribute(){}});
  const summary={textContent:''},submit={disabled:/type="submit" disabled/.test(html),isConnected:true};
  return {id:'buyin-form',dataset,fields,ids,elements:{namedItem:name=>fields.get(name)},
    querySelector:selector=>selector==='[data-buyin-points]'?summary:selector==='[type=submit]'?submit:ids.get(selector)||null,
    querySelectorAll:()=>buttons,summary};
}
test('room presets submit BB settings, direct buy-in and defaults without hidden mushroom/approval controls',()=>{
  const c=harness(),html=c.settingFields(c.defaults),form=formFrom(html),s=c.readSettings(form);
  assert.equal(s.smallBlind,5);assert.equal(s.bigBlind,10);assert.equal(s.minBuyInBB,100);assert.equal(s.maxBuyInBB,1000);
  assert.equal(s.actionSeconds,30);assert.equal(settingsFor({}).actionSeconds,30);assert.equal(s.durationMinutes,60);assert.equal(s.timeBankCards,3);assert.equal(s.timeBankSeconds,30);
  assert.equal(s.bombPot,false);assert.equal(s.bombAnteBB,2);assert.equal(s.bombIntervalMinutes,10);
  assert.equal(s.squid,false);assert.equal(s.squidUnitBB,2);
  assert.doesNotThrow(()=>settingsFor(s));
  assert.doesNotMatch(html,/蘑菇|name="(?:approvalRequired|minBuyIn|maxBuyIn)"/);
  c.state.createKeyRequired=true;c.createModal();assert.match(c.modals.at(-1).body,/小鱼必赢的局/);assert.doesNotMatch(c.modals.at(-1).body,/建房口令|name="createKey"/);
});
test('cumulative caps are optional and blind presets keep fixed transaction BB values',()=>{
  const c=harness(),form=formFrom(c.settingFields(c.defaults));
  assert.equal(c.readSettings(form).maxTotalBuyInBB,null);
  form.fields.get('unlimitedTotalBuyIn').checked=false;c.updateSettingConstraints(form);
  assert.equal(form.fields.get('maxTotalBuyInBB').disabled,false);assert.equal(c.readSettings(form).maxTotalBuyInBB,1000);
  let hidden=false;form.querySelector=selector=>selector==='[data-blind-custom]'?{set hidden(value){hidden=value;}}:null;
  const button={dataset:{value:'2/5'},closest:()=>form,parentElement:{querySelectorAll:()=>[]}};
  c.applySettingPreset(button,'blind');
  const s=c.readSettings(form);assert.equal(s.smallBlind,2);assert.equal(s.bigBlind,5);assert.equal(s.minBuyInBB,100);assert.equal(s.maxBuyInBB,1000);assert.equal(hidden,true);assert.doesNotThrow(()=>settingsFor(s));
  form.fields.get('unlimitedTotalBuyIn').checked=true;c.updateSettingConstraints(form);assert.equal(c.readSettings(form).maxTotalBuyInBB,null);
});
test('disabled mini-game amounts retain valid preferences and discard an invalid hidden value',()=>{
  const c=harness(),form=formFrom(c.settingFields({...c.defaults,squidUnitBB:4,bombAnteBB:3}));
  assert.equal(c.readSettings(form).squidUnitBB,4);assert.equal(c.readSettings(form).bombAnteBB,3);
  form.fields.get('bombAnteBB').value='-99';assert.equal(c.readSettings(form).bombAnteBB,3);
  form.fields.get('bombPot').checked=true;form.fields.get('bombAnteBB').disabled=false;form.fields.get('bombAnteBB').value='7';
  assert.equal(c.readSettings(form).bombPot,true);assert.equal(c.readSettings(form).bombAnteBB,7);
});
for(const unit of ['bb','points']){
  test(`${unit} buy-ins retain the 100–1000 BB transaction limits and cumulative cap`,()=>{
    const c=harness({unit}),scale=unit==='bb'?1:10;
    c.state.room={meId:'a',settings:{...c.defaults,maxTotalBuyInBB:1000},players:[{id:'a',seat:0,stack:55,totalBuyIn:8000}]};
    c.buyinModal();let form=buyinFormFrom(c.modals.at(-1).body),input=form.fields.get('amountDisplay');
    assert.equal(input.min,String(100*scale));assert.equal(input.max,String(200*scale));assert.equal(input.step,String(50*scale));
    assert.equal(input.value,String(200*scale));assert.equal(form.fields.get('amountBB').value,'200');
    c.state.room.players[0].totalBuyIn=9500;c.buyinModal();assert.match(c.modals.at(-1).body,/剩余额度不足/);assert.match(c.modals.at(-1).body,/type="submit" disabled/);
    c.state.room.settings.maxTotalBuyInBB=null;c.buyinModal();form=buyinFormFrom(c.modals.at(-1).body);
    assert.equal(form.fields.get('amountDisplay').max,String(1000*scale));assert.match(c.modals.at(-1).body,/本场累计带入不限/);
    c.state.room.players[0].seat=null;c.state.room.settings.maxTotalBuyInBB=1000;c.state.room.players[0].totalBuyIn=8500;c.buyinModal(2);form=buyinFormFrom(c.modals.at(-1).body);
    assert.equal(form.fields.get('amountDisplay').max,String(150*scale));assert.equal(form.fields.get('amountBB').value,'150');
  });
  test(`${unit} sliders and typed amounts submit exact BB payloads without rounding invalid entries`,async()=>{
    const c=harness({unit}),scale=unit==='bb'?1:10;
    c.state.room={meId:'a',settings:{...c.defaults,maxTotalBuyInBB:null},players:[{id:'a',seat:null,stack:0,totalBuyIn:0}]};
    c.buyinModal(2);const form=buyinFormFrom(c.modals.at(-1).body),input=form.fields.get('amountDisplay'),range=form.ids.get('#buyin-range'),stored=form.fields.get('amountBB');
    c.updateBuyinSummary(form,{id:'buyin-range',value:'500'});
    assert.equal(input.value,String(500*scale));assert.equal(range.value,'500');assert.equal(stored.value,'500');
    assert.equal(form.summary.textContent,unit==='bb'?'带入 500 BB':'带入 5,000 积分');
    for(const amountBB of [100,150,1000]){
      input.value=String(amountBB*scale);c.updateBuyinSummary(form);await c.submit(form);
      assert.equal(range.value,String(amountBB));assert.equal(stored.value,String(amountBB));
      assert.deepEqual(JSON.parse(JSON.stringify(c.commands.at(-1))),{type:'sit',amountBB,seat:2,entryMode:'wait'});
    }
    for(const invalid of [50,125,1050]){
      input.value=String(invalid*scale);c.updateBuyinSummary(form);
      assert.equal(input.value,String(invalid*scale));assert.equal(stored.value,'');assert.notEqual(input.validationMessage,'');
    }
    input.value='';c.updateBuyinSummary(form);assert.equal(stored.value,'');assert.notEqual(input.validationMessage,'');
  });
}
test('room duration and mini cutoff are computed against supplied server time, including an active final hand',()=>{
  const c=harness(),room={status:'playing',settings:{durationMinutes:60},endsAt:3600000,miniGamesCutoffAt:3300000};
  assert.equal(c.roomClock(room,0),'剩余 60:00');assert.equal(c.miniCutoff(room,3299999),false);assert.equal(c.miniCutoff(room,3300000),true);
  assert.equal(c.roomClock(room,3600000),'时间到 · 本手结束后散桌');room.status='closed';assert.equal(c.roomClock(room,4000000),'已结束');
  assert.equal(c.roomClock({status:'waiting',settings:{durationMinutes:90}},0),'90 分钟 · 首手开始计时');
});
test('avatar images use fixed local paths and malicious profile data never becomes markup',()=>{
  const c=harness();assert.match(c.avatar({avatar:11}),/avatars\/ai-06\.png/);assert.match(c.avatar({avatar:'<img onerror=alert(1)>',name:'<svg>'}),/avatars\/ai-01\.png/);
  assert.doesNotMatch(c.avatar({avatar:'<img onerror=alert(1)>',name:'<svg>'}),/<svg|onerror|src=x/);
});


test('the final hand can still be voluntarily shown after a timed table closes and players are stood up',()=>{
  const c=harness(),me={id:'hero',seat:null,inHand:true,cards:['As','Kh'],shownIndices:[]},room={meId:'hero',status:'closed',hand:{id:'last-hand',status:'complete'},players:[me],settings:{bigBlind:10}};
  c.state.connected=true;c.state.room=room;
  const html=c.actionArea(room,me,true);assert.match(html,/detached-final-cards/);assert.equal((html.match(/data-action="show-card"/g)||[]).length,2);assert.match(html,/data-hand="last-hand"/);
  assert.doesNotMatch(html,/data-action="(?:buyin|sitout|stand|show)"/);assert.equal(c.seatActions(room,me),'');
  me.seat=0;assert.doesNotMatch(c.actionArea(room,me,true),/detached-final-cards|data-action="show-card"/);
  me.seat=null;me.inHand=false;assert.doesNotMatch(c.actionArea(room,me,true),/detached-final-cards|data-action="show-card"/);
  assert.equal(c.seatActions(room,{seat:null,inHand:false}),'');
});

test('creation keeps only name, blinds and duration outside Advanced; expanding preserves field values',()=>{
  const c=harness(),settings={...c.defaults,squid:true,squidUnitBB:7,bombPot:true,bombAnteBB:4,timeBankCards:8};
  const closed=c.settingFields(settings,{roomName:'新桌'}),opened=c.settingFields(settings,{roomName:'新桌',advancedOpen:true});
  assert.match(closed,/<details[^>]*data-advanced-settings\s*>/);assert.match(opened,/<details[^>]*data-advanced-settings open>/);
  const advanced=closed.slice(closed.indexOf('<details'),closed.indexOf('</details>'));
  for(const key of ['squid','bombPot','maxTotalBuyInBB','maxPlayers','actionSeconds','timeBankCards','timeBankSeconds'])assert.match(advanced,new RegExp('name="'+key+'"'));
  assert.deepEqual(c.readSettings(formFrom(closed)),c.readSettings(formFrom(opened)));
  assert.match(closed,/鱿鱼 7 BB/);assert.match(closed,/炸弹池每 10 分钟 \/ 4 BB/);
});
function reuseFixture(c,{open=true}={}){
  c.state.rooms=[{code:'123456',name:'上次的局',status:'closed'}];c.createModal();
  const form=formFrom(c.modals.at(-1).body),selector={value:'123456',disabled:false,focus(){}},status={textContent:''},submit={disabled:false};
  form.dataset={};form.isConnected=true;form.fields.get('name').value='我微调的新局';
  let replacement='';const fields={disabled:false,set innerHTML(html){replacement=html;const parsed=formFrom(html);form.fields.clear();for(const [k,v]of parsed.fields)form.fields.set(k,v);}};
  form.querySelector=selectorText=>({'#reuse-room-settings':selector,'.settings-fields':fields,'[type="submit"]':submit,'[data-settings-reuse-status]':status,'[data-advanced-settings]':{open}}[selectorText]||null);
  const button={disabled:false,closest:()=>form};return {form,selector,status,submit,fields,button,get replacement(){return replacement;}};
}
test('loading an authorized prior room preserves the new name and Advanced state, then submits only fresh settings',async()=>{
  const calls=[],c=harness({api:async path=>{calls.push(path);return{code:'123456',invite:'private',players:[{id:'friend'}],endsAt:123,settings:{...c.defaults,smallBlind:2,bigBlind:5,maxTotalBuyInBB:1500,squid:true,squidUnitBB:6,durationMinutes:120}};}}),f=reuseFixture(c);
  await c.loadPreviousRoomSettings(f.button);assert.deepEqual(calls,['/api/rooms/123456']);
  assert.equal(f.form.fields.get('name').value,'我微调的新局');assert.match(f.replacement,/data-advanced-settings open/);assert.doesNotMatch(f.replacement,/private|friend|name="invite"/);
  const settings=c.readSettings(f.form);assert.equal(settings.bigBlind,5);assert.equal(settings.maxTotalBuyInBB,1500);assert.equal(settings.squidUnitBB,6);assert.equal(settings.durationMinutes,120);assert.doesNotThrow(()=>settingsFor(settings));
  assert.equal(f.fields.disabled,false);assert.equal(f.submit.disabled,false);assert.match(f.status.textContent,/已沿用/);
});
test('pending config loads block duplicate reads and a closed or superseded form ignores late data',async()=>{
  let release;let calls=0;const c=harness({api:()=>{calls++;return new Promise(resolve=>{release=resolve;});}}),f=reuseFixture(c,{open:false});
  const pending=c.loadPreviousRoomSettings(f.button);assert.equal(f.submit.disabled,true);assert.equal(f.fields.disabled,true);
  await c.loadPreviousRoomSettings(f.button);assert.equal(calls,1);
  f.form.isConnected=false;c.createModal();release({settings:{...c.defaults,bigBlind:20}});await pending;
  assert.equal(f.replacement,'');assert.equal(f.form.fields.get('bigBlind').value,'10');assert.equal(f.submit.disabled,false);
});
test('failed or unauthorized prior-room reads leave the current edited settings intact',async()=>{
  const messages=[],c=harness({api:async()=>{throw new Error('请先通过邀请链接加入房间');},toast:text=>messages.push(text)}),f=reuseFixture(c);
  f.form.fields.get('smallBlind').value='10';f.form.fields.get('bigBlind').value='20';await c.loadPreviousRoomSettings(f.button);
  assert.equal(f.form.fields.get('bigBlind').value,'20');assert.equal(f.form.fields.get('name').value,'我微调的新局');assert.equal(f.replacement,'');assert.equal(f.submit.disabled,false);assert.match(messages[0],/邀请链接/);
  f.selector.value='999999';await c.loadPreviousRoomSettings({...f.button,closest:()=>f.form});assert.equal(f.replacement,'');
});

test('expiry clock follows server squid extension and recovery window rather than promising closure after this hand',()=>{
  const c=harness(),room={status:'playing',endsAt:1000,settings:{durationMinutes:60},mini:{squid:{active:true}},expiryMode:'finish-squid'};
  assert.equal(c.roomClock(room,2000),'已到时 · 打完本轮鱿鱼');
  room.expiryMode='wait-squid';room.mini.squid.expiryGraceEndsAt=92000;assert.equal(c.roomClock(room,2000),'已到时 · 等待恢复 90秒');
  assert.equal(c.roomClock(room,92000),'已到时 · 等待恢复 0秒');
  room.mini.squid.expiryGraceEndsAt=null;room.hand={status:'playing',squidRound:null};assert.equal(c.roomClock(room,2000),'已到时 · 本手后等待恢复');
  room.status='closed';assert.equal(c.roomClock(room,2000),'已结束');
});

test('elapsed clock does not disable start during a server-authorized squid extension',()=>{
  const start={disabled:false},clock={dataset:{},classList:{toggle(){}}};
  const document={querySelectorAll:selector=>selector==='[data-action="start"]'?[start]:selector==='[data-room-clock]'?[clock]:[]};
  const c=harness({document});c.state.room={status:'playing',endsAt:Date.now()-1000,settings:{squid:true},expiryMode:'finish-squid'};
  c.tick();assert.equal(start.disabled,false);assert.equal(clock.dataset.squidExpiry,'true');assert.match(clock.textContent,/打完本轮鱿鱼/);
  c.state.room.expiryMode='wait-squid';c.tick();assert.equal(start.disabled,true);assert.match(clock.textContent,/等待鱿鱼恢复/);
});

test('mid-session buy-in defaults to waiting for a big blind and quotes a returner from server state',()=>{
  const c=harness();c.state.room={meId:'a',startedAt:1,settings:{...c.defaults,minBuyIn:200,maxBuyIn:2000},players:[{id:'a',seat:null,stack:0}]};
  c.buyinModal(2);let html=c.modals.at(-1).body;assert.match(html,/name="entryMode" value="wait" checked/);assert.match(html,/补盲加入 · 10 积分/);assert.match(html,/等过庄/);assert.match(html,/全员等盲无法开牌/);
  c.state.room.players[0].entryBlind={required:true,mode:'wait',reason:'missed',live:10,dead:5};c.buyinModal(3);html=c.modals.at(-1).body;
  assert.match(html,/补盲加入 · 15 积分/);assert.match(html,/补小盲 5 积分 不抵跟注/);
  c.state.room.players[0].seat=0;c.buyinModal();assert.doesNotMatch(c.modals.at(-1).body,/name="entryMode"/);
});

test('bomb presets and custom minutes submit a timer rather than a hand count',()=>{
  const c=harness(),form=formFrom(c.settingFields({...c.defaults,bombPot:true}));
  let hidden=false;form.querySelector=selector=>selector==='[data-bomb-custom]'?{set hidden(v){hidden=v;},querySelector:()=>({focus(){}})}:null;
  c.applySettingPreset({dataset:{value:'15'},closest:()=>form,parentElement:{querySelectorAll:()=>[]}},'bomb');
  assert.equal(c.readSettings(form).bombIntervalMinutes,15);assert.equal(hidden,true);assert.equal(c.readSettings(form).bombEveryHands,undefined);
  c.applySettingPreset({dataset:{value:'custom'},closest:()=>form,parentElement:{querySelectorAll:()=>[]}},'bomb');
  assert.equal(hidden,false);form.fields.get('bombIntervalMinutes').value='23';assert.equal(c.readSettings(form).bombIntervalMinutes,23);
});

function rebuyRoom(c){
  const room={code:'rebuy-room',meId:'hero',status:'waiting',hand:{id:'busted-hand',status:'complete'},settings:{...c.defaults},players:[{id:'hero',seat:0,stack:0,totalBuyIn:2000}],autoDeal:{paused:false,rebuyGrace:{handId:'busted-hand',pendingIds:['hero'],startsAt:5000,endsAt:10000}}};
  Object.assign(c.state,{room,page:'room',connected:true,busy:false,timeOffset:6000-Date.now()});return room;
}

test('automatic rebuy prompts once in the extra window, never submits money, and dismissing it does not extend time',()=>{
  const c=harness(),room=rebuyRoom(c),before=JSON.stringify(room.autoDeal.rebuyGrace);
  c.syncRebuyPrompt(room,4999);assert.equal(c.modals.length,0);
  c.syncRebuyPrompt(room,6000);assert.equal(c.modals.length,1);assert.equal(c.state.modal.autoRebuyHand,'busted-hand');assert.match(c.modals[0].body,/data-rebuy-countdown/);assert.equal(c.commands.length,0);
  c.state.modal=null;c.syncRebuyPrompt(room,7000);assert.equal(c.modals.length,1);assert.equal(JSON.stringify(room.autoDeal.rebuyGrace),before);
  c.syncRebuyPrompt(room,10000);assert.equal(c.modals.length,1);assert.equal(c.commands.length,0);
});

test('rebuy prompt defers behind other dialogs and hidden/offline states, then closes only its own expired dialog',()=>{
  const v=harness({document:{visibilityState:'hidden'}}),r=rebuyRoom(v);
  v.syncRebuyPrompt(r,6000);assert.equal(v.modals.length,0);
  v.state.connected=false;v.document.visibilityState='visible';v.syncRebuyPrompt(r,6000);assert.equal(v.modals.length,0);
  v.state.connected=true;v.state.modal={kind:'hand-library'};v.syncRebuyPrompt(r,6000);assert.equal(v.modals.length,0);assert.equal(v.state.modal.kind,'hand-library');
  v.state.modal=null;v.syncRebuyPrompt(r,6000);assert.equal(v.modals.length,1);
  v.syncRebuyPrompt(r,10000);assert.equal(v.state.modal,null);
  v.state.modal={kind:'buyin'};v.syncRebuyPrompt(r,11000);assert.equal(v.state.modal.kind,'buyin');
});

test('rebuy prompt waits for a fresh snapshot and does not consume its one-time prompt while resynchronizing',()=>{
  const c=harness(),room=rebuyRoom(c);
  c.state.feedbackResync=true;c.syncRebuyPrompt(room,6000);
  assert.equal(c.modals.length,0);assert.equal(c.state.rebuyPrompted,undefined);
  c.state.feedbackResync=false;c.state.busy=true;c.syncRebuyPrompt(room,6500);
  assert.equal(c.modals.length,0);assert.equal(c.state.rebuyPrompted,undefined);
  c.state.busy=false;c.syncRebuyPrompt(room,7000);
  assert.equal(c.modals.length,1);assert.equal(c.state.modal.autoRebuyHand,'busted-hand');
  assert.equal(c.commands.length,0);
});

test('expired automatic rebuy dialogs close even while disconnected, hidden, busy or waiting for a fresh snapshot',()=>{
  for(const blocked of [{connected:false},{busy:true},{feedbackResync:true},{hidden:true}]){
    const c=harness(),room=rebuyRoom(c);c.syncRebuyPrompt(room,6000);
    assert.equal(c.state.modal.autoRebuyHand,'busted-hand');
    Object.assign(c.state,blocked);if(blocked.hidden)c.document.visibilityState='hidden';
    c.syncRebuyPrompt(room,10000);assert.equal(c.state.modal,null,JSON.stringify(blocked));
    assert.equal(c.commands.length,0);
    c.state.modal={kind:'buyin'};c.syncRebuyPrompt(room,11000);
    assert.equal(c.state.modal.kind,'buyin','a manually opened dialog is not timed out');
  }
});

test('sit and rebuy confirmations cannot submit from disconnected or resynchronizing table data',async()=>{
  for(const isSit of [false,true])for(const blocked of [{connected:false,feedbackResync:false},{connected:true,feedbackResync:true}]){
    const messages=[],c=harness({toast:message=>messages.push(message)}),room=rebuyRoom(c);
    if(isSit)room.players[0].seat=null;
    c.buyinModal(isSit?2:undefined);const form=buyinFormFrom(c.modals.at(-1).body);
    Object.assign(c.state,blocked);await c.submit(form);
    assert.equal(c.commands.length,0);assert.match(messages.at(-1),/正在同步牌桌/);
    assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(c.state.modal.kind,'buyin');
    c.state.connected=true;c.state.feedbackResync=false;await c.submit(form);
    assert.equal(c.commands.length,1);assert.equal(c.commands[0].type,isSit?'sit':'buyin');
    assert.equal(c.commands[0].amountBB,200);assert.equal(c.state.modal,null);
  }
});
