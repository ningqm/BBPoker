import { sameRoomSnapshot } from '../public/room-snapshot.js';
import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import { createTurnRecovery } from '../public/turn-recovery.js';
import {updateHandCategoryMotion} from '../public/hand-category.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as lifecycle from '../public/lifecycle.js';
import * as money from '../public/money.js';
import {createRequestGuard} from '../public/platform.js';
import {createTableFunTracker} from '../public/table-fun.js';
import {createTableFeedback} from '../public/table-feedback.js';
import {createTableModeTracker} from '../public/table-mode-events.js';
import * as tableScene from '../public/table-scene.js';
import * as tableControls from '../public/table-controls.js';
import {patchStableControls} from '../public/stable-controls.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const clone=value=>JSON.parse(JSON.stringify(value));
function nineRoom(revision=1){
  const players=Array.from({length:9},(_,i)=>({id:`p${i}`,name:`朋友${i}`,seat:i,stack:2000,sessionProfit:0,connected:true,inHand:true,cards:i?[null,null]:['As','Kd'],squidCount:i===1?2:0}));
  return {code:'123456',revision,meId:'p0',hostId:'p0',status:'playing',players,settings:{bigBlind:10,smallBlind:5,squid:true,squidMode:'unlimited',squidExtraTokens:3,bombPot:true},
    hand:{id:'h1',number:1,status:'playing',actionSeq:0,log:[],board:['2s','3h','4d'],bombPot:true,squidRound:1},chat:[],actions:{},autoDeal:{paused:false},
    mini:{squid:{active:true,mode:'unlimited',round:1,unit:20,tokenBudget:12,participants:players.map(p=>p.id),won:['p1'],counts:Object.fromEntries(players.map(p=>[p.id,p.squidCount]))}}};
}
function harness(){
  const requests=createRequestGuard(),calls=[],listeners=new Map(),toasts=[],saved=[],navigated=[],sounds=[],infoPaint=[];
  const state={clock:createRoomClock(),user:{id:'p0'},token:'synthetic-session',page:'room',room:nineRoom(),busy:false,connected:true,feedbackResync:false,raise:0,
    chatDraft:'',chatBusy:false,chatPending:null,chatOpen:false,chatUnread:0,chatMuted:false,reactionsMuted:false,reactions:{},funEffects:[],animations:true,sound:true,modal:null};
  let serial=0;
  const pending=(path,body)=>new Promise((resolve,reject)=>calls.push({path,body,resolve,reject}));
  const context=vm.createContext({sameRoomSnapshot,createRoomClock,isOlderRoomSnapshot,patchStableControls,updateHandCategoryMotion,...money,...tableScene,...tableControls,lifecycle,state,requests,Date,URLSearchParams,
    api:pending,fetch:(url,options)=>pending(url,options),apiUrl:path=>path,
    FormData:class{constructor(form){this.values=form.values;}get(name){return this.values[name]??null;}},
    document:{visibilityState:'visible',addEventListener:(type,fn)=>listeners.set(type,fn)},navigator:{onLine:true},
    funTracker:createTableFunTracker(),feedback:createTableFeedback(),tableSounds:{playFeedback:result=>sounds.push(result)},
    rememberCommitment:()=>false,render(){},toast:message=>toasts.push(message),commandId:()=>`synthetic-command-${++serial}`,
    openModal(title,body,kind='custom'){state.modal={title,body,kind};},closeModal(){state.modal=null;},
    tableInfoModal(){infoPaint.push(clone(state.room));state.modal={kind:'table-info'};},roomMenu(){state.modal={kind:'room-menu'};},
    connectStream(){state.connected=false;},readSettings:()=>({bigBlind:10}),saveExport:async file=>{saved.push(file);return {canceled:false};},navigate:path=>navigated.push(path),
    fairnessSourceLinks:()=>'',
  });
  // Production normalization gets transport freshness from the recovery
  // controller; the display clock alone cannot decide whether to play effects.
  state.turnRecovery=createTurnRecovery({
    getContext:()=>({room:state.room,identity:state.token,now:state.clock.now()}),
    fetchRoom(){},apply(){},reconnect(){},
  });
  vm.runInContext([
    section('const esc=','const fmtDate='),section('const btn=','const avatar='),
    section('function captureRoomChanges(','function stopStream('),
    section('async function sendChat(','function renderHandLibrary('),
    section('function departureModal(','function participationNotice('),
    section('async function fairnessModal(','async function verifyHand('),
    section('async function handleAction(','function setRaise('),
    section("document.addEventListener('submit'",'function resetPrivateView('),
    'globalThis.client={normalizeState,command,sendChat,departureModal,confirmDeparture,entryBlindModal,confirmEntryBlind,fairnessModal,handleAction};',
  ].join('\n'),context);
  return {...context.client,state,requests,calls,toasts,saved,navigated,sounds,infoPaint,context,
    act:(action,data={})=>context.handleAction({dataset:{action,...data},disabled:false}),
    submit(id,values={},dataset={}){const submit={disabled:false,isConnected:true};return listeners.get('submit')({target:{id,values,dataset,querySelector:()=>submit},preventDefault(){}});},
    succeed(index=0){calls[index].resolve({room:nineRoom(state.room.revision+1)});},
  };
}

