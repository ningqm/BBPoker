import * as tableControls from '../public/table-controls.js';
import * as tableScene from '../public/table-scene.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as lifecycle from '../public/lifecycle.js';
import * as money from '../public/money.js';
import {createRequestGuard} from '../public/platform.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return source.slice(a,b);};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function harness(){
  const requests=createRequestGuard(),timers=new Map(),pending=[],paths=[],messages=[],commands=[];
  const state={user:{id:'a'},page:'lobby',rooms:[],timeOffset:0,lobby:{rooms:[],filter:'all',loading:false,loaded:false,error:'',request:0,timer:null,controller:null,joining:'',limit:10}};
  let sequence=0,renders=0;
  const context=vm.createContext({...tableScene,...tableControls,...money,lifecycle,state,requests,AbortController,document:{visibilityState:'visible'},
    clearTimeout:id=>timers.delete(id),setTimeout:(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;},
    api:(path,body,options={})=>{const result=deferred();pending.push({path,body,options,...result});return result.promise;},
    navigate:path=>paths.push(path),render:()=>renders++,toast:message=>messages.push(message),rebuyPrompt:()=>null,
    openModal:(title,body,kind)=>{state.modal={title,body,kind};},closeModal:()=>{state.modal=null;},
    command:async(type,payload)=>{commands.push({type,payload});return true;},
  });
  vm.runInContext([
    section('const esc=','const profitClass='),section('const btn=','const avatar='),
    section('function stopLobbyPolling(','async function route('),
    section('function lobbyRoomCard(','function career('),
    section('function departureModal(','function rulesModal('),section('function buyinModal(','function updateBuyinSummary('),
    'globalThis.client={stopLobbyPolling,loadLobby,joinPublicRoom,joinInviteModal,lobbyRoomCard,departureModal,confirmDeparture,settleSquidModal,participationNotice,entryBlindModal,confirmEntryBlind,buyinModal,entryModeFields};',
  ].join('\n'),context);
  return {...context.client,state,requests,context,pending,timers,paths,messages,commands,get renders(){return renders;}};
}
const room=(overrides={})=>({code:'123456',name:'朋友的局',hostName:'小鱼',access:'public',joined:false,canJoin:true,status:'playing',seatedCount:3,maxPlayers:9,smallBlind:5,bigBlind:10,...overrides});
const squidRoom=()=>({code:'123456',meId:'a',status:'playing',hand:{status:'playing'},players:[{id:'a',seat:0,inHand:true}],mini:{squid:{active:true,round:4,participants:['a','b','c'],won:['b'],unit:20}}});

test('room directory keeps invitation gates and returns members without a second join',()=>{
  assert.equal(lifecycle.lobbyRoomAction(room({access:'invite',canJoin:true})).action,'join-invite');
  assert.equal(lifecycle.lobbyRoomAction(room({access:undefined})).action,'join-invite');
  assert.equal(lifecycle.lobbyRoomAction(room({access:'invite',joined:true})).label,'返回牌桌');
  assert.equal(lifecycle.lobbyRoomAction(room({seatedCount:9})).label,'加入观战');
  const rows=[room({code:'closed',status:'closed'}),room({code:'private',access:'invite'}),room({code:'mine',access:'invite',joined:true}),room()];
  assert.deepEqual(lifecycle.filterLobbyRooms(rows,'joinable').map(r=>r.code),['mine','123456']);
  assert.deepEqual(lifecycle.filterLobbyRooms(rows,'mine').map(r=>r.code),['mine']);
});

test('directory rendering escapes names and only uses summary fields',()=>{
  const c=harness(),html=c.lobbyRoomCard(room({access:'invite',name:'<img src=x onerror=1>',hostName:'<script>',invite:'secret-token',cards:['As','Ah']}));
  assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<img|<script|secret-token|As|Ah/);
  assert.match(html,/data-action="join-invite"/);assert.doesNotMatch(html,/data-action="join-public"/);
});

