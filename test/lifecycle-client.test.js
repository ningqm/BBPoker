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
  const context=vm.createContext({...money,lifecycle,state,requests,AbortController,document:{visibilityState:'visible'},
    clearTimeout:id=>timers.delete(id),setTimeout:(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;},
    api:(path,body,options={})=>{const result=deferred();pending.push({path,body,options,...result});return result.promise;},
    navigate:path=>paths.push(path),render:()=>renders++,toast:message=>messages.push(message),
    openModal:(title,body,kind)=>{state.modal={title,body,kind};},closeModal:()=>{state.modal=null;},
    command:async(type,payload)=>{commands.push({type,payload});return true;},
  });
  vm.runInContext([
    section('const esc=','const profitClass='),section('const btn=','const avatar='),
    section('function stopLobbyPolling(','async function route('),
    section('function lobbyRoomCard(','function career('),
    section('function departureModal(','function rulesModal('),
    'globalThis.client={stopLobbyPolling,loadLobby,joinPublicRoom,joinInviteModal,lobbyRoomCard,departureModal,confirmDeparture,settleSquidModal,participationNotice,entryBlindModal,confirmEntryBlind};',
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
  assert.match(lifecycle.buyinTiming(r),/下一轮/);delete r.mini;assert.match(lifecycle.buyinTiming(r),/后续符合条件/);
  r.hand.status='complete';assert.match(lifecycle.buyinTiming(r,false),/补充积分/);
  assert.equal(lifecycle.participation(r,{seat:1,waitingFor:'squid'}).label,'等待下一轮鱿鱼');
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
  room.mini.squid.won.push('a');c.departureModal('stand');assert.match(c.state.modal.body,/已获得本轮鱿鱼标记/);assert.match(c.state.modal.body,/结算权益/);
});

test('only an actual current-hand participant queues departure; squid responsibility is retained either way',()=>{
  const room=squidRoom();room.players[0].inHand=false;
  const plan=lifecycle.departurePlan(room,room.players[0],'stand');assert.equal(plan.queued,false);assert.equal(plan.cost,40);assert.equal(plan.participant,true);
  room.players[0].inHand=true;assert.equal(lifecycle.departurePlan(room,room.players[0],'stand').queued,true);
});

test('expired squid waits for eligible original players and does not promise newcomer participation',()=>{
  const room=squidRoom();room.expiryMode='wait-squid';room.mini.squid.blockerSince=100;
  assert.match(lifecycle.squidMode(room).label,/已到时.*本手结束后等待原轮/);assert.match(lifecycle.squidMode(room).note,/不足两人/);
  assert.match(lifecycle.buyinTiming(room,true,{id:'new'}),/新入座者不参加原轮/);
  assert.match(lifecycle.buyinTiming(room,true,{id:'a'}),/重新入座不会再收/);
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

test('new squid participants wait for the round even if they opted to post; returning originals get their existing reserve explanation',()=>{
  const room=squidRoom(),player=entryPlayer({waitingFor:'squid'});player.entryBlind.mode='post';
  assert.equal(lifecycle.participation(room,player).label,'等待下一轮鱿鱼');
  assert.match(lifecycle.participation(room,player).note,/本轮结束后生效/);
  assert.match(lifecycle.buyinTiming(room,true,{id:'a'}),/资格.*预留都保留/);
  assert.match(lifecycle.buyinTiming(room,true,{id:'new'}),/等下一轮/);
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
