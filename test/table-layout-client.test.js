import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as lifecycle from '../public/lifecycle.js';
import {formatChips,setDisplayUnit,getDisplayUnit} from '../public/money.js';
import {revealOptions} from '../public/table-controls.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);};
function harness(){
  const context=vm.createContext({lifecycle,formatChips,getDisplayUnit,revealOptions,Date,state:{timeOffset:0,connected:true,connection:'已连接',animations:false,fun:false,chatUnread:0},
    avatar:()=>'<span class="avatar">B</span>',renderSeatMask:()=>'',reactionBubble:()=>'',statsUI:{renderEquityBadge:()=>''},formatAction:a=>a.type||a,
    boardCard:()=>'<span class="board-slot"></span>',streetNames:{flop:'翻牌'},
    actionArea:()=>'<div class="action-area"></div>',chatPanel:()=>'',errorPage:()=>''});
  vm.runInContext([section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('const card=','const feedback='),section('const layouts=','function boardCard('),section('function tableCenter(','function seatActions('),section('function roomView(){','function tableInfoModal('),section('function miniPanel(','function autoDealText('),section('function roomClock(','function tick('),'globalThis.client={state,seatView,seatHoleCards,tableCenter,roomView,gameModeMarkers,miniPanel};'].join('\n'),context);
  return context.client;
}
function room(count=9){return {code:'fixture',name:'本地验收桌',status:'waiting',hostId:'p0',meId:'p0',settings:{maxPlayers:count,smallBlind:5,bigBlind:10,durationMinutes:60,squid:true,squidUnit:20,squidUnitBB:2,bombPot:true,bombAnte:30,bombAnteBB:3,bombIntervalMinutes:10},players:Array.from({length:count},(_,i)=>({id:'p'+i,name:'玩家昵称'+i,seat:i,stack:2000,connected:true})),mini:{squid:{active:false}},actions:{}};}

test('idle table shows core settings inside the felt while the header keeps title, connection and invite',()=>{
  setDisplayUnit('points');const c=harness(),r=room(2);c.state.room=r;const html=c.roomView(),head=html.slice(0,html.indexOf('<div class="game-grid"')),center=c.tableCenter(r);
  assert.match(head,/本地验收桌/);assert.match(head,/data-connection/);assert.match(head,/data-action="invite"/);assert.doesNotMatch(head,/data-room-clock|game-mode-markers|table-blinds/);
  assert.match(center,/table-config/);assert.match(center,/5 \/ 10 积分/);assert.match(center,/60 分钟 · 首手开始计时/);assert.match(center,/20 积分\/人/);assert.match(center,/30 积分\/人/);assert.match(center,/title="1 BB = 10 积分"/);
});

