import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { raiseFromSlider, sliderFromRaise } from '../public/table-feedback.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)+a.length));
function harness(){
  const context=vm.createContext({sliderFromRaise,raiseFromSlider,Date,
    state:{connected:true,busy:false,raise:20,timeOffset:0,chatOpen:false,chatUnread:0},
    cards:()=>'<span class="fixture-card"></span>',tableCenter:()=>'<div class="table-center"></div>',seatView:()=>'<div class="seat"></div>',chatPanel:()=>'',roomClock:()=> '剩余 59:59',errorPage:()=>'',
  });
  vm.runInContext([section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('function roomView(){','function tableInfoModal('),section('function autoDealText(','function career(){'),'globalThis.client={state,roomView,actionArea,autoDealText};'].join('\n'),context);
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
