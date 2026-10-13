import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as lifecycle from '../public/lifecycle.js';
import {createRequestGuard} from '../public/platform.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return source.slice(a,b);};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function harness(){
  const requests=createRequestGuard(),timers=new Map(),pending=[],paths=[],messages=[],commands=[];
  const state={user:{id:'a'},page:'lobby',rooms:[],timeOffset:0,lobby:{rooms:[],filter:'all',loading:false,loaded:false,error:'',request:0,timer:null,controller:null,joining:'',limit:10}};
  let sequence=0,renders=0;
  const context=vm.createContext({lifecycle,state,requests,AbortController,document:{visibilityState:'visible'},
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
    'globalThis.client={stopLobbyPolling,loadLobby,joinPublicRoom,joinInviteModal,lobbyRoomCard,departureModal,confirmDeparture,settleSquidModal,participationNotice};',
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
  assert.match(lifecycle.buyinTiming(r),/下一轮/);delete r.mini;assert.match(lifecycle.buyinTiming(r),/下一手/);
  r.hand.status='complete';assert.match(lifecycle.buyinTiming(r,false),/补充积分/);
  assert.equal(lifecycle.participation(r,{seat:1,waitingFor:'squid'}).label,'等待下一轮鱿鱼');
  assert.equal(lifecycle.participation(r,{seat:1,pendingDeparture:'stand'}).canCancel,true);
  assert.equal(lifecycle.participation(r,{seat:1,sittingOut:true}).canReturn,true);
});

test('exit quote binds the user round and fee, including zero for newcomers and marked players',()=>{
  const r=squidRoom();assert.equal(lifecycle.departurePlan(r,r.players[0],'stand').cost,40);
  assert.equal(lifecycle.departurePlan(r,{id:'new',seat:3},'stand').round,0);
  assert.equal(lifecycle.departurePlan(r,{id:'new',seat:3,inHand:false},'stand').queued,false);
  assert.equal(lifecycle.departurePlan(r,{id:'a',seat:0,inHand:true,folded:true},'stand').queued,true);
  assert.equal(lifecycle.departurePlan(r,{id:'b',seat:1},'stand').cost,0);
  assert.equal(lifecycle.departurePlan(r,{id:'b',seat:1},'stand').won,true);
});

test('a changed exit fee or hand boundary requires fresh confirmation before any command',async()=>{
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


test('ordinary fallback hand remains ordinary after reconnect and only the next hand restores squid',()=>{
  const room=squidRoom();room.hand.squidRound=null;room.mini.squid.paused=true;
  let mode=lifecycle.squidMode(room);assert.equal(mode.countsForSquid,false);assert.match(mode.label,/鱿鱼暂停.*本手普通德州/);assert.match(mode.note,/普通手不获得鱿鱼标记/);
  room.mini.squid.paused=false;mode=lifecycle.squidMode(room);assert.equal(mode.ordinaryHand,true);assert.match(mode.label,/下一手恢复鱿鱼/);
  room.hand.squidRound=4;assert.equal(lifecycle.squidMode(room).countsForSquid,true);assert.equal(lifecycle.squidMode(room).label,'');
  room.mini.squid.paused=true;assert.match(lifecycle.squidMode(room).label,/本手仍计鱿鱼/);
});

test('a paused round retains its exit fee but an ordinary hand does not promise earning a squid mark',()=>{
  const c=harness(),room=squidRoom();room.mini.squid.paused=true;room.hand.squidRound=null;c.state.room=room;
  const plan=lifecycle.departurePlan(room,room.players[0],'stand');assert.equal(plan.cost,40);assert.equal(plan.round,4);assert.equal(plan.canEarnMark,false);
  c.departureModal('stand');assert.match(c.state.modal.body,/40 积分/);assert.match(c.state.modal.body,/不会为你增加鱿鱼标记/);assert.doesNotMatch(c.state.modal.body,/如果本手获得标记/);
  assert.match(lifecycle.buyinTiming(room),/下一手普通德州/);assert.match(lifecycle.buyinTiming(room),/原轮恢复后/);
});

test('an unmarked original participant queues exit during a fallback hand even if not dealt into it',()=>{
  const room=squidRoom();room.hand.squidRound=null;room.mini.squid.paused=true;room.players[0].inHand=false;
  const plan=lifecycle.departurePlan(room,room.players[0],'stand');assert.equal(plan.queued,true);assert.equal(plan.cost,40);assert.equal(plan.canEarnMark,false);
  assert.equal(lifecycle.departurePlan(room,{id:'new',seat:3,inHand:false},'stand').queued,false);
});

test('an expired suspended squid does not advertise another ordinary hand or participation for newcomers',()=>{
  const room=squidRoom();room.expiryMode='wait-squid';room.mini.squid.paused=true;room.hand.squidRound=null;
  assert.match(lifecycle.squidMode(room).label,/本手普通德州.*结束后等待原轮恢复/);assert.match(lifecycle.squidMode(room).note,/不再开启普通手/);
  assert.match(lifecycle.buyinTiming(room),/不会再开启新的普通手/);
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
