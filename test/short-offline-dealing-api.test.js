import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { seedLegacyAccount } from './helpers/accounts.js';
import { readyRoomAction } from './helpers/room-clock.js';

test('real SSE closure retains next-hand participation without duplicate blind on reconnect',async t=>{
 let time=1800000000000;t.mock.method(Date,'now',()=>time);
 const dataDir=mkdtempSync(join(tmpdir(),'bbpoker-offline-grace-'));
 const app=createApp({dataDir,actionTickMs:1000000,diagnosticsSink(){}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+app.server.address().port;
 const users=Array.from({length:3},(_,i)=>seedLegacyAccount(app,{name:'离线验收'+i}));
 async function api(i,path,body){const res=await fetch(origin+path,{method:'POST',headers:{Authorization:'Bearer '+users[i].token,'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await res.json();assert.ok(res.ok,JSON.stringify(v));return v;}
 const created=(await api(0,'/api/rooms',{name:'短暂断线验收',settings:{smallBlind:5,bigBlind:10,durationMinutes:30}})).room;
 const code=created.code,room=()=>app.store.data.rooms[code],id=i=>users[i].user.id;
 const cmd=(i,type,extra={})=>api(i,'/api/rooms/'+code+'/action',{type,commandId:randomUUID(),handId:room().hand?.id,actionSeq:room().hand?.log.length,...extra});
 for(let i=0;i<3;i++){if(i)await api(i,'/api/rooms/'+code+'/join',{invite:created.invite});await cmd(i,'sit',{seat:i,amountBB:200});app.service.connections.set(code+':'+id(i),1);}
 await cmd(0,'start');
 while(room().hand.status==='playing'){
  readyRoomAction(app.service,room(),v=>time=v);if(room().hand.status!=='playing')break;
  await cmd([0,1,2].find(i=>id(i)===room().hand.actingId),'fold');
 }
 app.service.completeRabbit(room(),time);
 const key=code+':'+id(2),stream=()=>fetch(origin+'/api/events?room='+code,{headers:{Authorization:'Bearer '+users[2].token}});
 app.service.connections.delete(key);
 const response=await stream();assert.equal(response.status,200);
 const reader=response.body.getReader();await reader.read();assert.equal(app.service.connections.get(key),1);await reader.cancel();
 for(let i=0;i<100&&!app.service.offlinePresence.get(key)?.continueDealing;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(app.service.online(room(),id(2)),false);assert.equal(app.service.canReceiveHand(room(),id(2)),true);
 const before=room().members[id(2)].stack;
 app.service.start(room(),time,{automatic:true});
 const player=()=>room().hand.players.find(p=>p.id===id(2));
 assert.ok(player());assert.equal(room().hand.smallBlindSeat,2);assert.equal(player().contributed,5);assert.equal(player().stack,before-5);
 const resumed=await stream(),read=resumed.body.getReader();await read.read();
 assert.equal(app.service.offlinePresence.has(key),false);assert.equal(player().contributed,5);assert.equal(player().stack,before-5);
 const members=Object.values(room().members);assert.equal(members.reduce((s,m)=>s+m.stack+m.cashedOut-(m.squidDebt||0),0)+room().hand.players.reduce((s,p)=>s+p.contributed,0),6000);
 await read.cancel();
});
