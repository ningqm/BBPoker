import { seedLegacyAccount } from './helpers/accounts.js';
import test from 'node:test';
import { readyRoomAction } from './helpers/room-clock.js';
import assert from 'node:assert/strict';
const pointTotals = ({ bb, ...points }) => points;
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { recordFilters, pageRecords } from '../src/records.js';
import { createApp } from '../server.js';

function fixture(t) {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const store={data:{version:1,users:{},rooms:{},hands:[],ledger:[]}},users=['me','friend','observer','stranger'].map(id=>({id,name:id,avatar:0}));
  for(const user of users)store.data.users[user.id]=user;
  const service=new RoomService(store),room=service.create(users[0],{name:'周五好友局',settings:{}});
  for(const user of users.slice(1,3))service.join(user,room.code,room.invite);
  const command=(user,type,payload={})=>service.command(user,room.code,{type,commandId:randomUUID(),handId:room.hand?.id,actionSeq:room.hand?.log.length,...payload});
  command(users[0],'sit',{seat:0,amount:1000});command(users[1],'sit',{seat:1,amount:1000});
  for(const user of users.slice(0,2))service.connections.set(`${room.code}:${user.id}`,1);
  command(users[0],'start');
  while(room.hand.status==='playing') { if (!readyRoomAction(service, room, value => { clock = value; })) break; command(users.find(user=>user.id===room.hand.actingId),'fold'); }
  const template=structuredClone(store.data.hands[0]);store.data.hands=[];
  function hand(id,{net=0,mini=0,friendMini=-mini,at='2026-10-12T12:00:00.000Z',number=1,bomb=false,status='complete',name=room.name}={}){
    const h=structuredClone(template);Object.assign(h,{id,number,at,bombPot:bomb,status,roomName:name});
    for(const p of h.players){p.startingStack=1000;p.stack=1000+(p.id==='me'?net:-net);}
    h.miniChanges={me:mini,friend:friendMini};store.data.hands.push(h);return h;
  }
  return {store,users,service,room,command,hand};
}

function noSecrets(value){
  const forbidden=new Set(['cards','deck','audit','salt','proofs','commitment','invite','token','passwordHash','recoveryHash','log','chat']);
  const visit=input=>{if(!input||typeof input!=='object')return;for(const [key,item] of Object.entries(input)){assert.ok(!forbidden.has(key),`Unexpected ${key}`);visit(item);}};
  visit(value);
}

test('session totals count settled poker and mini changes plus legacy refunds, not buy-ins or a live hand',t=>{
  const f=fixture(t);f.hand('first',{net:-30,mini:50});f.hand('second',{net:20,mini:-10,friendMini:0,number:2});
  f.store.data.ledger.push({roomCode:f.room.code,type:'mushroomRefund',playerId:'me',amount:10,at:'2026-10-12T13:00:00.000Z'});
  f.room.members.me.totalBuyIn+=500;f.room.members.me.stack+=500;
  f.store.data.ledger.push({roomCode:f.room.code,type:'buyin',playerId:'me',amount:500});
  f.service.start(f.room);assert.equal(f.room.hand.status,'playing');
  const {session}=f.service.sessionFor('me',f.room.code);
  assert.equal(session.handCount,2);assert.equal(session.handInProgress,true);assert.equal(session.playerCount,2);
  assert.equal(session.meHoldemNet,-10);assert.equal(session.meMiniNet,50);assert.equal(session.meNet,40);
  const me=session.players.find(p=>p.id==='me');assert.equal(me.totalBuyIn,1500);assert.equal(me.hands,2);
  assert.equal(session.players.reduce((n,p)=>n+p.net,0),0);assert.equal(session.adjustments,true);noSecrets(session);
});

test('session details are member-only, include both players for an invited observer, and personal hand pages exclude that observer',t=>{
  const f=fixture(t);f.hand('settled',{net:10});
  assert.throws(()=>f.service.sessionFor('stranger',f.room.code),e=>e.status===403);
  assert.throws(()=>f.service.sessions('stranger',{room:f.room.code}),e=>e.status===403);
  assert.deepEqual(f.service.sessions('stranger').sessions,[]);
  const observer=f.service.sessionFor('observer',f.room.code).session;
  assert.equal(observer.players.length,2);assert.equal(observer.meNet,0);assert.equal(observer.playerCount,2);noSecrets(observer);
  assert.equal(f.service.sessions('observer').sessions.length,1);
  assert.deepEqual(f.service.handLibrary('observer').hands,[]);
  const observed=f.service.history('observer',f.room.code,{limit:'20'});
  assert.equal(observed.hands.length,1);assert.equal(observed.hands[0].participated,false);assert.deepEqual(observed.hands[0].cards,[null,null]);
  assert.throws(()=>f.service.history('stranger',f.room.code,{limit:'20'}),e=>e.status===403);
});

