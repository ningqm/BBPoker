import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import * as scene from '../public/table-scene.js';
import * as statsUI from '../public/stats.js';
import { renderHandCategory } from '../public/hand-category.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as lifecycle from '../public/lifecycle.js';
import {formatChips,setDisplayUnit,getDisplayUnit} from '../public/money.js';
import {revealOptions,betActionEnabled} from '../public/table-controls.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);};
function harness({realBoardCards=false}={}){
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,...scene,lifecycle,renderHandCategory,formatChips,getDisplayUnit,revealOptions,betActionEnabled,Date,state:{clock:createRoomClock(),connected:true,connection:'已连接',animations:false,fun:false,chatUnread:0},
    avatar:()=>'<span class="avatar">B</span>',renderSeatMask:()=>'',reactionBubble:()=>'',statsUI,formatAction:a=>a.type||a,
    boardCard:()=>'<span class="board-slot"></span>',streetNames:{flop:'翻牌'},
    autoDealText:()=> '5 秒后自动发下一手',actionArea:()=>'<div class="action-area"></div>',chatPanel:()=>'',errorPage:()=>''});
  vm.runInContext([section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('const card=','const feedback='),realBoardCards?section('function boardCard(','async function playerStatsModal('):'',section('const layouts=','function boardCard('),section('function tableCenter(','function seatActions('),section('function roomView(){','function tableInfoModal('),section('function miniPanel(','function autoDealText('),section('function roomClock(','function tick('),'globalThis.client={state,seatView,seatHoleCards,tableCenter,roomView,roomStatusBar,gameModeMarkers,miniPanel,seatTimeBankEnabled};'].join('\n'),context);
  return context.client;
}
function room(count=9){return {code:'fixture',name:'本地验收桌',status:'waiting',hostId:'p0',meId:'p0',settings:{maxPlayers:count,smallBlind:5,bigBlind:10,durationMinutes:60,squid:true,squidUnit:20,squidUnitBB:2,bombPot:true,bombAnte:30,bombAnteBB:3,bombIntervalMinutes:10},players:Array.from({length:count},(_,i)=>({id:'p'+i,name:'玩家昵称'+i,seat:i,stack:2000,connected:true})),mini:{squid:{active:false}},actions:{}};}

test('idle table moves settings into the compact header and reserves the felt for play',()=>{
  setDisplayUnit('points');const c=harness(),r=room(2);c.state.room=r;const html=c.roomView(),head=html.slice(0,html.indexOf('<div class="game-grid"')),center=c.tableCenter(r);
  assert.match(head,/本地验收桌/);assert.match(head,/data-connection/);assert.match(head,/data-action="invite"/);assert.match(head,/room-status-bar/);
  assert.match(head,/5 \/ 10 积分/);assert.match(head,/data-room-clock="compact"/);assert.match(head,/>未开始</);assert.match(head,/60 分钟 · 首手开始计时/);assert.match(head,/每条 20 积分/);assert.match(head,/每人前注 30 积分/);assert.match(head,/title="1 BB = 10 积分"/);
  assert.doesNotMatch(center,/table-config|game-mode-markers|table-blinds|data-room-clock/);assert.match(center,/朋友已就位/);
});

test('compact header retains live mode counts through active, completed, rabbit and all-in states',()=>{
  setDisplayUnit('bb');const c=harness(),r=room();c.state.room=r;r.endsAt=Date.now()+60000;
  const hand={id:'h',number:1,status:'playing',street:'flop',board:['As','Kh','2d'],pot:990,bombPot:true,squidRound:2};
  r.mini.squid={active:true,round:2,unit:40,participants:r.players.map(p=>p.id),won:['p1','p2']};
  for(const extras of [{},{status:'complete',result:{mainWinnerIds:['p0'],pots:[{amount:990}]}},{rabbit:{board:['As','Kh','2d','3c','4s'],originalCount:3}},{equity:{pots:[{amount:990}]},runout:{active:true}}]){
    r.hand={...hand,...extras};const html=c.tableCenter(r),header=c.roomStatusBar(r);assert.doesNotMatch(html,/data-room-clock|table-blinds|game-mode-markers/);assert.equal((html.match(/class="board-slot"/g)||[]).length,5);
    assert.equal((header.match(/data-room-clock/g)||[]).length,1);assert.match(header,/0\.5 \/ 1 BB/);assert.match(header,/每条 4 BB/);assert.match(header,/>鱿鱼 2\/9</);assert.match(header,/2\/9 有鱼/);assert.match(html,/>99 BB</);
  }
  setDisplayUnit('points');
});

test('every seat count and rotated viewpoint preserves unique seats and names outside the avatar row',()=>{
  setDisplayUnit('points');const c=harness();
  for(let count=2;count<=9;count++){
    const r=room(count);r.meId='p'+(count-1);c.state.room=r;const drawn=r.players.map((_,i)=>c.seatView(i,r));
    assert.equal(new Set(drawn.map(html=>html.match(/data-relative-seat="(\d+)"/)[1])).size,count);
    for(let i=0;i<count;i++){const html=drawn[i];assert.match(html,new RegExp(`data-player-id="p${i}"`));assert.match(html,/data-side="(?:left|right|center)"/);assert.ok(html.indexOf('class="name"')<html.indexOf('class="stack-value"'));assert.ok(html.indexOf('class="stack-value"')<html.indexOf('class="seat-identity"'));assert.ok(html.indexOf('seat-avatar-button')<html.indexOf('seat-status'));}
  }
});