test('a superseded or hidden lobby request cannot replace a newer directory or restart polling',async()=>{
  const c=harness(),first=c.loadLobby();assert.equal(c.pending.length,1);
  const second=c.loadLobby();assert.equal(c.pending[0].options.signal.aborted,true);
  c.pending[1].resolve({rooms:[room({name:'new'})],limit:10});await second;
  c.pending[0].resolve({rooms:[room({name:'old'})]});await first;
  assert.equal(c.state.lobby.rooms[0].name,'new');assert.equal(c.timers.size,1);
  const third=c.loadLobby();c.context.document.visibilityState='hidden';c.stopLobbyPolling();c.pending[2].resolve({rooms:[]});await third;
  assert.equal(c.state.lobby.rooms[0].name,'new');assert.equal(c.timers.size,0);
  await c.loadLobby();assert.equal(c.pending.length,3);
});

test('failed refresh retains summaries, and leaving the lobby or changing identity discards responses',async()=>{
  const c=harness();c.state.lobby.rooms=[room()];c.state.lobby.loaded=true;
  const failed=c.loadLobby();c.pending[0].reject(new Error('网络中断'));await failed;
  assert.equal(c.state.lobby.rooms.length,1);assert.equal(c.state.lobby.error,'网络中断');
  const late=c.loadLobby();c.requests.invalidate();c.state.page='room';c.stopLobbyPolling();c.pending[1].resolve({rooms:[]});await late;
  assert.equal(c.state.lobby.rooms.length,1);assert.equal(c.timers.size,0);
});

test('public join submits no invitation, ignores double-clicks, and cannot join private summaries',async()=>{
  const c=harness();c.state.lobby.rooms=[room({access:'invite'})];await c.joinPublicRoom('123456');assert.equal(c.pending.length,0);
  c.state.lobby.rooms=[room()];const request=c.joinPublicRoom('123456');await c.joinPublicRoom('123456');
  assert.equal(c.pending.length,1);assert.equal(JSON.stringify(c.pending[0].body),'{}');
  c.pending[0].resolve({});await request;assert.deepEqual(c.paths,['/room/123456']);
  c.state.lobby.rooms[0].joined=true;await c.joinPublicRoom('123456');assert.equal(c.pending.length,1);
});

test('mid-hand seats and squid waiting have distinct guidance, and pending exit is cancellable',()=>{
  const r=squidRoom();
  assert.match(lifecycle.buyinTiming(r),/下一手以 0 鱼加入.*总鱼数加 1/);delete r.mini;assert.match(lifecycle.buyinTiming(r),/后续符合条件/);
  r.hand.status='complete';assert.match(lifecycle.buyinTiming(r,false),/立即到账.*下次发牌前可用/);
  r.mini={squid:{active:true,round:4,participants:['a']}};
  assert.equal(lifecycle.participation(r,{id:'new',seat:1,waitingFor:'squid'}).label,'等待加入本轮');
  assert.equal(lifecycle.participation(r,{seat:1,pendingDeparture:'stand'}).canCancel,true);
  assert.equal(lifecycle.participation(r,{seat:1,sittingOut:true}).canReturn,true);
});

test('departure quote retains the round liability without immediately forfeiting it',()=>{
  const r=squidRoom();assert.equal(lifecycle.departurePlan(r,r.players[0],'stand').cost,40);
  assert.equal(lifecycle.departurePlan(r,{id:'new',seat:3},'stand').round,0);
  assert.equal(lifecycle.departurePlan(r,{id:'new',seat:3,inHand:false},'stand').queued,false);
  assert.equal(lifecycle.departurePlan(r,{id:'a',seat:0,inHand:true,folded:true},'stand').queued,true);
  assert.equal(lifecycle.departurePlan(r,{id:'b',seat:1},'stand').cost,0);
  assert.equal(lifecycle.departurePlan(r,{id:'b',seat:1},'stand').won,true);
});

test('changed round liability or hand boundary requires a fresh departure confirmation',async()=>{
  const c=harness();c.state.room=squidRoom();c.departureModal('sitout');assert.match(c.state.modal.body,/40 积分/);
  c.state.room.mini.squid.unit=30;await c.confirmDeparture();assert.equal(c.commands.length,0);assert.match(c.state.modal.body,/60 积分/);
  await c.confirmDeparture();assert.equal(c.commands.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(c.commands[0])),{type:'sitout',payload:{value:true,expectedSquidRound:4,expectedSquidCost:60}});
  c.departureModal('stand');c.state.room.hand.status='complete';await c.confirmDeparture();assert.equal(c.commands.length,1);
});

