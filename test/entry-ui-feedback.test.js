import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequestGuard} from '../public/platform.js';
import {createRoomClock,isOlderRoomSnapshot} from '../public/room-clock.js';
import * as lifecycle from '../public/lifecycle.js';
import * as money from '../public/money.js';
import * as controls from '../public/table-controls.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(a,b){const start=source.indexOf(a),end=source.indexOf(b,start+a.length);assert.ok(start>=0&&end>start);return source.slice(start,end);}
function harness(){
  const requests=createRequestGuard(),listeners=new Map(),calls=[],toasts=[],streams=[];
  const state={clock:createRoomClock(),user:{id:'me'},room:{code:'123456',revision:1,serverTime:Date.now(),meId:'me',status:'playing',
    settings:{bigBlind:10,maxPlayers:9},players:[{id:'me',seat:null,stack:0,totalBuyIn:0}],hand:{id:'entry-ui-hand',status:'playing',actionSeq:3},actions:{}},
    page:'room',modal:{kind:'buyin'},busy:false,connected:true,feedbackResync:false};
  const submit={disabled:false,isConnected:true},form={id:'buyin-form',dataset:{room:'123456',seat:'3'},values:{amountBB:'200',entryMode:'post'},querySelector:s=>s==='[type=submit]'?submit:null};
  let pending,sequence=0;
  const context=vm.createContext({...money,...controls,lifecycle,requests,state,Date,isOlderRoomSnapshot,
    document:{visibilityState:'visible',addEventListener:(type,callback)=>listeners.set(type,callback)},navigator:{onLine:true},
    FormData:class{constructor(form){this.form=form;}get(name){return this.form.values[name]??null;}},
    dialog:{querySelector:s=>s==='#buyin-form'&&state.modal?.kind==='buyin'?form:null},
    commandId:()=>`entry-ui-${++sequence}`,api:(path,body)=>{calls.push({path,body});return new Promise((resolve,reject)=>{pending={resolve,reject};});},
    render(){},captureRoomChanges(){},rememberCommitment:()=>false,toast:message=>toasts.push(message),
    openModal(title,body,kind){state.modal={title,body,kind};},closeModal(){state.modal=null;submit.isConnected=false;},connectStream(code){streams.push(code);state.connected=false;state.feedbackResync=true;},
  });
  vm.runInContext([section('const esc=','const profitClass='),section('const btn=','const avatar='),section('function entryBlindModal(','function participationNotice('),section('function normalizeState(','// A delayed room response'),section('async function command(','function stopStream('),
    section('function refreshBuyinStatus(','function entryModeFields('),section("document.addEventListener('submit'",'function resetPrivateView('),
    'globalThis.applyRoom=normalizeState;globalThis.entryOpen=entryBlindModal;globalThis.entryConfirm=confirmEntryBlind;'].join('\n'),context);
  const seated=()=>({...structuredClone(state.room),revision:2,players:[{id:'me',seat:3,stack:2000,totalBuyIn:2000,inHand:false,waitingFor:'hand',
    entryBlind:{required:true,mode:'post',live:10,dead:0,waitingFor:'button',reason:'new',estimated:true}}]});
  return {state,form,submit,calls,toasts,streams,requests,apply:next=>context.applyRoom(next),entryOpen:()=>context.entryOpen(),entryConfirm:mode=>context.entryConfirm(mode),seated,
    send:()=>listeners.get('submit')({target:form,preventDefault(){}}),resolve:next=>pending.resolve({room:next}),reject:error=>pending.reject(error)};
}

for(const sseFirst of [false,true])test(`successful mid-hand sit acknowledges the seat even when ${sseFirst?'SSE':'the HTTP response'} closes the old purchase dialog`,async()=>{
  const h=harness(),job=h.send();assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.type,'sit');
  const next=h.seated();if(sseFirst)h.apply(next);
  h.resolve(next);await job;
  assert.equal(h.state.room.players[0].seat,3);assert.equal(h.state.modal,null);
  assert.ok(h.toasts.some(message=>/已入座/.test(message)),'successful seating must be acknowledged independently of modal ownership');
  assert.equal(h.state.busy,false);assert.equal(h.calls.length,1);
});