test('core settings and live countdown hooks survive active, completed, rabbit and all-in hand views',()=>{
  setDisplayUnit('bb');const c=harness(),r=room();c.state.room=r;r.endsAt=Date.now()+60000;
  const hand={id:'h',number:1,status:'playing',street:'flop',board:['As','Kh','2d'],pot:990,bombPot:true,squidRound:2};
  r.mini.squid={active:true,round:2,unit:40,participants:r.players.map(p=>p.id),won:['p1','p2']};
  for(const extras of [{},{status:'complete',result:{mainWinnerIds:['p0'],pots:[{amount:990}]}},{rabbit:{board:['As','Kh','2d','3c','4s'],originalCount:3}},{equity:{pots:[{amount:990}]},runout:{active:true}}]){
    r.hand={...hand,...extras};const html=c.tableCenter(r);assert.equal((html.match(/data-room-clock/g)||[]).length,1);assert.equal((html.match(/class="board-slot"/g)||[]).length,5);assert.match(html,/0\.5 \/ 1 BB/);assert.match(html,/4 BB\/人/);assert.match(html,/2\/9 有鱼/);assert.match(html,/>99 BB</);
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
  const c=harness(),r=room(2),p=r.players[1];c.state.room=r;p.name='<img src=x onerror=alert(1)>';p.inHand=true;p.cards=['As','Kd'];p.allIn=true;p.bet=1234;p.squidWon=true;
  r.hand={id:'h',status:'playing',buttonSeat:1,smallBlindSeat:1,bigBlindSeat:0};const html=c.seatView(1,r);
  assert.doesNotMatch(html,/<img/);assert.match(html,/title="&lt;img/);assert.match(html,/aria-label="查看 &lt;img/);assert.match(html,/title="庄家"/);assert.match(html,/title="小盲"/);assert.match(html,/squid-mark/);assert.match(html,/title="ALL IN" data-tone="allin"/);assert.match(html,/1,234 积分/);
});

test('unit display changes rendered amounts without modifying seat, pot or settings values',()=>{
  const c=harness(),r=room(2);r.hand={id:'h',status:'playing',number:1,street:'flop',pot:35,board:[]};r.players[0].bet=15;c.state.room=r;const before=JSON.stringify(r);
  setDisplayUnit('bb');const bb=c.seatView(0,r)+c.tableCenter(r);assert.match(bb,/200 <small class="stack-unit">BB<\/small>/);assert.match(bb,/1\.5 BB/);assert.match(bb,/3\.5 BB/);assert.match(bb,/1 BB = 10 积分/);
  setDisplayUnit('points');const points=c.seatView(0,r)+c.tableCenter(r);assert.match(points,/class="stack-value">2,000<\/div>/);assert.match(points,/15 积分/);assert.match(points,/35 积分/);assert.equal(JSON.stringify(r),before);
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

test('avatar opens player data instead of a full-seat interaction target',()=>{
  const c=harness(),r=room(9);c.state.room=r;
  for(let i=0;i<r.players.length;i++){
    const html=c.seatView(i,r),buttons=html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)||[];
    assert.equal(buttons.length,1);assert.match(buttons[0],/class="seat-avatar-button"/);
    assert.match(buttons[0],new RegExp(`data-player="p${i}"`));assert.match(buttons[0],/aria-label="查看 玩家昵称\d 的数据"/);
    assert.match(buttons[0],/data-action="player-stats"/);assert.doesNotMatch(html,/seat-interaction-hit|data-action="interact"/);
  }
});
test('avatar data controls do not cover own card reveals or empty seats',()=>{
  const c=harness(),r=room(3);c.state.room=r;
  r.hand={id:'own-hand',status:'complete'};Object.assign(r.players[0],{inHand:true,cards:['As','Kh'],shownIndices:[]});
  const own=c.seatView(0,r);assert.equal((own.match(/data-action="show-card"/g)||[]).length,2);assert.equal((own.match(/data-action="player-stats"/g)||[]).length,1);
  assert.doesNotMatch(own,/seat-interaction-hit/);r.players.pop();assert.doesNotMatch(c.seatView(2,r),/data-action="player-stats"/);
});

test('blind badges replace duplicate blind status text, while real actions remain visible', () => {
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
  assert.match(c.seatView(0,r), /class="seat-status\s*" title="raise"/);
  r.players[0].lastAction=null;r.players[0].allIn=true;
  assert.match(c.seatView(0,r), /title="ALL IN" data-tone="allin"/);
});

test('nine-player unlimited and bomb markers retain exact fish counts for every viewpoint',()=>{
  const c=harness(),r=room(9);c.state.room=r;setDisplayUnit('bb');r.settings.squidMode='unlimited';r.settings.squidExtraTokens=3;
  r.mini.squid={active:true,mode:'unlimited',round:2,unit:20,extraTokens:3,tokenBudget:12,participants:r.players.map(p=>p.id),counts:Object.fromEntries(r.players.map((p,i)=>[p.id,i===4?3:i===5?1:0])),won:['p4','p5']};
  r.players[4].squidCount=3;r.players[5].squidCount=1;
  r.hand={id:'nine',number:8,status:'playing',street:'flop',board:['As','2h','3c'],pot:270,bombPot:true,buttonSeat:4,smallBlindSeat:5,bigBlindSeat:6,squidRound:2};
  const markers=c.gameModeMarkers(r);assert.match(markers,/无限/);assert.match(markers,/余 8\/12 · 7人无鱼/);assert.match(markers,/本手炸弹池/);assert.match(markers,/2 BB\/鱼/);
  for(const me of ['p0','p4','p8']){r.meId=me;for(let seat=0;seat<9;seat++){const html=c.seatView(seat,r);assert.doesNotMatch(html,/title="小盲"|title="大盲"/);if(seat===4){assert.match(html,/title="庄家"/);assert.match(html,/本轮已获 3 条鱼/);assert.match(html,/>鱼×3</);}}}
  const panel=c.miniPanel(r);assert.match(panel,/本轮 12 条鱼，剩余 8 条；7 人还没鱼/);assert.equal((panel.match(/<span class="(?:has-fish|no-fish)">/g)||[]).length,9);assert.match(panel,/未发出的鱼不计费/);
  setDisplayUnit('points');
});

test('settled squid displays the actual posted mini result without changing poker pot or current counts',()=>{
  const c=harness(),r=room(9);c.state.room=r;r.settings.squidMode='unlimited';
  r.mini.squid={active:false,round:1,lastResult:{round:1,mode:'unlimited',tokensExhausted:true,changes:{p0:180,p1:-120}}};
  const before=JSON.stringify(r),panel=c.miniPanel(r);assert.match(panel,/第 1 轮已结算/);assert.match(panel,/本轮鱼已发完/);assert.match(panel,/我的鱿鱼盈亏.*\+180 积分/);assert.match(panel,/本场小游戏盈亏/);assert.match(c.gameModeMarkers(r),/第 1 轮已结算/);assert.equal(JSON.stringify(r),before);
});
