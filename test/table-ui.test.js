import { renderRoomResults } from '../public/room-results.js';
import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import * as scene from '../public/table-scene.js';
import { renderHandCategory, displayedHandCategory } from '../public/hand-category.js';
import test from 'node:test';
import * as lifecycle from '../public/lifecycle.js';
import {formatChips,chipInputValue,getDisplayUnit,unitLabel} from '../public/money.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { betPresetOptions, betActionLabel, betTurnKey, normalizeBetAmount, betAmountFromSlider, betSliderFromAmount, betSelection, syncBetControls, betSliderKeyPosition, betActionEnabled, revealOptions } from '../public/table-controls.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)+a.length));
function harness(){
  const context=vm.createContext({renderRoomResults,moneyUnitToggle:()=>'<div class="money-unit-toggle"></div>',createRoomClock,isOlderRoomSnapshot,...scene,renderHandCategory,displayedHandCategory,lifecycle,betPresetOptions,betActionLabel,betTurnKey,normalizeBetAmount,betAmountFromSlider,betSliderFromAmount,betSelection,syncBetControls,betSliderKeyPosition,betActionEnabled,revealOptions,Date,formatChips,chipInputValue,getDisplayUnit,unitLabel,boardCard:()=>'<span class="fixture-board-card"></span>',streetNames:{preflop:'翻前',flop:'翻牌'},
    state:{clock:createRoomClock(),connected:true,busy:false,raise:20,chatOpen:false,chatUnread:0},
    cards:()=>'<span class="fixture-card"></span>',tableCenter:()=>'<div class="table-center"></div>',seatView:()=>'<div class="seat"></div>',chatPanel:()=>'',miniCutoff:()=>false,roomClock:()=> '剩余 59:59',errorPage:()=>'',
  });
  vm.runInContext([section('function participationNotice(','function rulesModal('),section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('function tableCenter(','function seatActions('),section('function roomView(){','function tableInfoModal('),section('function miniPanel(','function career(){'),'globalThis.client={state,roomView,actionArea,autoDealText,miniPanel,bombStatus};'].join('\n'),context);
  return context.client;
}
function room(){return {code:'123456',name:'朋友必赢的局',meId:'me',hostId:'me',status:'waiting',settings:{smallBlind:5,bigBlind:10,maxPlayers:9,timeBankCards:3,timeBankSeconds:30},players:[{id:'me',seat:0,stack:1000,inHand:true,cards:['As','Kd']},{id:'friend',seat:1,stack:1000}],actions:{},autoDeal:{paused:false,nextHandAt:null,waitReason:null}};}
test('a completed hand keeps the countdown but removes duplicated cards and the old show dialog from the dock',()=>{
  const c=harness(),r=room();r.hand={id:'h1',number:1,status:'complete'};r.autoDeal.nextHandAt=15000;
  assert.equal(c.autoDealText(r,10000),'5 秒后自动发下一手');assert.equal(c.autoDealText(r,15000),'正在准备下一手…');
  const html=c.actionArea(r,r.players[0],true);assert.doesNotMatch(html,/data-action="start"|data-action="show"|my-hand-summary|my-cards/);assert.match(html,/data-auto-deal/);
  r.autoDeal.paused=true;assert.match(c.actionArea(r,r.players[0],true),/data-action="resume-deal"/);assert.doesNotMatch(c.actionArea(r,r.players[1],false),/data-action="resume-deal"/);
});
test('first hand still starts with the host, and waiting causes are useful to players',()=>{
  const c=harness(),r=room();assert.match(c.actionArea(r,r.players[0],true),/data-action="start"/);assert.doesNotMatch(c.actionArea(r,r.players[1],false),/data-action="start"/);
  r.hand={status:'complete'};r.autoDeal.waitReason='等待至少两位玩家入座';assert.equal(c.autoDealText(r),'等待至少两位玩家入座');
  r.status='closed';assert.doesNotMatch(c.actionArea(r,r.players[0],true),/data-action="(?:start|resume-deal|buyin)"/);
});
test('the rebuy grace countdown promises only a waiting window, and then shows the actual insufficient-player reason',()=>{
  const c=harness(),r=room();r.hand={status:'complete'};r.players[0].stack=0;
  r.autoDeal.waitReason='insufficient_players';r.autoDeal.rebuyGrace={pendingIds:['me'],startsAt:5000,endsAt:10000};
  assert.equal(c.autoDealText(r,6000),'补码等待 · 还剩 4 秒');
  assert.doesNotMatch(c.autoDealText(r,6000),/自动发|自动继续/);
  assert.equal(c.autoDealText(r,9999),'补码等待 · 还剩 1 秒');
  assert.equal(c.autoDealText(r,10000),'不足 2 人可参与 · 回桌或补码后自动继续');
  r.autoDeal.paused=true;assert.equal(c.autoDealText(r,6000),'房主已暂停 · 可在菜单继续');
});
test('raise controls group four pot presets with a separate custom opener above them',()=>{
  const c=harness(),r=room();r.hand={status:'playing',currentBet:0,pot:300};r.actions={canAct:true,canFold:true,canCheck:true,canRaise:true,minRaiseTo:20,maxRaiseTo:100000,canUseTimeBank:true,timeBankCards:3};c.state.room=r;c.state.raise=1230;
  const html=c.actionArea(r,r.players[0],true);assert.match(html,/id="raise-range" min="0" max="1000"/);assert.match(html,new RegExp('value="'+betSliderFromAmount(r,1230)+'"'));assert.match(html,/<output id="raise-amount"[^>]*><span class="raise-selection-label">下注<\/span><strong class="raise-selection-amount">1,230 积分<\/strong>/);assert.doesNotMatch(html,/id="raise-input"|my-hand-summary|my-cards/);assert.doesNotMatch(html,/data-action="timebank"/);
  assert.doesNotMatch(html,/data-preset="min"/);
  for(const id of ['third','half','two-thirds','pot'])assert.match(html,new RegExp('data-preset="'+id+'"'));
  assert.doesNotMatch(html,/data-preset="(?:over|all)"|1\.2倍池/);
  const shortcuts=html.slice(html.indexOf('<div class="raise-shortcuts"'),html.indexOf('<div class="action-buttons"'));
  assert.equal((shortcuts.match(/<button /g)||[]).length,4);assert.doesNotMatch(shortcuts,/id="raise-toggle"/);
  assert.match(html.slice(0,html.indexOf('<div class="raise-shortcuts"')),/id="raise-toggle"/);
});
test('table layout keeps only the table, action dock and four grouped tools on the main screen',()=>{
  const c=harness();c.state.room=room();const html=c.roomView();assert.match(html,/class="table-bottom"/);assert.match(html,/class="table-toolbar"/);assert.doesNotMatch(html,/side-stack|activity-list|data-action="stand"|data-action="verify"/);
  for(const action of ['toggle-chat','history','table-info','room-menu'])assert.match(html,new RegExp('data-action="'+action+'"'));
});


