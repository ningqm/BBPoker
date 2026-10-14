import * as statsUI from '../public/stats.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createReplayPlayback, historyBoard, replaySnapshot, replayStreets, REPLAY_SPEEDS } from '../public/replay.js';
import * as money from '../public/money.js';
import * as lifecycle from '../public/lifecycle.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first,`Missing ${start}`);return source.slice(first,last);}
function node(){return {value:'',innerHTML:'',textContent:'',dataset:{},disabled:false,attributes:{},setAttribute(name,value){this.attributes[name]=value;},classList:{toggle(){}}};}
function harness({unit='bb',historicalBlind=10,realCards=false}={}){
  money.setDisplayUnit(unit);
  const hand={id:'replay-a',...(historicalBlind===undefined?{}:{settings:{bigBlind:historicalBlind}}),players:[{id:'me',name:'Me',startingStack:100,cards:['As','Ah']},{id:'friend',name:'Friend',startingStack:100,cards:['Ks','Kh']}],log:[
    {type:'smallBlind',playerId:'me',amount:5},{type:'bigBlind',playerId:'friend',amount:10},
    {type:'call',playerId:'me',amount:5},{type:'check',playerId:'friend'},
    {type:'street',street:'flop',board:['2c','3h','4s']},
  ]};
  const state={user:{id:'me'},room:{settings:{bigBlind:100}},page:'hands',modal:{kind:'replay'},replay:{hand,index:0,origin:'library',favorite:false},replaySpeed:1,replayRequest:0,replayPlayback:null};
  const selectors=new Map(['.replay-view','[data-replay-frame]','[data-replay-players]','[data-replay-notes]',
    '[data-action="replay-play"]','[data-action="replay-prev"]','[data-action="replay-next"]',
    '#replay-progress','#replay-position','#replay-speed','[data-replay-favorite]'].map(selector=>[selector,node()]));
  selectors.get('.replay-view').dataset.hand=hand.id;
  for(const id of ['replay-progress','replay-speed'])selectors.get('#'+id).id=id;
  const steps=replayStreets(hand).map(()=>node()),logs=hand.log.map(()=>node());
  const dialog={open:true,innerHTML:'initial',scrollTop:23,querySelector:selector=>selectors.get(selector)||null,querySelectorAll:selector=>selector==='.replay-streets button'?steps:logs,close(){this.open=false;}};
  const listeners=new Map(),windowListeners=new Map(),timers=new Map();let next=0;
  const document={visibilityState:'visible',querySelector:selector=>selectors.get(selector)||null,addEventListener(type,fn){const rows=listeners.get(type)||[];rows.push(fn);listeners.set(type,rows);}};
  const context=vm.createContext({historyRefresh:{watch(){},stop(){}},...money,lifecycle,clearTimeout,statsUI,state,dialog,document,window:{addEventListener(type,fn){windowListeners.set(type,fn);}},profileEditor:null,
    replaySnapshot,replayStreets,REPLAY_SPEEDS,createReplayPlayback,historyBoard,
    num:String,profitClass:()=>'',esc:String,fmtDate:()=>'',render(){},saveTablePreferences(){},
    cards:cards=>cards.join(','),card:card=>card||'?',btn:()=>'',openModal(){throw new Error('Existing playback must not replace the modal');},
    updateSettingConstraints(){},updateBuyinSummary(){},resumeTable(){},$:selector=>selectors.get(selector),
  });
  vm.runInContext([
    ...(realCards?[section('const card=','const feedback=')]:[]),
    section('const chips=','const profitClass='),
    section('function moneyUnitToggle(', 'function header('),
    section('function eventText(', 'async function historyModal('),
    section('function stopLobbyPolling(', 'async function loadLobby('),
    section('function renderReplay(){','async function replayLastHand('),
    section('function closeModal(){',"dialog.addEventListener('cancel'"),
    section("document.addEventListener('input'", "document.addEventListener('invalid'"),
    section("document.addEventListener('visibilitychange'", 'bindNativeLifecycle('),
    'globalThis.ui={renderReplay,closeModal,playReplay,stopReplay,changeMoneyUnit};',
  ].join('\n'),context);
  state.replayPlayback=createReplayPlayback({total:hand.log.length,onChange:frame=>{state.replay.index=frame.index;state.replaySpeed=frame.speed;context.ui.renderReplay();},setTimer(fn,delay){const id=++next;timers.set(id,{fn,delay});return id;},clearTimer(id){timers.delete(id);}});
  return {state,dialog,document,selectors,timers,logs,...context.ui,dispatch(type,event={}){for(const fn of listeners.get(type)||[])fn(event);},windowDispatch(type,event={}){windowListeners.get(type)?.(event);},tick(){const [id,job]=[...timers][0]||[];if(job){timers.delete(id);job.fn();}}};
}