test('settlement prompt uses current marked participants and is absent without viewer permission',()=>{
  const c=harness();c.state.room=squidRoom();c.settleSquidModal();assert.equal(c.state.modal,undefined);
  c.state.room.mini.squid.canSettle=true;c.state.room.mini.squid.blockerSince=100;c.settleSquidModal();
  assert.match(c.state.modal.body,/未获标记者支付 20 积分/);assert.match(c.state.modal.body,/已获标记者获得 40 积分/);
  c.state.room.mini.squid.won=[];c.settleSquidModal();assert.match(c.state.modal.body,/所有预留积分退回/);
});


test('leaving the lobby during a public join cannot navigate back or leave its next join button stuck',async()=>{
  const c=harness();c.state.lobby.rooms=[room()];const pending=c.joinPublicRoom('123456');
  c.requests.invalidate();c.state.page='career';c.pending[0].resolve({});await pending;
  assert.equal(c.paths.length,0);assert.equal(c.state.lobby.joining,'');
  c.state.page='lobby';const retry=c.joinPublicRoom('123456');assert.equal(c.pending.length,2);c.pending[1].resolve({});await retry;assert.deepEqual(c.paths,['/room/123456']);
});


test('a restored ordinary hand keeps its original mode and never promises a mid-hand squid conversion',()=>{
  const room=squidRoom();room.hand.squidRound=null;
  let mode=lifecycle.squidMode(room);assert.equal(mode.countsForSquid,false);assert.match(mode.label,/本手普通德州.*下一手继续原轮/);
  room.hand.squidRound=4;mode=lifecycle.squidMode(room);assert.equal(mode.countsForSquid,true);assert.equal(mode.label,'');
  room.mini.squid.blockerSince=100;mode=lifecycle.squidMode(room);assert.match(mode.label,/本手仍计鱿鱼/);assert.match(mode.note,/不足两人/);
});

test('departure clearly keeps reserve and settlement responsibility, including a marked player',()=>{
  const c=harness(),room=squidRoom();room.players[0].squidReserve=40;c.state.room=room;
  c.departureModal('stand');assert.match(c.state.modal.body,/最多覆盖.*40 积分/);assert.match(c.state.modal.body,/不会随离座取走/);assert.match(c.state.modal.body,/不重新收鱿鱼预留/);
  assert.doesNotMatch(c.state.modal.body,/离开需支付|立即结算|视为失败/);
  room.mini.squid.won.push('a');c.departureModal('stand');assert.match(c.state.modal.body,/已获得本轮 1 条鱼/);assert.match(c.state.modal.body,/结算权益/);
});

test('only an actual current-hand participant queues departure; squid responsibility is retained either way',()=>{
  const room=squidRoom();room.players[0].inHand=false;
  const plan=lifecycle.departurePlan(room,room.players[0],'stand');assert.equal(plan.queued,false);assert.equal(plan.cost,40);assert.equal(plan.participant,true);
  room.players[0].inHand=true;assert.equal(lifecycle.departurePlan(room,room.players[0],'stand').queued,true);
});

test('expired squid waits for eligible original players and does not promise newcomer participation',()=>{
  const room=squidRoom();room.expiryMode='wait-squid';room.mini.squid.blockerSince=100;
  assert.match(lifecycle.squidMode(room).label,/已到时.*本手结束后等待原轮/);assert.match(lifecycle.squidMode(room).note,/不足两人/);
  assert.match(lifecycle.buyinTiming(room,true,{id:'new'}),/新玩家不能再入座参加本轮/);
  assert.match(lifecycle.buyinTiming(room,true,{id:'a'}),/重新入座不重复增加鱼数/);
  room.hand.status='complete';assert.match(lifecycle.squidMode(room).label,/期间不开新手/);
  assert.equal(lifecycle.lobbyTime(1000,2000),'已到时 · 等待收尾');
});