for(const [action,kind] of [['settle-squid-confirm','settle-squid'],['transfer-confirm','custom'],['close-room','custom'],['toggle-autodeal','room-menu'],['cancel-departure','room-menu']]){
  test(`${action}: a delayed success never closes or replaces a newer same-kind modal`,async()=>{
    const c=harness();c.state.modal={kind,owner:'first'};
    const pending=c.act(action,{player:'p1'});assert.equal(c.calls.length,1);
    const newer={kind,owner:'second'};c.state.modal=newer;c.succeed();await pending;
    assert.equal(c.state.modal,newer);assert.equal(c.calls.length,1);
  });
}
test('current close-room success still closes its own confirmation',async()=>{
  const c=harness();c.state.modal={kind:'custom'};const pending=c.act('close-room');c.succeed();await pending;assert.equal(c.state.modal,null);
});
test('a delayed departure preserves a new card and any newer departure quote',async()=>{
  const c=harness();c.departureModal('stand');const pending=c.confirmDeparture();
  const newer={kind:'player-stats'},quote={code:'123456',round:2};c.state.modal=newer;c.state.departureConfirmation=quote;
  c.succeed();await pending;assert.equal(c.state.modal,newer);assert.equal(c.state.departureConfirmation,quote);
});
test('a delayed entry choice preserves a new card and any newer entry quote',async()=>{
  const c=harness(),me=c.state.room.players[0];me.inHand=false;me.entryBlind={required:true,mode:'wait',reason:'missed',live:10,dead:5};
  c.entryBlindModal();const pending=c.confirmEntryBlind('post');
  const newer={kind:'player-stats'},quote={code:'123456',playerId:'p0',reason:'new'};c.state.modal=newer;c.state.entryBlindConfirmation=quote;
  c.succeed();await pending;assert.equal(c.state.modal,newer);assert.equal(c.state.entryBlindConfirmation,quote);
});
for(const [form,kind,dataset] of [['buyin-form','buyin',{seat:''}],['buyin-form','buyin',{seat:'8'}],['settings-form','settings',{}]]){
  test(`${form} ${dataset.seat??''}: slow save cannot close a reopened instance`,async()=>{
    const c=harness();c.state.modal={kind};const pending=c.submit(form,{amountBB:'100',entryMode:'post'},dataset);
    assert.equal(c.calls.length,1);const newer={kind};c.state.modal=newer;c.succeed();await pending;assert.equal(c.state.modal,newer);
  });
}
test('a stale buy-in conflict does not close a newly reopened buy-in modal',async()=>{
  const c=harness();c.state.modal={kind:'buyin'};const pending=c.command('buyin',{amountBB:100});const newer={kind:'buyin'};c.state.modal=newer;
  c.calls[0].reject(Object.assign(new Error('stale amount'),{status:409}));await pending;assert.equal(c.state.modal,newer);
});
test('export preserves a newer modal and labels the file with the requested table',async()=>{
  const c=harness();c.state.modal={kind:'export'};c.state.exportRoom='123456';const pending=c.submit('export-form',{format:'json'});
  const newer={kind:'export'};c.state.modal=newer;c.state.exportRoom='654321';
  c.calls[0].resolve({status:200,ok:true,text:async()=>'{}',headers:{get:()=>'application/json'}});await pending;
  assert.equal(c.state.modal,newer);assert.equal(c.saved.length,1);assert.match(c.saved[0].name,/BBPoker-123456-/);
});
test('a slow room creation does not navigate away from a newer modal',async()=>{
  const c=harness();c.state.modal={kind:'create'};const pending=c.submit('create-form',{name:'新桌',access:'public'});
  const newer={kind:'player-stats'};c.state.modal=newer;c.calls[0].resolve({room:{code:'654321',invite:'synthetic-invite'}});await pending;
  assert.equal(c.state.modal,newer);assert.equal(c.navigated.length,0);
});
test('old fairness responses cannot overwrite a reopened explanation or dismiss another modal',async()=>{
  for(const fail of [false,true]){const c=harness();const pending=c.fairnessModal();const newer={kind:fail?'player-stats':'fairness'};c.state.modal=newer;
    if(fail)c.calls[0].reject(new Error('offline'));else c.calls[0].resolve({summary:['old result']});await pending;assert.equal(c.state.modal,newer);}
});
test('nine-player repeated and out-of-order snapshots never duplicate chat, fish, or action feedback',()=>{
  const c=renderHarness(),initial=nineRoom();c.state.room=null;c.normalizeState(initial);
  const updated=nineRoom(2);updated.chat=Array.from({length:9},(_,i)=>({id:`m${i}`,playerId:`p${i}`,kind:'emote',emote:'nice',at:new Date().toISOString()}));
  updated.mini.squid.counts.p1=3;updated.players[1].squidCount=3;updated.hand.actionSeq=1;updated.hand.log=[{seq:1,type:'call',playerId:'p2',amount:10}];
  c.normalizeState(updated);assert.equal(c.state.chatUnread,8);const feedback=c.sounds.filter(s=>s.speech).length;assert.equal(feedback,1,'the first live action is audible only after the real render consumes it');
  c.normalizeState(clone(updated));c.normalizeState(initial);assert.equal(c.state.chatUnread,8);assert.equal(c.state.room.revision,2);
  assert.equal(c.state.room.mini.squid.counts.p1,3);assert.equal(c.sounds.filter(s=>s.speech).length,feedback);assert.equal(c.calls.length,0);
});
test('nine-player reconnect consumes past throw and action events silently and never mutates fish counts',()=>{
  const c=renderHarness(),initial=nineRoom();c.state.room=null;c.normalizeState(initial);
  const restored=nineRoom(8);restored.chat=[{id:'restore-throw',kind:'throw',emote:'pat',playerId:'p2',targetId:'p3',at:new Date().toISOString()}];
  restored.hand.actionSeq=1;restored.hand.log=[{seq:1,type:'raise',playerId:'p2',to:100}];restored.mini.squid.counts.p1=4;restored.players[1].squidCount=4;
  const before=JSON.stringify(restored);c.state.feedbackResync=true;c.normalizeState(restored);c.normalizeState(clone(restored));
  assert.equal(JSON.stringify(restored),before);assert.equal(c.state.funEffects.length,0);assert.equal(c.sounds.filter(s=>s.speech).length,0);assert.equal(c.calls.length,0);
});
test('a nine-player late private snapshot for another identity is ignored',()=>{
  const c=harness(),original=c.state.room,other=nineRoom(100);other.meId='p8';other.players[8].cards=['Ah','Ad'];c.normalizeState(other);
  assert.equal(c.state.room,original);assert.deepEqual(c.state.room.players[8].cards,[null,null]);assert.equal(c.calls.length,0);
});

