import test from 'node:test';
import * as lifecycle from '../public/lifecycle.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { raiseFromSlider, sliderFromRaise } from '../public/table-feedback.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)+a.length));
function harness(){
  const context=vm.createContext({lifecycle,sliderFromRaise,raiseFromSlider,Date,
    state:{connected:true,busy:false,raise:20,timeOffset:0,chatOpen:false,chatUnread:0},
    cards:()=>'<span class="fixture-card"></span>',tableCenter:()=>'<div class="table-center"></div>',seatView:()=>'<div class="seat"></div>',chatPanel:()=>'',roomClock:()=> '剩余 59:59',errorPage:()=>'',
  });
  vm.runInContext([section('function participationNotice(','function rulesModal('),section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('function roomView(){','function tableInfoModal('),section('function miniPanel(','function career(){'),'globalThis.client={state,roomView,actionArea,autoDealText,miniPanel,bombStatus};'].join('\n'),context);
  return context.client;
}
function room(){return {code:'123456',name:'朋友必赢的局',meId:'me',hostId:'me',status:'waiting',settings:{smallBlind:5,bigBlind:10,maxPlayers:9,timeBankCards:3,timeBankSeconds:30},players:[{id:'me',seat:0,stack:1000,inHand:true,cards:['As','Kd']},{id:'friend',seat:1,stack:1000}],actions:{},autoDeal:{paused:false,nextHandAt:null,waitReason:null}};}
test('a completed hand offers countdown and show cards, without a manual next-hand start',()=>{
  const c=harness(),r=room();r.hand={id:'h1',number:1,status:'complete'};r.autoDeal.nextHandAt=15000;
  assert.equal(c.autoDealText(r,10000),'5 秒后自动发下一手');assert.equal(c.autoDealText(r,15000),'正在准备下一手…');
  const html=c.actionArea(r,r.players[0],true);assert.doesNotMatch(html,/data-action="start"/);assert.match(html,/data-auto-deal/);assert.match(html,/data-action="show"/);
  r.autoDeal.paused=true;assert.match(c.actionArea(r,r.players[0],true),/data-action="resume-deal"/);assert.doesNotMatch(c.actionArea(r,r.players[1],false),/data-action="resume-deal"/);
});
test('first hand still starts with the host, and waiting causes are useful to players',()=>{
  const c=harness(),r=room();assert.match(c.actionArea(r,r.players[0],true),/data-action="start"/);assert.doesNotMatch(c.actionArea(r,r.players[1],false),/data-action="start"/);
  r.hand={status:'complete'};r.autoDeal.waitReason='等待至少两位玩家入座';assert.equal(c.autoDealText(r),'等待至少两位玩家入座');
  r.status='closed';assert.doesNotMatch(c.actionArea(r,r.players[0],true),/data-action="(?:start|resume-deal|buyin)"/);
});
test('raise amount remains exact while the nonlinear slider expresses the corresponding position',()=>{
  const c=harness(),r=room();r.hand={status:'playing'};r.actions={canAct:true,canFold:true,canCheck:true,canRaise:true,minRaiseTo:20,maxRaiseTo:100000,canUseTimeBank:true,timeBankCards:3};c.state.raise=1234;
  const html=c.actionArea(r,r.players[0],true);assert.match(html,/id="raise-range" min="0" max="1000"/);assert.match(html,new RegExp('value="'+sliderFromRaise(1234,20,100000,10)+'"'));assert.match(html,/id="raise-input" min="20" max="100000" step="1" value="1234"/);assert.match(html,/123\.4 BB/);assert.match(html,/data-action="timebank"/);
});
test('table layout keeps only the table, action dock and four grouped tools on the main screen',()=>{
  const c=harness();c.state.room=room();const html=c.roomView();assert.match(html,/class="table-bottom"/);assert.match(html,/class="table-toolbar"/);assert.doesNotMatch(html,/side-stack|activity-list|data-action="stand"|data-action="verify"/);
  for(const action of ['toggle-chat','history','table-info','room-menu'])assert.match(html,new RegExp('data-action="'+action+'"'));
});