test('legacy token-keyed users display their current names even before their first completed hand',t=>{
  const f=fixture(t);delete f.store.data.users.me;f.users[0].name='已经改过的昵称';f.store.data.users['legacy-token-hash']=f.users[0];
  const detail=f.service.sessionFor('me',f.room.code).session;
  assert.equal(detail.players.find(p=>p.id==='me').name,'已经改过的昵称');
  assert.equal(detail.players.find(p=>p.id==='me').hands,0);
  f.hand('old-name');assert.equal(f.service.sessionFor('me',f.room.code).session.players.find(p=>p.id==='me').name,'已经改过的昵称');
});

test('explicit local-day ISO bounds include midnight and the final millisecond while excluding the adjacent days',t=>{
  const f=fixture(t);
  for(const [id,at] of [['before','2026-10-11T15:59:59.999Z'],['midnight','2026-10-11T16:00:00.000Z'],['end','2026-10-12T15:59:59.999Z'],['after','2026-10-12T16:00:00.000Z']])f.hand(id,{at,net:1});
  const result=f.service.handLibrary('me',{from:'2026-10-12T00:00:00.000+08:00',to:'2026-10-12T23:59:59.999+08:00'});
  assert.deepEqual(result.hands.map(h=>h.id),['end','midnight']);assert.equal(result.totals.count,2);
});

test('hand result/date/type/text filters apply before pagination and totals cover all matching hands',t=>{
  const f=fixture(t);
  f.hand('win-a',{net:5,mini:5,number:1,bomb:true});
  f.hand('win-b',{net:-10,mini:30,number:2,bomb:true});
  f.hand('win-c',{net:15,mini:0,number:3,bomb:true});
  f.hand('loss',{net:30,mini:-40,number:4,bomb:true});
  f.hand('even',{net:5,mini:-5,number:5,bomb:true});
  f.hand('ordinary',{net:10,number:6});
  f.hand('other-name',{net:10,number:7,bomb:true,name:'另一个房间'});
  f.hand('other-day',{net:10,number:8,bomb:true,at:'2026-10-09T12:00:00.000Z'});
  f.hand('live',{net:100,number:9,bomb:true,status:'playing'});
  const query={limit:'2',from:'2026-10-12',to:'2026-10-12',result:'win',type:'bomb',q:'好友'};
  const first=f.service.handLibrary('me',query),second=f.service.handLibrary('me',{...query,before:first.nextCursor});
  assert.equal(first.hands.length,2);assert.equal(second.hands.length,1);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.hands,...second.hands].map(h=>h.id)).size,3);
  assert.deepEqual(pointTotals(first.totals), {count:3,net:45,holdemNet:10,miniNet:35,wins:3,losses:0,even:0});assert.deepEqual(second.totals,first.totals);
  for(const item of [...first.hands,...second.hands]){assert.equal(item.participated,true);assert.equal(item.totalNet,item.net+item.miniNet);assert.equal(item.players,undefined);assert.equal(item.deck,undefined);assert.equal(item.log,undefined);assert.deepEqual(item.cards,f.store.data.hands.find(h=>h.id===item.id).players.find(p=>p.id==='me').cards);}
  assert.equal(f.service.handLibrary('me',{...query,result:'loss'}).hands[0].id,'loss');
  assert.equal(f.service.handLibrary('me',{...query,result:'even'}).hands[0].id,'even');
  assert.equal(f.service.handLibrary('me',{...query,type:'holdem'}).hands[0].id,'ordinary');
  assert.equal(f.service.handLibrary('me',{q:'WIN-B'}).hands[0].id,'win-b');
});

test('session lists filter and paginate stable ties, with aggregate totals and no player details on summaries',t=>{
  const f=fixture(t);f.hand('session-hand',{net:10,mini:5});f.room.startedAt=Date.parse('2026-10-12T12:00:00.000Z');f.room.status='closed';
  for(const code of ['100001','100002']){
    const room=structuredClone(f.room);room.code=code;f.store.data.rooms[code]=room;
    const hand=structuredClone(f.store.data.hands[0]);hand.id='hand-'+code;hand.roomCode=code;f.store.data.hands.push(hand);
  }
  const query={q:'好友',from:'2026-10-12',to:'2026-10-12',status:'closed',result:'win',limit:'2'};
  const first=f.service.sessions('me',query),second=f.service.sessions('me',{...query,before:first.nextCursor});
  assert.equal(first.sessions.length,2);assert.equal(second.sessions.length,1);
  assert.equal(new Set([...first.sessions,...second.sessions].map(r=>r.code)).size,3);
  assert.deepEqual(pointTotals(first.totals), {count:3,net:45,holdemNet:30,miniNet:15,wins:3,losses:0,even:0});assert.deepEqual(first.totals,second.totals);
  for(const row of [...first.sessions,...second.sessions]){assert.equal(row.players,undefined);assert.equal(row.id,undefined);noSecrets(row);}
  assert.equal(f.service.sessions('me',{...query,status:'active'}).sessions.length,0);
  assert.equal(f.service.sessions('me',{q:'100002'}).sessions[0].code,'100002');
});