test('lobby status distinguishes an unstarted room, a hand break and expired recovery',()=>{
  const c=harness();
  assert.match(c.lobbyRoomCard(room({status:'waiting',handNumber:0,endsAt:null})),/>等待开局<\/span>/);
  assert.match(c.lobbyRoomCard(room({status:'waiting',handNumber:2})),/>等待下一手<\/span>/);
  assert.match(c.lobbyRoomCard(room({status:'waiting',endsAt:Date.now()+60000})),/>等待下一手<\/span>/);
  const expired=c.lobbyRoomCard(room({status:'waiting',handNumber:2,endsAt:1}));
  assert.match(expired,/>等待收尾<\/span>/);assert.doesNotMatch(expired,/等待开局/);
  assert.match(c.lobbyRoomCard(room({status:'playing',handNumber:2,endsAt:1})),/>进行中<\/span>/);
});

const entryPlayer=(overrides={})=>({id:'a',seat:0,entryBlind:{required:true,mode:'wait',reason:'new',live:10,dead:0,waitingFor:'bigBlind'},...overrides});
test('server entry quotes distinguish waiting, post-and-wait-for-button, and same-hand reconnect',()=>{
  const room=squidRoom(),player=entryPlayer();room.players=[player];
  assert.equal(lifecycle.participation(room,player).label,'等待大盲加入');
  player.entryBlind.mode='post';player.entryBlind.waitingFor='button';assert.match(lifecycle.participation(room,player).label,/等待过庄/);
  player.entryBlind.reason='missed';player.entryBlind.dead=5;const quoted=lifecycle.entryBlindView(room,player);assert.equal(quoted.total,15);assert.equal(quoted.dead,5);
  player.inHand=true;assert.equal(lifecycle.entryBlindView(room,player),null);assert.equal(lifecycle.participation(room,player).label,'正在参与本手');
  player.inHand=false;room.status='closed';assert.equal(lifecycle.entryBlindView(room,player),null);
});

test('new squid participants follow next-hand admission while returning players retain the original identity',()=>{
  const room=squidRoom(),player=entryPlayer({id:'new',waitingFor:'squid',squidJoin:{status:'next-hand',round:4,reason:'本手结束后核定入轮，暂不扣预留。',requiredReserve:60,tokenBudgetAfterJoin:3}});player.entryBlind.mode='post';
  assert.equal(lifecycle.participation(room,player).label,'等待加入本轮');
  assert.match(lifecycle.participation(room,player).note,/本手结束后核定/);
  assert.match(lifecycle.buyinTiming(room,true,{id:'a'}),/资格.*预留都保留/);
  assert.match(lifecycle.buyinTiming(room,true,{id:'new'}),/下一手以 0 鱼加入/);
  room.mini.squid.participants.push('new');
  assert.equal(lifecycle.squidJoinView(room,player),null);
  assert.match(lifecycle.buyinTiming(room,true,player),/不重复增加鱼数/);
});

test('squid admission reports blind waiting and whose reserve is insufficient without changing server amounts',()=>{
  const room=squidRoom(),player=entryPlayer({id:'new',waitingFor:'squid'});
  player.squidJoin={status:'entry-blind',round:4,reason:'轮到大盲时再核定入轮。',requiredReserve:60,tokenBudgetAfterJoin:3};
  assert.equal(lifecycle.participation(room,player).label,'等待大盲加入');
  assert.equal(lifecycle.squidJoinView(room,player).seatLabel,'等大盲');
  player.entryBlind.mode='post';player.entryBlind.waitingFor='button';
  assert.equal(lifecycle.squidJoinView(room,player).seatLabel,'等过庄');
  player.squidJoin={...player.squidJoin,status:'reserve',reason:'小鱼需补足预留，你先等待，原轮继续。',requiredReserve:80,tokenBudgetAfterJoin:4};
  const before=JSON.stringify(player),view=lifecycle.participation(room,player);
  assert.equal(view.label,'等待补足鱿鱼预留');assert.equal(view.requiredReserve,80);assert.equal(view.budget,4);
  assert.match(view.note,/小鱼需补足预留/);assert.equal(JSON.stringify(player),before);
  player.squidJoin.reason='你的积分不足以预留并继续发牌。';assert.match(lifecycle.participation(room,player).note,/你的积分不足/);
});