test('squid keeps continuing with absent players; only unavailable tables display a waiting state',()=>{
  const c=harness(),r=room();r.status='playing';r.hand={status:'playing',squidRound:2};r.mini={squid:{active:true,round:2,participants:['me','friend','away'],won:[]}};c.state.room=r;
  assert.doesNotMatch(c.roomView(),/鱿鱼暂停|本手普通德州/);assert.equal(c.autoDealText(r),'每手结束后自动继续');
  r.mini.squid.blockerSince=1;assert.match(c.roomView(),/本手仍计鱿鱼.*等待玩家/);assert.match(c.autoDealText(r),/等待原轮玩家/);
  r.hand.status='complete';r.autoDeal.paused=true;assert.equal(c.autoDealText(r,10000),'自动发牌已暂停');
  r.hand.status='playing';r.autoDeal.paused=false;r.mini.squid.blockerSince=null;r.hand.squidRound=null;assert.match(c.roomView(),/本手普通德州.*下一手继续原轮/);
  r.actions={canAct:true,canFold:true,canCheck:true};assert.match(c.actionArea(r,r.players[0],true),/data-action="check"/);
});

test('end-of-session recovery suppresses ordinary-table countdown while preserving an explicit host pause',()=>{
  const c=harness(),r=room();r.status='playing';r.hand={status:'playing',squidRound:null};r.expiryMode='wait-squid';r.mini={squid:{active:true,paused:true,round:2}};
  assert.equal(c.autoDealText(r),'已到时，本手后等待鱿鱼恢复');
  r.hand.status='complete';r.autoDeal.nextHandAt=15000;assert.equal(c.autoDealText(r,10000),'已到时，等待原轮鱿鱼恢复');
  r.expiryMode='finish-squid';r.mini.squid.paused=false;r.autoDeal.paused=true;assert.equal(c.autoDealText(r,10000),'自动发牌已暂停');
});

test('expired squid details explain automatic closure without repeating ordinary manual settlement guidance',()=>{
  const c=harness(),r=room();r.settings.squid=true;r.expiryMode='wait-squid';
  r.mini={squid:{active:true,paused:true,round:2,participants:['me','friend'],won:['me'],blockerSince:1,canSettle:true,unit:20}};
  const expired=c.miniPanel(r);assert.match(expired,/等待窗口内恢复就继续原轮/);assert.match(expired,/按现有标记结算散桌/);
  assert.doesNotMatch(expired,/squid-settle-note|data-action="settle-squid"|两手之间/);
  r.expiryMode=null;const regular=c.miniPanel(r);assert.match(regular,/data-action="settle-squid"/);assert.match(regular,/两手之间/);
});

