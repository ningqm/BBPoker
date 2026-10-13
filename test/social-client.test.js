import {THROWABLES,createTableFunTracker} from '../public/table-fun.js';
import * as statsUI from '../public/stats.js';
import * as records from '../public/records.js';
import {createTableFeedback} from '../public/table-feedback.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequestGuard } from '../public/platform.js';
import { createReplayPlayback } from '../public/replay.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first,`Missing ${start}`);return source.slice(first,last);}
function harness(){
  const calls=[],toasts=[],draws=[],audioFeedback=[];let client,counter=0;
  const context=vm.createContext({THROWABLES,funTracker:createTableFunTracker(),statsUI,records,feedback:createTableFeedback(),tableSounds:{play(){},playFeedback(value){audioFeedback.push(value);},suspend(){}},createRequestGuard,createReplayPlayback,URLSearchParams,Date,Set,Map,profileEditor:null,document:{visibilityState:'visible',querySelector:()=>null},
    api(path,body){return new Promise((resolve,reject)=>calls.push({path,body,resolve,reject}));},
    render(){draws.push(client?.state.chatDraft);},renderReplay(){draws.push(client.state.replay.hand.id);},playReplay(){},tick(){},
    toast(...args){toasts.push(args);},commandId:()=>`message-${++counter}`,
    openModal(title,body,kind){client.state.modal={kind,title};},
    dialog:{open:false,innerHTML:''},clearInterval(){},
    num:n=>String(n||0),signed:n=>`${n>0?'+':''}${n||0}`,profitClass:()=>'',fmtDate:String,
    btn:(label,action,cls='',attrs='')=>`<button data-action="${action}" class="${cls}" ${attrs}>${label}</button>`,
    cards:()=>'',card:()=>'',
  });
  vm.runInContext([
    'const requests=createRequestGuard();',section('const state=','const num='),
    section('function captureRoomChanges(','function normalizeState('),
    section('const emotes=','const layouts='),
    section('async function replayModal(','function renderReplay('),
    section('function closeModal(','dialog.addEventListener('),
    'globalThis.client={state,requests,captureRoomChanges,sendChat,chatPanel,loadLibrary,handLibrary,favoriteHand,replayModal,closeModal};',
  ].join('\n'),context);
  client=context.client;client.state.user={id:'me',name:'Me'};client.state.room={code:'123456',meId:'me',chat:[]};client.state.page='room';
  return {...client,calls,toasts,draws,audioFeedback};
}
function deferredRoom(chat=[]){return {code:'123456',meId:'me',chat,hand:{id:'hand1',number:1,status:'playing',board:[],actingId:'me',actionSeq:0,log:[]}};}

test('chat fails and retries the same message id; a different draft gets a fresh id',async()=>{
  const c=harness();c.state.chatDraft='你好';
  const first=c.sendChat('text','你好');c.calls[0].reject(new Error('lost response'));await first;
  assert.equal(c.state.chatDraft,'你好');assert.equal(c.state.busy,false);
  const second=c.sendChat('text','你好');assert.equal(c.calls[1].body.messageId,c.calls[0].body.messageId);
  c.calls[1].resolve({message:{id:'server-message'}});await second;
  assert.equal(c.state.chatDraft,'');assert.equal(c.state.chatPending,null);
  c.state.chatDraft='下一手';const third=c.sendChat('text','下一手');assert.notEqual(c.calls[2].body.messageId,c.calls[1].body.messageId);
  c.calls[2].resolve({message:{id:'other'}});await third;
});

test('chat never consumes the gameplay busy state and does not erase edits typed during sending',async()=>{
  const c=harness();c.state.busy=true;c.state.chatDraft='第一句';const pending=c.sendChat('text','第一句');
  assert.equal(c.calls.length,1);assert.equal(c.state.busy,true);assert.equal(c.state.chatBusy,true);
  c.state.chatDraft='正在写第二句';c.calls[0].resolve({message:{id:'sent'}});await pending;
  assert.equal(c.state.chatDraft,'正在写第二句');assert.equal(c.state.busy,true);assert.equal(c.state.chatBusy,false);
});

