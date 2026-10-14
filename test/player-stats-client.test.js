import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderPlayerStats } from '../public/player-stats.js';
const values={count:2,opportunities:10,percent:20};
const data={player:{id:'p',name:'朋友',avatar:1},hands:10,preflopHands:8,metrics:Object.fromEntries(['winRate','vpip','pfr','threeBet','rfi','fourBet','fiveBet','wtsd','wsd'].map(k=>[k,values]))};
test('core metrics show sample counts, denominators, definitions and explicit scope',()=>{
 const html=renderPlayerStats({data,scope:'table'});assert.match(html,/10 <small>手/);assert.match(html,/VPIP/);assert.match(html,/PFR/);assert.match(html,/3-Bet/);assert.match(html,/4-Bet/);assert.match(html,/5-Bet/);assert.match(html,/2 \/ 10/);assert.match(html,/20%/);assert.match(html,/样本较少/);assert.match(html,/这张牌桌的已结算手牌/);
 assert.match(renderPlayerStats({data,scope:'career'}),/这位选手全部已结算手牌/);
 assert.doesNotMatch(html,/data-action="interact"|name="username"/);
});
test('zero samples, loading, error and hostile display names are safe',()=>{
 assert.match(renderPlayerStats({data:{...data,hands:0,metrics:{}}}),/这个范围还没有记录/);
 assert.doesNotMatch(renderPlayerStats({data:{...data,metrics:{}}}),/NaN|Infinity|<strong>0%/);
 assert.match(renderPlayerStats({loading:true,player:{name:'<img onerror=x>'}}),/&lt;img onerror=x&gt;/);
 assert.match(renderPlayerStats({error:'<script>bad</script>'}),/&lt;script&gt;bad&lt;\/script&gt;/);
});
test('opponent comparison shares the player card scope, hides on own avatar and during pending/error states',()=>{
 const opponent={...data,versus:{sharedHands:4,headsUp:{hands:2,netBB:10,bbComplete:true,profitRate:{count:1,opportunities:2,percent:50}},showdown:{hands:1,wins:1,losses:0,ties:0}}};
 const html=renderPlayerStats({data:opponent,scope:'career'});
 assert.match(html,/与你对抗/);assert.match(html,/累计相遇 4 手/);assert.match(html,/\+10 <small>BB/);
 assert.doesNotMatch(renderPlayerStats({data:{...opponent,versus:null}}),/与你对抗/);
 assert.doesNotMatch(renderPlayerStats({data:opponent,loading:true}),/与你对抗/);
 assert.doesNotMatch(renderPlayerStats({data:opponent,error:'请求失败'}),/与你对抗/);
});
function harness(){
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),calls=[],paint=[];
 const state={room:{code:'table',players:[data.player]},modal:null};let valid=true;
 const context=vm.createContext({state,renderPlayerStats,requests:{capture:()=>({valid:()=>valid,check(){if(!valid)throw Object.assign(new Error('stale'),{stale:true});}})},api:path=>new Promise((resolve,reject)=>calls.push({path,resolve,reject})),openModal(title,body,kind){state.modal={kind};paint.push(body);},historyTurnNotice:()=>'',avatarCache:{hydrate(){}},dialog:{},tick(){}});
 vm.runInContext(source.slice(source.indexOf('async function playerStatsModal('),source.indexOf('function interactionModal('))+';globalThis.open=playerStatsModal',context);
 return {state,calls,paint,open:context.open,invalidate(){valid=false;}};
}
test('switching scope or closing the card cannot display an old request result',async()=>{
 const f=harness(),first=f.open('p');assert.match(f.calls[0].path,/scope=table/);const second=f.open('p','career');assert.match(f.calls[1].path,/scope=career/);
 f.calls[0].resolve(data);await first;assert.equal(f.state.playerStats.data,null);
 f.calls[1].resolve(data);await second;assert.equal(f.state.playerStats.data,data);
 const third=f.open('p');f.state.modal=null;const n=f.paint.length;f.calls[2].resolve(data);await third;assert.equal(f.paint.length,n);
});
test('room and identity changes discard in-flight player data',async()=>{
 for(const invalidate of [false,true]){const f=harness(),pending=f.open('p');if(invalidate)f.invalidate();else f.state.room={code:'other',players:[]};const n=f.paint.length;f.calls[0].resolve(data);await pending;assert.equal(f.paint.length,n);assert.equal(f.state.playerStats.data,null);}
});
