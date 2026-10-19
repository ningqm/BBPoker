import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}

// A small tree adapter exercises the real notification function without an HTML
// parser: innerHTML is deliberately forbidden so untrusted error strings cannot
// accidentally be turned into markup by an implementation change.
class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.dataset={};this.attributes={};this.events=new Map();this.className='';this.textContent='';this.scrolls=[];}
  get classList(){return {contains:name=>this.className.split(/\s+/).includes(name),toggle:(name,on)=>{const classes=new Set(this.className.split(/\s+/).filter(Boolean));if(on)classes.add(name);else classes.delete(name);this.className=[...classes].join(' ');}};}
  set innerHTML(_value){throw new Error('Notification must render text without parsing HTML');}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  removeAttribute(name){delete this.attributes[name];}
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  prepend(node){node.remove();node.parentNode=this;this.children.unshift(node);}
  remove(){if(!this.parentNode)return;const parent=this.parentNode;parent.children=parent.children.filter(node=>node!==this);this.parentNode=null;}
  querySelectorAll(selector){const matches=node=>selector==='.toast'?node.classList.contains('toast'):selector==='.modal-body'?node.classList.contains('modal-body'):selector==='.admin-account-fields'?node.classList.contains('admin-account-fields'):false;return this.children.flatMap(node=>[...(matches(node)?[node]:[]),...node.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  addEventListener(name,callback){this.events.set(name,callback);}
  scrollIntoView(options){this.scrolls.push(options);}
}

function harness(){
  const body=new Element('body'),globalHost=new Element(),dialog=new Element('dialog'),modalBody=new Element(),timers=new Map(),state={clock:createRoomClock(),modal:null};
  modalBody.className='modal-body';dialog.append(modalBody);dialog.open=false;body.append(globalHost,dialog);
  let sequence=0,clock=0;
  const document={createElement:tag=>new Element(tag),querySelectorAll:selector=>body.querySelectorAll(selector)};
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,state,dialog,document,$:selector=>selector==='#toasts'?globalHost:null,
    setTimeout(callback,delay){const id=++sequence;timers.set(id,{callback,at:clock+delay,canceled:false});return id;},
    clearTimeout(id){const timer=timers.get(id);if(timer)timer.canceled=true;},
  });
  vm.runInContext(section('function toast(','async function api(')+'\nglobalThis.toast=toast;',context);
  return {state,dialog,modalBody,globalHost,body,timers,toast:context.toast,context,
    open(owner={kind:'buyin'}){state.modal=owner;dialog.open=true;return owner;},
    advance(ms){clock+=ms;for(const timer of timers.values())if(!timer.canceled&&timer.at<=clock){timer.canceled=true;timer.callback();}},
    notices:()=>body.querySelectorAll('.toast'),
  };
}

test('notifications replace rather than stack and old timer callbacks cannot erase the replacement',()=>{
  const h=harness();h.toast('第一条');const first=h.notices()[0],oldTimer=h.timers.get(first.noticeTimer);
  h.advance(100);h.toast('第二条',true);const next=h.notices()[0];
  assert.equal(h.notices().length,1);assert.notEqual(first,next);assert.equal(next.children[0].textContent,'第二条');assert.equal(oldTimer.canceled,true);
  oldTimer.callback();assert.equal(h.notices().length,1);assert.equal(h.notices()[0],next);
});

test('duplicate notices keep their original expiry instead of living forever under repeated updates',()=>{
  const h=harness();h.toast('网络已断开',true);const first=h.notices()[0],timerId=first.noticeTimer;
  h.advance(6000);h.toast('网络已断开',true);
  assert.equal(h.notices()[0],first);assert.equal(first.noticeTimer,timerId);assert.equal(h.timers.size,1);
  h.advance(500);assert.equal(h.notices().length,0);
});

test('changing severity is a new notice even with identical words',()=>{
  const h=harness();h.toast('正在同步');const first=h.notices()[0];h.toast('正在同步',true);
  assert.equal(h.notices().length,1);assert.notEqual(h.notices()[0],first);assert.equal(h.notices()[0].classList.contains('error'),true);assert.equal(h.notices()[0].getAttribute('role'),'alert');
});

test('notice dismissal is a labelled ordinary button and cancels its own expiry',()=>{
  const h=harness();h.toast('已复制');const notice=h.notices()[0],button=notice.children[1],timer=h.timers.get(notice.noticeTimer);
  assert.equal(notice.getAttribute('role'),'status');assert.equal(button.tagName,'BUTTON');assert.equal(button.type,'button');assert.equal(button.getAttribute('aria-label'),'关闭提示');
  button.events.get('click')();assert.equal(h.notices().length,0);assert.equal(timer.canceled,true);
  h.toast('已复制');assert.equal(h.notices().length,1,'a deliberate retry may report the same result after dismissal');
});

test('current-dialog failures render inside the top layer before the unchanged form',()=>{
  const h=harness(),owner=h.open(),form=new Element('form'),input=new Element('input');input.value='250';form.append(input);h.modalBody.append(form);
  h.toast('超过本场上限',true,{modal:owner});const notice=h.notices()[0];
  assert.equal(h.globalHost.children.length,0);assert.equal(h.modalBody.children[0],notice);assert.equal(h.modalBody.children[1],form);assert.equal(form.children[0],input);assert.equal(input.value,'250');assert.equal(notice.scrolls.length,1);h.advance(15000);assert.equal(h.notices()[0],notice,'form errors remain readable until dismissed or replaced');
});