test('stale or unsupported squid admission quotes never invent charges or overwrite existing participant status',()=>{
  const room=squidRoom(),player=entryPlayer({id:'new',waitingFor:'squid',squidJoin:{round:3,status:'reserve',reason:'old',requiredReserve:999}});
  assert.equal(lifecycle.squidJoinView(room,player),null);
  player.squidJoin={round:4,status:'future-state',requiredReserve:-1,tokenBudgetAfterJoin:NaN};
  const view=lifecycle.squidJoinView(room,player);assert.equal(view.label,'等待加入本轮');assert.equal(view.requiredReserve,null);assert.equal(view.budget,null);
  room.mini.squid.participants.push('new');assert.equal(lifecycle.squidJoinView(room,player),null);
  player.inHand=true;assert.equal(lifecycle.participation(room,player).label,'正在参与本手');
});

test('expired tables decline newcomer seating but allow original participants to return without adding fish',()=>{
  const c=harness(),r=squidRoom();r.settings={bigBlind:10};r.endsAt=Date.now()-1000;c.state.room=r;
  r.players=[{id:'a',seat:null,totalBuyIn:0}];r.mini.squid.participants=['b','c'];
  c.buyinModal(2);assert.equal(c.state.modal,undefined);assert.match(c.messages.at(-1),/不能再入座/);assert.equal(c.commands.length,0);
  r.mini.squid.participants.push('a');c.buyinModal(2);assert.equal(c.state.modal.kind,'buyin');assert.match(c.state.modal.body,/不重复增加鱼数/);
  assert.equal(lifecycle.squidAdmissionClosed(r,{id:'new'},r.endsAt-1),false);
  assert.equal(lifecycle.squidAdmissionClosed(r,{id:'new'},r.endsAt),true);
  r.expiryMode='wait-squid';delete r.endsAt;assert.equal(lifecycle.squidAdmissionClosed(r,{id:'new'}),true);
});

test('newcomer entry dialog and inline queue show escaped server reasons and quote reserve only as an estimate',()=>{
  const c=harness(),r=squidRoom();r.settings={bigBlind:10};r.meId='new';
  const player=entryPlayer({id:'new',waitingFor:'squid',squidJoin:{round:4,status:'reserve',reason:'<img src=x onerror=alert(1)>需补足预留',requiredReserve:60,tokenBudgetAfterJoin:3}});r.players=[player];c.state.room=r;
  c.entryBlindModal();const html=c.state.modal.body;
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|名单固定|等待下一轮/);assert.match(html,/预计本人入轮至少预留 60 积分/);assert.match(html,/以实际发牌时为准/);
  const notice=c.participationNotice(r,player);assert.match(notice,/&lt;img/);assert.doesNotMatch(notice,/<img/);assert.match(notice,/参与方式/);
  c.buyinModal(1);assert.match(c.state.modal.body,/以 0 鱼加入，总鱼数加 1/);assert.doesNotMatch(c.state.modal.body,/鱿鱼新人仍等下一轮/);
  assert.equal(c.commands.length,0);
});

test('entry controls use the server quote and submit mode only, never a client-calculated charge',async()=>{
  const c=harness();c.state.room=squidRoom();c.state.room.players=[entryPlayer()];
  c.entryBlindModal();assert.match(c.state.modal.body,/补盲加入 · 10 积分/);assert.match(c.state.modal.body,/同手重连不会重复收盲/);
  await c.confirmEntryBlind('fake');assert.equal(c.commands.length,0);
  await c.confirmEntryBlind('post');assert.deepEqual(c.commands.map(c=>JSON.parse(JSON.stringify(c))),[{type:'entryBlind',payload:{mode:'post'}}]);
});