test('long player names and status descriptions are escaped, with all-in and position markers retained',()=>{
  const c=harness(),r=room(2),p=r.players[1];c.state.room=r;p.name='<img src=x onerror=alert(1)>';p.inHand=true;p.cards=['As','Kd'];p.allIn=true;p.stack=0;p.bet=1234;p.squidWon=true;
  r.hand={id:'h',status:'playing',buttonSeat:1,smallBlindSeat:1,bigBlindSeat:0};const html=c.seatView(1,r);
  assert.doesNotMatch(html,/<img/);assert.match(html,/title="&lt;img/);assert.match(html,/aria-label="查看 &lt;img/);assert.match(html,/title="庄家"/);assert.match(html,/title="小盲"/);assert.match(html,/squid-mark/);assert.match(html,/class="seat-allin-label"[^>]*>All-in</);assert.doesNotMatch(html,/bet-allin-label|class="seat-status[^>]*>All-in</);assert.match(html,/1,234 积分/);
});

test('unit display changes rendered amounts without modifying seat, pot or settings values',()=>{
  const c=harness(),r=room(2);r.hand={id:'h',status:'playing',number:1,street:'flop',pot:35,board:[]};r.players[0].inHand=true;r.players[0].bet=15;c.state.room=r;const before=JSON.stringify(r);
  setDisplayUnit('bb');const bb=c.seatView(0,r)+c.tableCenter(r)+c.roomStatusBar(r);assert.match(bb,/200 <small class="stack-unit">BB<\/small>/);assert.match(bb,/1\.5 BB/);assert.match(bb,/3\.5 BB/);assert.match(bb,/1 BB = 10 积分/);
  setDisplayUnit('points');const points=c.seatView(0,r)+c.tableCenter(r)+c.roomStatusBar(r);assert.match(points,/class="stack-value">2,000<\/div>/);assert.match(points,/15 积分/);assert.match(points,/35 积分/);assert.equal(JSON.stringify(r),before);
});

test('nine-way runout removes repeated wagers while preserving every public hand, category and main-pot equity',()=>{
  setDisplayUnit('points');const c=harness(),r=room(9);c.state.room=r;r.status='playing';
  const hands=[['As','Ad'],['Ks','Kd'],['Qs','Qd'],['Js','Jd'],['Ts','Td'],['9s','9d'],['8s','8d'],['7s','7d'],['6s','6d']];
  r.hand={id:'nine-compact',number:8,status:'playing',street:'preflop',board:[],pot:900,runout:{active:true},equity:{method:'monte-carlo',players:r.players.map((p,i)=>({id:p.id,equity:i===0?20:10})),pots:[]}};
  r.players.forEach((p,i)=>Object.assign(p,{inHand:true,allIn:true,stack:0,bet:100,contributed:100,cards:hands[i],handCategory:'一对'}));
  const before=JSON.stringify(r);
  for(const state of [{runout:{active:true},transition:null},{runout:{active:false},transition:{kind:'showdown',revealed:true}}]){
    Object.assign(r.hand,state);const html=r.players.map((_,i)=>c.seatView(i,r)).join('');
    assert.equal((html.match(/class="seat-allin-label"/g)||[]).length,9);
    assert.equal((html.match(/class="hole-cards/g)||[]).length,9);assert.equal(elements(markupTree(html)).filter(node=>hasClass(node,'card')).length,18);
    assert.equal((html.match(/class="equity-badge/g)||[]).length,9);assert.equal((html.match(/data-hand-category="pair"/g)||[]).length,9);
    assert.doesNotMatch(html,/class="bet-chip|bet-allin-label/);
    assert.match(html,/主池权益/);assert.match(html,/含平分份额/);assert.match(html,/此百分比不代表各边池权益/);
  }
  Object.assign(r.hand,{runout:{active:true}});delete r.hand.transition;assert.equal(JSON.stringify(r),before,'compacting the display never sweeps or modifies chips locally');
});

test('deep callers, folded players and newly seated players never inherit a zero-stack All-in marker',()=>{
  setDisplayUnit('points');const c=harness(),r=room(3);c.state.room=r;r.hand={id:'live',status:'playing',board:[],street:'flop',runout:{active:true}};
  const p=r.players[1];Object.assign(p,{inHand:true,allIn:false,stack:500,bet:100,contributed:300});
  let html=c.seatView(1,r);assert.match(html,/class="stack-value">500<\/div>/);assert.doesNotMatch(html,/seat-allin-label|class="bet-chip/);
  p.allIn=true;assert.doesNotMatch(c.seatView(1,r),/seat-allin-label/,'inconsistent old All-in flag must not hide real remaining chips');
  p.stack=0;assert.match(c.seatView(1,r),/class="seat-allin-label">All-in<\/span>/);
  p.folded=true;assert.doesNotMatch(c.seatView(1,r),/seat-allin-label/);p.folded=false;p.inHand=false;assert.doesNotMatch(c.seatView(1,r),/seat-allin-label/);
  p.inHand=true;r.hand.status='complete';r.hand.result={payouts:{[p.id]:500}};p.stack=500;html=c.seatView(1,r);
  assert.doesNotMatch(html,/seat-allin-label|class="bet-chip/);assert.match(html,/class="stack-value">500<\/div>/);assert.match(html,/收池 500 积分/);
});

test('a live betting round retains the wager amount and only the card shows All-in',()=>{
  setDisplayUnit('points');const c=harness(),r=room(3);c.state.room=r;r.hand={id:'betting',status:'playing',actingId:'p2',board:[],street:'preflop'};
  const p=r.players[1];Object.assign(p,{inHand:true,allIn:true,stack:0,bet:150,contributed:150});
  let html=c.seatView(1,r);assert.match(html,/class="seat-allin-label">All-in<\/span>/);assert.match(html,/class="bet-chip/);assert.match(html,/本轮已投入 150 积分，All-in/);assert.match(html,/class="bet-value">150/);assert.doesNotMatch(html,/bet-allin-label/);
  p.bet=0;html=c.seatView(1,r);assert.match(html,/seat-allin-label/);assert.doesNotMatch(html,/class="bet-chip/,'previous street All-in does not create an empty wager label');
});

test('the total pot opens equity details on demand without a separate table button or losing side pots',()=>{
  setDisplayUnit('points');const c=harness(),r=room(3);c.state.room=r;r.hand={id:'pots',number:1,status:'playing',street:'flop',board:['As','Kh','2d'],pot:800,pots:[{amount:300,eligibleIds:['p0','p1','p2']},{amount:500,eligibleIds:['p1','p2']}]};r.players[0].inHand=true;r.players[0].allIn=true;
  let html=c.tableCenter(r);assert.match(html,/<div class="pot-total">/);assert.doesNotMatch(html,/data-action="equity-details"/);
  r.hand.equity={players:[],pots:[]};html=c.tableCenter(r);
  assert.equal((html.match(/data-action="equity-details"/g)||[]).length,1);assert.match(html,/<button[^>]*data-action="equity-details"[^>]*aria-label="查看主池及各边池胜率"[^>]*class="pot-total/);
  assert.doesNotMatch(html,/equity-runout|>胜率详情</);assert.match(html,/总底池<\/span><strong>800 积分/);assert.match(html,/主池<b>300 积分/);assert.match(html,/边池 1<b>500 积分/);
});

test('on-demand equity details retain eligible side-pot players and explain the seat percentage',()=>{
  setDisplayUnit('points');const r=room(3),rows=[{id:'p0',equity:20,winPct:15,tiePct:10},{id:'p1',equity:35,winPct:35,tiePct:0},{id:'p2',equity:45,winPct:45,tiePct:0}];
  r.hand={board:['As','Kh','2d'],equity:{method:'exact',samples:990,players:rows,pots:[{amount:300,eligibleIds:['p0','p1','p2'],players:rows},{amount:500,eligibleIds:['p1','p2'],players:[{id:'p0',equity:99},{id:'p1',equity:40},{id:'p2',equity:60}]}]}};
  let opened;const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,state:{clock:createRoomClock(),room:r},dialog:{scrollTop:12,querySelector:()=>null},card:()=>'',formatChips,num:String,openModal:(title,body,kind)=>{opened={title,body,kind};}});
  vm.runInContext([section('const esc=','const fmtDate='),section('function equityDetails(','function miniPanel('),'equityDetails();'].join('\n'),context);
  assert.equal(opened.title,'全下胜率');assert.equal(opened.kind,'equity');assert.match(opened.body,/座位上的百分比为主池权益，平局按分得的份额计入/);
  const potSections=[...opened.body.matchAll(/<section class="table-info-section">([\s\S]*?)<\/section>/g)].map(match=>match[1]);assert.equal(potSections.length,2);
  assert.match(potSections[0],/玩家昵称0/);assert.doesNotMatch(potSections[1],/玩家昵称0|99\.0%/);assert.match(potSections[1],/玩家昵称1[\s\S]*40\.0%/);assert.match(potSections[1],/玩家昵称2[\s\S]*60\.0%/);assert.equal(context.dialog.scrollTop,12);
});

test('narrow-screen rules keep badges beside the identity card and retain reachable play and reveal controls',()=>{
  const css=readFileSync(new URL('../public/table-interactions.css',import.meta.url),'utf8');
  assert.match(css,/\.seat-identity \.seat-avatar-button\{position:relative;left:auto;top:auto/);assert.match(css,/\.table-stage \.seat \.name\{min-width:0;max-width:none/);assert.match(css,/\.seat\[data-side="left"\]\{--seat-x:4%/);assert.match(css,/\.seat\[data-side="right"\]\{--seat-x:96%/);assert.match(css,/@media\(max-width:360px\)/);
  assert.match(css,/\.table-stage \.seat \.seat-label\{position:absolute;top:\d+px;right:-\d+px;[^}]*flex-direction:column/);assert.match(css,/\.seat\[data-side="left"\] \.seat-label\{left:-\d+px;right:auto/);
  assert.match(css,/\.table-stage \.seat \.hole-cards\{[^}]*top:auto;bottom:calc\(100% \+ 5px\)/);assert.match(css,/\.table-bottom \.action-buttons button\{[^}]*min-height:44px/);assert.match(css,/\.table-config \.game-mode \.mode-state\{[^}]*text-overflow:ellipsis/);
});

test('only my completed hand is clickable, and public labels survive server refresh without local reveal state',()=>{
  const c=harness(),r=room(2),me=r.players[0];c.state.room=r;
  Object.assign(me,{inHand:true,cards:['As','Kh'],shownIndices:[]});r.hand={id:'h-safe',status:'playing',buttonSeat:0,smallBlindSeat:0,bigBlindSeat:1};
  assert.doesNotMatch(c.seatView(0,r),/data-action="show-card"/);
  r.hand.status='complete';let html=c.seatView(0,r);
  assert.equal((html.match(/data-action="show-card"/g)||[]).length,2);assert.match(html,/data-index="0" data-hand="h-safe"/);assert.match(html,/data-index="1" data-hand="h-safe"/);
  assert.ok(html.indexOf('hole-cards')<html.indexOf('class="name"'));assert.ok(html.indexOf('seat-status')<html.indexOf('seat-label'));
  me.shownIndices=[0];html=c.seatView(0,r);
  assert.match(html,/<button[^>]*data-index="0"[^>]*aria-label="已亮出 A黑桃"[^>]*disabled/);
  assert.match(html,/<button[^>]*data-index="1"[^>]*aria-label="向所有人亮出 K红桃"\s*>/);
  const fresh=harness();fresh.state.room=r;assert.equal(fresh.seatView(0,r),html);
  me.shownIndices=[0,1];assert.equal((c.seatView(0,r).match(/data-action="show-card"[^>]*disabled/g)||[]).length,2);
  r.meId='p1';me.cards=['As',null];me.shownIndices=[0];html=c.seatView(0,r);
  assert.doesNotMatch(html,/data-action="show-card"|K红桃|♥K/);assert.match(html,/未公开的牌/);
});

test('show-card controls remain visible but disabled while disconnected or another command is pending',()=>{
  const c=harness(),r=room(2),me=r.players[0];c.state.room=r;r.hand={id:'h',status:'complete'};Object.assign(me,{inHand:true,cards:['As','Kh'],shownIndices:[]});
  for(const state of [{connected:false,busy:false},{connected:true,busy:true}]){Object.assign(c.state,state);assert.equal((c.seatHoleCards(me,r).match(/data-action="show-card"[^>]*disabled/g)||[]).length,2);}
});

test('identity card and avatar open player data instead of an entertainment interaction',()=>{
  const c=harness(),r=room(9);c.state.room=r;
  for(let i=0;i<r.players.length;i++){
    const html=c.seatView(i,r),buttons=html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)||[];
    assert.equal(buttons.length,1);assert.match(buttons[0],/class="seat-avatar-button"/);
    assert.match(buttons[0],new RegExp(`data-player="p${i}"`));assert.match(buttons[0],/aria-label="查看 玩家昵称\d 的数据"/);
    assert.match(buttons[0],/data-action="player-stats"/);assert.match(html,new RegExp(`<div class="seat-main" data-action="player-stats" data-player="p${i}">`));assert.doesNotMatch(html,/seat-interaction-hit|data-action="interact"/);
  }
});
test('identity data controls retain separate own-card reveals and empty seats',()=>{
  const c=harness(),r=room(3);c.state.room=r;
  r.hand={id:'own-hand',status:'complete'};Object.assign(r.players[0],{inHand:true,cards:['As','Kh'],shownIndices:[]});
  const own=c.seatView(0,r);assert.equal((own.match(/data-action="show-card"/g)||[]).length,2);assert.equal((own.match(/data-action="player-stats"/g)||[]).length,2);
  assert.doesNotMatch(own,/seat-interaction-hit/);r.players.pop();assert.doesNotMatch(c.seatView(2,r),/data-action="player-stats"/);
});

test('blind badges remain while routine actions stay hidden and All-in replaces the empty stack', () => {
  const c=harness(),r=room(2);c.state.room=r;
  r.hand={id:'h',status:'playing',buttonSeat:0,smallBlindSeat:0,bigBlindSeat:1};
  for (const [i,type] of [[0,'smallBlind'],[1,'bigBlind']]) {
    r.players[i].inHand=true;r.players[i].lastAction={type};
    const html=c.seatView(i,r);
    assert.match(html, /class="seat-status\s*" title="" data-tone="[^\"]*"><\/div>/);
    assert.match(html, new RegExp(i===0?'title="小盲"':'title="大盲"'));
  }
  assert.match(c.seatView(0,r), /class="dealer-button" title="庄家" aria-label="庄家"/);
  r.players[0].lastAction={type:'raise',to:50};
  assert.doesNotMatch(c.seatView(0,r), /title="raise"/);
  r.players[0].lastAction=null;r.players[0].allIn=true;r.players[0].stack=0;r.players[0].bet=100;
  const html=c.seatView(0,r);assert.match(html,/class="seat-allin-label"[^>]*>All-in</);assert.doesNotMatch(html,/bet-allin-label|class="seat-status[^>]*>All-in</);
});

test('nine-player unlimited and bomb markers retain exact fish counts for every viewpoint',()=>{
  const c=harness(),r=room(9);c.state.room=r;setDisplayUnit('bb');r.settings.squidMode='unlimited';r.settings.squidExtraTokens=3;
  r.mini.squid={active:true,mode:'unlimited',round:2,unit:20,extraTokens:3,tokenBudget:12,participants:r.players.map(p=>p.id),counts:Object.fromEntries(r.players.map((p,i)=>[p.id,i===4?3:i===5?1:0])),won:['p4','p5']};
  r.players[4].squidCount=3;r.players[5].squidCount=1;
  r.hand={id:'nine',number:8,status:'playing',street:'flop',board:['As','2h','3c'],pot:270,bombPot:true,buttonSeat:4,smallBlindSeat:5,bigBlindSeat:6,squidRound:2};
  const markers=c.gameModeMarkers(r);assert.match(markers,/无限/);assert.match(markers,/余 8\/12 · 7人无鱼/);assert.match(markers,/本手炸弹池/);assert.match(markers,/每条 2 BB/);
  for(const me of ['p0','p4','p8']){r.meId=me;for(let seat=0;seat<9;seat++){const html=c.seatView(seat,r);assert.doesNotMatch(html,/title="小盲"|title="大盲"/);if(seat===4){assert.match(html,/title="庄家"/);assert.match(html,/本轮已获 3 条鱼/);assert.match(html,/>鱼×3</);}}}
  const panel=c.miniPanel(r);assert.match(panel,/本轮 12 条鱼，剩余 8 条；7 人还没鱼/);assert.equal((panel.match(/<span class="(?:has-fish|no-fish)">/g)||[]).length,9);assert.match(panel,/未发出的鱼不计费/);
  setDisplayUnit('points');
});

test('settled squid displays the actual posted mini result without changing poker pot or current counts',()=>{
  const c=harness(),r=room(9);c.state.room=r;r.settings.squidMode='unlimited';
  r.mini.squid={active:false,round:1,lastResult:{round:1,mode:'unlimited',tokensExhausted:true,changes:{p0:180,p1:-120}}};
  const before=JSON.stringify(r),panel=c.miniPanel(r);assert.match(panel,/第 1 轮已结算/);assert.match(panel,/本轮鱼已发完/);assert.match(panel,/我的鱿鱼盈亏.*\+180 积分/);assert.match(panel,/本场小游戏盈亏/);assert.match(c.gameModeMarkers(r),/第 1 轮已结算/);assert.equal(JSON.stringify(r),before);
});

test('mid-round admission displays authoritative grown budgets and retains departed fish holders in both modes',()=>{
  const c=harness();setDisplayUnit('points');
  for(const mode of ['normal','unlimited']){
    const r=room(9);r.settings.squidMode=mode;r.settings.squidExtraTokens=3;c.state.room=r;
    const departed={id:'old',name:'原轮已离座',seat:null,stack:0,connected:false};r.players.push(departed);
    const participants=[...r.players.map(p=>p.id)],budget=mode==='normal'?9:13;
    r.mini.squid={active:true,mode,round:3,unit:20,extraTokens:3,tokenBudget:budget,participants,counts:Object.fromEntries(participants.map(id=>[id,id==='old'?mode==='normal'?1:3:0])),won:['old']};
    const before=JSON.stringify(r),panel=c.miniPanel(r),markers=c.gameModeMarkers(r);
    assert.equal((panel.match(/<span class="(?:has-fish|no-fish)">/g)||[]).length,10);
    assert.match(panel,/原轮已离座/);assert.match(panel,new RegExp(mode==='normal'?'本轮共 9 条，剩余 8 条':'本轮 13 条鱼，剩余 10 条'));
    assert.match(markers,new RegExp(mode==='normal'?'1/10 有鱼':'余 10/13 · 9人无鱼'));
    assert.doesNotMatch(c.seatView(8,r),/squid-mark/);assert.equal(JSON.stringify(r),before);
  }
});

test('waiting newcomer seat and mini details show the next-hand quote without counting a player before admission',()=>{
  const c=harness(),r=room(4);setDisplayUnit('bb');c.state.room=r;r.meId='p3';
  r.mini.squid={active:true,mode:'unlimited',round:2,unit:20,extraTokens:3,tokenBudget:6,participants:['p0','p1','p2'],counts:{p0:2,p1:0,p2:0},won:['p0']};
  const p=r.players[3];p.waitingFor='squid';p.squidJoin={status:'reserve',round:2,reason:'<队友>需补足预留，原轮继续',requiredReserve:140,tokenBudgetAfterJoin:7};
  const seat=c.seatView(3,r),panel=c.miniPanel(r);
  assert.match(seat,/title="等预留"/);assert.doesNotMatch(seat,/squid-mark|等待下一轮/);
  assert.match(panel,/&lt;队友&gt;需补足预留/);assert.doesNotMatch(panel,/<队友>/);assert.match(panel,/预计本人预留 14 BB，加入后共 7 条鱼/);assert.match(panel,/本轮 6 条鱼，剩余 4 条/);
  assert.equal((panel.match(/<span class="(?:has-fish|no-fish)">/g)||[]).length,3);
  r.mini.squid.participants.push('p3');r.mini.squid.counts.p3=0;r.mini.squid.tokenBudget=7;p.waitingFor=null;p.squidJoin=null;
  const joined=c.miniPanel(r);assert.match(joined,/本轮 7 条鱼，剩余 5 条；3 人还没鱼/);assert.doesNotMatch(joined,/预计本人预留|需补足预留/);assert.equal((joined.match(/<span class="(?:has-fish|no-fish)">/g)||[]).length,4);
  setDisplayUnit('points');
});


// Parse the rendered structure, so these assertions check where controls live
// instead of relying on the order of sibling template strings.
function markupTree(html) {
  const root={tag:'#document',attrs:{},children:[],text:'',parent:null},stack=[root];
  for(const part of html.match(/<[^>]+>|[^<]+/g)||[]){
    if(part.startsWith('</')){stack.pop();continue;}
    if(part.startsWith('<')){
      const match=part.match(/^<([a-z][\w-]*)\b([^>]*)>/i);if(!match)continue;
      const attrs={};for(const row of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[row[1]]=row[2]??'';
      const parent=stack.at(-1),node={tag:match[1],attrs,children:[],text:'',parent};parent.children.push(node);
      if(!['input','img','br','hr','meta','link'].includes(node.tag)&&!part.endsWith('/>'))stack.push(node);
    }else for(const node of stack)node.text+=part;
  }
  return root;
}
const elements=node=>node.children.flatMap(child=>[child,...elements(child)]);
const hasClass=(node,name)=>(node.attrs.class||'').split(/\s+/).includes(name);
const oneClass=(node,name)=>elements(node).find(child=>hasClass(child,name));

function thinkingRoom(){
  const r=room(9);r.status='playing';r.settings.actionSeconds=20;r.settings.timeBankCards=6;
  Object.assign(r.players[0],{inHand:true,timeBankCardsRemaining:6,cards:['As','Kh']});
  r.hand={id:'thinking',status:'playing',actingId:'p0',actionReadyAt:Date.now()-100,turnStartedAt:Date.now()-100};
  r.deadline=Date.now()+19900;r.actions={canAct:true,canUseTimeBank:true,timeBankCards:6};return r;
}

test('All-in occupies the zero-stack line while the actual inward wager contains only its amount',()=>{
  setDisplayUnit('points');const c=harness(),r=room(9),p=r.players[1];c.state.room=r;
  Object.assign(p,{inHand:true,allIn:true,stack:0,bet:1100,contributed:1500,cards:['As','Kh']});r.hand={status:'playing'};
  for(const viewer of ['p0','p1','p4','p8']){
    r.meId=viewer;const tree=markupTree(c.seatView(1,r)),chip=oneClass(tree,'bet-chip'),label=oneClass(tree,'seat-allin-label'),main=oneClass(tree,'seat-main');
    assert.equal(label.parent,oneClass(main,'stack-value'));assert.equal(chip.parent,main.parent);assert.equal(label.text,'All-in');
    assert.equal(oneClass(chip,'bet-value').text,'1,100 积分');assert.doesNotMatch(chip.text,/All-in/);assert.doesNotMatch(oneClass(main,'hole-cards').text,/All-in/);
    assert.match(chip.attrs['aria-label'],/本轮.*1,100.*All-in/);assert.equal(elements(tree).filter(el=>hasClass(el,'seat-allin-label')).length,1);assert.equal(oneClass(tree,'bet-allin-label'),undefined);
  }
});

test('after the street sweeps chips in, All-in stays visible without inventing a second cumulative wager',()=>{
  setDisplayUnit('points');const c=harness(),r=room(9),p=r.players[1];c.state.room=r;
  Object.assign(p,{inHand:true,allIn:true,stack:0,bet:0,contributed:1500});r.hand={status:'playing',runout:{active:true}};
  const before=JSON.stringify(r),tree=markupTree(c.seatView(1,r)),chip=oneClass(tree,'bet-chip');
  assert.equal(chip,undefined);assert.equal(oneClass(tree,'seat-allin-label').text,'All-in');
  assert.doesNotMatch(tree.text,/1,500|0 积分/);assert.equal(JSON.stringify(r),before);
  p.folded=true;assert.equal(oneClass(markupTree(c.seatView(1,r)),'bet-chip'),undefined);
  p.folded=false;r.hand.status='complete';assert.equal(oneClass(markupTree(c.seatView(1,r)),'bet-chip'),undefined);
});

test('own time cards and countdown share one seat-side control area with no copy on other seats',()=>{
  const c=harness(),r=thinkingRoom();c.state.room=r;
  const tree=markupTree(c.seatView(0,r)),tools=oneClass(tree,'seat-time-tools'),main=oneClass(tree,'seat-main');
  const clock=oneClass(tools,'seat-turn'),button=elements(tools).find(n=>n.attrs['data-action']==='timebank');
  assert.ok(clock);assert.equal(tools.parent,main.parent);assert.equal(button.tag,'button');assert.equal(button.attrs.type,'button');
  assert.match(button.text,/\+30秒.*6张/);assert.ok(!('disabled' in button.attrs));
  assert.ok(!elements(main).some(n=>n.attrs['data-action']==='timebank'),'the timer control is outside the player-stats hit area');
  for(let i=1;i<9;i++)assert.doesNotMatch(c.seatView(i,r),/data-action="timebank"/);
  r.hand.actingId='p1';r.actions.canAct=false;r.actions.canUseTimeBank=false;
  const waiting=markupTree(c.seatView(0,r)),waitingTools=oneClass(waiting,'seat-time-tools');
  assert.ok(waitingTools,'off-turn controls stay in a predictable place');assert.equal(oneClass(waitingTools,'seat-turn'),undefined);
  assert.ok('disabled' in elements(waitingTools).find(n=>n.attrs['data-action']==='timebank').attrs);
});

test('each opponent clock and fish counter remain in the identity grid with name, stack and avatar retained',()=>{
  const c=harness(),r=thinkingRoom();c.state.room=r;
  for(let index=1;index<9;index++){
    r.hand.actingId='p'+index;r.players[index].squidWon=true;
    const tree=markupTree(c.seatView(index,r)),main=oneClass(tree,'seat-main'),identity=oneClass(main,'seat-identity');
    assert.equal(oneClass(identity,'seat-turn').parent,identity);
    assert.ok(oneClass(main,'name').text.length>0);assert.ok(oneClass(main,'stack-value').text.length>0);
    assert.ok(oneClass(identity,'seat-avatar-button'));assert.ok(oneClass(oneClass(main,'seat-label'),'squid-count'));
    assert.equal(oneClass(tree,'seat-time-tools'),undefined,'only the hero needs an outside time-card control group');
    assert.equal(elements(tree).filter(n=>hasClass(n,'seat-turn')).length,1);
  }
});

test('seat time cards respect fresh actor, connection and presentation state and update remaining count',()=>{
  for(const [name,change] of [
    ['off turn',(c,r)=>{r.hand.actingId='p1';r.actions.canAct=false;}],
    ['busy',c=>c.state.busy=true],['disconnected',c=>c.state.connected=false],['resync',c=>c.state.feedbackResync=true],
    ['street transition',(c,r)=>r.hand.transition={kind:'street',nextAt:Date.now()+900}],
    ['showdown transition',(c,r)=>r.hand.transition={kind:'showdown',nextAt:Date.now()+900}],
    ['runout',(c,r)=>r.hand.runout={active:true}],['flip pending',(c,r)=>r.hand.actionReadyAt=Date.now()+900],
    ['expired deadline',(c,r)=>r.deadline=Date.now()-1],['missing deadline',(c,r)=>r.deadline=null],
    ['exhausted',(c,r)=>{r.actions.timeBankCards=0;r.actions.canUseTimeBank=false;}],
  ]){
    const c=harness(),r=thinkingRoom();c.state.room=r;change(c,r);
    const button=elements(markupTree(c.seatView(0,r))).find(n=>n.attrs['data-action']==='timebank');
    assert.ok(button,name);assert.ok('disabled' in button.attrs,name);assert.equal(c.seatTimeBankEnabled(r),false,name);
  }
  const c=harness(),r=thinkingRoom();c.state.room=r;r.actions.timeBankCards=2;
  let button=elements(markupTree(c.seatView(0,r))).find(n=>n.attrs['data-action']==='timebank');assert.match(button.text,/2张/);
  r.actions.timeBankCards=0;r.actions.canUseTimeBank=false;
  button=elements(markupTree(c.seatView(0,r))).find(n=>n.attrs['data-action']==='timebank');assert.match(button.text,/0张/);assert.doesNotMatch(button.text,/6张/);
  for(const mutate of [r=>r.players[0].folded=true,r=>r.players[0].allIn=true,r=>r.players[0].inHand=false,r=>r.hand.status='complete',r=>r.players[0].seat=null]){
    const other=thinkingRoom();mutate(other);c.state.room=other;assert.doesNotMatch(c.seatView(0,other),/data-action="timebank"/);
  }
});


// Run the real delegated click handler and mutation wrapper. DOM primitives are
// doubled; authorization, busy-state and the submitted command are production code.
function timeCardClickHarness(){
  const room=thinkingRoom(),state={clock:createRoomClock(),room,connected:true,busy:false,feedbackResync:false,modal:null,page:'room'},calls=[],modals=[],errors=[],listeners=new Map();
  let finish;
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,state,Date,actorClock:scene.actorClock,betActionEnabled,requests:{capture:()=>({check(){},valid:()=>true})},commandId:()=>String(calls.length+1),
    api:(path,payload)=>{calls.push({path,payload});return new Promise(resolve=>{finish=resolve;});},render(){},normalizeState(next){state.room=next;},playerStatsModal:async id=>modals.push(id),toast:(message)=>errors.push(message),
    document:{addEventListener:(type,listener)=>listeners.set(type,listener),visibilityState:'visible'},navigator:{onLine:true}});
  vm.runInContext([section('function seatTimeBankEnabled(','function seatHoleCards('),section('async function command(','function stopStream('),section('async function handleAction(','function setRaise('),section("document.addEventListener('click'","document.addEventListener('compositionstart'")].join('\n'),context);
  const button={dataset:{action:'timebank'},disabled:false,classList:{contains:()=>false}},target={closest:selector=>selector==='[data-action]'?button:null};
  return {state,calls,modals,errors,button,click:detail=>listeners.get('click')({target,detail}),finish:next=>finish({room:next})};
}
const flushClick=()=>new Promise(resolve=>setImmediate(resolve));

test('a seat time-card click or native keyboard click submits once without opening player statistics',async()=>{
  for(const detail of [1,0]){
    const h=timeCardClickHarness();h.click(detail);h.click(detail);
    assert.equal(h.calls.length,1);assert.equal(h.state.busy,true);assert.deepEqual(h.modals,[]);
    const sent=h.calls[0];assert.match(sent.path,/\/api\/rooms\/fixture\/action$/);assert.equal(sent.payload.type,'timebank');assert.equal(sent.payload.handId,'thinking');
    const updated=structuredClone(h.state.room);updated.actions.timeBankCards=5;updated.deadline+=30000;h.finish(updated);await flushClick();
    assert.equal(h.state.busy,false);assert.equal(h.state.room.actions.timeBankCards,5);assert.deepEqual(h.errors,[]);assert.deepEqual(h.modals,[]);
  }
});

test('an old enabled seat-time button cannot act after turn, clock or synchronization changes',async()=>{
  for(const change of [
    h=>h.button.disabled=true,h=>h.state.busy=true,h=>h.state.connected=false,h=>h.state.feedbackResync=true,
    h=>h.state.room.hand.actingId='p1',h=>h.state.room.actions.canUseTimeBank=false,h=>h.state.room.hand.transition={kind:'street'},
    h=>h.state.room.hand.runout={active:true},h=>h.state.room.hand.actionReadyAt=Date.now()+900,h=>h.state.room.deadline=Date.now()-1,
    h=>h.state.room.players[0].allIn=true,h=>h.state.room.players[0].folded=true,
  ]){
    const h=timeCardClickHarness();change(h);h.click(1);await flushClick();assert.deepEqual(h.calls,[]);assert.deepEqual(h.modals,[]);assert.deepEqual(h.errors,[]);
  }
});

test('connection updates use the same seat-time guard instead of re-enabling a stale command',()=>{
  const room=thinkingRoom(),state={clock:createRoomClock(),room,connected:true,busy:false,feedbackResync:false,timeOffset:0};
  const button={dataset:{action:'timebank'},disabled:true};
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,state,Date,actorClock:scene.actorClock,betActionEnabled,esc:String,setRaisePanel(){},syncInteractionPanel(){},document:{querySelectorAll:selector=>selector==='[data-game-action]'?[button]:[]}});
  vm.runInContext([section('function seatTimeBankEnabled(','function seatHoleCards('),section('function updateConnection(','async function loadMe(')].join('\n'),context);
  context.updateConnection();assert.equal(button.disabled,false);
  for(const change of [()=>state.feedbackResync=true,()=>state.connected=false,()=>state.busy=true,()=>room.hand.actionReadyAt=Date.now()+900,()=>room.deadline=Date.now()-1]){
    change();context.updateConnection();assert.equal(button.disabled,true);
    state.feedbackResync=false;state.connected=true;state.busy=false;room.hand.actionReadyAt=Date.now()-100;room.deadline=Date.now()+19900;
  }
  context.updateConnection();assert.equal(button.disabled,false);
});


test('the flop flips as one group, turn and river keep earlier cards still, and chat renders resume the same motion',()=>{
  const c=harness({realBoardCards:true}),r=room(2),at=Date.now();c.state.room=r;c.state.animations=true;
  r.hand={id:'runout-group',status:'playing',number:1,street:'flop',pot:400,board:['As','Kd','2c'],runout:{active:true}};
  c.state.boardMotion={handId:r.hand.id,from:0,count:3,at};
  const slots=html=>[...html.matchAll(/<span class="board-slot ([^"]*)" style="--flip-delay:(\d+)ms;--motion-age:(\d+)ms">/g)];
  let shown=slots(c.tableCenter(r));assert.equal(shown.length,5);assert.deepEqual(shown.map(m=>m[1].includes('is-flipping')),[true,true,true,false,false]);
  assert.deepEqual(shown.slice(0,3).map(m=>Number(m[2])),[0,0,0]);assert.equal(new Set(shown.slice(0,3).map(m=>m[3])).size,1,'all three cards have exactly the same animation age');
  c.state.boardMotion.at=Date.now()-300;shown=slots(c.tableCenter(r));assert.ok(shown.slice(0,3).every(m=>Number(m[3])>=300),'unrelated renders do not restart a group at zero');
  for(const [street,card] of [['turn','7h'],['river','9s']]){const from=r.hand.board.length;r.hand.board.push(card);r.hand.street=street;c.state.boardMotion={handId:r.hand.id,from,count:from+1,at:Date.now()};shown=slots(c.tableCenter(r));assert.deepEqual(shown.map(m=>m[1].includes('is-flipping')),Array.from({length:5},(_,i)=>i===from));}
  c.state.boardMotion.at=Date.now()-700;assert.ok(slots(c.tableCenter(r)).every(m=>!m[1].includes('is-flipping')));
  c.state.boardMotion=null;assert.ok(slots(c.tableCenter(r)).every(m=>!m[1].includes('is-flipping')),'reconnect is a still restore');
});

test('post-fold rabbit reveal still opens the remaining cards together and marks them as non-playing cards',()=>{
  const c=harness({realBoardCards:true}),r=room(2);c.state.room=r;c.state.animations=true;
  r.hand={id:'rabbit-group',status:'complete',number:1,street:'complete',pot:50,board:['As','Kd','2c'],rabbit:{originalCount:3,board:['As','Kd','2c','7h','9s']}};
  c.state.boardMotion={handId:r.hand.id,from:3,count:5,at:Date.now()};const html=c.tableCenter(r);
  assert.equal((html.match(/is-flipping/g)||[]).length,2);assert.equal((html.match(/is-rabbit/g)||[]).length,2);assert.doesNotMatch(html,/--flip-delay:(?:70|140)ms/);assert.match(html,/补看余牌 · 不计输赢/);
});


test('side-seat winners keep one compact payout alongside the category without stale equity or duplicate status',()=>{
  setDisplayUnit('bb');const c=harness(),r=room(9);r.status='playing';c.state.room=r;
  r.hand={id:'h',status:'complete',board:['Kc','2d','7h','Qc','Kd'],result:{payouts:{p3:90}},equity:{players:[{id:'p3',equity:100}]}};
  Object.assign(r.players[3],{cards:['Kh','Qd'],handCategory:'葫芦',inHand:true});
  const html=c.seatView(3,r);
  assert.equal((html.match(/seat-status /g)||[]).length,1);
  assert.match(html,/seat-hand-info[\s\S]*data-hand-category="full-house"[\s\S]*seat-status-inline/);
  assert.match(html,/title="收池 9 BB"/);assert.match(html,/＋9 BB/);
  assert.doesNotMatch(html,/equity-badge/);
  r.hand.status='playing';r.players[3].connected=false;
  assert.match(c.seatView(3,r),/seat-status-inline[\s\S]*离线/);
  r.players[3].handCategory=null;const hidden=c.seatView(3,r);
  assert.doesNotMatch(hidden,/seat-status-inline|hand-category/);assert.match(hidden,/离线/);
});


test('mode settings live outside the felt in every hand state and cannot crowd the board',()=>{
 const c=harness(),r=room(9);c.state.room=r;
 for(const hand of [null,{id:'a',status:'playing',number:1,board:[],pot:50},{id:'a',status:'complete',number:1,board:['As','Ks','Qs','Js','Ts'],pot:300,result:{payouts:{p0:300}}}]){
  r.hand=hand;const tree=markupTree(c.roomView()),head=oneClass(tree,'room-head'),stage=oneClass(tree,'table-stage');
  assert.ok(oneClass(head,'room-status-bar'));assert.ok(oneClass(head,'game-mode-markers'));assert.ok(oneClass(stage,'table-center'));
  assert.equal(oneClass(stage,'room-status-bar'),undefined);assert.equal(oneClass(stage,'game-mode-markers'),undefined);assert.equal(oneClass(tree,'table-config'),undefined);
  assert.equal(elements(tree).filter(el=>hasClass(el,'room-status-bar')).length,1);
 }
});

test('the next player is neutral until dealing and authoritative readiness finish',()=>{
 const c=harness(),r=room(9);c.state.room=r;r.status='playing';r.hand={id:'first',status:'playing',actingId:'p0',actionReadyAt:Date.now()-1000};r.deadline=Date.now()+19000;
 r.actions={turnAvailable:true,canAct:false};let tree=markupTree(c.seatView(0,r));
 assert.equal(hasClass(oneClass(tree,'seat'),'acting'),false);assert.ok(oneClass(tree,'is-preparing'));assert.match(oneClass(tree,'seat-turn').text,/发牌中/);
 r.actions.canAct=true;tree=markupTree(c.seatView(0,r));assert.ok(hasClass(oneClass(tree,'seat'),'acting'));assert.equal(oneClass(tree,'is-preparing'),undefined);
 r.meId='p1';r.actions={turnAvailable:false,canAct:false};tree=markupTree(c.seatView(0,r));assert.ok(hasClass(oneClass(tree,'seat'),'acting'));
});

test('hero payout and hand category share one information line instead of overlapping below the identity',()=>{
 const c=harness(),r=room(9);r.status='playing';c.state.room=r;
 Object.assign(r.players[0],{inHand:true,cards:['As','Kd'],handCategory:'两对'});
 r.hand={id:'hero-result',status:'complete',board:['Ah','Kh','7c','2s','3h'],result:{payouts:{p0:120}}};
 const tree=markupTree(c.seatView(0,r)),main=oneClass(tree,'seat-main'),info=oneClass(tree,'seat-hand-info');
 assert.equal(oneClass(main,'seat-status'),undefined);assert.ok(oneClass(info,'seat-status-inline'));assert.ok(oneClass(info,'hand-category'));
 assert.equal(elements(tree).filter(el=>hasClass(el,'seat-status')).length,1);
});

// A compact mobile suffix must never shorten the amount or its accessible unit.
test('compact wager units preserve complete point and BB values, All-in state and accessible descriptions',()=>{
 const c=harness(),r=room(9);c.state.room=r;r.hand={id:'unit-wager',status:'playing'};
 const player=r.players[0];Object.assign(player,{inHand:true,stack:0,bet:2760,contributed:2760,allIn:true});
 const before=JSON.stringify(r);
 for(const [unit,amount,suffix] of [['points','2,760','积分'],['bb','276','BB']]){
  setDisplayUnit(unit);const tree=markupTree(c.seatView(0,r)),chip=oneClass(tree,'bet-chip');
  assert.equal(chip.attrs['data-unit'],unit);assert.equal(oneClass(chip,'bet-value').text,`${amount} ${suffix}`);
  assert.equal(oneClass(chip,'bet-unit').text,` ${suffix}`);assert.equal(oneClass(tree,'seat-allin-label').text,'All-in');assert.equal(oneClass(chip,'bet-allin-label'),undefined);
  assert.match(chip.attrs['aria-label'],new RegExp(`${amount} ${suffix}，All-in`));assert.equal(chip.attrs.title,chip.attrs['aria-label']);
 }
 assert.equal(JSON.stringify(r),before);setDisplayUnit('points');
});


test('top-seat receipts use the above-seat information lane with or without public cards in every rotated layout',()=>{
 setDisplayUnit('bb');const c=harness();let checked=0;
 for(let count=2;count<=9;count++)for(let viewer=0;viewer<count;viewer++){
  const r=room(count);r.meId='p'+viewer;r.status='playing';c.state.room=r;
  for(const player of r.players){
   if(scene.seatPlacement(r,player.seat).edge!=='top')continue;
   for(const category of [null,'葫芦']){
    Object.assign(player,{inHand:true,cards:category?['Kh','Qd']:[null,null],handCategory:category});
    r.hand={id:'top-result',status:'complete',result:{payouts:{[player.id]:300}}};
    const tree=markupTree(c.seatView(player.seat,r)),main=oneClass(tree,'seat-main'),info=oneClass(tree,'seat-hand-info'),receipt=oneClass(info,'seat-status-inline');
    assert.equal(oneClass(main,'seat-status'),undefined,`${count} seats, viewer ${viewer}: receipt must not live in downward card lane`);
    assert.ok(receipt);assert.equal(receipt.attrs.title,'收池 30 BB');assert.match(receipt.text,/＋30 BB/);
    assert.equal(elements(tree).filter(el=>hasClass(el,'seat-status')).length,1);assert.equal(Boolean(oneClass(info,'hand-category')),Boolean(category));assert.ok(oneClass(main,'hole-cards'));
    assert.equal(oneClass(tree,'seat-turn'),undefined);checked++;
   }
   // The same lane also protects top-seat hole cards on disconnect during play.
   player.connected=false;player.handCategory=null;r.hand={id:'top-playing',status:'playing'};
   const tree=markupTree(c.seatView(player.seat,r));assert.equal(oneClass(oneClass(tree,'seat-main'),'seat-status'),undefined);assert.match(oneClass(oneClass(tree,'seat-hand-info'),'seat-status-inline').text,/离线/);player.connected=true;
  }
 }
 assert.ok(checked>100);setDisplayUnit('points');
});