test('late chat responses cannot clear a new identity draft or busy state',async()=>{
  const c=harness();c.state.chatDraft='old';const pending=c.sendChat('text','old');
  c.requests.invalidate();c.state.chatDraft='new identity';c.state.chatBusy=true;
  c.calls[0].resolve({message:{id:'old'}});await pending;
  assert.equal(c.state.chatDraft,'new identity');assert.equal(c.state.chatBusy,true);
});

test('initial and replayed chat state cannot create unread messages; only fresh messages do',()=>{
  const c=harness(),old={id:'one',playerId:'friend',name:'朋友',kind:'text',text:'hello',at:new Date().toISOString()};
  const first=deferredRoom([old]);c.captureRoomChanges(null,first);assert.equal(c.state.chatUnread,0);assert.equal(Object.keys(c.state.reactions).length,0);
  c.captureRoomChanges(first,deferredRoom([old]));assert.equal(c.state.chatUnread,0);
  const fresh={...old,id:'two'};c.captureRoomChanges(first,deferredRoom([old,fresh]));assert.equal(c.state.chatUnread,1);assert.equal(c.state.reactions.friend.id,'two');
  c.state.chatOpen=true;c.captureRoomChanges(first,deferredRoom([old,fresh]));assert.equal(c.state.chatUnread,1,'an open chat receives no new unread count');
});

test('live turn and card effects occur only for changed game state, not a chat SSE refresh',()=>{
  const c=harness(),first=deferredRoom();c.captureRoomChanges(null,first);assert.equal(c.state.motion,null);
  const next=deferredRoom();next.hand.board=['As','Kd','2c'];next.hand.actingId='friend';next.hand.actionSeq=1;next.hand.log=[{seq:1,type:'check',playerId:'me'}];c.captureRoomChanges(first,next);
  assert.equal(c.state.motion.newBoard,true);assert.equal(c.state.motion.actor,'friend');assert.equal(c.state.motion.board,0);
  const started=c.state.motion.at;c.captureRoomChanges(next,{...next,chat:[{id:'x'}]});assert.equal(c.state.motion.newBoard,true,'the same effect retains its original timestamp until CSS finishes');assert.equal(c.state.motion.at,started);assert.equal(c.state.motion.win,false);
});

test('chat body, sender and draft are escaped and only known emotes are rendered',()=>{
  const c=harness();c.state.chatOpen=true;c.state.chatDraft='\"><script>alert(1)</script>';
  const html=c.chatPanel({code:'123456',meId:'me',status:'waiting',chat:[{id:'1',playerId:'friend',name:'<img src=x>',kind:'text',text:'<script>alert(2)</script>',at:new Date().toISOString()}]});
  assert.doesNotMatch(html,/<script>|<img src=x>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/maxlength="160"/);
  assert.equal((html.match(/data-action="send-emote"/g)||[]).length,6);
});

test('closing replay A and opening replay B prevents slow A from replacing B',async()=>{
  const c=harness(),a=c.replayModal('A','123456');c.closeModal();const b=c.replayModal('B','123456');
  c.calls[0].resolve({hand:{id:'A'}});await a;assert.equal(c.state.replay,undefined);
  c.calls[1].resolve({hand:{id:'B'}});await b;assert.equal(c.state.replay.hand.id,'B');
});

test('late replay failure never closes the newer replay',async()=>{
  const c=harness(),a=c.replayModal('A','123456');c.closeModal();const b=c.replayModal('B','123456');
  c.calls[1].resolve({hand:{id:'B'}});await b;c.calls[0].reject(new Error('old network failure'));await a;
  assert.equal(c.state.replay.hand.id,'B');assert.equal(c.toasts.length,0);
});