test('actual replay renderer retains the same slider during continuous dragging and only resumes after release',()=>{
  const c=harness(),range=c.selectors.get('#replay-progress');
  c.playReplay();c.tick();assert.equal(c.state.replay.index,1);
  c.dispatch('pointerdown',{target:range});assert.equal(c.timers.size,0);
  for(const value of ['2','3','4']){range.value=value;c.dispatch('input',{target:range});assert.equal(c.state.replay.index,Number(value));assert.equal(c.selectors.get('#replay-progress'),range);}
  assert.equal(c.dialog.innerHTML,'initial');assert.equal(c.dialog.scrollTop,23);
  assert.equal(c.state.replayPlayback.snapshot().playing,false);
  c.dispatch('pointerup');assert.equal(c.state.replayPlayback.snapshot().playing,true);assert.equal(c.timers.size,1);
  c.tick();assert.equal(c.state.replay.index,5);assert.equal(c.timers.size,0);
  assert.equal(c.selectors.get('[data-action="replay-play"]').textContent,'重播');
});

test('changing replay units retains progress and privacy while amounts use historical blinds',()=>{
  const c=harness();
  c.state.replayPlayback.seek(3);
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/2 BB/);
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/Me · 跟注 0\.5 BB/);
  assert.match(c.selectors.get('[data-replay-players]').innerHTML,/9 BB/);
  assert.doesNotMatch(c.selectors.get('[data-replay-players]').innerHTML,/Ks,Kh/);
  const range=c.selectors.get('#replay-progress');
  c.changeMoneyUnit('points');
  assert.equal(c.state.replay.index,3);assert.equal(c.selectors.get('#replay-progress'),range);
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/20 积分/);
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/Me · 跟注 5 积分/);
  assert.match(c.selectors.get('[data-replay-players]').innerHTML,/90 积分/);
  assert.doesNotMatch(c.selectors.get('[data-replay-players]').innerHTML,/Ks,Kh/);
  c.changeMoneyUnit('bb');
  assert.equal(c.state.replay.index,3);assert.equal(c.dialog.scrollTop,23);
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/2 BB/);
});

test('missing historical blinds never borrow the current table blind',()=>{
  const c=harness();delete c.state.replay.hand.settings;
  c.state.replayPlayback.seek(3);
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/— BB/);
  assert.doesNotMatch(c.selectors.get('[data-replay-frame]').innerHTML,/0\.2 BB/);
  c.changeMoneyUnit('points');
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/20 积分/);
  assert.match(c.logs[2].textContent,/跟注 5 积分/);
  c.changeMoneyUnit('bb');
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/— BB/);
  assert.match(c.logs[2].textContent,/跟注 — BB/);
  assert.doesNotMatch(c.logs.map(log=>log.textContent).join(' '),/0\.05 BB|0\.1 BB/);
});

test('speed select changes the active cadence without resetting the cursor; keyboard seeking pauses',()=>{
  const c=harness(),speed=c.selectors.get('#replay-speed'),range=c.selectors.get('#replay-progress');
  c.playReplay();c.tick();speed.value='4';c.dispatch('change',{target:speed});
  assert.equal(c.state.replay.index,1);assert.equal(c.state.replaySpeed,4);assert.equal([...c.timers.values()][0].delay,250);
  range.value='3';c.dispatch('input',{target:range});c.dispatch('change',{target:range});
  assert.equal(c.state.replay.index,3);assert.equal(c.timers.size,0);
  assert.equal(range.attributes['aria-valuetext'],'第 3 步，共 5 步');
  assert.equal(c.selectors.get('#replay-position').textContent,'3 / 5 步');
  assert.match(c.selectors.get('[data-replay-players]').innerHTML,/As,Ah/);
  assert.doesNotMatch(c.selectors.get('[data-replay-players]').innerHTML,/Ks,Kh/);
});