test('late errors from a prior dialog never get inserted into the replacement dialog',()=>{
  const h=harness(),old=h.open({kind:'buyin'}),newOwner={kind:'player-stats'};h.state.modal=newOwner;
  h.toast('旧补码请求失败',true,{modal:old});
  assert.equal(h.modalBody.children.length,0);assert.equal(h.state.modal,newOwner);
  assert.equal(h.globalHost.querySelector('.toast')?.children[0].textContent,'旧补码请求失败');
});

test('an explicitly global failure does not attach to whatever modal happens to be open',()=>{
  const h=harness();h.open();h.toast('需要重新连接',true,{modal:null});
  assert.equal(h.modalBody.children.length,0);assert.equal(h.globalHost.children.length,1);
});

test('success confirmations do not become form errors and survive later dialog replacement',()=>{
  const h=harness();h.open();h.toast('已保存');
  assert.equal(h.modalBody.children.length,0);assert.equal(h.globalHost.children.length,1);
  h.state.modal={kind:'room-menu'};h.modalBody.children=[];
  assert.equal(h.notices()[0].children[0].textContent,'已保存');assert.equal(h.notices()[0].getAttribute('role'),'status');
});

test('transitioning from a page notice to a dialog notice retains just the current message',()=>{
  const h=harness();h.toast('已复制');const first=h.notices()[0];h.open();h.toast('请输入有效金额',true);
  assert.equal(h.globalHost.children.length,0);assert.equal(h.notices().length,1);assert.equal(h.notices()[0].parentNode,h.modalBody);assert.equal(h.timers.get(first.noticeTimer).canceled,true);
});

test('server error text is never interpreted as markup or executable attributes',()=>{
  const h=harness(),message='<img src=x onerror="alert(1)"><script>steal()</script>&';h.toast(message,true);
  const label=h.notices()[0].children[0];assert.equal(label.tagName,'SPAN');assert.equal(label.textContent,message);assert.equal(label.children.length,0);assert.deepEqual(label.attributes,{});
});

test('failed modal loading reports the error after closing so the notice is not immediately erased',async()=>{
  for(const kind of ['fairness','replay','verify']){
    const h=harness();h.state.replayRequest=0;
    Object.assign(h.context,{
      requests:{capture:()=>({check(){},valid:()=>true})},api:async()=>{throw new Error('模拟读取失败');},crypto:{},receipts:{},
      openModal(_title,_body,modalKind){h.open({kind:modalKind});},
      closeModal(){h.state.modal=null;h.dialog.open=false;for(const child of [...h.modalBody.children])child.remove();},
    });
    const code=kind==='fairness'?section('async function fairnessModal(){','async function verifyHand('):kind==='replay'?section('async function replayModal(','function overviewBackButton('):section('async function verifyHand(','function eventText(');
    const fn=kind==='fairness'?'fairnessModal':kind==='replay'?'replayModal':'verifyHand';
    vm.runInContext(code+`\nglobalThis.load=${fn};`,h.context);
    if(kind==='replay')await h.context.load('synthetic-hand','synthetic-room');else if(kind==='verify')await h.context.load({id:'synthetic-hand',proofs:[]});else await h.context.load();
    assert.equal(h.dialog.open,false,kind);assert.equal(h.notices().length,1,kind);assert.equal(h.notices()[0].parentNode,h.globalHost,kind);assert.equal(h.notices()[0].getAttribute('role'),'alert',kind);
  }
});

test('turn urgency removes stale browser tooltips while keeping accessible timeout guidance',()=>{
  const button=new Element('button');button.setAttribute('title','旧弹出提示');button.setAttribute('aria-label','弃牌');
  const state={clock:createRoomClock(),room:{settings:{},hand:{status:'playing'},actions:{canCheck:false}},page:'room',connected:true,feedbackResync:false,busy:false,timeOffset:0};
  let urgent=true;
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,state,Date,document:{visibilityState:'visible',querySelectorAll:selector=>selector==='[data-timeout-action]'?[button]:[]},
    syncRebuyPrompt(){},actorClock:()=>null,turnCountdown:{update:()=>({urgent,sound:null})},tableSounds:{play(){throw new Error('Unexpected audio');}},
  });
  vm.runInContext(section('function tick(){','setInterval(tick,400);')+'\nglobalThis.tick=tick;',context);
  context.tick();assert.equal(button.getAttribute('title'),null);assert.equal(button.getAttribute('aria-label'),'弃牌');assert.equal(button.getAttribute('aria-description'),'超时将自动弃牌');assert.equal(button.classList.contains('timeout-warning'),true);
  state.room.actions.canCheck=true;context.tick();assert.equal(button.getAttribute('aria-description'),'超时将自动过牌');
  urgent=false;context.tick();assert.equal(button.getAttribute('aria-description'),'');assert.equal(button.classList.contains('timeout-warning'),false);assert.equal(button.getAttribute('title'),null);
});

test('account errors and credential copy feedback stay in scrollable fields and leave the fixed footer in place',()=>{
  const h=harness(),fields=new Element(),footer=new Element();fields.className='admin-account-fields';h.modalBody.append(fields,footer);
  h.open({kind:'admin-account-create'});h.toast('结果尚未确认',true);
  assert.equal(h.notices()[0].parentNode,fields);assert.equal(h.modalBody.children.at(-1),footer);assert.equal(h.globalHost.children.length,0);
  h.open({kind:'admin-account-credentials'});h.toast('账号和密码已复制');
  assert.equal(h.notices()[0].parentNode,fields);assert.equal(h.notices()[0].getAttribute('role'),'status');assert.equal(h.modalBody.children.at(-1),footer);
});
