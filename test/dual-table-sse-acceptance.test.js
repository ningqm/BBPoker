import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dualTableFixture } from './helpers/dual-table-http.mjs';
import { replayIndependently } from './helpers/pokerkit-oracle.mjs';
import { exportPhh } from '../src/phh.js';

// Real TCP/HTTP and eighteen SSE readers; only the server clock is advanced.
// Decisions use the currently acting identity's public SSE projection. Random
// decks remain untouched. No test assigns presence or hidden cards to a bot.
for (const modes of [['holdem','normal'],['unlimited','bomb'],['normalBomb','unlimitedBomb']]) {
  test(`two simultaneous nine-player HTTP/SSE tables: ${modes.join(' + ')}`, {timeout:180000}, async t=>{
    let now=Date.now();t.mock.method(Date,'now',()=>now);
    const f=await dualTableFixture({modes,registered:true,actionTickMs:1000000});t.after(()=>f.close());
    const sleep=()=>new Promise(resolve=>setTimeout(resolve,5));
    const details={modes,timing:'controlled clock; real HTTP/SSE; production random shuffle',simultaneousBatches:0,actions:0,retries:0,chats:0,reconnects:0,entries:0,fishAdmissionChecks:0};
    const handViews=[], socialDone=new Set();
    const clocks=()=>f.tables.flatMap(table=>{const r=f.internal(table),h=r.hand;return h?.status!=='playing'?[]:[h.transition?.nextAt,h.runout?.active?h.runout.nextAt:null,!r.presentation?.readyPublished?r.presentation?.actionReadyAt:null,r.deadline].filter(Number.isFinite).filter(v=>v>=now);});
    const tick=()=>{for(const table of f.tables){f.app.service.tick(f.internal(table),now);f.app.broadcast(table.code);}f.app.store.save();};
    const waitFrames=async()=>{for(let n=0;n<100;n++){if(f.tables.every(table=>{const h=f.internal(table).hand;return !h?.actingId||h.status!=='playing'||!f.sockets.has(`${table.index}:${table.users.findIndex(u=>u.user.id===h.actingId)}`)||(f.sockets.get(`${table.index}:${table.users.findIndex(u=>u.user.id===h.actingId)}`).latest?.hand?.actionSeq===h.log.length&&f.sockets.get(`${table.index}:${table.users.findIndex(u=>u.user.id===h.actingId)}`).latest?.serverTime===now);}))return;await sleep();}throw Error('SSE frames failed to catch up');};
    const cmd=(table,index,type,extra={})=>f.command(table,index,type,extra);
    for(const table of f.tables)await cmd(table,0,'autoDeal',{paused:true});
    // Both rooms receive simultaneous chats, reads and repeated pending topups.
    const topups=f.tables.map(()=>randomUUID());
    const before=f.tables.map(table=>structuredClone(f.internal(table).hand));
    await Promise.all(f.tables.flatMap(table=>[
      cmd(table,8,'buyin',{amountBB:100,commandId:topups[table.index]}),cmd(table,8,'buyin',{amountBB:100,commandId:topups[table.index]}),
      ...table.users.slice(0,9).map((user,i)=>f.api(user,`/api/rooms/${table.code}/chat`,{messageId:randomUUID(),kind:'text',text:`${table.index}桌-${i}并发验收`})),
      ...table.users.slice(0,9).map(user=>f.api(user,`/api/rooms/${table.code}`)),
    ]));details.chats+=18;details.retries+=2;
    for(const table of f.tables){const r=f.internal(table);assert.deepEqual(r.hand,before[table.index]);assert.equal(f.app.service.pendingBuyIn(r.members[table.users[8].user.id]),1000);assert.equal(r.chat.length,9);assert.ok(r.chat.every(m=>m.text.startsWith(`${table.index}桌-`)));f.conserve(table);}
    await Promise.all(f.tables.map(table=>f.disconnect(table,6)));details.reconnects+=2;
    const replaced=new Map();
    for(let round=0;round<8;round++){
      if(round>0){
        now+=round%2?65000:6000;
        for(const table of f.tables){
          const r=f.internal(table);f.app.service.completeRabbit(r,now);
          for(let i=0;i<table.users.length;i++){const m=r.members[table.users[i].user.id];if(m.seat!=null&&m.stack<1000)await cmd(table,i,'buyin',{amountBB:200});}
          await cmd(table,0,'start');
        }
      }
      if(round>0){for(let startStep=0;f.tables.some(table=>f.internal(table).hand.status!=='playing');startStep++){assert.ok(startStep<10,'next hands start');const due=f.tables.map(table=>f.internal(table).nextHandAt).filter(Number.isFinite);assert.ok(due.length,'both tables are eligible to resume');now=Math.max(now,Math.min(...due));tick();}for(const table of f.tables)await cmd(table,0,'autoDeal',{paused:true});}
      for(let step=0;f.tables.some(table=>f.internal(table).hand.status==='playing');step++){
        assert.ok(step<500,'both tables finish bounded hand');await waitFrames();
        const jobs=[];
        for(const table of f.tables){
          const r=f.internal(table),h=r.hand;f.conserve(table);if(h.status!=='playing')continue;
          const index=table.users.findIndex(u=>u.user.id===h.actingId),stream=f.sockets.get(`${table.index}:${index}`),view=stream?.latest;
          if(!view?.actions?.canAct||view.hand.id!==h.id||view.hand.actionSeq!==h.log.length)continue;
          let decision=f.strategy(view,table);if(round===1&&r.mini.squid.active&&r.mini.squid.won.length===0){const target=h.players[0].id;decision={type:view.meId===target?(view.actions.canCheck?'check':'call'):'fold'};}if(!decision)continue;
          jobs.push((async()=>{
            const id=randomUUID(),seq=h.log.length;
            const body={...(decision.amount===undefined?{}:{amount:decision.amount}),commandId:id,handId:h.id,actionSeq:seq};
            await cmd(table,index,decision.type,body);details.actions++;
            if(details.actions%11===0){const snapshot=structuredClone(r.hand);await cmd(table,index,decision.type,body);assert.deepEqual(r.hand,snapshot);details.retries++;}
            f.conserve(table);
          })());
        }
        if(jobs.length===2)details.simultaneousBatches++;
        // Independent users chat, throw an emote and open records while both
        // betting requests are already in flight, without changing actionSeq.
        if(jobs.length&&!socialDone.has(round)){socialDone.add(round);
          for(const table of f.tables){const r=f.internal(table),seated=table.users.filter(u=>r.members[u.user.id]?.seat!=null);
            jobs.push(f.api(seated[0],`/api/rooms/${r.code}/chat`,{kind:'emote',emote:'nice',messageId:randomUUID()}));
            jobs.push(f.api(seated[1],`/api/rooms/${r.code}/chat`,{kind:'throw',emote:'pat',targetId:seated[2].user.id,messageId:randomUUID()}));
            jobs.push(f.api(seated[3],`/api/rooms/${r.code}/history`));
            if(table.completed.length)jobs.push(f.api(seated[4],`/api/rooms/${r.code}/hands/${table.completed.at(-1).id}`));
            details.chats+=2;
          }
        }
        if(jobs.length)await Promise.all(jobs);
        else {const due=clocks();assert.ok(due.length,'a future timer exists for stalled tables');now=Math.max(now,Math.min(...due));tick();await sleep();}
      }
      for(const table of f.tables){
        const r=f.internal(table),h=r.hand;f.conserve(table);
        const visible=f.app.service.handFor(h.players[0].id,r.code,h.id);handViews.push(visible);
        assert.equal(h.number,round+1,'each requested round deals a new hand');assert.equal(h.players.reduce((s,p)=>s+p.stack-p.startingStack,0),0);
        for(const p of h.players){const row=f.app.store.data.ledger.filter(l=>l.roomCode===r.code&&l.note===`第 ${h.number} 手德州结算`&&l.playerId===p.id&&l.type==='holdem');assert.equal(row.length,1);assert.equal(row[0].amount,p.stack-p.startingStack);}
        for(const p of h.players){const v=f.app.service.handFor(p.id,r.code,h.id);for(const other of v.players){if(other.id!==p.id&&other.folded)assert.deepEqual(other.cards,[null,null]);}}
      }
      if(round===0){await Promise.all(f.tables.map(table=>f.connect(table,6)));for(const table of f.tables)await cmd(table,6,'entryBlind',{mode:'post'});}
      if(round===1){
        // A winner leaves, a new identity sits in that seat, then the old
        // identity returns later. Liabilities remain until the round settles.
        for(const table of f.tables){
          const r=f.internal(table),q=r.mini.squid;
          const id=q.active?q.won.find(id=>r.members[id]?.seat!=null):r.hand.players.find(p=>p.id!==table.users[0].user.id).id;
          if(!id)continue;
          const old=table.users.findIndex(u=>u.user.id===id),seat=r.members[id].seat,counts=structuredClone(q.counts),budget=q.tokenBudget,roundId=q.roundSettlementId;
          await cmd(table,old,'stand',{expectedSquidRound:q.active?q.round:0,expectedSquidCost:0});await f.disconnect(table,old);
          const sitId=randomUUID();await Promise.all([cmd(table,9,'sit',{seat,amountBB:200,entryMode:'post',commandId:sitId}),cmd(table,9,'sit',{seat,amountBB:200,entryMode:'post',commandId:sitId})]);await f.connect(table,9);
          assert.equal(r.members[table.users[9].user.id].totalBuyIn,2000);assert.deepEqual(q.counts,counts);
          replaced.set(table.index,{old,seat,roundId,budget,admitted:false,entryPosts:0});details.entries++;details.retries++;
        }
      }
      for(const table of f.tables){const rep=replaced.get(table.index);if(!rep)continue;const r=f.internal(table),q=r.mini.squid,newid=table.users[9].user.id;
        rep.entryPosts+=r.hand.log.filter(e=>e.playerId===newid&&e.type==='entryBlind').length;
        assert.ok(rep.entryPosts<=1,'new player is not charged entry blind twice');
        if(!rep.admitted&&r.hand.players.some(p=>p.id===newid)){rep.admitted=true;if(q.active&&q.roundSettlementId===rep.roundId){assert.equal(q.tokenBudget,rep.budget+1);assert.equal(q.participants.filter(id=>id===newid).length,1);details.fishAdmissionChecks++;}}
        if(round===4&&rep.admitted){const cost=q.active&&q.participants.includes(newid)&&!q.counts[newid]?q.tokenBudget*q.unit:0;await cmd(table,9,'stand',{expectedSquidRound:q.active&&q.participants.includes(newid)?q.round:0,expectedSquidCost:cost});await f.disconnect(table,9);await cmd(table,rep.old,'sit',{seat:rep.seat,amountBB:100,entryMode:'post'});await f.connect(table,rep.old);details.entries++;}
      }
    }
    // End both tables concurrently and compare all public totals to raw hand
    // stack changes + independently grouped fish ledger changes.
    const finalFish=f.tables.map(table=>structuredClone(f.internal(table).mini.squid));
    await Promise.all(f.tables.map(table=>cmd(table,0,'close')));
    for(const table of f.tables){const r=f.internal(table),q=finalFish[table.index];f.conserve(table);
      if(q.active){const rows=f.app.store.data.ledger.filter(l=>l.roomCode===r.code&&l.type==='squidSettlement'&&l.roundSettlementId===q.roundSettlementId),total=Object.values(q.counts).reduce((s,n)=>s+n,0),zeros=q.participants.filter(id=>!q.counts[id]).length;
        assert.equal(rows.length,q.participants.length);for(const row of rows)assert.equal(row.amount,q.counts[row.playerId]?q.counts[row.playerId]*q.unit*zeros:-total*q.unit);
      }
      for(const user of table.users){const id=user.user.id,own=f.app.store.data.hands.filter(h=>h.roomCode===r.code&&h.players.some(p=>p.id===id)),net=own.reduce((s,h)=>{const p=h.players.find(p=>p.id===id);return s+p.stack-p.startingStack;},0),fish=f.app.store.data.ledger.filter(l=>l.roomCode===r.code&&l.type==='squidSettlement'&&l.playerId===id).reduce((s,l)=>s+l.amount,0);
        const stats=await f.api(user,'/api/stats');assert.equal(stats.hands,own.length);assert.equal(stats.holdemNet,net);assert.equal(stats.miniNet,fish);
        const direct=(await f.api(user,`/api/opponents?room=${r.code}`)).opponents;assert.ok(Math.abs(direct.rows.reduce((s,row)=>s+row.total.net,0)-net-fish)<1e-7);
        for(const scope of ['table','career']){const profile=await f.api(table.users[0],`/api/rooms/${r.code}/players/${id}/stats?scope=${scope}`);assert.equal(profile.hands,own.length);const vpip=own.filter(h=>h.log.some(e=>e.playerId===id&&e.street==='preflop'&&['call','raise','allin'].includes(e.type)&&e.amount>0)).length;assert.equal(profile.metrics.vpip.count,vpip);}
      }
    }
    const groups=new Map();for(const row of f.app.store.data.ledger.filter(l=>l.type==='squidSettlement')){const key=`${row.roomCode}:${row.roundSettlementId}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    for(const rows of groups.values()){const zeros=rows.filter(row=>row.squidCount===0).length,total=rows.reduce((s,row)=>s+row.squidCount,0);assert.equal(rows.length,rows[0].participantIds.length);assert.equal(new Set(rows.map(row=>row.playerId)).size,rows.length);for(const row of rows){assert.equal(row.tokensAwarded,total);assert.equal(row.amount,row.squidCount?row.squidCount*row.squidUnit*zeros:-total*row.squidUnit);if(row.squidMode==='normal')assert.ok(row.squidCount<=1);}assert.equal(rows.reduce((s,row)=>s+row.amount,0),0);}
    details.fishSettlements=groups.size;
    assert.equal(f.errors.length,0);assert.equal(details.entries,4,'both tables replace and return one identity');assert.ok(details.simultaneousBatches>10,JSON.stringify(details));
    const summary={...details,coverage:{threeBetHands:handViews.filter(h=>h.log.filter(e=>e.street==='preflop'&&e.isRaise).length>=2).length,fourBetHands:handViews.filter(h=>h.log.filter(e=>e.street==='preflop'&&e.isRaise).length>=3).length,sidePotHands:handViews.filter(h=>h.result.pots.length>1).length,bombHands:handViews.filter(h=>h.bombPot).length},...f.summary(),sseFrames:[...f.sockets.values()].reduce((s,v)=>s+v.frames,0)};
    if(process.env.POKERKIT_PYTHON)summary.pokerkit=replayIndependently(exportPhh(handViews),handViews.length);
    t.diagnostic(JSON.stringify({modes,actions:details.actions,simultaneousBatches:details.simultaneousBatches,entries:details.entries,fishAdmissionChecks:details.fishAdmissionChecks,threeBetHands:handViews.filter(h=>h.log.filter(e=>e.street==='preflop'&&e.isRaise).length>=2).length,fourBetHands:handViews.filter(h=>h.log.filter(e=>e.street==='preflop'&&e.isRaise).length>=3).length,sidePotHands:handViews.filter(h=>h.result.pots.length>1).length,bombHands:handViews.filter(h=>h.bombPot).length,pokerkit:summary.pokerkit}));
  });
}