test('squid keeps continuing with absent players; only unavailable tables display a waiting state',()=>{
  const c=harness(),r=room();r.status='playing';r.hand={status:'playing',squidRound:2};r.mini={squid:{active:true,round:2,participants:['me','friend','away'],won:[]}};c.state.room=r;
  assert.doesNotMatch(c.roomView(),/鱿鱼暂停|本手普通德州/);assert.equal(c.autoDealText(r),'每手结束后自动继续');
  r.mini.squid.blockerSince=1;assert.match(c.roomView(),/本手仍计鱿鱼.*等待玩家/);assert.match(c.autoDealText(r),/等待原轮玩家/);
  r.hand.status='complete';r.autoDeal.paused=true;assert.equal(c.autoDealText(r,10000),'房主已暂停 · 可在菜单继续');
  r.hand.status='playing';r.autoDeal.paused=false;r.mini.squid.blockerSince=null;r.hand.squidRound=null;assert.match(c.roomView(),/本手普通德州.*下一手继续原轮/);
  r.actions={canAct:true,canFold:true,canCheck:true};assert.match(c.actionArea(r,r.players[0],true),/data-action="check"/);
});

test('end-of-session recovery distinguishes waiting from continuation and cannot retain an obsolete pause',()=>{
  const c=harness(),r=room();r.status='playing';r.hand={status:'playing',squidRound:null};r.expiryMode='wait-squid';r.mini={squid:{active:true,paused:true,round:2}};
  assert.equal(c.autoDealText(r),'已到时，本手后等待鱿鱼恢复');
  r.hand.status='complete';r.autoDeal.nextHandAt=15000;assert.equal(c.autoDealText(r,10000),'已到时，等待原轮鱿鱼恢复');
  r.expiryMode='finish-squid';r.mini.squid.paused=false;r.autoDeal.paused=true;assert.equal(c.autoDealText(r,10000),'5 秒后自动发下一手');
  r.autoDeal.nextHandAt=null;assert.equal(c.autoDealText(r,10000),'已到时 · 等待原轮自动继续');
});

