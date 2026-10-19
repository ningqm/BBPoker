import test from 'node:test';
import assert from 'node:assert/strict';
import {liveSessionRows,renderLiveSession} from '../public/room-results.js';
import {setDisplayUnit} from '../public/money.js';
const room=()=>({meId:'a',settings:{bigBlind:10},hand:{status:'playing'},players:[{id:'b',name:'B',totalBuyIn:1000,stack:1100,cashedOut:0,contributed:100,sessionProfit:100,seat:1},{id:'a',name:'A',totalBuyIn:1000,stack:0,cashedOut:0,contributed:800,sessionProfit:-1000,pendingBuyIn:500,seat:0}]});
test('live summary excludes unawarded wagers even when all-in, and places self first',()=>{
 const r=room(),rows=liveSessionRows(r);assert.equal(rows[0].id,'a');assert.equal(rows[0].settledProfit,-200);assert.equal(rows[1].settledProfit,200);assert.equal(rows[0].totalBuyIn,1000);assert.equal(rows[0].pendingBuyIn,500);
});
test('complete hand does not add old wagers back to settled winnings',()=>{
 const r=room();r.hand.status='complete';r.players[1].stack=1600;r.players[1].sessionProfit=600;assert.equal(liveSessionRows(r)[0].settledProfit,600);
});
test('departed players and squid debt remain included without double counting debt',()=>{
 const r=room();r.hand.status='complete';r.players[1]={...r.players[1],leftRoom:true,seat:null,cashedOut:700,sessionProfit:-400,squidDebt:100};
 assert.equal(liveSessionRows(r)[0].settledProfit,-400);setDisplayUnit('points');const html=renderLiveSession(r);assert.match(html,/已离座/);assert.match(html,/鱿鱼待补 100 积分/);assert.match(html,/待到账补码 500 积分/);assert.match(html,/-400 积分/);
});
test('summary escapes names, honors BB unit and excludes spectators',()=>{
 const r=room();r.players[1].name='<img src=x>';r.players.push({id:'s',name:'spectator',totalBuyIn:0});setDisplayUnit('bb');const html=renderLiveSession(r);assert.doesNotMatch(html,/<img|spectator/);assert.match(html,/&lt;img/);assert.match(html,/-20 BB/);assert.match(html,/100 BB/);
});
