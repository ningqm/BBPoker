import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { seedLegacyAccount } from './helpers/accounts.js';
import { readyRoomAction } from './helpers/room-clock.js';
import { preActionOptions, createPreActions } from '../public/pre-actions.js';

const context = { identity: 'isolated-session', page: 'room', connected: true, visible: true,
  resync: false, busy: false, staleSnapshot: false, online: true };

// Real loopback HTTP and production account/room/action handlers. Presence and
// the server clock are controlled locally; no production accounts are touched.
async function fixture(t, buyins = [200, 200, 200], actionTickMs = 1000000) {
  let time = 1800000000000; t.mock.method(Date, 'now', () => time);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-preactions-'));
  const app = createApp({ dataDir: directory, actionTickMs, diagnosticsSink() {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let writes = 0;
  const users = buyins.map((_, i) => seedLegacyAccount(app, { name: `预操作验收${i + 1}` }));
  async function api(index, path, body, expected = 200) {
    if (body) writes++;
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users[index].token}` },
      body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); if(Array.isArray(expected))assert.ok(expected.includes(response.status),JSON.stringify(value));else assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  const created = (await api(0, '/api/rooms', { name: '预操作 HTTP 验收', settings: {
    smallBlind: 5, bigBlind: 10, maxPlayers: 9, durationMinutes: 30,
  } }, 201)).room;
  const code = created.code, path = `/api/rooms/${code}`, room = () => app.store.data.rooms[code];
  const id = index => users[index].user.id;
  const command = (index, type, extra = {}, expected = 200) => api(index, path + '/action', {
    type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra,
  }, expected);
  for (let i = 0; i < users.length; i++) {
    if (i) await api(i, path + '/join', { invite: created.invite });
    await command(i, 'sit', { seat: i, amountBB: buyins[i] });
    app.service.connections.set(`${code}:${id(i)}`, 1);
  }
  await command(0, 'start');
  const ready = () => { readyRoomAction(app.service, room(), value => { time = value; }); app.store.save(); };
  const conserve = () => {
    const r = room(), members = Object.values(r.members);
    const held = members.reduce((sum, player) => sum + player.stack + player.cashedOut - (player.squidDebt ?? 0), 0)
      + (r.hand?.status === 'playing' ? r.hand.players.reduce((sum, player) => sum + player.contributed, 0) : 0);
    assert.equal(held, members.reduce((sum, player) => sum + player.totalBuyIn, 0));
  };
  ready(); conserve();
  return { app, room, id, command, ready, conserve, api, path, get writes() { return writes; }, tick(){ app.service.tick(room(),time);app.store.save(); }, advance(ms){time+=ms;}, users,
    timeout() { time = room().deadline; app.service.tick(room(), time); app.store.save(); },
    view: index => api(index, path), player: index => room().hand.players.find(player => player.id === id(index)) };
}


async function select(f,i,kind='call-current',extra={},status=200){
 const v=await f.view(i),q=preActionOptions(v);
 return f.command(i,'preAction',{kind,preActionVersion:v.preActionVersion,handId:v.hand.id,street:v.hand.street,
 currentBet:q.currentBet,ownBet:v.players.find(p=>p.id===f.id(i)).bet,callAmount:q.callAmount,...extra},status);
}
async function cancel(f,i,extra={},status=200){const v=await f.view(i);return f.command(i,'preAction',{
 kind:null,preActionId:v.preAction?.id,preActionVersion:v.preActionVersion,...extra},status);}
const actionCount=(f,i,type)=>f.room().hand.log.filter(x=>x.playerId===f.id(i)&&x.type===type).length;

test('server executes a confirmed intent while disconnected, once; private to its owner',async t=>{
 const f=await fixture(t);await select(f,1);const v=await f.view(1);assert.equal(v.preAction.callAmount,5);
 assert.equal((await f.view(0)).preAction,null);assert.ok(!JSON.stringify(await f.view(0)).includes(v.preAction.id));
 f.app.service.connections.set(f.room().code+':'+f.id(1),0);f.app.service.connectionChanged(f.room(),Date.now(),{disconnectedId:f.id(1)});
 const before=f.player(1).contributed;await f.command(0,'call');f.tick();
 assert.equal(actionCount(f,1,'call'),1);assert.equal(f.player(1).contributed-before,5);assert.equal((await f.view(1)).preAction,null);
 for(let i=0;i<4;i++){f.tick();f.app.service.connections.set(f.room().code+':'+f.id(1),1);f.app.service.connectionChanged(f.room(),Date.now(),{reconnected:true});}
 assert.equal(actionCount(f,1,'call'),1);f.conserve();
});
test('cancel before the turn prevents execution; late cancellation reports conflict instead of false success',async t=>{
 const f=await fixture(t);await select(f,1);await cancel(f,1);await f.command(0,'call');f.tick();assert.equal(actionCount(f,1,'call'),0);f.conserve();
});
test('executed selection cannot be cancelled or recreated by a stale device',async t=>{
 const f=await fixture(t);await select(f,1);const v=await f.view(1);await f.command(0,'call');f.tick();
 await cancel(f,1,{preActionVersion:v.preActionVersion,preActionId:v.preAction.id},409);
 await select(f,1,'check-fold',{preActionVersion:v.preActionVersion},409);assert.equal(actionCount(f,1,'call'),1);f.conserve();
});
test('retrying same set and cancel requests never re-arms consumed intent, even after command cache eviction',async t=>{
 const f=await fixture(t),commandId=randomUUID();await select(f,1,'call-current',{commandId});const v=await f.view(1);
 await select(f,1,'call-current',{commandId,preActionVersion:0});assert.equal((await f.view(1)).preActionVersion,v.preActionVersion);
 await f.command(0,'call');f.tick();await select(f,1,'call-current',{commandId,preActionVersion:0});
 f.room().commandIds={};await select(f,1,'call-current',{commandId,preActionVersion:0},409);f.conserve();
});
test('increase cancels a fixed-price call and free check; check-fold still folds without paying',async t=>{
 const f=await fixture(t);await select(f,1);await select(f,2);await f.command(0,'raise',{amount:40});
 assert.equal((await f.view(1)).preAction,null);assert.equal((await f.view(2)).preAction,null);f.tick();assert.equal(actionCount(f,1,'call'),0);
 await select(f,2,'check-fold');await f.command(1,'call');const before=f.player(2).contributed;f.tick();
 assert.equal(actionCount(f,2,'fold'),1);assert.equal(f.player(2).contributed,before);f.conserve();
});
test('manual action wins race and consumes intent; subsequent server tick cannot act twice',async t=>{
 const f=await fixture(t);await select(f,1);await f.command(0,'call');await f.command(1,'call');f.tick();
 assert.equal(actionCount(f,1,'call'),1);assert.equal((await f.view(1)).preAction,null);f.conserve();
});
test('server execution wins race and rejects stale manual wager',async t=>{
 const f=await fixture(t);await select(f,1);await f.command(0,'call');const seq=f.room().hand.log.length;f.tick();
 await f.command(1,'call',{actionSeq:seq},409);assert.equal(actionCount(f,1,'call'),1);f.conserve();
});
test('one automatic check does not become a later automatic fold when action circles back',async t=>{
 const f=await fixture(t);await f.command(0,'call');await f.command(1,'call');await f.command(2,'check');f.ready();
 // Flop actor is small blind; big blind preselects once.
 assert.equal(f.room().hand.actingId,f.id(1));await select(f,2,'check-fold');await f.command(1,'check');f.tick();
 assert.equal(actionCount(f,2,'check'),2);assert.equal((await f.view(2)).preAction,null);
 await f.command(0,'raise',{amount:20});await f.command(1,'call');f.tick();assert.equal(f.room().hand.actingId,f.id(2));assert.equal(actionCount(f,2,'fold'),0);f.conserve();
});
test('late tick never spends a call after the action deadline',async t=>{
 const f=await fixture(t);await select(f,1);await f.command(0,'call');f.timeout();
 assert.equal(actionCount(f,1,'call'),0);assert.equal(actionCount(f,1,'fold'),1);assert.equal((await f.view(1)).preAction,null);f.conserve();
});
test('restart invalidates unexecuted selections instead of reviving stale authorization',async t=>{
 const f=await fixture(t);await select(f,1);f.app.service.observationId=randomUUID();f.tick();assert.equal((await f.view(1)).preAction,null);
 await f.command(0,'call');f.tick();assert.equal(actionCount(f,1,'call'),0);f.conserve();
});
test('cancel/replacement uses CAS: a delayed old tab cannot clear a newer selection',async t=>{
 const f=await fixture(t);await select(f,1);const old=await f.view(1);await select(f,1,'check-fold');
 await cancel(f,1,{preActionVersion:old.preActionVersion,preActionId:old.preAction.id},409);
 assert.equal((await f.view(1)).preAction.kind,'check-fold');await f.command(0,'call');f.tick();assert.equal(actionCount(f,1,'fold'),1);f.conserve();
});
test('failed persistence does not confirm or retain an uncommitted selection',async t=>{
 const f=await fixture(t);const save=f.app.store.save.bind(f.app.store);f.app.store.save=()=>{throw Object.assign(new Error('injected storage failure'),{status:500});};
 await select(f,1,'call-current',{},500);f.app.store.save=save;assert.equal((await f.view(1)).preAction,null);assert.equal((await f.view(1)).preActionVersion,0);
 await select(f,1);await f.command(0,'call');f.tick();assert.equal(actionCount(f,1,'call'),1);f.conserve();
});

test('execution and consumption roll back together on disk failure; timer retry charges once',async t=>{
 const f=await fixture(t,undefined,10);await select(f,1);const save=f.app.store.save.bind(f.app.store);let failures=0;
 f.app.store.save=()=>{if(f.room().members[f.id(1)].preActionResult?.reason==='executed'&&failures===0){failures++;throw new Error('injected execution persistence failure');}return save();};
 await f.command(0,'call');
 for(let n=0;n<100&&actionCount(f,1,'call')!==1;n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(failures,1);assert.equal(actionCount(f,1,'call'),1);assert.equal(f.player(1).contributed,10);
 f.app.store.save=save;await new Promise(r=>setTimeout(r,40));assert.equal(actionCount(f,1,'call'),1);f.conserve();
});
test('failed cancellation cannot falsely clear confirmed intent',async t=>{
 const f=await fixture(t);await select(f,1);const v=await f.view(1),save=f.app.store.save.bind(f.app.store);
 f.app.store.save=()=>{throw Object.assign(new Error('cancel storage failure'),{status:500});};await cancel(f,1,{},500);f.app.store.save=save;
 assert.equal((await f.view(1)).preAction.id,v.preAction.id);await f.command(0,'call');f.tick();assert.equal(actionCount(f,1,'call'),1);f.conserve();
});
test('explicit departure clears intent even while the current hand remains active',async t=>{
 const f=await fixture(t);await select(f,1);await f.command(1,'sitout',{value:true});
 assert.equal((await f.view(1)).preAction,null);await f.command(0,'call');f.tick();assert.equal(actionCount(f,1,'call'),0);f.conserve();
});
test('a delayed stale hand or street selection cannot arm a new hand',async t=>{
 const f=await fixture(t),v=await f.view(1),q=preActionOptions(v);
 await select(f,1,'call-current',{street:'river'},409);assert.equal((await f.view(1)).preAction,null);
 await f.command(0,'call');await f.command(1,'call');await f.command(2,'check');f.ready();
 await f.command(2,'preAction',{kind:'check-fold',preActionVersion:0,handId:v.hand.id,street:v.hand.street,actionSeq:v.hand.actionSeq,currentBet:q.currentBet,ownBet:10,callAmount:0},409);
 assert.equal((await f.view(2)).preAction,null);f.conserve();
});

test('server-owned short-stack call is capped at remaining stack and never becomes a raise',async t=>{
 const f=await fixture(t,[300,100,200,300]);await f.command(3,'allin');f.ready();await select(f,1);
 assert.equal((await f.view(1)).preAction.callAmount,995);await f.command(0,'fold');f.tick();
 assert.equal(f.player(1).stack,0);assert.equal(f.player(1).contributed,1000);assert.equal(actionCount(f,1,'call'),1);
 assert.equal(actionCount(f,1,'allin'),0);f.tick();assert.equal(actionCount(f,1,'call'),1);f.conserve();
});
test('real timer cancellation race is serializable: either cancelled or executed exactly once',async t=>{
 const f=await fixture(t,undefined,10);await select(f,1);const v=await f.view(1),commandId=randomUUID();
 await Promise.all([f.command(0,'call'),f.command(1,'preAction',{kind:null,preActionId:v.preAction.id,preActionVersion:v.preActionVersion,commandId},[200,409])]);
 await new Promise(r=>setTimeout(r,40));const result=f.room().members[f.id(1)].preActionResult;
 assert.ok(['cancelled','executed'].includes(result.reason));assert.equal(actionCount(f,1,'call'),result.reason==='executed'?1:0);
 await f.command(1,'preAction',{kind:null,preActionId:v.preAction.id,preActionVersion:v.preActionVersion,commandId},[200,409]);
 assert.equal(f.player(1).contributed,result.reason==='executed'?10:5);f.conserve();
});
