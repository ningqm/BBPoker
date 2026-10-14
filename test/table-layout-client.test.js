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
  const context=vm.createContext({...scene,lifecycle,renderHandCategory,formatChips,getDisplayUnit,revealOptions,betActionEnabled,Date,state:{timeOffset:0,connected:true,connection:'已连接',animations:false,fun:false,chatUnread:0},
    avatar:()=>'<span class="avatar">B</span>',renderSeatMask:()=>'',reactionBubble:()=>'',statsUI,formatAction:a=>a.type||a,
    boardCard:()=>'<span class="board-slot"></span>',streetNames:{flop:'翻牌'},
    autoDealText:()=> '5 秒后自动发下一手',actionArea:()=>'<div class="action-area"></div>',chatPanel:()=>'',errorPage:()=>''});
  vm.runInContext([section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('const card=','const feedback='),realBoardCards?section('function boardCard(','async function playerStatsModal('):'',section('const layouts=','function boardCard('),section('function tableCenter(','function seatActions('),section('function roomView(){','function tableInfoModal('),section('function miniPanel(','function autoDealText('),section('function roomClock(','function tick('),'globalThis.client={state,seatView,seatHoleCards,tableCenter,roomView,gameModeMarkers,miniPanel,seatTimeBankEnabled};'].join('\n'),context);
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
  assert.doesNotMatch(html,/<img/);assert.match(html,/title="&lt;img/);assert.match(html,/aria-label="查看 &lt;img/);assert.match(html,/title="庄家"/);assert.match(html,/title="小盲"/);assert.match(html,/squid-mark/);assert.match(html,/class="bet-allin-label"[^>]*>All-in</);assert.doesNotMatch(html,/class="seat-status[^>]*>All-in</);assert.match(html,/1,234 积分/);
});

test('unit display changes rendered amounts without modifying seat, pot or settings values',()=>{
  const c=harness(),r=room(2);r.hand={id:'h',status:'playing',number:1,street:'flop',pot:35,board:[]};r.players[0].inHand=true;r.players[0].bet=15;c.state.room=r;const before=JSON.stringify(r);
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

test('blind badges remain while routine action and All-in labels stay off the player card', () => {
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
  r.players[0].lastAction=null;r.players[0].allIn=true;r.players[0].bet=100;
  const html=c.seatView(0,r);assert.match(html,/class="bet-allin-label"[^>]*>All-in</);assert.doesNotMatch(html,/class="seat-status[^>]*>All-in</);
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

test('All-in is beside the actual inward wager, never in the player identity or on its hole cards',()=>{
  setDisplayUnit('points');const c=harness(),r=room(9),p=r.players[1];c.state.room=r;
  Object.assign(p,{inHand:true,allIn:true,bet:1100,contributed:1500,cards:['As','Kh']});r.hand={status:'playing'};
  for(const viewer of ['p0','p1','p4','p8']){
    r.meId=viewer;const tree=markupTree(c.seatView(1,r)),chip=oneClass(tree,'bet-chip'),label=oneClass(tree,'bet-allin-label'),main=oneClass(tree,'seat-main');
    assert.equal(label.parent,chip);assert.equal(chip.parent,main.parent);assert.equal(label.text,'All-in');
    assert.equal(oneClass(chip,'bet-value').text,'1,100 积分');assert.doesNotMatch(main.text,/All-in/);
    assert.match(chip.attrs['aria-label'],/本轮.*1,100/);assert.equal((elements(tree).filter(el=>hasClass(el,'bet-allin-label'))).length,1);
  }
});

test('after the street sweeps chips in, All-in stays visible without inventing a second cumulative wager',()=>{
  setDisplayUnit('points');const c=harness(),r=room(9),p=r.players[1];c.state.room=r;
  Object.assign(p,{inHand:true,allIn:true,bet:0,contributed:1500});r.hand={status:'playing',runout:{active:true}};
  const before=JSON.stringify(r),tree=markupTree(c.seatView(1,r)),chip=oneClass(tree,'bet-chip');
  assert.ok(oneClass(chip,'poker-chip'));assert.equal(oneClass(chip,'bet-allin-label').text,'All-in');
  assert.equal(oneClass(chip,'bet-value'),undefined);assert.doesNotMatch(chip.text,/1,500|0 积分/);
  assert.match(chip.attrs['aria-label'],/1,500/);assert.match(chip.attrs['aria-label'],/底池|累计|本手/);assert.equal(JSON.stringify(r),before);
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
  const room=thinkingRoom(),state={room,connected:true,busy:false,feedbackResync:false,timeOffset:0,modal:null,page:'room'},calls=[],modals=[],errors=[],listeners=new Map();
  let finish;
  const context=vm.createContext({state,Date,actorClock:scene.actorClock,betActionEnabled,requests:{capture:()=>({check(){},valid:()=>true})},commandId:()=>String(calls.length+1),
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
  const room=thinkingRoom(),state={room,connected:true,busy:false,feedbackResync:false,timeOffset:0};
  const button={dataset:{action:'timebank'},disabled:true};
  const context=vm.createContext({state,Date,actorClock:scene.actorClock,betActionEnabled,esc:String,setRaisePanel(){},syncInteractionPanel(){},document:{querySelectorAll:selector=>selector==='[data-game-action]'?[button]:[]}});
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