test('new hand library filters win over an older pagination response',async()=>{
  const c=harness();c.state.page='hands';const old=c.loadLibrary(true);
  c.state.library.favorites=true;const fresh=c.loadLibrary(true);
  c.calls[1].resolve({hands:[{id:'favorite'}],nextCursor:null});await fresh;
  c.calls[0].resolve({hands:[{id:'old'}],nextCursor:'old-cursor'});await old;
  assert.deepEqual(JSON.parse(JSON.stringify(c.state.library.hands)),[{id:'favorite'}]);assert.equal(c.state.library.nextCursor,null);
  assert.match(c.calls[1].path,/favorites=1/);
});

test('targeted throw retries keep idempotency only for the same recipient',async()=>{
  const c=harness();const a=c.sendChat('throw','water','friend-a');
  assert.equal(c.calls[0].body.targetId,'friend-a');assert.equal(c.calls[0].body.kind,'throw');
  c.calls[0].reject(new Error('lost response'));await a;
  const retry=c.sendChat('throw','water','friend-a');assert.equal(c.calls[1].body.messageId,c.calls[0].body.messageId);
  c.calls[1].reject(new Error('lost again'));await retry;
  const b=c.sendChat('throw','water','friend-b');assert.notEqual(c.calls[2].body.messageId,c.calls[0].body.messageId);assert.equal(c.calls[2].body.targetId,'friend-b');
  c.calls[2].resolve({});await b;assert.equal(c.state.busy,false);assert.ok(c.state.throwUntil>Date.now());
});

test('throw display escapes recipient and never creates an empty speech bubble',()=>{
  const c=harness();c.state.chatOpen=true;const first=deferredRoom(),next=deferredRoom([{id:'throw-1',playerId:'friend',targetId:'me',targetName:'<img src=x>',emote:'tomato',kind:'throw',at:new Date().toISOString()}]);
  c.captureRoomChanges(null,first);c.captureRoomChanges(first,next);
  assert.equal(c.state.reactions.friend,undefined);c.state.chatOpen=true;const html=c.chatPanel(next);assert.doesNotMatch(html,/<img src=x>/);assert.match(html,/&lt;img src=x&gt;/);
});

test('rabbit reveal animates independently without changing real board feedback',()=>{
  const c=harness(),first=deferredRoom();first.hand.status='complete';first.hand.rabbit={board:[],originalCount:0,active:true};
  c.captureRoomChanges(null,first);const next=structuredClone(first);next.hand.rabbit.board=['As'];c.captureRoomChanges(first,next);
  assert.equal(c.state.boardMotion.from,0);assert.equal(c.state.boardMotion.count,1);assert.equal(c.state.motion,null);
  c.state.feedbackResync=true;const restored=structuredClone(next);restored.hand.rabbit.board=['As','Kd'];c.captureRoomChanges(next,restored);assert.equal(c.state.boardMotion,null);assert.equal(c.state.funEffects.length,0);
});

test('live action feedback forwards speech and chips once, while muting and resync consume old events silently',()=>{
  const c=harness(),first=deferredRoom();c.captureRoomChanges(null,first);
  const called=structuredClone(first);called.hand.actionSeq=1;called.hand.log=[{seq:1,type:'call',playerId:'friend',amount:10,street:'preflop'}];
  c.captureRoomChanges(first,called);
  assert.equal(c.audioFeedback.at(-1).speech,'call');assert.equal(c.audioFeedback.at(-1).chips,true);
  c.captureRoomChanges(called,called);assert.equal(c.audioFeedback.at(-1).speech,undefined);
  c.state.sound=false;const beforeMute=c.audioFeedback.length;
  const raised=structuredClone(called);raised.hand.actionSeq=2;raised.hand.log.push({seq:2,type:'raise',playerId:'me',to:30,street:'preflop'});
  c.captureRoomChanges(called,raised);assert.equal(c.audioFeedback.length,beforeMute);
  c.state.sound=true;c.captureRoomChanges(raised,raised);assert.equal(c.audioFeedback.at(-1).speech,undefined);
  const folded=structuredClone(raised);folded.hand.actionSeq=3;folded.hand.log.push({seq:3,type:'fold',playerId:'friend',street:'preflop'});
  c.state.feedbackResync=true;c.captureRoomChanges(raised,folded);assert.equal(c.audioFeedback.at(-1).speech,undefined);
});