test('waiting entry offers one compact choice while actual hand participants never see another blind charge',()=>{
  const c=harness(),r=room(),me=r.players[0];r.hand={status:'playing'};me.inHand=false;me.entryBlind={required:true,mode:'wait',reason:'new',live:10,dead:0,waitingFor:'bigBlind'};
  let html=c.actionArea(r,me,true);assert.match(html,/等待大盲加入/);assert.equal((html.match(/data-action="entry-blind"/g)||[]).length,1);
  me.inHand=true;html=c.actionArea(r,me,true);assert.doesNotMatch(html,/data-action="entry-blind"/);
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
test('bomb countdown waits for a hand boundary and never promises a new bomb past cutoff',()=>{
  const c=harness(),r=room();r.settings.bombPot=true;r.nextBombAt=61000;
  assert.equal(c.bombStatus(r,1000).label,'下次炸弹 1:00');assert.equal(c.bombStatus(r,61000).label,'炸弹待触发 · 等合适的下一手');assert.equal(c.bombStatus(r,61000).active,false);
  r.bombDue=true;r.miniGamesCutoffAt=62000;assert.equal(c.bombStatus(r,62000),null);
  r.hand={status:'playing',bombPot:true};assert.equal(c.bombStatus(r,63000).label,'本手炸弹池');
  r.hand.status='complete';assert.equal(c.bombStatus(r,63000),null);
});
test('table tool strip keeps play-related tools and removes general data and legal copy',()=>{
  const c=harness();c.state.room=room();const html=c.roomView();
  assert.doesNotMatch(html,/data-action="career"|发牌与隐私|公平与隐私|公开源码|不提供充值/);
  for(const action of ['toggle-chat','interact','history','table-info','room-menu'])assert.match(html,new RegExp('data-action="'+action+'"'));
});

test('seat status colors follow the visible lifecycle state before stale betting flags',()=>{
  const context=vm.createContext({lifecycle,state:{},avatar:()=>'',renderSeatMask:()=>'',reactionBubble:()=>'',statsUI:{renderEquityBadge:()=>''},formatAction:action=>({call:'跟注',check:'过牌',raise:'加注',timeout:'超时'})[action]||String(action)});
  vm.runInContext([section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('const layouts=','function boardCard('),'globalThis.draw=seatView;'].join('\n'),context);
  const r=room(),p=r.players[1];r.hand={status:'playing',actingId:'me'};p.connected=true;p.inHand=true;p.allIn=true;
  let html=context.draw(1,r);assert.match(html,/data-tone="allin">ALL IN/);
  p.connected=false;html=context.draw(1,r);assert.match(html,/data-tone="waiting">离线/);assert.doesNotMatch(html,/data-tone="allin"/);
  p.connected=true;p.sittingOut=true;assert.match(context.draw(1,r),/data-tone="waiting">暂离/);
  p.sittingOut=false;p.waitingFor='squid';p.inHand=false;assert.match(context.draw(1,r),/data-tone="waiting">等待下一轮/);
  p.inHand=true;assert.match(context.draw(1,r),/data-tone="allin">ALL IN/);
  p.allIn=false;p.waitingFor=null;p.lastAction='call';assert.match(context.draw(1,r),/data-tone="call">跟注/);
  p.lastAction='timeout';assert.match(context.draw(1,r),/data-tone="neutral">超时/);
  r.hand={status:'complete',result:{mainWinnerIds:[p.id]}};p.connected=false;assert.match(context.draw(1,r),/data-tone="win">赢得主池/);
});

test('the last available chips are labeled all-in both for a call and the raise amount controls',()=>{
  const c=harness(),r=room(),me=r.players[0];r.hand={status:'playing'};r.actions={canAct:true,canFold:true,canCheck:false,callAmount:me.stack,canRaise:false,canAllIn:false};
  assert.match(c.actionArea(r,me,true),/data-action="call"[^>]*data-allin="true"[^>]*>全下跟注/);
  r.actions={...r.actions,callAmount:10,canRaise:true,minRaiseTo:20,maxRaiseTo:1000};c.state.raise=1000;
  assert.match(c.actionArea(r,me,true),/data-action="raise"[^>]*data-allin="true"[^>]*>全下至 1,000/);
  c.state.raise=20;assert.match(c.actionArea(r,me,true),/data-action="raise"[^>]*data-allin="false"[^>]*>加至 20/);
  const nodes=new Map(['#raise-button','#raise-range','#raise-input','#raise-bb'].map(id=>[id,{dataset:{},setAttribute(){}}]));
  c.state.room=r;
  const context=vm.createContext({state:c.state,$:id=>nodes.get(id),sliderFromRaise,num:value=>String(value)});
  vm.runInContext(section('function setRaise(value){','document.addEventListener(')+';globalThis.adjust=setRaise;',context);
  context.adjust(1000);assert.equal(nodes.get('#raise-button').dataset.allin,'true');assert.match(nodes.get('#raise-button').textContent,/全下至/);
  context.adjust(25);assert.equal(nodes.get('#raise-button').dataset.allin,'false');assert.equal(nodes.get('#raise-input').value,25);assert.match(nodes.get('#raise-button').textContent,/加至 25/);
});
