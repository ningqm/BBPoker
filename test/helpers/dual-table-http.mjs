import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server.js';

export const MODES = {
  holdem: {}, normal: { squid:true, squidMode:'normal' }, unlimited:{ squid:true, squidMode:'unlimited' },
  bomb:{ bombPot:true }, normalBomb:{ squid:true,squidMode:'normal',bombPot:true },
  unlimitedBomb:{ squid:true,squidMode:'unlimited',bombPot:true },
};
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export async function dualTableFixture({port=0,modes=['normalBomb','unlimitedBomb'],registered=true,actionTickMs=100}={}) {
  const directory=mkdtempSync(join(tmpdir(),'bbpoker-dual-http-'));
  const app=createApp({dataDir:directory,allowGuestSessions:true,actionTickMs});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${app.server.address().port}`, tables=[], sockets=new Map(), events=[], errors=[];
  let busy=false,closed=false,timer=null;
  async function api(user,path,body,expected=200) {
    const before=performance.now();
    const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(user?{Authorization:`Bearer ${user.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const value=await response.json();
    events.push({kind:body===undefined?'read':'write',path:path.replace(/\/players\/[^/]+\//,'/players/person/'),status:response.status,ms:performance.now()-before});
    assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  async function connect(table,index) {
    const user=table.users[index],key=`${table.index}:${index}`,controller=new AbortController();
    const response=await fetch(`${origin}/api/events?room=${table.code}`,{headers:{Authorization:`Bearer ${user.token}`},signal:controller.signal});
    assert.equal(response.status,200);
    const stream={controller,reader:response.body.getReader(),latest:null,frames:0,table,index};sockets.set(key,stream);
    stream.done=(async()=>{let buffer='';const decoder=new TextDecoder();try{for(;;){const{done,value}=await stream.reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const json=frame.split('\n').find(line=>line.startsWith('data: '));if(json){const state=JSON.parse(json.slice(6));assert.equal(state.meId,user.user.id);assert.equal(state.code,table.code);assert.equal(state.hand?.deck,undefined);stream.latest=state;stream.frames++;}}}}catch(error){if(!controller.signal.aborted&&!closed)errors.push({phase:'stream',message:error.message,table:table.index});}})();
    for(let i=0;i<200&&!stream.latest;i++)await sleep(5);assert.ok(stream.latest,'initial SSE frame');return stream;
  }
  async function disconnect(table,index) {
    const key=`${table.index}:${index}`,stream=sockets.get(key);if(!stream)return;
    stream.controller.abort();await stream.reader.cancel().catch(()=>{});await stream.done;sockets.delete(key);
    for(let i=0;i<200&&(app.service.connections.get(`${table.code}:${table.users[index].user.id}`)??0)>0;i++)await sleep(5);
    assert.equal(app.service.connections.get(`${table.code}:${table.users[index].user.id}`)??0,0);
  }
  const internal=table=>app.store.data.rooms[table.code];
  async function command(table,index,type,extra={},expected=200) {
    const h=internal(table).hand;
    const body={type,commandId:randomUUID(),handId:h?.id,actionSeq:h?.log.length,...extra};
    const result=await api(table.users[index],`/api/rooms/${table.code}/action`,body,expected);
    if(expected===200&&['fold','check','call','raise','allin'].includes(type))table.actions[type]=(table.actions[type]??0)+1;
    return result;
  }
  const checkedHands=new Set();
  function conserve(table) {
    const r=internal(table),members=Object.values(r.members),h=r.hand;
    const chips=members.reduce((n,m)=>n+m.stack+m.cashedOut,0)+Object.values(r.mini.squid.reserves).reduce((n,v)=>n+v,0)+(h?.status==='playing'?h.players.reduce((n,p)=>n+p.contributed,0):0);
    const buyins=members.reduce((n,m)=>n+m.totalBuyIn,0);assert.equal(chips,buyins,`table ${table.index} total points`);
    for(const m of members)assert.ok(Number.isSafeInteger(m.stack)&&m.stack>=0);
    assert.equal(app.store.data.ledger.filter(row=>row.roomCode===r.code&&['holdem','squidSettlement'].includes(row.type)).reduce((sum,row)=>sum+row.amount,0),0);
    const q=r.mini.squid;
    if(q.active){assert.equal(new Set(q.participants).size,q.participants.length);assert.equal(Object.values(q.counts).reduce((s,n)=>s+n,0),q.won.reduce((s,id)=>s+q.counts[id],0));assert.ok(Object.values(q.counts).reduce((s,n)=>s+n,0)<=q.tokenBudget);}
    if(h?.status==='complete'&&!checkedHands.has(h.id)){
      checkedHands.add(h.id);assert.equal(h.players.reduce((n,p)=>n+p.stack-p.startingStack,0),0);
      assert.equal(app.store.data.hands.filter(x=>x.id===h.id).length,1);
      table.completed.push({number:h.number,id:h.id,bomb:h.bombPot,players:h.players.length,pots:h.result.pots.map(p=>p.amount),sidePots:h.result.pots.length-1,allIn:!!h.allInLock,showdown:h.result.showdown});
    }
    return {buyins,held:chips,hands:table.completed.length,fishBudget:q.tokenBudget??0,fish:q.counts??{}};
  }
  function strategy(view,table) {
    const a=view.actions,h=view.hand;if(!a?.canAct||h?.status!=='playing'||h.actingId!==view.meId)return null;
    const index=table.users.findIndex(u=>u.user.id===view.meId),plan=(h.number+table.index)%5;
    const paid=(h.log??[]).filter(e=>e.street==='preflop'&&e.isRaise).length;
    if(plan===0)return {type:a.canCheck?'check':'call'};
    if(plan===1&&h.street==='preflop'&&paid<3&&a.canRaise)return {type:'raise',amount:Math.min(a.maxRaiseTo,Math.ceil(Math.max(a.minRaiseTo,(h.currentBet||10)*3)/10)*10)};
    if(plan===1&&index%3!==0&&h.street==='preflop'&&a.canFold)return {type:'fold'};
    if((plan===1&&h.street!=='preflop'||plan===2)&&a.canAllIn)return {type:'allin'};
    if(plan===3&&index!==(h.number%table.users.length)&&a.canFold)return {type:'fold'};
    if(plan===4&&a.canRaise&&paid<2&&index%3===0)return {type:'raise',amount:Math.min(a.maxRaiseTo,Math.ceil(Math.max(a.minRaiseTo,(h.pot||10)*0.5)/10)*10)};
    return {type:a.canCheck?'check':a.callAmount>0?'call':'fold'};
  }
  async function autoplayStep({manualWhenBrowser=true,thinkMs=850}={}) {
    if(busy||closed)return;busy=true;
    try {await Promise.all(tables.map(async table=>{
      const r=internal(table);if(r.status==='closed')return;conserve(table);
      for(let i=0;i<table.users.length;i++){
        if(table.manual.has(i)||manualWhenBrowser&&i===0&&(app.service.connections.get(`${table.code}:${table.users[0].user.id}`)??0)>1)continue;
        const m=r.members[table.users[i].user.id];if(m?.seat!=null&&m.stack<300&&!m.pendingDeparture&&!app.service.pendingBuyIn(m)&&(!r.hand||r.hand.status!=='playing'))await command(table,i,'buyin',{amountBB:200});
      }
      const actor=table.users.findIndex(u=>u.user.id===r.hand?.actingId);if(actor<0)return;
      const stream=sockets.get(`${table.index}:${actor}`),view=stream?.latest;
      if(!view?.actions?.canAct||view.hand.id!==r.hand.id||view.hand.actionSeq!==r.hand.log.length)return;
      if(table.manual.has(actor)||manualWhenBrowser&&actor===0&&(app.service.connections.get(`${table.code}:${table.users[0].user.id}`)??0)>1)return;
      const key=`${view.hand.id}:${view.hand.actionSeq}`;
      if(table.nextKey!==key){table.nextKey=key;table.nextAt=Date.now()+thinkMs+actor*35;return;}
      if(Date.now()<table.nextAt)return;
      const decision=strategy(view,table);if(!decision)return;
      await command(table,actor,decision.type,decision.amount===undefined?{}:{amount:decision.amount});conserve(table);
    }));}catch(error){errors.push({phase:'autoplay',message:error.message});}finally{busy=false;}
  }
  for(let tableIndex=0;tableIndex<2;tableIndex++){
    const table={index:tableIndex,mode:modes[tableIndex],users:[],actions:{},completed:[],manual:new Set(),nextAt:0};tables.push(table);
    for(let i=0;i<11;i++){
      let user;if(registered&&i===0){const username=`qa_dual_${tableIndex===0?'a':'b'}`,password=`QA-${randomBytes(12).toString('base64url')}`;user=await api(null,'/api/account/register',{username,password,name:`验收玩家${tableIndex===0?'甲':'乙'}`},201);table.login={username,password};}
      else user=await api(null,'/api/session',{name:`${tableIndex===0?'甲':'乙'}桌机器人${i+1}`},201);
      table.users.push(user);
    }
    const created=(await api(table.users[0],'/api/rooms',{name:`双桌验收${tableIndex===0?'甲':'乙'} · ${table.mode}`,access:'public',settings:{maxPlayers:9,smallBlind:5,bigBlind:10,durationMinutes:480,squidExtraTokens:3,squidUnitBB:2,bombIntervalMinutes:1,bombAnteBB:2,...MODES[table.mode]}},201)).room;
    table.code=created.code;table.url=`${origin}/#/room/${table.code}`;
    for(let i=1;i<table.users.length;i++)await api(table.users[i],`/api/rooms/${table.code}/join`,{invite:created.invite});
    for(let i=0;i<9;i++){await command(table,i,'sit',{seat:i,amountBB:100+i*50});await connect(table,i);}
    await command(table,0,'start');conserve(table);
  }
  // Each registered browser identity may observe either table, but is seated in
  // only its own. The two tables still have disjoint sets of nine dealt users.
  for(let i=0;i<2;i++)await api(tables[i].users[0],`/api/rooms/${tables[1-i].code}/join`,{});
  return {app,origin,directory,tables,sockets,events,errors,api,command,connect,disconnect,internal,conserve,strategy,autoplayStep,
    startBots(options={}){timer=setInterval(()=>autoplayStep(options),100);},
    pauseBots(){clearInterval(timer);timer=null;},
    async close(){closed=true;clearInterval(timer);for(const s of sockets.values())s.controller.abort();await Promise.all([...sockets.values()].map(s=>s.done));await app.close();rmSync(directory,{recursive:true,force:true});},
    summary(){return {origin,tables:tables.map(t=>({index:t.index,mode:t.mode,url:t.url,actions:t.actions,completed:t.completed,accounting:conserve(t)})),errors:[...errors],requests:events.length};},
  };
}