// Minimal DOM double for attachment, replacement and reading-state checks. The
// real render/refresh functions run here; no browser click timing is simulated.
class ViewNode {
  constructor({tag='div',className='',id='',dataset={},attrs={},text='',children=[]}={}){
    Object.assign(this,{nodeType:1,tagName:tag,className,id,dataset:{...dataset},attrs:{...attrs},text,parentElement:null,scrollTop:0,open:false,disabled:false,style:{cssText:''}});this.children=[];
    for(const child of children)this.insertBefore(child instanceof ViewNode?child:new ViewNode(child),null);
  }
  get childNodes(){return [...(this.text?[new ViewText(this)]:[]),...this.children];}
  get attributes(){return Object.entries({...this.attrs,...(this.className?{class:this.className}:{}),...(this.id?{id:this.id}:{}),...Object.fromEntries(Object.entries(this.dataset).map(([key,value])=>['data-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),String(value)]))}).map(([name,value])=>({name,value}));}
  get outerHTML(){return JSON.stringify(this.descriptor());}
  get firstElementChild(){return this.children[0]||null;}
  get nextElementSibling(){const siblings=this.parentElement?.children||[];return siblings[siblings.indexOf(this)+1]||null;}
  get textContent(){return this.text+this.children.map(c=>c.textContent).join('');}
  set textContent(text){this.innerHTML='';this.text=String(text);}
  descriptor(){return {tag:this.tagName,className:this.className,id:this.id,dataset:this.dataset,attrs:this.attrs,text:this.text,children:this.children.map(c=>c.descriptor())};}
  get innerHTML(){return JSON.stringify({text:this.text,children:this.children.map(c=>c.descriptor())});}
  set innerHTML(value){for(const child of [...this.children])child.remove();this.text='';if(!value)return;let data;try{data=JSON.parse(value);}catch{this.text=value;return;}this.text=data.text||'';for(const child of data.children||[])this.insertBefore(new ViewNode(child),null);}
  get isConnected(){return this.parentElement?.isConnected??Boolean(this.root);}
  getBoundingClientRect(){return {x:0,y:0,left:0,top:0,right:800,bottom:600,width:800,height:600};}
  contains(node){return this===node||this.children.some(c=>c.contains(node));}
  remove(){if(!this.parentElement)return;const list=this.parentElement.children;list.splice(list.indexOf(this),1);this.parentElement=null;}
  insertBefore(node,anchor){if(node===anchor)return;node.remove();const i=anchor?this.children.indexOf(anchor):this.children.length;assert.ok(i>=0);this.children.splice(i,0,node);node.parentElement=this;}
  replaceWith(node){const parent=this.parentElement,anchor=this.nextElementSibling;this.remove();parent.insertBefore(node,anchor);}
  append(node){if(node.nodeType===3){const value=node.nodeValue;node.remove();this.text+=value;}else this.insertBefore(node,null);}
  focus(){}
  matches(selector){if(selector.startsWith('.'))return this.className.split(' ').includes(selector.slice(1));if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector==='[data-action]')return Boolean(this.dataset.action);return this.tagName===selector;}
  querySelectorAll(selector){const direct=selector.startsWith(':scope > ');if(direct)selector=selector.slice(9);const result=[];for(const c of this.children){if(c.matches(selector))result.push(c);if(!direct)result.push(...c.querySelectorAll(selector));}return result;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  getAttribute(key){if(key==='class')return this.className||null;if(key==='id')return this.id||null;if(key.startsWith('data-'))return this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]??null;return this.attrs[key]??null;}
  hasAttribute(key){return this.getAttribute(key)!==null;}
  setAttribute(key,value){if(key==='class')this.className=String(value);else if(key==='id')this.id=String(value);else if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);else this.attrs[key]=String(value);}
  removeAttribute(key){if(key==='class')this.className='';else if(key==='id')this.id='';else if(key.startsWith('data-'))delete this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())];else delete this.attrs[key];}
}
class ViewText {
  constructor(parent){this.nodeType=3;this.parentElement=parent;}
  get nodeValue(){return this.parentElement?.text||'';}
  set nodeValue(value){if(this.parentElement)this.parentElement.text=String(value);}
  remove(){if(this.parentElement)this.parentElement.text='';this.parentElement=null;}
  replaceWith(node){const parent=this.parentElement;this.remove();if(node.nodeType===3)parent.text=node.nodeValue;else parent.insertBefore(node,parent.firstElementChild);}
}
function infoView(room){return JSON.stringify({children:[
  {dataset:{tableInfo:'chips'},children:[{text:`带入${room.players[0].totalBuyIn||0};筹码${room.players[0].stack}`},{tag:'details',id:'chip-explanation',children:[{tag:'summary',text:'筹码说明'},{text:'说明'}]}]},
  {dataset:{tableInfo:'mini'},text:room.players.map(p=>`${p.id}:${p.seat}:${p.connected}:${p.sittingOut}`).join(',')},
  {dataset:{tableInfo:'activity'},text:(room.hand?.log||[]).map(e=>`${e.playerId}:${e.type}`).join(',')},
  {dataset:{tableInfo:'footer'},children:[{tag:'button',dataset:{action:'last-hand'},text:'上一手'}]},
]});}
function infoHarness(){
  const c=harness(),body=new ViewNode({className:'modal-body'}),dialog=new ViewNode({children:[body]});dialog.root=true;
  let paints=0;c.context.dialog=dialog;c.context.document.createElement=()=>new ViewNode();
  vm.runInContext(section('function tableInfoModal(){','function paintStats(){'),c.context);
  c.context.tableInfoBody=room=>{paints++;return infoView(room);};
  c.state.modal={kind:'table-info'};body.innerHTML=infoView(c.state.room);
  return {...c,dialog,body,get paints(){return paints;}};
}
test('same-hand action updates table details without replacing the modal, footer or reading position',()=>{
  const c=infoHarness(),modal=c.state.modal,footer=c.body.children[3],button=footer.children[0];c.dialog.scrollTop=170;c.body.scrollTop=35;
  const updated=clone(c.state.room);updated.revision++;updated.hand.actionSeq++;updated.hand.log.push({seq:1,type:'call',playerId:'p3'});
  c.normalizeState(updated);assert.match(c.body.children[2].textContent,/p3:call/);assert.equal(c.paints,1);
  assert.equal(c.state.modal,modal);assert.equal(c.body.children[3],footer);assert.equal(footer.children[0],button);
  assert.equal(c.dialog.scrollTop,170);assert.equal(c.body.scrollTop,35);
});
test('buy-ins, seat departures and reconnects refresh details while retaining expanded explanations',()=>{
  const c=infoHarness();c.body.querySelector('details').open=true;c.body.children[0].scrollTop=22;
  const updated=clone(c.state.room);updated.revision++;updated.players[0].stack+=1000;updated.players[0].totalBuyIn=3000;updated.players[5].seat=null;
  c.normalizeState(updated);assert.match(c.body.children[0].textContent,/带入3000;筹码3000/);assert.match(c.body.children[1].textContent,/p5:null/);
  assert.equal(c.body.querySelector('details').open,true);assert.equal(c.body.children[0].scrollTop,22);
  const offline=clone(updated);offline.revision++;offline.players[1].connected=false;c.normalizeState(offline);assert.match(c.body.children[1].textContent,/p1:1:false/);
});
test('nine chat-only snapshots leave table details and its expanded content untouched',()=>{
  const c=infoHarness(),nodes=[...c.body.children],details=c.body.querySelector('details');details.open=true;
  for(let i=0;i<9;i++){const updated=clone(c.state.room);updated.revision++;updated.chat.push({id:`chat-${i}`,playerId:`p${i}`,kind:'text',text:'你好',at:new Date().toISOString()});c.normalizeState(updated);}
  assert.equal(c.paints,0);assert.deepEqual(c.body.children,nodes);assert.equal(c.body.querySelector('details'),details);assert.equal(details.open,true);
});
function roomScene(state){return JSON.stringify({children:[{className:'topbar'},{className:'room-shell',dataset:{room:state.room.code},children:[
  {className:'room-head',text:state.room.name||'九人桌',children:[{tag:'button',id:'probe-topup',dataset:{action:'buyin'},text:'补码'}]},{className:'game-grid',children:[{className:'table-column',children:[{className:'table-stage',children:[{className:'seat',dataset:{playerId:'p0'},children:[{className:'seat-main',dataset:{action:'player-stats',player:'p0'},children:[{className:'stack-value',text:`筹码${state.room.players[0].stack}`}]},{className:'seat-time-tools',children:[{tag:'button',id:'probe-timebank',dataset:{action:'timebank'},text:'+30秒 · 6张'}]}]}]},{className:'table-bottom',dataset:{turn:`${state.room.hand?.id||''}:${state.room.hand?.actionSeq||0}`},children:[{tag:'button',id:'probe-bet',attrs:state.busy||!state.connected||state.feedbackResync?{disabled:''}:{},dataset:{action:'raise-preset',amount:String(state.room.actions?.minRaiseTo||20)},text:`加至 ${state.room.actions?.minRaiseTo||20}`}]}]}]},
  {tag:'nav',className:'table-toolbar',children:[{tag:'button',id:'chat-toggle',dataset:{action:'toggle-chat'},attrs:{'aria-expanded':String(state.chatOpen),'aria-controls':'chat-drawer'},text:`聊天${state.chatUnread||''}`},{tag:'button',dataset:{action:'history'},text:'牌谱'}]},
  ...(state.chatOpen?[{className:'chat-card',text:'聊天已打开'}]:[]),
]}]});}
function renderHarness(){
  const c=harness(),app=new ViewNode();app.root=true;app.innerHTML=roomScene(c.state);
  Object.assign(c.context,{app,header:()=>'',roomView:()=>roomScene(c.state),statsUI:{captureStatsDraft(){},restoreStatsDraft(){}},records:{captureRecordDraft(){},restoreRecordDraft(){}},
    avatarCache:{hydrate(){}},mountFunEffects(){},tick(){},welcome(){},recoveryPage(){},errorPage(){},lobby(){},career(){},handLibrary(){},sessionLibrary(){},opponentLibrary(){},$:selector=>app.querySelector(selector)});
  Object.assign(c.context.document,{activeElement:null,createElement:()=>new ViewNode(),querySelector:selector=>app.querySelector(selector),getElementById:id=>app.querySelector('#'+id),body:{classList:{toggle(){}}}});
  vm.runInContext(section('function recordFormSelector(','function recordState(')+section('function patchRoomToolbar(','function usernameField('),c.context);
  return {...c,app,render:()=>c.context.render()};
}
test('same-table updates keep the pressed chat and history buttons attached while updating their labels',()=>{
  const c=renderHarness(),chat=c.app.querySelector('#chat-toggle'),toolbar=c.app.querySelector('.table-toolbar'),history=toolbar.children[1];
  for(let i=1;i<=9;i++){c.state.chatUnread=i;c.state.room.players[0].stack-=10;c.render();assert.equal(c.app.querySelector('#chat-toggle'),chat);assert.equal(chat.isConnected,true);assert.equal(toolbar.children[1],history);}
  assert.equal(chat.textContent,'聊天9');assert.match(c.app.querySelector('.table-stage').textContent,/筹码1910/);
});

test('same-turn chat snapshots retain the actual bet button and its target amount',()=>{
  const c=renderHarness();c.render();const bet=c.app.querySelector('#probe-bet'),dock=c.app.querySelector('.table-bottom');
  for(let i=1;i<=9;i++){c.state.chatUnread=i;c.state.room.players[1].connected=i%2===0;c.render();assert.equal(c.app.querySelector('#probe-bet'),bet);assert.equal(bet.isConnected,true);assert.equal(c.app.querySelector('.table-bottom'),dock);}
  assert.equal(bet.dataset.amount,'20');
});
test('real room patches retain top-up, time-card and pressed player-card nodes through repeated snapshots',()=>{
  const c=renderHarness();c.render();
  const selectors=['#probe-topup','#probe-timebank','.seat-main','.stack-value'];
  const pressed=selectors.map(selector=>c.app.querySelector(selector));
  for(let i=1;i<=9;i++){
    c.state.chatUnread=i;c.state.room.players[0].stack=2000-i*10;c.render();
    selectors.forEach((selector,index)=>{assert.equal(c.app.querySelector(selector),pressed[index]);assert.equal(pressed[index].isConnected,true);});
  }
  assert.equal(c.app.querySelector('.stack-value').textContent,'筹码1910');
});
test('busy, disconnect and resync changes still replace stale actionable controls',()=>{
  for(const [property,value] of [['busy',true],['connected',false],['feedbackResync',true]]) {
    const c=renderHarness();c.render();const bet=c.app.querySelector('#probe-bet');c.state[property]=value;c.render();
    const blocked=c.app.querySelector('#probe-bet');assert.notEqual(blocked,bet);assert.equal(blocked.getAttribute('disabled'),'');
    c.state[property]=!value;c.render();const enabled=c.app.querySelector('#probe-bet');assert.notEqual(enabled,blocked);assert.equal(enabled.getAttribute('disabled'),null);
  }
});
test('a changed quote or new action sequence detaches stale bet buttons instead of silently repricing them',()=>{
  const c=renderHarness();c.render();const original=c.app.querySelector('#probe-bet');
  c.state.room.actions.minRaiseTo=40;c.render();const repriced=c.app.querySelector('#probe-bet');
  assert.notEqual(repriced,original);assert.equal(original.isConnected,false);assert.equal(repriced.dataset.amount,'40');
  c.state.room.hand.actionSeq++;c.render();assert.notEqual(c.app.querySelector('#probe-bet'),repriced);assert.equal(repriced.isConnected,false);
});
test('the preserved chat button still opens and closes its drawer exactly once per action',async()=>{
  const c=renderHarness(),chat=c.app.querySelector('#chat-toggle');c.state.chatUnread=8;c.render();
  await c.act('toggle-chat');assert.equal(c.state.chatOpen,true);assert.equal(c.state.chatUnread,0);assert.ok(c.app.querySelector('.chat-card'));
  assert.equal(c.app.querySelector('#chat-toggle'),chat);assert.equal(chat.getAttribute('aria-expanded'),'true');
  await c.act('toggle-chat');assert.equal(c.state.chatOpen,false);assert.equal(c.app.querySelector('.chat-card'),null);
  assert.equal(c.app.querySelector('#chat-toggle'),chat);assert.equal(chat.getAttribute('aria-expanded'),'false');
});
test('moving to a different room replaces the old toolbar rather than retaining old room controls',()=>{
  const c=renderHarness(),old=c.app.querySelector('#chat-toggle');c.state.room.code='654321';c.render();
  assert.notEqual(c.app.querySelector('#chat-toggle'),old);assert.equal(old.isConnected,false);
  assert.equal(c.app.querySelector('.room-shell').dataset.room,'654321');
});

test('live action audio is consumed while a non-chat IME pauses DOM rendering, with no overwrite or replay',()=>{
  const c=renderHarness(),initial=nineRoom();c.state.room=null;c.normalizeState(initial);
  c.sounds.length=0;
  const stage=c.app.querySelector('.table-stage');
  c.state.composing=true;c.context.document.activeElement={id:'player-search'};
  const checked=nineRoom(2);checked.hand.actingId='p2';checked.hand.actionSeq=1;checked.hand.log=[{seq:1,type:'check',playerId:'p1',street:'flop'}];
  c.normalizeState(checked);
  const actions=()=>c.sounds.filter(sound=>sound.animations?.some(event=>event.type==='action'));
  assert.equal(c.state.renderDeferred,true,'the composition still prevents DOM replacement');
  assert.equal(c.app.querySelector('.table-stage'),stage);
  assert.equal(actions().length,1,'a live check must not wait for the input method to finish');
  assert.equal(actions()[0].animations.find(event=>event.type==='action').seq,1);
  assert.equal(c.state.pendingFeedback,null,'the sound cannot remain for a chat snapshot to overwrite');
  const chat=clone(checked);chat.revision=3;chat.chat=[{id:'during-ime',playerId:'p4',kind:'text',text:'你好',at:new Date().toISOString()}];
  c.normalizeState(chat);assert.equal(actions().length,1,'chat has no new action audio');
  const next=clone(chat);next.revision=4;next.hand.actingId='p3';next.hand.actionSeq=2;next.hand.log.push({seq:2,type:'check',playerId:'p2',street:'flop'});
  c.normalizeState(next);
  assert.deepEqual(actions().map(sound=>sound.animations.find(event=>event.type==='action').seq),[1,2],'consecutive live actions survive the paused render');
  assert.equal(c.state.pendingFeedback,null);assert.equal(c.app.querySelector('.table-stage'),stage);
  c.state.composing=false;c.context.document.activeElement=null;c.render();
  assert.equal(actions().length,2,'finishing composition never repeats already consumed feedback');
});

test('deferred audio is consumed silently after mute, disconnect, hiding or leaving, including paused IME rendering',()=>{
  for(const composing of [false,true])for(const transition of ['mute','disconnect','hidden','resync','leave']){
    const c=renderHarness();c.state.pendingFeedback={eventId:'123456:p0:h1:4',sound:'chip',speech:'raise'};
    c.state.composing=composing;c.context.document.activeElement=composing?{id:'player-search'}:null;
    if(transition==='mute')c.state.sound=false;
    if(transition==='disconnect')c.state.connected=false;
    if(transition==='hidden')c.context.document.visibilityState='hidden';
    if(transition==='resync')c.state.feedbackResync=true;
    if(transition==='leave')c.state.page='welcome';
    c.render();assert.equal(c.sounds.length,0,transition);assert.equal(c.state.pendingFeedback,null,transition);
    c.state.page='room';c.state.sound=true;c.state.connected=true;c.state.feedbackResync=false;c.state.composing=false;c.context.document.activeElement=null;c.context.document.visibilityState='visible';
    c.render();assert.equal(c.sounds.length,0,'returning must not replay the skipped action');
  }
});

test('real snapshot integration collects all split/side-pot awards once and clears them for the next hand',()=>{
  const c=renderHarness(),initial=nineRoom();c.state.room=null;c.normalizeState(initial);
  const complete=nineRoom(2);Object.assign(complete.hand,{status:'complete',actingId:null,result:{mainWinnerIds:['p0','p1'],payouts:{p0:150,p1:350,p2:100,p3:0}},log:[{seq:1,type:'payout',playerId:'p0',amount:150},{seq:2,type:'payout',playerId:'p1',amount:350},{seq:3,type:'payout',playerId:'p2',amount:100}],actionSeq:3});
  c.normalizeState(complete);const first=c.state.potMotion;
  assert.deepEqual(clone(first.awards),[{playerId:'p0',amount:150},{playerId:'p1',amount:350},{playerId:'p2',amount:100}]);
  c.normalizeState(clone(complete));assert.equal(c.state.potMotion,first,'duplicate state retains original animation age');
  c.normalizeState(initial);assert.equal(c.state.potMotion,first,'out-of-order state cannot retrigger settlement');
  const next=nineRoom(3);next.hand.id='h2';next.hand.number=2;c.normalizeState(next);assert.equal(c.state.potMotion,null);
});

test('settlement received hidden or reconnecting never becomes a collection replay on return',()=>{
  for(const mode of ['hidden','reconnected']){
    const c=renderHarness(),initial=nineRoom();c.state.room=null;c.normalizeState(initial);
    if(mode==='hidden')c.context.document.visibilityState='hidden';else c.state.feedbackResync=true;
    const complete=nineRoom(2);Object.assign(complete.hand,{status:'complete',actingId:null,result:{mainWinnerIds:['p1'],payouts:{p1:600}},log:[{seq:1,type:'payout',playerId:'p1',amount:600}],actionSeq:1});
    c.normalizeState(complete);assert.equal(c.state.potMotion,null,mode);
    c.context.document.visibilityState='visible';const restored=clone(complete);restored.revision=3;c.normalizeState(restored);
    assert.equal(c.state.potMotion,null,`${mode}: restored same-hand result is not a new win`);
  }
});

test('real room snapshots keep transition, flip and readiness feedback separate even with chat refreshes',()=>{
 const c=renderHarness(),now=Date.now(),initial=nineRoom();
 Object.assign(initial.hand,{board:[],actingId:'p1'});initial.serverTime=now;c.state.room=null;c.normalizeState(initial);
 const tail=clone(initial);tail.revision=2;tail.serverTime=now+1;Object.assign(tail.hand,{actingId:null,transition:{kind:'street',nextAt:now+901},log:[{seq:1,type:'call',playerId:'p1',amount:10}],actionSeq:1});
 c.normalizeState(tail);assert.equal(c.sounds.filter(s=>s.speech==='call').length,1);assert.equal(c.state.potMotion,null);
 const chat=clone(tail);chat.revision=3;chat.serverTime=now+500;chat.chat=[{id:'chat',playerId:'p3',kind:'text',text:'好牌',at:new Date(now+500).toISOString()}];c.normalizeState(chat);
 const flop=clone(chat);flop.revision=4;flop.serverTime=now+901;Object.assign(flop.hand,{board:['As','Kd','2c'],actingId:'p0',actionReadyAt:now+1801,transition:null,log:[...tail.hand.log,{seq:2,type:'street',street:'flop'}],actionSeq:2});flop.actions={canAct:false};
 c.normalizeState(flop);assert.equal(c.sounds.filter(s=>s.sound==='board').length,1);assert.equal(c.sounds.filter(s=>s.yourTurnId).length,0);assert.ok(c.state.boardMotion);assert.equal(c.state.motion.actor,null);
 const ready=clone(flop);ready.revision=5;ready.serverTime=now+1801;ready.actions.canAct=true;c.normalizeState(ready);
 assert.equal(c.sounds.filter(s=>s.yourTurnId).length,1);assert.equal(c.sounds.filter(s=>s.speech==='call').length,1);assert.deepEqual(clone(c.state.motion.actions),[]);
 const ids=c.sounds.filter(s=>s.eventId).map(s=>s.eventId);assert.equal(new Set(ids).size,ids.length);
 c.normalizeState(clone(ready));assert.equal(c.sounds.filter(s=>s.yourTurnId).length,1);
});

test('expired room delivery suppresses all visual and sound effects together and cannot replay them later',()=>{
 const c=renderHarness(),initial=nineRoom(),now=Date.now();initial.serverTime=now;c.state.room=null;c.normalizeState(initial);
 const old=clone(initial);old.revision=2;old.serverTime=now-6000;
 old.chat=[{id:'old-chat',playerId:'p3',kind:'emote',emote:'nice',at:new Date(now).toISOString()}];
 old.players[1].shownIndices=[0,1];old.players[1].cards=['As','Ah'];
 Object.assign(old.hand,{status:'complete',board:[...old.hand.board,'Ks','Kh'],actingId:null,result:{mainWinnerIds:['p1'],payouts:{p1:600}},log:[{seq:1,type:'payout',playerId:'p1',amount:600}],actionSeq:1});
 c.normalizeState(old);
 for(const field of ['boardMotion','potMotion','revealMotion','motion'])assert.equal(c.state[field],null,field);
 assert.equal(Object.keys(c.state.reactions).length,0);assert.deepEqual(clone(c.state.funEffects),[]);assert.equal(c.sounds.filter(s=>s.sound||s.speech).length,0);
 const restored=clone(old);restored.revision=3;restored.serverTime=now;c.normalizeState(restored);
 for(const field of ['boardMotion','potMotion','revealMotion','motion'])assert.equal(c.state[field],null,field);
 assert.equal(c.sounds.filter(s=>s.sound||s.speech).length,0);
});


function modeClientFixture() {
  const c = renderHarness();
  const baseTime = 1800000000000;
  c.state.clock = createRoomClock({ monotonicNow: () => 0, wallNow: () => baseTime });
  c.state.modeTracker = createTableModeTracker(); c.state.modeEffects = []; c.state.room = null;
  const idle = nineRoom(1); idle.serverTime = baseTime; idle.hand = null; idle.status = 'waiting';
  Object.assign(idle.mini.squid, { active: false, round: 0, won: [], counts: {}, tokenBudget: 0 });
  c.normalizeState(idle);
  const opening = nineRoom(2); opening.serverTime = baseTime;
  Object.assign(opening.hand, { at: new Date(baseTime).toISOString(), actionReadyAt: baseTime + 1100, ante: 20 });
  return { c, baseTime, opening };
}

test('actual client capture keeps one combined opening through render, chat and buy-in updates without extending its duration', () => {
  const { c, baseTime, opening } = modeClientFixture();
  const untouched = JSON.stringify(opening); c.normalizeState(opening);
  assert.equal(JSON.stringify(opening), untouched);
  assert.deepEqual(Array.from(c.state.modeEffects, e => e.type), ['bomb-start', 'squid-start']);
  const first = clone(c.state.modeEffects);
  for (let i = 0; i < 5; i++) c.render();
  assert.deepEqual(clone(c.state.modeEffects), first);
  for (let i = 3; i <= 8; i++) {
    const next = clone(opening); next.revision = i; next.serverTime = baseTime + i * 100;
    next.chat = [{ id: `mode-chat-${i}`, playerId: 'p2', kind: 'text', text: '你好', at: new Date(baseTime).toISOString() }];
    next.players[0].pendingBuyIn = i * 100;
    c.normalizeState(next); c.render();
    assert.deepEqual(clone(c.state.modeEffects), first);
  }
  assert.equal(c.calls.length, 0, 'transitions submit no table commands or extra waits');
  const expired = clone(opening); expired.revision = 9; expired.serverTime = baseTime + 1100;
  c.normalizeState(expired); assert.equal(c.state.modeEffects.length, 0);
  expired.revision++; expired.serverTime++; c.normalizeState(expired); assert.equal(c.state.modeEffects.length, 0);
});

test('actual client switching tables discards old mode effects and treats the other table as a silent baseline', () => {
  const { c, opening } = modeClientFixture(); c.normalizeState(opening);
  assert.equal(c.state.modeEffects.length, 2);
  const other = clone(opening); other.code = '654321'; other.revision = 1;
  c.normalizeState(other); assert.equal(c.state.modeEffects.length, 0);
  c.normalizeState(opening); assert.equal(c.state.modeEffects.length, 0);
  assert.equal(c.calls.length, 0);
});

test('actual stopStream clears mounted mode effects and reconnect cannot replay them', () => {
  const { c, opening } = modeClientFixture(); c.normalizeState(opening);
  const mounts = [], aborts = [];
  Object.assign(c.context, { clearTimeout, turnCountdown: { reset() {} },
    mountTableModeEffects: (...args) => mounts.push(args),
  });
  vm.runInContext(section('function stopStream(', 'async function connectStream('), c.context);
  c.state.modeMounted = true; c.state.stream = { abort() { aborts.push(true); } };
  c.context.stopStream();
  assert.equal(c.state.modeEffects.length, 0); assert.equal(c.state.modeMounted, false);
  assert.equal(mounts.length, 1); assert.equal(mounts[0][2].enabled, false);
  assert.equal(aborts.length, 1); assert.equal(c.state.feedbackResync, true);
  c.state.connected = true; c.normalizeState(clone(opening));
  assert.equal(c.state.modeEffects.length, 0); c.render(); assert.equal(c.state.modeEffects.length, 0);
  assert.equal(c.calls.length, 0);
});

test('actual client hidden snapshots and restoration do not replay a squid settlement', () => {
  const { c, baseTime, opening } = modeClientFixture(); c.normalizeState(opening);
  c.context.document.visibilityState = 'hidden';
  const finished = clone(opening); finished.revision = 3; finished.serverTime = baseTime + 100;
  finished.status = 'waiting'; finished.hand.status = 'complete';
  Object.assign(finished.mini.squid, { active: false, lastResult: {
    round: 1, roundSettlementId: 'synthetic-mode-settlement', settledAt: new Date(baseTime + 100).toISOString(),
    handId: finished.hand.id, mode: 'unlimited', amount: 120, unit: 20, counts: { p0: 6 },
    changes: { p0: 120 }, tokensAwarded: 6, winnerIds: ['p0'], loserIds: ['p1'],
  } });
  const before = JSON.stringify(finished); c.normalizeState(finished);
  assert.equal(c.state.modeEffects.length, 0); assert.equal(JSON.stringify(finished), before);
  c.context.document.visibilityState = 'visible'; c.normalizeState(clone(finished));
  assert.equal(c.state.modeEffects.length, 0); assert.equal(c.calls.length, 0);
});