test('expired squid details explain automatic closure without repeating ordinary manual settlement guidance',()=>{
  const c=harness(),r=room();r.settings.squid=true;r.expiryMode='wait-squid';
  r.mini={squid:{active:true,paused:true,round:2,participants:['me','friend'],won:['me'],blockerSince:1,canSettle:true,unit:20}};
  const expired=c.miniPanel(r);assert.match(expired,/等待窗口内恢复就继续原轮/);assert.match(expired,/按现有标记结算散桌/);
  assert.doesNotMatch(expired,/squid-settle-note|data-action="settle-squid"|两手之间/);
  r.expiryMode=null;const regular=c.miniPanel(r);assert.match(regular,/data-action="settle-squid"/);assert.match(regular,/两手之间/);
});

test('waiting entry offers one header choice while actual hand participants never see another blind charge',()=>{
  const c=harness(),r=room(),me=r.players[0];r.hand={status:'playing'};me.inHand=false;me.entryBlind={required:true,mode:'wait',reason:'new',live:10,dead:0,waitingFor:'bigBlind'};
  c.state.room=r;
  let html=c.roomView(),header=html.slice(html.indexOf('<div class="room-head">'),html.indexOf('<div class="game-grid">'));
  assert.equal((html.match(/data-action="entry-blind"/g)||[]).length,1);
  assert.match(header,/等大盲加入.*data-action="entry-blind"|data-action="entry-blind"[^>]*>等大盲加入/);
  assert.doesNotMatch(c.actionArea(r,me,true),/data-action="entry-blind"/);
  me.entryBlind.mode='post';me.entryBlind.waitingFor='button';html=c.roomView();assert.match(html,/补盲加入/);assert.doesNotMatch(html,/等大盲加入 ▾/);
  me.inHand=true;html=c.roomView();assert.doesNotMatch(html,/data-action="entry-blind"/);
});

test('absent-player settlement countdown has priority over dealing another hand',()=>{
  const c=harness(),r=room();r.hand={status:'complete'};r.autoDeal.nextHandAt=15000;r.mini={squid:{active:true,absentSettlementAt:13000}};
  assert.equal(c.autoDealText(r,10000),'3 秒后按现有标记结轮');assert.equal(c.autoDealText(r,14000),'正在结算本轮鱿鱼…');
});

test('spectators with a future entry quote do not render a duplicate participation notice',()=>{
  const c=harness(),r=room(),me=r.players[0];me.seat=null;me.inHand=false;me.entryBlind={required:true,mode:'wait',live:10,dead:0};r.hand={status:'complete'};
  const html=c.actionArea(r,me,true);assert.doesNotMatch(html,/lifecycle-queue|data-action="entry-blind"/);assert.match(html,/观战中 · 点击空座入座/);
});

test('sitting-out players retain a return action without a duplicate away notice',()=>{
  const c=harness(),r=room(),me=r.players[0];me.sittingOut=true;me.inHand=false;me.entryBlind={required:true,mode:'wait',reason:'missed',live:10,dead:5};r.hand={status:'complete'};
  const html=c.actionArea(r,me,true);assert.equal((html.match(/你已暂离/g)||[]).length,1);assert.doesNotMatch(html,/lifecycle-queue|data-action="entry-blind"/);assert.match(html,/data-action="sitout"/);
});

