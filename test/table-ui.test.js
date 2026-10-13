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
  vm.runInContext([section('function participationNotice(','function rulesModal('),section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('function roomView(){','function tableInfoModal('),section('function miniPanel(','function career(){'),'globalThis.client={state,roomView,actionArea,autoDealText,miniPanel};'].join('\n'),context);
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


test('squid suspension shows a compact ordinary-hand status without disabling normal play or confusing host pause',()=>{
  const c=harness(),r=room();r.status='playing';r.hand={status:'playing',squidRound:null};r.mini={squid:{active:true,paused:true,round:2}};c.state.room=r;
  assert.match(c.roomView(),/鱿鱼暂停 · 本手普通德州/);assert.match(c.autoDealText(r),/下一手继续普通德州/);
  r.hand.status='complete';r.autoDeal.nextHandAt=15000;assert.equal(c.autoDealText(r,10000),'5 秒后发普通德州');
  r.autoDeal.paused=true;assert.equal(c.autoDealText(r,10000),'自动发牌已暂停');
  r.hand.status='playing';r.autoDeal.paused=false;r.mini.squid.paused=false;assert.match(c.roomView(),/本手普通德州 · 下一手恢复鱿鱼/);
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
