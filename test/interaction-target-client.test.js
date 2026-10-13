import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {THROWABLES} from '../public/table-fun.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function harness(){
  const state={room:{code:'123456',meId:'me',status:'playing',players:[{id:'me',name:'我',seat:0},{id:'a',name:'朋友甲',seat:1},{id:'b',name:'朋友乙',seat:2}]},connected:true,feedbackResync:false,chatBusy:false,fun:true,funTarget:'',throwUntil:0};
  const modals=[],sent=[],toasts=[];
  const dialog={buttons:[],hint:{textContent:''},querySelectorAll(selector){assert.equal(selector,'[data-action="throw"]');return this.buttons;},querySelector(selector){assert.equal(selector,'[data-interaction-hint]');return this.hint;}};
  const context=vm.createContext({state,THROWABLES,Date,dialog,avatar:()=>'<span class="avatar"></span>',avatarCache:{hydrate(){}},
    openModal(title,html,kind){state.modal={title,kind};modals.push({title,html,kind});dialog.buttons=throwButtons(html).map(button=>({dataset:{target:button.match(/data-target="([^"]*)"/)[1],room:button.match(/data-room="([^"]*)"/)[1]},disabled:/\sdisabled/.test(button)}));},
    closeModal(){state.modal=null;},toast(message){toasts.push(message);},async sendChat(...args){sent.push(args);}});
  vm.runInContext([section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('function interactionModal(','function formatAction('),'globalThis.client={interactionModal,sendThrow,syncInteractionPanel};'].join('\n'),context);
  return {...context.client,state,modals,sent,toasts,dialog};
}
const throwButtons=html=>html.match(/<button\b[^>]*data-action="throw"[^>]*>/g)||[];

test('clicking a player opens a compact panel addressed to that exact player',()=>{
  const c=harness();c.state.funTarget='a';c.interactionModal('b');
  const html=c.modals.at(-1).html;
  assert.equal(c.state.funTarget,'b');assert.match(html,/送给 <strong>朋友乙<\/strong>/);
  assert.doesNotMatch(html,/interaction-targets|data-action="interact-target"/);
  assert.match(html,/data-action="interact"[^>]*>换个人</);
  assert.equal(throwButtons(html).length,THROWABLES.length);
  for(const button of throwButtons(html)){assert.match(button,/data-target="b"/);assert.match(button,/data-room="123456"/);assert.doesNotMatch(button,/\sdisabled/);}
});

test('explicit missing, departed, or self targets never fall back to a different friend',()=>{
  for(const id of ['missing','me','a']){
    const c=harness();c.state.funTarget='b';if(id==='a')c.state.room.players.find(p=>p.id==='a').seat=null;
    c.interactionModal(id);
    assert.equal(c.modals.length,0);assert.equal(c.state.funTarget,'b');assert.equal(c.sent.length,0);assert.equal(c.toasts.length,1);
  }
});

test('the toolbar remains an explicit target picker and keeps the previous valid selection',()=>{
  const c=harness();c.state.funTarget='b';c.interactionModal();const html=c.modals.at(-1).html;
  assert.match(html,/interaction-targets/);assert.equal((html.match(/data-action="interact-target"/g)||[]).length,2);
  assert.match(html,/data-player="b" aria-pressed="true"/);assert.doesNotMatch(html,/data-player="me"/);
});

test('a chosen interaction keeps its recipient despite later target preference changes',async()=>{
  const c=harness();c.interactionModal('b');const button=throwButtons(c.modals.at(-1).html)[0];
  const target=button.match(/data-target="([^"]+)"/)[1],code=button.match(/data-room="([^"]+)"/)[1],emote=button.match(/data-emote="([^"]+)"/)[1];
  c.state.funTarget='a';await c.sendThrow(emote,target,code);
  assert.deepEqual(c.sent,[['throw','water','b']]);assert.equal(c.state.modal,null);
});

test('a new occupant of the same seat cannot receive an interaction selected for the departed player',async()=>{
  const c=harness();c.interactionModal('b');
  c.state.room.players=c.state.room.players.filter(p=>p.id!=='b');c.state.room.players.push({id:'replacement',name:'新朋友',seat:2});c.state.funTarget='replacement';
  await c.sendThrow('water','b','123456');
  assert.equal(c.sent.length,0);assert.equal(c.state.modal,null);assert.match(c.toasts.at(-1),/离座/);
});

test('the selected player may change seats without changing recipient identity',async()=>{
  const c=harness();c.state.room.players.find(p=>p.id==='b').seat=7;
  await c.sendThrow('pat','b','123456');assert.deepEqual(c.sent,[['throw','pat','b']]);
});