test('game markers distinguish enabled modes from the current bomb hand and active squid round',()=>{
  const c=harness(),r=room();c.state.room=r;r.settings.squid=true;r.settings.bombPot=true;
  let html=c.roomView();assert.match(html,/鱿鱼已开启/);assert.match(html,/炸弹池已开启/);assert.doesNotMatch(html,/本手炸弹池|鱿鱼 · 第/);
  r.mini={squid:{active:true,round:3,participants:['me','friend','third'],won:['friend']}};r.hand={status:'playing',squidRound:3,bombPot:true};
  html=c.roomView();assert.match(html,/鱿鱼 · 第 3 轮/);assert.match(html,/1\/3 有鱼/);assert.match(html,/本手炸弹池/);assert.match(html,/game-mode bomb active/);
  r.status='closed';assert.doesNotMatch(c.roomView(),/game-mode-markers/);
});
test('bomb countdown and marker remain visible past the squid cutoff',()=>{
  const c=harness(),r=room();r.settings.bombPot=true;r.nextBombAt=61000;
  assert.equal(c.bombStatus(r,1000).label,'下次炸弹 1:00');assert.equal(c.bombStatus(r,61000).label,'炸弹待触发 · 等合适的下一手');assert.equal(c.bombStatus(r,61000).active,false);
  r.bombDue=true;r.miniGamesCutoffAt=62000;assert.equal(c.bombStatus(r,62000).shortLabel,'炸弹待开');
  r.hand={status:'playing',bombPot:true};assert.equal(c.bombStatus(r,63000).label,'本手炸弹池');
  r.hand.status='complete';assert.equal(c.bombStatus(r,63000).shortLabel,'炸弹待开');
  r.status='closed';assert.equal(c.bombStatus(r,63000),null);
});
test('table tool strip keeps play-related tools and removes general data and legal copy',()=>{
  const c=harness();c.state.room=room();const html=c.roomView();
  assert.doesNotMatch(html,/data-action="interact"|data-action="career"|发牌与隐私|公平与隐私|公开源码|不提供充值/);
  for(const action of ['toggle-chat','history','table-info','room-menu'])assert.match(html,new RegExp('data-action="'+action+'"'));
});

test('seat lifecycle status remains separate from the zero-stack All-in marker and completed payouts',()=>{
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,...scene,renderHandCategory,displayedHandCategory,lifecycle,formatChips,chipInputValue,getDisplayUnit,unitLabel,revealOptions,betActionEnabled,state:{clock:createRoomClock(),},avatar:()=>'',renderSeatMask:()=>'',reactionBubble:()=>'',statsUI:{renderEquityBadge:()=>''},formatAction:action=>({call:'跟注',check:'过牌',raise:'加注',timeout:'超时'})[action]||String(action)});
  vm.runInContext([section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('const layouts=','function boardCard('),'globalThis.draw=seatView;'].join('\n'),context);
  const r=room(),p=r.players[1];r.hand={status:'playing',actingId:'me'};p.connected=true;p.inHand=true;p.allIn=true;p.stack=0;p.bet=100;p.contributed=100;
  let html=context.draw(1,r);assert.match(html,/class="seat-allin-label"[^>]*>All-in</);assert.doesNotMatch(html,/bet-allin-label|class="seat-status[^>]*>All-in</);assert.match(html,/本轮已投入 100 积分，All-in/);
  p.connected=false;html=context.draw(1,r);assert.doesNotMatch(html,/>离线</);assert.match(html,/class="seat-allin-label"[^>]*>All-in</,'a disconnected participant still has its actual All-in committed');
  p.connected=true;p.sittingOut=true;assert.match(context.draw(1,r),/data-tone="waiting">暂离/);
  r.mini={squid:{active:true,round:2,mode:'normal',participants:['me','away','third'],counts:{me:0,away:1,third:0},tokenBudget:2}};
  p.sittingOut=false;p.waitingFor='squid';p.inHand=false;
  p.squidJoin={status:'next-hand',round:2,reason:'本手结束后核对预留与补盲，满足条件的下一手以 0 鱼加入',requiredReserve:60,tokenBudgetAfterJoin:3};
  html=context.draw(1,r);assert.match(html,/data-tone="waiting">待入本轮/);assert.doesNotMatch(html,/seat-allin-label|bet-allin-label|等待下一轮/);
  p.inHand=true;assert.match(context.draw(1,r),/class="seat-allin-label"[^>]*>All-in</);
  p.allIn=false;p.waitingFor=null;p.lastAction='call';assert.doesNotMatch(context.draw(1,r),/>跟注<|data-tone="call"/);
  p.lastAction='timeout';assert.doesNotMatch(context.draw(1,r),/>超时</);
  r.hand={status:'complete',result:{mainWinnerIds:[p.id],payouts:{[p.id]:100}}};p.connected=false;p.allIn=true;p.stack=100;html=context.draw(1,r);assert.match(html,/data-tone="win">收池 100 积分/);assert.doesNotMatch(html,/seat-allin-label|bet-allin-label/);
});