test('invalid record filters and cursor/limit values fail explicitly rather than broadening a search',t=>{
  for(const query of [{from:'2026-02-30'},{to:'next Monday'},{from:'2026-10-14',to:'2026-10-13'},{from:'2026-13-01'},{result:'all OR 1=1'},{type:'omaha'},{status:'deleted'},{q:'界'.repeat(81)},{q:{}}])assert.throws(()=>recordFilters(query),e=>e.status===400);
  for(const query of [{limit:'0'},{limit:'51'},{limit:'1e1'},{before:'@'},{before:'not-a-cursor'},{before:Buffer.from(JSON.stringify({at:'bad',id:'id'})).toString('base64url')}])assert.throws(()=>pageRecords([],query),e=>e.status===400);
  const f=fixture(t);for(const query of [{result:'bad'},{from:'bad'},{q:'x'.repeat(81)},{before:'@'}]){
    assert.throws(()=>f.service.sessions('me',query),e=>e.status===400);assert.throws(()=>f.service.handLibrary('me',query),e=>e.status===400);
  }
});

test('HTTP records require login and room membership, reject malformed filters, and preserve folded-card privacy',async t=>{
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const directory=mkdtempSync(join(tmpdir(),'bbpoker-records-')),app=createApp({dataDir:directory});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  async function api(user,path,body,status=200){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(user?{Authorization:`Bearer ${user.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;}
  const users=[];for(const name of ['甲','乙','旁观','局外'])users.push(seedLegacyAccount(app, {name}));
  const room=(await api(users[0],'/api/rooms',{name:'HTTP朋友局'},201)).room;
  for(const user of users.slice(1,3))await api(user,`/api/rooms/${room.code}/join`,{invite:room.invite});
  for(const path of ['/api/sessions','/api/hands',`/api/sessions/${room.code}`])await api(null,path,undefined,401);
  await api(users[3],`/api/sessions/${room.code}`,undefined,403);await api(users[3],`/api/sessions?room=${room.code}`,undefined,403);
  const command=async(i,type,payload={})=>{const internal=app.store.data.rooms[room.code];return api(users[i],`/api/rooms/${room.code}/action`,{type,commandId:randomUUID(),handId:internal.hand?.id,actionSeq:internal.hand?.log.length,...payload});};
  await command(0,'sit',{seat:0,amount:1000});await command(1,'sit',{seat:1,amount:1000});
  for(const user of users.slice(0,2))app.service.connections.set(`${room.code}:${user.user.id}`,1);
  await command(0,'start');
  readyRoomAction(app.service, app.store.data.rooms[room.code], value => { clock = value; });
  const foldedId=app.store.data.rooms[room.code].hand.actingId;await command(users.findIndex(u=>u.user.id===foldedId),'fold');
  readyRoomAction(app.service, app.store.data.rooms[room.code], value => { clock = value; });
  const observer=await api(users[2],`/api/sessions/${room.code}`);assert.equal(observer.session.players.length,2);noSecrets(observer);
  assert.deepEqual((await api(users[2],'/api/hands')).hands,[]);
  assert.deepEqual((await api(users[2],'/api/hands?includeObserved=true')).hands,[]);
  assert.deepEqual((await api(users[3],'/api/hands?includeObserved=true')).hands,[]);
  const personal=await api(users[0],'/api/hands?result=all&type=holdem');assert.equal(personal.hands.length,1);
  const replay=await api(users[2],`/api/rooms/${room.code}/hands/${personal.hands[0].id}`);
  assert.deepEqual(replay.players.find(p=>p.id===foldedId).cards,[null,null]);
  const observed=await api(users[2],`/api/rooms/${room.code}/history?limit=1&type=holdem`);assert.deepEqual(observed.hands[0].cards,[null,null]);
  for(const endpoint of ['/api/sessions','/api/hands',`/api/rooms/${room.code}/history`])for(const query of ['from=2026-02-30','q='+encodeURIComponent('字'.repeat(81)),'before=%40','result=wrong'])await api(users[0],`${endpoint}?${query}`,undefined,400);
});