test('stale-room, self, observer and departed targets cannot send an interaction',async()=>{
  for(const kind of ['room','self','observer','departed']){
    const c=harness();let target='b',code='123456';
    if(kind==='room')code='654321';if(kind==='self')target='me';
    if(kind==='observer')c.state.room.players[0].seat=null;
    if(kind==='departed')c.state.room.players.find(p=>p.id==='b').seat=null;
    await c.sendThrow('water',target,code);assert.equal(c.sent.length,0,kind);
  }
});

test('closed, disconnected, synchronizing and observer views disable all send buttons and recheck before sending',async()=>{
  for(const kind of ['closed','disconnected','synchronizing','observer']){
    const c=harness();
    if(kind==='closed')c.state.room.status='closed';if(kind==='disconnected')c.state.connected=false;if(kind==='synchronizing')c.state.feedbackResync=true;if(kind==='observer')c.state.room.players[0].seat=null;
    c.interactionModal('b');const buttons=throwButtons(c.modals.at(-1).html);
    assert.equal(buttons.length,THROWABLES.length);assert.ok(buttons.every(b=>/\sdisabled/.test(b)),kind);
    await c.sendThrow('tomato','b','123456');assert.equal(c.sent.length,0,kind);
  }
});

test('unsupported emotes, pending chat and cooldown do not issue duplicate or invalid interactions',async()=>{
  const c=harness();await c.sendThrow('script','b','123456');assert.equal(c.sent.length,0);
  c.state.chatBusy=true;await c.sendThrow('water','b','123456');assert.equal(c.sent.length,0);
  c.state.chatBusy=false;c.state.throwUntil=Date.now()+5000;await c.sendThrow('water','b','123456');assert.equal(c.sent.length,0);assert.match(c.toasts.at(-1),/3 秒/);
});

test('recipient text and attributes are escaped in direct and target-picker views',()=>{
  const c=harness(),p=c.state.room.players[2];p.id='b" data-injected="yes';p.name='乙"><svg onload="bad">&';c.state.room.code='123" onclick="bad';
  for(const direct of [true,false]){
    c.state.funTarget=p.id;c.interactionModal(direct?p.id:undefined);const html=c.modals.at(-1).html;
    assert.doesNotMatch(html,/<svg|data-injected="yes|onclick="bad|onload="bad/);
    assert.match(html,/乙&quot;&gt;&lt;svg onload=&quot;bad&quot;&gt;&amp;/);
    assert.match(html,/data-target="b&quot; data-injected=&quot;yes"/);
    assert.match(html,/data-room="123&quot; onclick=&quot;bad"/);
    assert.match(html,/aria-label="泼水给 乙&quot;&gt;&lt;svg/);
  }
});

test('an empty opponent list has no actionable recipient or enabled send button',()=>{
  const c=harness();c.state.room.players=c.state.room.players.slice(0,1);c.interactionModal();const html=c.modals.at(-1).html;
  assert.equal(c.state.funTarget,'');assert.match(html,/朋友入座后就可以互动/);assert.ok(throwButtons(html).every(b=>/\sdisabled/.test(b)));
});

test('an open interaction panel disables during disconnect and synchronization then re-enables without reopening or retargeting',()=>{
  const c=harness();c.interactionModal('b');const originalButtons=c.dialog.buttons;
  c.state.connected=false;c.syncInteractionPanel();
  assert.ok(c.dialog.buttons.every(b=>b.disabled));assert.match(c.dialog.hint.textContent,/恢复连接后再互动/);
  c.state.connected=true;c.state.feedbackResync=true;c.syncInteractionPanel();assert.ok(c.dialog.buttons.every(b=>b.disabled));
  c.state.feedbackResync=false;c.state.funTarget='a';c.syncInteractionPanel();
  assert.ok(c.dialog.buttons.every(b=>!b.disabled));assert.match(c.dialog.hint.textContent,/每 3 秒/);
  assert.equal(c.modals.length,1);assert.equal(c.dialog.buttons,originalButtons);assert.ok(c.dialog.buttons.every(b=>b.dataset.target==='b'&&b.dataset.room==='123456'));
});

test('connection recovery cannot enable a departed recipient or redirect an open panel to their new seat occupant',()=>{
  const c=harness();c.interactionModal('b');c.state.connected=false;c.syncInteractionPanel();
  c.state.room.players=c.state.room.players.filter(p=>p.id!=='b');c.state.room.players.push({id:'replacement',name:'新朋友',seat:2});c.state.funTarget='replacement';
  c.state.connected=true;c.state.feedbackResync=false;c.syncInteractionPanel();
  assert.ok(c.dialog.buttons.every(b=>b.disabled));assert.match(c.dialog.hint.textContent,/这位朋友已离座/);
  assert.ok(c.dialog.buttons.every(b=>b.dataset.target==='b'));assert.equal(c.modals.length,1);assert.equal(c.sent.length,0);
});