test('a hidden library replay pauses and does not resume on visibility return; closing disposes its callback',()=>{
  const c=harness();c.playReplay();const stale=[...c.timers.values()][0].fn;
  c.document.visibilityState='hidden';c.dispatch('visibilitychange');assert.equal(c.timers.size,0);
  stale();assert.equal(c.state.replay.index,0);
  c.document.visibilityState='visible';c.dispatch('visibilitychange');assert.equal(c.timers.size,0);
  c.playReplay();const afterClose=[...c.timers.values()][0].fn;c.closeModal();afterClose();
  assert.equal(c.timers.size,0);assert.equal(c.state.modal,null);assert.equal(c.state.replayPlayback,null);
  assert.equal(c.dialog.open,false);assert.equal(c.dialog.innerHTML,'');
});

test('pagehide or an interrupted pointer session leaves replay paused instead of starting a hidden timer',()=>{
  const c=harness(),range=c.selectors.get('#replay-progress');
  c.playReplay();c.windowDispatch('pagehide');assert.equal(c.timers.size,0);
  c.playReplay();c.dispatch('pointerdown',{target:range});c.windowDispatch('blur');c.dispatch('pointerup');
  assert.equal(c.timers.size,0);assert.equal(c.state.replayPlayback.snapshot().playing,false);
  c.playReplay();c.dispatch('pointerdown',{target:range});c.dispatch('pointercancel');c.dispatch('pointerup');
  assert.equal(c.timers.size,0);
});

test('completed replay puts turn and river preview in the board row, and rewinding hides them again',()=>{
  const c=harness({realCards:true}),hand=c.state.replay.hand;
  hand.board=['2c','3h','4s'];hand.result={showdown:false};hand.players[1].cards=[null,null];
  hand.rabbit={originalCount:3,board:[...hand.board,'Js','Qh'],active:false};
  hand.log.push({type:'fold',playerId:'friend',street:'flop'},{type:'payout',playerId:'me',amount:20,street:'flop'});
  c.state.replay.index=hand.log.length;c.renderReplay();
  const frame=c.selectors.get('[data-replay-frame]').innerHTML;
  assert.match(frame,/aria-label="♠J"/);assert.match(frame,/aria-label="♥Q"/);
  assert.equal((frame.match(/rabbit-card/g)||[]).length,2);
  assert.doesNotMatch(frame,/aria-label="尚未发出"/);
  assert.equal((c.selectors.get('[data-replay-players]').innerHTML.match(/aria-label="未公开的牌"/g)||[]).length,2);
  c.state.replay.index=5;c.renderReplay();
  const previous=c.selectors.get('[data-replay-frame]').innerHTML;
  assert.doesNotMatch(previous,/♠J|♥Q|rabbit-card/);
  assert.equal((previous.match(/aria-label="尚未发出"/g)||[]).length,2);
});

test('the completed replay displays the distributed pot rather than an empty remainder, excluding side-game amounts',()=>{
  const c=harness(),hand=c.state.replay.hand;
  hand.players[0].miniNet=500;hand.players[0].endingStack=900;
  hand.log.push({type:'raise',playerId:'me',amount:60,to:60},{type:'call',playerId:'friend',amount:60},{type:'payout',playerId:'me',amount:50},{type:'payout',playerId:'friend',amount:90});
  c.state.replay.index=hand.log.length-1;c.renderReplay();
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/底池<\/div><strong class="pot-amount">9 BB/);
  c.state.replay.index=hand.log.length;c.renderReplay();
  const frame=c.selectors.get('[data-replay-frame]').innerHTML;
  assert.match(frame,/已分配底池<\/div><strong class="pot-amount">14 BB/);
  assert.doesNotMatch(frame,/已完成结算<\/div><strong class="pot-amount">0 BB|64 BB|90 BB/);
});

test('distributed replay pot excludes uncalled refunds and hides a missing historical settlement amount',()=>{
  const c=harness(),hand=c.state.replay.hand;
  c.state.replay.index=hand.log.length;c.renderReplay();
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/已完成结算/);
  assert.doesNotMatch(c.selectors.get('[data-replay-frame]').innerHTML,/class="pot-amount"/);
  hand.log.push({type:'raise',playerId:'me',amount:80,to:80},{type:'fold',playerId:'friend'},{type:'refund',playerId:'me',amount:80},{type:'payout',playerId:'me',amount:20});
  c.state.replay.index=hand.log.length;c.renderReplay();
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/已分配底池<\/div><strong class="pot-amount">2 BB/);
  c.changeMoneyUnit('points');
  assert.match(c.selectors.get('[data-replay-frame]').innerHTML,/已分配底池<\/div><strong class="pot-amount">20 积分/);
});