test('returning with missed blinds displays live and dead amounts, preserves squid identity, and refreshes stale quotes',async()=>{
  const c=harness();c.state.room=squidRoom();const p=entryPlayer({sittingOut:true});p.entryBlind.reason='missed';p.entryBlind.dead=5;c.state.room.players=[p];
  c.entryBlindModal(true);assert.match(c.state.modal.body,/补小盲 5 积分进底池、不抵跟注/);
  p.entryBlind.live=20;await c.confirmEntryBlind('post');assert.equal(c.commands.length,0);assert.match(c.state.modal.body,/补盲加入 · 25 积分/);
  await c.confirmEntryBlind('wait');assert.deepEqual(c.commands.map(c=>JSON.parse(JSON.stringify(c))),[{type:'sitout',payload:{value:false,entryMode:'wait'}}]);
});

test('stale room changes or a new hand cannot charge through an old entry dialog',async()=>{
  const c=harness();c.state.room=squidRoom();const p=entryPlayer();c.state.room.players=[p];c.entryBlindModal();
  c.state.room.code='654321';await c.confirmEntryBlind('post');assert.equal(c.commands.length,0);
  c.state.room.code='123456';p.inHand=true;await c.confirmEntryBlind('post');assert.equal(c.commands.length,0);assert.equal(c.state.modal,null);
});

test('absent-player settlement buffer explains how a returning unmarked player can still continue',()=>{
  const room=squidRoom();room.hand.status='complete';room.mini.squid.absentSettlementAt=Date.now()+5000;
  const mode=lifecycle.squidMode(room);assert.equal(mode.settlingAbsentees,true);assert.match(mode.label,/即将.*结算/);assert.match(mode.note,/及时回来.*仍可继续/);
});

test('entry choice explains a table waiting for everyone without silently changing their preference',()=>{
  const c=harness();c.state.room=squidRoom();c.state.room.players=[entryPlayer(),{id:'b',seat:1}];c.entryBlindModal();
  assert.match(c.state.modal.body,/全员等盲无法开牌，至少一人改选补盲/);assert.equal(c.commands.length,0);
  assert.equal(c.state.room.players[0].entryBlind.mode,'wait');
});

test('seat badges stay short on mobile while detailed participation instructions remain available',()=>{
  const room=squidRoom(),player=entryPlayer();assert.equal(lifecycle.entryBlindView(room,player).seatLabel,'等大盲');
  player.entryBlind.mode='post';player.entryBlind.waitingFor='button';assert.equal(lifecycle.entryBlindView(room,player).seatLabel,'等过庄');
  player.entryBlind.waitingFor=null;assert.equal(lifecycle.entryBlindView(room,player).seatLabel,'待补盲');assert.match(lifecycle.entryBlindView(room,player).label,/已选补盲/);
});

test('manual lobby refresh updates newly ended personal tables while automatic polling stays lightweight',async()=>{
  const c=harness();c.state.rooms=[{code:'old',status:'closed'}];
  const refresh=c.loadLobby({refreshHistory:true});assert.deepEqual(c.pending.map(call=>call.path),['/api/lobby','/api/me']);
  c.pending[0].resolve({rooms:[room()],limit:10});c.pending[1].resolve({rooms:[{code:'newly-ended',status:'closed'}]});await refresh;
  assert.equal(c.state.rooms[0].code,'newly-ended');assert.equal(c.state.lobby.rooms.length,1);
  const automatic=c.loadLobby({silent:true});assert.equal(c.pending.length,3);assert.equal(c.pending[2].path,'/api/lobby');
  c.pending[2].resolve({rooms:[]});await automatic;assert.equal(c.state.rooms[0].code,'newly-ended');
});

test('partial refresh failures preserve the affected list and still apply the successful list',async()=>{
  for(const failure of ['directory','history']){
    const c=harness();c.state.rooms=[{code:'past',status:'closed'}];c.state.lobby.rooms=[room({code:'live-old'})];c.state.lobby.loaded=true;
    const refresh=c.loadLobby({refreshHistory:true});
    if(failure==='directory'){c.pending[0].reject(new Error('目录离线'));c.pending[1].resolve({rooms:[{code:'past-new',status:'closed'}]});}
    else{c.pending[0].resolve({rooms:[room({code:'live-new'})]});c.pending[1].reject(new Error('历史离线'));}
    await refresh;
    assert.equal(c.state.rooms[0].code,failure==='history'?'past':'past-new');
    assert.equal(c.state.lobby.rooms[0].code,failure==='directory'?'live-old':'live-new');assert.ok(c.state.lobby.error);
  }
});