test('uncertain seating response closes its own form, resynchronizes and never resends a purchase',async()=>{
  const h=harness(),job=h.send();
  h.reject(Object.assign(new Error('操作结果尚未确认，请勿重复提交'),{resync:true}));await job;
  assert.equal(h.state.modal,null);assert.equal(h.calls.length,1);assert.deepEqual(h.streams,['123456']);
  assert.equal(h.state.connected,false);assert.equal(h.state.feedbackResync,true);
  assert.ok(h.toasts.some(message=>/尚未确认/.test(message)));assert.ok(h.toasts.every(message=>!/已入座/.test(message)));
});

test('a late failed purchase cannot close a newer modal or issue a second purchase',async()=>{
  const h=harness(),job=h.send(),newModal={kind:'profile'};h.state.modal=newModal;
  h.reject(Object.assign(new Error('操作结果尚未确认，请勿重复提交'),{resync:true}));await job;
  assert.equal(h.state.modal,newModal);assert.equal(h.calls.length,1);assert.deepEqual(h.streams,['123456']);
});


for(const sseFirst of [false,true])test(`saving an entry choice closes its dialog when ${sseFirst?'SSE':'the HTTP response'} changes that same quote`,async()=>{
  const h=harness(),before=h.seated();before.players[0].entryBlind.mode='wait';before.players[0].entryBlind.waitingFor='bigBlind';h.apply(before);
  h.entryOpen();const job=h.entryConfirm('post'),next=h.seated();next.revision=3;
  if(sseFirst)h.apply(next);
  h.resolve(next);await job;
  assert.equal(h.state.room.players[0].entryBlind.mode,'post');
  assert.equal(h.state.modal,null,'response-driven refresh must not steal the submitting dialog ownership');
  assert.ok(h.toasts.some(message=>/已保存：补盲/.test(message)));
});

test('uncertain entry response retains the latest confirmed choice even if SSE arrived during submission',async()=>{
  const h=harness(),before=h.seated();before.players[0].entryBlind.mode='wait';before.players[0].entryBlind.waitingFor='bigBlind';h.apply(before);h.entryOpen();
  const job=h.entryConfirm('post'),next=h.seated();next.revision=3;h.apply(next);
  h.reject(Object.assign(new Error('操作结果尚未确认，请勿重复提交'),{resync:true}));await job;
  h.apply(next); // The resync legitimately repeats the latest known snapshot.
  assert.equal(h.calls.length,1,'an uncertain mode change is never resent automatically');
  assert.equal(h.state.room.players[0].entryBlind.mode,'post');
  assert.ok(!h.state.modal||/✓ 已选 · 补盲/.test(h.state.modal.body),'a confirmed preference must not be shown as its previous value after resync');
});

test('entry command completion never closes or rewrites a later dialog',async()=>{
  const h=harness(),before=h.seated();before.players[0].entryBlind.mode='wait';before.players[0].entryBlind.waitingFor='bigBlind';h.apply(before);h.entryOpen();
  const job=h.entryConfirm('post'),newModal={kind:'profile'};h.state.modal=newModal;
  const next=h.seated();next.revision=3;h.resolve(next);await job;
  assert.equal(h.state.modal,newModal);
});

test('entry dialog follows another device choice and closes once the player is actually dealt in',()=>{
  const h=harness(),before=h.seated();before.players[0].entryBlind.mode='wait';before.players[0].entryBlind.waitingFor='bigBlind';h.apply(before);h.entryOpen();
  const initial=h.state.modal,unchanged=structuredClone(before);unchanged.revision=3;unchanged.hand.actionSeq++;h.apply(unchanged);
  assert.equal(h.state.modal,initial,'routine action updates must not replace a pressed dialog control');
  const changed=h.seated();changed.revision=4;h.apply(changed);
  assert.match(h.state.modal.body,/✓ 已选 · 补盲/);assert.doesNotMatch(h.state.modal.body,/✓ 已选 · 等大盲/);
  const dealt=structuredClone(changed);dealt.revision=5;dealt.hand.id='next-hand';dealt.players[0].inHand=true;dealt.players[0].entryBlind.required=false;h.apply(dealt);
  assert.equal(h.state.modal,null);
});
