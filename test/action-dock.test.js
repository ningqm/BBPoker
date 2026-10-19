import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as lifecycle from '../public/lifecycle.js';
import * as controls from '../public/table-controls.js';
import {formatChips,getDisplayUnit,setDisplayUnit} from '../public/money.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('function actionArea('),end=source.indexOf('function career(){',start);
const css=readFileSync(new URL('../public/table-controls.css',import.meta.url),'utf8');
function setup(){
  const room={code:'room-a',meId:'me',hostId:'me',status:'playing',settings:{bigBlind:10,maxPlayers:9,timeBankCards:6},
    hand:{id:'h1',status:'playing',actionSeq:1,actingId:'me',currentBet:10,pot:15},
    actions:{canAct:true,canFold:true,canCheck:false,canRaise:true,minRaiseTo:20,maxRaiseTo:1000,callAmount:5},
    players:[{id:'me',seat:0,bet:5,stack:1000,inHand:true},{id:'other',seat:1,stack:1000,inHand:true}],autoDeal:{}};
  const state={room,connected:true,busy:false,raise:30,raisePreset:'pot',raisePanelOpen:false};
  const ctx=vm.createContext({...controls,lifecycle,state,getDisplayUnit,chips:n=>formatChips(n,10),num:String,esc:s=>String(s??''),autoDealText:()=>'5 秒后自动发下一手',seatHoleCards:()=>'',
    btn:(label,action,cls='',attrs='')=>`<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`});
  vm.runInContext(source.slice(start,end),ctx);
  return {room,state,draw:()=>ctx.actionArea(room,room.players[0],true)};
}
function actionButtons(html){return html.slice(html.indexOf('<div class="action-buttons"'),html.indexOf('</div>',html.indexOf('<div class="action-buttons"'))).match(/<button\b[^>]*>/g)||[];}

test('the same two actions and four presets remain stable with an independent custom opener above them',()=>{
  const h=setup();const situations=[()=>{},()=>{h.room.actions.canAct=false;},()=>{h.room.hand.status='complete';},()=>{h.room.hand=null;},()=>{h.room.status='closed';}];
  for(const change of situations){change();const html=h.draw();assert.equal(actionButtons(html).length,2);assert.equal((html.match(/data-preset=/g)||[]).length,4);assert.match(html,/class="action-area action-dock /);
    const row=html.slice(html.indexOf('<div class="raise-shortcuts"'),html.indexOf('<div class="action-buttons"'));
    assert.equal((row.match(/<button\b/g)||[]).length,4);assert.doesNotMatch(row,/id="raise-toggle"|data-preset="(?:all|over)"/);
    const tools=html.slice(html.indexOf('<div class="turn-tools"'),html.indexOf('<div class="raise-shortcuts"'));assert.equal((tools.match(/id="raise-toggle"/g)||[]).length,1);}
  const bottom=css.match(/\.room-shell \.table-bottom\{flex:0 0 (\d+)px;height:(\d+)px;min-height:(\d+)px/);
  const dock=css.match(/\.room-shell \.table-bottom \.action-dock\{[^}]*height:(\d+)px;min-height:(\d+)px;padding:(\d+)px/);
  const rows=css.match(/\.room-shell \.table-bottom \.action-dock \.decision\{[^}]*grid-template-rows:(\d+)px (\d+)px (\d+)px;gap:(\d+)px/);
  assert.ok(bottom&&dock&&rows,'the base dock has a reserved fixed height and three defined rows');
  assert.ok([...bottom.slice(1),...dock.slice(1,3)].every(value=>Number(value)===Number(bottom[1])),'dock and reserved table-bottom use the same height');
  const content=rows.slice(1,4).reduce((sum,value)=>sum+Number(value),0)+2*Number(rows[4])+2*Number(dock[3]);
  assert.ok(Number(bottom[1])>=content,'the upper custom row, four presets and main actions all fit without expanding the table');
});

test('off-turn controls never arm a game action or leave another countdown below the table',()=>{
  const h=setup();h.room.actions.canAct=false;h.room.hand.actingId='other';
  const html=h.draw();assert.ok(actionButtons(html).every(tag=>/disabled/.test(tag)));assert.doesNotMatch(html,/data-turn-clock|轮到你|等待 other|raise-popover/);
  assert.match(html,/等待行动/);assert.match(html,/data-action="toggle-raise-panel"[^>]*disabled/);
});

test('vertical amount picker is hidden by default, displays chosen amount when opened and never consumes space',()=>{
  const h=setup();let html=h.draw();assert.match(html,/id="raise-panel"[^>]* hidden/);assert.match(html,/aria-controls="raise-panel"/);assert.match(html,/aria-orientation="vertical"/);
  h.state.raisePanelOpen=true;html=h.draw();assert.doesNotMatch(html,/id="raise-panel"[^>]* hidden/);assert.match(html,/aria-expanded="true"/);assert.match(css,/\.raise-popover\{position:absolute/);
  h.state.connected=false;assert.match(h.draw(),/id="raise-panel"[^>]* hidden/);
});

test('every preset visibly shows its exact total in the chosen unit and none is a selection toggle',()=>{
  for(const unit of ['bb','points']){
    setDisplayUnit(unit);const h=setup(),html=h.draw();
    assert.doesNotMatch(html,/aria-pressed|class="selected"/);
    const presets=[...html.matchAll(/<button[^>]*data-preset="([^"]+)"[^>]*data-amount="(\d+)"[^>]*>([\s\S]*?)<\/button>/g)];
    assert.equal(presets.length,4);
    for(const [,id,amount,body] of presets){
      assert.match(body,/class="bet-preset-label"/);assert.match(body,/class="bet-preset-amount"/);
      assert.ok(body.includes(formatChips(Number(amount),10)),id);
    }
    const main=html.slice(html.indexOf('<div class="action-buttons"'),html.indexOf('</div></div>',html.indexOf('<div class="action-buttons"')));
    assert.doesNotMatch(main,/data-action="raise"|raise-button/);
    assert.match(html,/class="raise-control"[\s\S]*id="raise-button"[\s\S]*id="raise-panel"/);
  }
  setDisplayUnit('points');
});

test('a short all-in stays available above the presets without adding a third main action',()=>{
  const h=setup();h.room.hand.currentBet=100;h.room.actions={...h.room.actions,canRaise:false,canAllIn:true,minRaiseTo:200,maxRaiseTo:155,callAmount:95};
  const html=h.draw();assert.equal(actionButtons(html).length,2);assert.match(html,/class="bet-preset short-allin"[^>]*data-action="allin"[^>]*data-amount="155"/);assert.doesNotMatch(html,/id="raise-panel"|id="raise-toggle"/);
  assert.ok(html.indexOf('class="bet-preset short-allin"')<html.indexOf('class="raise-shortcuts"'));
  h.state.connected=false;assert.match(h.draw(),/<button[^>]*data-action="allin"[^>]*disabled/);h.state.connected=true;
  h.state.busy=true;assert.match(h.draw(),/<button[^>]*data-action="allin"[^>]*disabled/);h.state.busy=false;
  h.room.actions.maxRaiseTo=80;h.room.actions.callAmount=75;h.room.players[0].stack=75;
  const call=h.draw();assert.doesNotMatch(call,/data-action="allin"/);assert.match(call,/All-in 跟注/);
});

test('street and settlement transitions retain fixed disabled slots, hide the slider and describe the actual phase',()=>{
 const h=setup();h.state.raisePanelOpen=true;h.room.actions={canAct:false};h.room.hand.actingId=null;
 for(const [kind,revealed,label] of [['street',false,'准备翻牌…'],['showdown',false,'准备摊牌…'],['showdown',true,'正在比牌…'],['award',false,'准备收池…']]){
  h.room.hand.transition={kind,revealed,nextAt:1000};const html=h.draw();
  assert.equal(actionButtons(html).length,2);assert.ok(actionButtons(html).every(tag=>/disabled/.test(tag)));assert.equal((html.match(/data-preset=/g)||[]).length,4);assert.match(html,/id="raise-toggle"[^>]*disabled/);
  assert.match(html,new RegExp(label));assert.doesNotMatch(html,/id="raise-panel"|data-timeout-action|data-turn-clock/);
  const selection=controls.syncBetControls(h.room,{amount:30,preset:'pot',panelOpen:true,key:'old-turn'});
  assert.equal(selection.key,null);assert.equal(selection.panelOpen,false);
 }
});

// Full point totals must remain visible rather than spill into another live
// bet target or be abbreviated to a different apparent amount.
test('long point quotes retain exact digits and can wrap inside the fixed-height preset',()=>{
  setDisplayUnit('points');const h=setup();h.room.hand.pot=300000;h.room.hand.currentBet=0;h.room.players[0].bet=0;h.room.actions.callAmount=0;h.room.actions.maxRaiseTo=2000000;h.room.actions.minRaiseTo=10;
  const html=h.draw();assert.match(html,/class="bet-preset-amount">100,000 积分<\/strong>/);assert.match(html,/class="bet-preset-amount">300,000 积分<\/strong>/);
  assert.match(css,/\.bet-preset-amount\{[^}]*max-width:100%[^}]*white-space:normal[^}]*overflow-wrap:anywhere/);
  assert.match(css,/\.raise-shortcuts button\{height:44px;min-height:44px/);
});

// The ceiling is the current legal total (including chips already committed on
// this street). A next-hand top-up cannot silently increase an all-in quote.
test('the picker displays one selected amount and shows the exact legal all-in total only at maximum',()=>{
  for(const unit of ['points','bb']){
    setDisplayUnit(unit);const h=setup();h.room.players[0].bet=5;h.room.players[0].stack=2000;h.room.players[0].pendingBuyIn=5000;h.room.actions.maxRaiseTo=2005;h.state.raise=20;
    const html=h.draw(),selected=html.match(/class="raise-selection-amount">(.*?)<\/strong>/);
    assert.equal(selected?.[1],formatChips(20,10));assert.doesNotMatch(html,/raise-stack-limit|>全押 /);
    const panel=html.slice(html.indexOf('<section class="raise-popover"'),html.indexOf('</section>',html.indexOf('<section class="raise-popover"')));
    assert.doesNotMatch(panel,/id="raise-button"/);assert.equal((panel.match(/class="raise-selection-amount"/g)||[]).length,1);
    assert.match(html,/<button[^>]*id="raise-button"[^>]* hidden/);assert.doesNotMatch(html,/<button[^>]*id="raise-toggle"[^>]* hidden/);
    assert.match(html,/class="raise-control"[\s\S]*id="raise-toggle"[\s\S]*id="raise-panel"/);
    assert.match(html,/id="raise-panel"[^>]*style="--raise-progress:0;--raise-fill:0%"/);
    assert.match(html,/id="raise-range"[^>]*value="0"[^>]*style="--raise-fill:0%"/);
    h.state.raise=2005;h.state.raisePanelOpen=true;const maximum=h.draw();
    assert.match(maximum,/<button[^>]*id="raise-toggle"[^>]* hidden/);assert.doesNotMatch(maximum,/<button[^>]*id="raise-button"[^>]* hidden/);assert.doesNotMatch(maximum,/收起|全押 /);
    assert.match(maximum,/id="raise-range"[^>]*value="1000"[^>]*style="--raise-fill:100%"/);
    const submit=maximum.match(/<button[^>]*id="raise-button"[^>]*>(.*?)<\/button>/);
    assert.equal(submit?.[1],'All-in');assert.ok(maximum.includes(`aria-label="All-in ${formatChips(2005,10)}，点击直接下注"`));
    assert.match(maximum,/id="raise-panel"[^>]*style="--raise-progress:1;--raise-fill:100%"/);
  }
  setDisplayUnit('points');
});
