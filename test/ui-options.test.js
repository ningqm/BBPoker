import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {settingsFor} from '../src/room.js';
import {avatarMarkup,createAvatarCache} from '../public/avatar.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function harness(){
  const modals=[];
  const context=vm.createContext({avatarMarkup,createAvatarCache,apiUrl:path=>path,
    FormData:class{constructor(form){this.form=form;}get(name){const field=this.form.elements.namedItem(name);return !field||field.disabled?null:field.type==='checkbox'?(field.checked?'on':null):field.value;}},
    state:{user:{name:'小鱼'},timeOffset:0},
    openModal(title,body,kind){modals.push({title,body,kind});},toast(message){throw new Error(message);},
  });
  vm.runInContext([
    section('const defaults=','const state='),section('const esc=','const profitClass='),section('const btn=','const card='),
    section('function seatActions(','function roomView('),section('function roomClock(','function tick('),section('function settingFields(','function joinInvite('),section('function buyinModal(','function inviteModal('),
    'globalThis.client={defaults,state,settingFields,settingsOverview,readSettings,updateSettingConstraints,applySettingPreset,createModal,buyinModal,roomClock,miniCutoff,avatar,seatActions};',
  ].join('\n'),context);
  return {...context.client,modals};
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
test('room presets submit BB settings, direct buy-in and defaults without hidden mushroom/approval controls',()=>{
  const c=harness(),html=c.settingFields(c.defaults),form=formFrom(html),s=c.readSettings(form);
  assert.equal(s.smallBlind,5);assert.equal(s.bigBlind,10);assert.equal(s.minBuyInBB,20);assert.equal(s.maxBuyInBB,200);
  assert.equal(s.actionSeconds,15);assert.equal(s.durationMinutes,60);assert.equal(s.timeBankCards,3);assert.equal(s.timeBankSeconds,30);
  assert.equal(s.bombPot,false);assert.equal(s.bombAnteBB,2);assert.equal(s.bombEveryHands,10);
  assert.equal(s.squid,false);assert.equal(s.squidUnitBB,2);
  assert.doesNotThrow(()=>settingsFor(s));
  assert.doesNotMatch(html,/蘑菇|name="(?:approvalRequired|minBuyIn|maxBuyIn)"/);
  c.state.createKeyRequired=true;c.createModal();assert.match(c.modals.at(-1).body,/小鱼必赢的局/);assert.doesNotMatch(c.modals.at(-1).body,/建房口令|name="createKey"/);
});
test('turning on unlimited buy-in submits null; switching blind presets keeps BB counts unchanged',()=>{
  const c=harness(),form=formFrom(c.settingFields(c.defaults));
  form.fields.get('unlimitedBuyIn').checked=true;c.updateSettingConstraints(form);
  assert.equal(form.fields.get('maxBuyInBB').disabled,true);assert.equal(c.readSettings(form).maxBuyInBB,null);
  let hidden=false;form.querySelector=selector=>selector==='[data-blind-custom]'?{set hidden(value){hidden=value;}}:null;
  const button={dataset:{value:'2/5'},closest:()=>form,parentElement:{querySelectorAll:()=>[]}};
  c.applySettingPreset(button,'blind');
  const s=c.readSettings(form);assert.equal(s.smallBlind,2);assert.equal(s.bigBlind,5);assert.equal(s.minBuyInBB,20);assert.equal(hidden,true);assert.doesNotThrow(()=>settingsFor(s));
  form.fields.get('unlimitedBuyIn').checked=false;c.updateSettingConstraints(form);assert.equal(c.readSettings(form).maxBuyInBB,200);
});
test('disabled mini-game amounts retain valid preferences and discard an invalid hidden value',()=>{
  const c=harness(),form=formFrom(c.settingFields({...c.defaults,squidUnitBB:4,bombAnteBB:3}));
  assert.equal(c.readSettings(form).squidUnitBB,4);assert.equal(c.readSettings(form).bombAnteBB,3);
  form.fields.get('bombAnteBB').value='-99';assert.equal(c.readSettings(form).bombAnteBB,3);
  form.fields.get('bombPot').checked=true;form.fields.get('bombAnteBB').disabled=false;form.fields.get('bombAnteBB').value='7';
  assert.equal(c.readSettings(form).bombPot,true);assert.equal(c.readSettings(form).bombAnteBB,7);
});
test('top-ups cap total stack and accept unlimited caps without displaying zero as a limit',()=>{
  const c=harness();c.state.room={meId:'a',settings:{...c.defaults,minBuyIn:200,maxBuyIn:2000},players:[{id:'a',seat:0,stack:1955}]};
  c.buyinModal();assert.match(c.modals.at(-1).body,/name="amountBB"[^>]*max="4"/);assert.match(c.modals.at(-1).body,/合计 40 积分/);
  c.state.room.settings.maxBuyIn=null;c.buyinModal();assert.match(c.modals.at(-1).body,/无上限/);assert.doesNotMatch(c.modals.at(-1).body,/max="/);
});
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
  const c=harness(),room={status:'closed',hand:{status:'complete'}},me={seat:null,inHand:true};
  assert.match(c.seatActions(room,me),/data-action="show"/);
  assert.doesNotMatch(c.seatActions(room,me),/data-action="(?:buyin|sitout|stand)"/);
  assert.equal(c.seatActions(room,{seat:null,inHand:false}),'');
});