test('old personal history cannot return after a newer refresh or identity change',async()=>{
  for(const identityChange of [false,true]){
    const c=harness();c.state.rooms=[{code:'current',status:'closed'}];
    const first=c.loadLobby({refreshHistory:true});
    if(identityChange){c.requests.invalidate();c.stopLobbyPolling();}
    else{const second=c.loadLobby({refreshHistory:true});assert.equal(c.pending[0].options.signal.aborted,true);assert.equal(c.pending[1].options.signal.aborted,true);c.pending[2].resolve({rooms:[]});c.pending[3].resolve({rooms:[{code:'newest',status:'closed'}]});await second;}
    c.pending[0].resolve({rooms:[room({code:'stale-live'})]});c.pending[1].resolve({rooms:[{code:'stale-past',status:'closed'}]});await first;
    assert.equal(c.state.rooms[0].code,identityChange?'current':'newest');assert.equal(c.state.lobby.rooms.length,0);
  }
});

test('nine-player unlimited progress counts fish rather than unique holders and retains the round mode',()=>{
  const participants=Array.from({length:9},(_,i)=>'p'+i),counts=Object.fromEntries(participants.map((id,i)=>[id,i===0?3:i===1?1:0]));
  const r={settings:{squidMode:'unlimited'},mini:{squid:{active:true,mode:'unlimited',tokenBudget:12,participants,counts,won:['p0','p1']}}};
  const view=lifecycle.squidProgress(r);assert.equal(view.name,'无限鱿鱼');assert.equal(view.awarded,4);assert.equal(view.holders,2);assert.equal(view.missing,7);assert.equal(view.remaining,8);assert.equal(view.budget,12);
  assert.equal(lifecycle.playerSquidCount(r,{id:'p0'}),3);assert.equal(lifecycle.playerSquidCount(r,{id:'p2',squidCount:0,squidWon:true}),0);
  delete r.mini.squid.mode;delete r.mini.squid.counts;const legacy=lifecycle.squidProgress(r);assert.equal(legacy.mode,'normal');assert.equal(legacy.awarded,2);assert.equal(legacy.counts.p0,1);
});

test('unlimited departure and premature settlement use the actual budget and fish counts',()=>{
  const c=harness(),r=squidRoom();r.hand.status='complete';r.settings={bigBlind:10,squidMode:'unlimited',squidExtraTokens:3};
  Object.assign(r.mini.squid,{mode:'unlimited',tokenBudget:6,counts:{a:0,b:3,c:1},won:['b','c'],canSettle:true,blockerSince:1});
  r.players[0].squidMaxLoss=120;c.state.room=r;
  const plan=lifecycle.departurePlan(r,r.players[0],'stand');assert.equal(plan.cost,120);assert.equal(plan.fishCount,0);
  c.departureModal('stand');assert.match(c.state.modal.body,/最多覆盖.*120 积分/);
  const quote=lifecycle.squidSettlement(r);assert.equal(quote.loserCost,80);assert.equal(quote.winnerGain,20);
  c.settleSquidModal();assert.match(c.state.modal.body,/每位未获标记者支付 80 积分/);assert.match(c.state.modal.body,/有鱼者每条鱼获得 20 积分/);assert.match(c.state.modal.body,/剩余未发出的鱼不计费/);
  r.mini.squid.counts.a=2;r.mini.squid.won.push('a');c.departureModal('stand');assert.match(c.state.modal.body,/本轮 2 条鱼/);assert.equal(c.state.departureConfirmation.cost,0);
});


test('overtime keeps current squid responsibility without advertising new admission during play',()=>{
  const r=squidRoom();r.expiryMode='continue-squid';r.endsAt=Date.now()-1000;
  assert.match(lifecycle.squidMode(r).note,/仅已加入本轮的玩家继续或返回/);
  assert.doesNotMatch(lifecycle.squidMode(r).note,/新人可加入|总鱼数加 1/);
  r.hand.squidRound=null;assert.match(lifecycle.squidMode(r).note,/不再增加参与者/);
});
