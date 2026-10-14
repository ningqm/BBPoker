import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as lifecycle from '../public/lifecycle.js';
import * as controls from '../public/table-controls.js';
import {formatChips,getDisplayUnit} from '../public/money.js';
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

test('the same three actions, four presets and inline amount opener remain present through every table phase',()=>{
  const h=setup();const situations=[()=>{},()=>{h.room.actions.canAct=false;},()=>{h.room.hand.status='complete';},()=>{h.room.hand=null;},()=>{h.room.status='closed';}];
  for(const change of situations){change();const html=h.draw();assert.equal(actionButtons(html).length,3);assert.equal((html.match(/data-preset=/g)||[]).length,4);assert.match(html,/class="action-area action-dock /);
    const row=html.slice(html.indexOf('<div class="raise-shortcuts"'),html.indexOf('<div class="action-buttons"'));
    assert.equal((row.match(/<button\b/g)||[]).length,5);assert.equal((row.match(/id="raise-toggle"/g)||[]).length,1);assert.doesNotMatch(row,/data-preset="(?:all|over)"/);}
  assert.match(css,/\.table-bottom\{flex:0 0 146px;height:146px;min-height:146px/);
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

test('rendering after a presence update preserves only the explicitly chosen rounded preset',()=>{
  const h=setup();h.state.raise=20;h.state.raisePreset='third';assert.equal(controls.betPresetOptions(h.room).find(p=>p.id==='third').amount,controls.betPresetOptions(h.room).find(p=>p.id==='half').amount);
  let html=h.draw();assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);assert.match(html,/class="selected"[^>]*data-preset="third"/);
  h.room.players[1].connected=false;html=h.draw();assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);
  h.state.raisePreset='half';html=h.draw();assert.match(html,/class="selected"[^>]*data-preset="half"/);assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);
});

test('street and settlement transitions retain fixed disabled slots, hide the slider and describe the actual phase',()=>{
 const h=setup();h.state.raisePanelOpen=true;h.room.actions={canAct:false};h.room.hand.actingId=null;
 for(const [kind,revealed,label] of [['street',false,'准备翻牌…'],['showdown',false,'准备摊牌…'],['showdown',true,'正在比牌…'],['award',false,'准备收池…']]){
  h.room.hand.transition={kind,revealed,nextAt:1000};const html=h.draw();
  assert.equal(actionButtons(html).length,3);assert.ok(actionButtons(html).every(tag=>/disabled/.test(tag)));assert.equal((html.match(/data-preset=/g)||[]).length,4);assert.match(html,/id="raise-toggle"[^>]*disabled/);
  assert.match(html,new RegExp(label));assert.doesNotMatch(html,/id="raise-panel"|data-timeout-action|data-turn-clock/);
  const selection=controls.syncBetControls(h.room,{amount:30,preset:'pot',panelOpen:true,key:'old-turn'});
  assert.equal(selection.key,null);assert.equal(selection.panelOpen,false);
 }
});