test('the last available chips are labeled all-in both for a call and the raise amount controls',()=>{
  const c=harness(),r=room(),me=r.players[0];c.state.room=r;r.hand={status:'playing',currentBet:10};r.actions={canAct:true,canFold:true,canCheck:false,callAmount:me.stack,canRaise:false,canAllIn:false};
  assert.match(c.actionArea(r,me,true),/data-action="call"[^>]*data-allin="true"[^>]*>All-in 跟注/);
  r.actions={...r.actions,callAmount:10,canRaise:true,minRaiseTo:20,maxRaiseTo:1000};c.state.raise=1000;
  assert.match(c.actionArea(r,me,true),/data-action="raise"[^>]*data-allin="true"[^>]*>All-in<\/button>/);
  c.state.raise=20;assert.match(c.actionArea(r,me,true),/data-action="raise"[^>]*data-allin="false"[^>]*>加注<\/button>/);
  const nodes=new Map(['#raise-button','#raise-range','#raise-amount'].map(id=>[id,{dataset:{},setAttribute(){}}]));
  c.state.room=r;
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,...scene,renderHandCategory,state:c.state,$:id=>nodes.get(id),document:{querySelectorAll:()=>[]},betActionLabel,betPresetOptions,betTurnKey,normalizeBetAmount,betSliderFromAmount,betSelection,betActionEnabled,chipInputValue,unitLabel,esc:String,chips:value=>formatChips(value,r.settings.bigBlind),num:value=>String(value)});
  vm.runInContext(section('function setRaise(','document.addEventListener(')+';globalThis.adjust=setRaise;',context);
  context.adjust(1000);assert.equal(nodes.get('#raise-button').dataset.allin,'true');assert.match(nodes.get('#raise-button').textContent,/All-in/);
  context.adjust(25);assert.equal(nodes.get('#raise-button').dataset.allin,'false');assert.match(nodes.get('#raise-amount').innerHTML,/加至<\/span><strong class="raise-selection-amount">30 积分/);assert.equal(nodes.get('#raise-button').textContent,'加注');
});

test('rounded or clamped fraction presets remain enabled and short all-ins do not expose an impossible raise slider',()=>{
  const c=harness(),r=room();c.state.room=r;r.hand={status:'playing',currentBet:50,pot:105};r.players[0].bet=20;
  r.actions={canAct:true,canFold:true,canCheck:false,callAmount:30,canRaise:true,minRaiseTo:100,maxRaiseTo:150};
  const html=c.actionArea(r,r.players[0],true);
  assert.match(html,/<button[^>]*data-preset="third"[^>]*aria-label="1\/3池，加至 100 积分，点击直接下注"[^>]*>/);
  assert.match(html,/<button[^>]*data-preset="pot"[^>]*aria-label="满池，All-in 150 积分，点击直接下注"[^>]*>/);
  assert.match(html,/<button[^>]*data-preset="half"[^>]*aria-label="1\/2池，加至 120 积分，点击直接下注"[^>]*>/);
  assert.doesNotMatch(html,/<button[^>]*data-preset="[^"]+"[^>]*disabled/);
  r.actions={...r.actions,canRaise:false,canAllIn:true,maxRaiseTo:70};
  const short=c.actionArea(r,r.players[0],true);assert.doesNotMatch(short,/id="raise-range"|data-action="raise"/);assert.match(short,/data-action="allin"/);
});


test('closing a room replaces the entire live table with all-player results, including departed players',()=>{
  const c=harness(),r=room();r.status='closed';r.hand={number:19,status:'complete'};
  r.players=[{id:'me',name:'我',seat:null,stack:0,totalBuyIn:4000,sessionProfit:200},{id:'left',name:'提前走的朋友',seat:null,stack:0,totalBuyIn:2000,sessionProfit:-200},{id:'watch',name:'旁观者',seat:null,totalBuyIn:0,sessionProfit:0}];c.state.room=r;
  const html=c.roomView();assert.match(html,/本场战绩/);assert.match(html,/提前走的朋友/);assert.match(html,/2 人 · 19 手/);assert.match(html,/累计带入/);assert.match(html,/累计收回/);assert.match(html,/data-action="history"/);assert.match(html,/data-action="lobby"/);
  assert.doesNotMatch(html,/table-stage|table-bottom|table-toolbar|raise-range|data-action="(?:check|call|buyin|start)"|旁观者/);
});
