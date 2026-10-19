import test from 'node:test';
import assert from 'node:assert/strict';
import { roomResults, renderRoomResults } from '../public/room-results.js';
import { setDisplayUnit } from '../public/money.js';

const fixture = () => ({status:'closed',code:'123456',name:'朋友局',meId:'me',settings:{bigBlind:10},hand:{number:8},players:[
  {id:'me',name:'自己',seat:null,stack:0,totalBuyIn:4000,sessionProfit:-125},
  {id:'left',name:'提前离开',seat:null,stack:0,totalBuyIn:2000,sessionProfit:125},
  {id:'watch',name:'旁观者',seat:null,totalBuyIn:0,sessionProfit:0},
]});
test('only closed rooms use final cash-out, and every bought-in member remains in the results',()=>{
  const r=fixture();const result=roomResults(r);
  assert.deepEqual(result.players.map(p=>[p.id,p.buyIn,p.cashOut,p.net]),[['left',2000,2125,125],['me',4000,3875,-125]]);
  assert.equal(result.mine.id,'me');assert.equal(result.hands,8);
  for(const status of ['waiting','playing']){r.status=status;assert.equal(roomResults(r),null);assert.equal(renderRoomResults(r),'');}
});
test('results show the same final money in BB and points, with escaped names and no hole cards',()=>{
  const r=fixture();r.players[0].name='<img src=x onerror=alert(1)>';r.players[0].cards=['As','Ah'];
  setDisplayUnit('bb');let html=renderRoomResults(r);assert.match(html,/-12\.5 BB/);assert.match(html,/387\.5 BB/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x|As|Ah/);
  setDisplayUnit('points');html=renderRoomResults(r);assert.match(html,/-125 积分/);assert.match(html,/3,875 积分/);
});
test('missing settlement data stays unknown rather than pretending to be a zero profit',()=>{
  const r=fixture();delete r.players[0].sessionProfit;const result=roomResults(r);assert.equal(result.mine.net,null);assert.equal(result.mine.cashOut,null);
  assert.match(renderRoomResults(r),/待同步/);assert.match(renderRoomResults(r),/— 积分/);
});
test('a bought-in player who never received a hand is included, while an empty closed room has no history action',()=>{
  const r=fixture();r.hand=null;r.players=[{id:'me',name:'自己',seat:null,totalBuyIn:2000,sessionProfit:0}];
  assert.equal(roomResults(r).mine.cashOut,2000);assert.match(renderRoomResults(r),/1 人 · 0 手/);assert.match(renderRoomResults(r),/data-action="history" disabled/);
  r.players=[];assert.match(renderRoomResults(r),/本场没有玩家带入筹码/);
});

test('a squid loss beyond the stack is shown separately, never as negative recovered chips',()=>{
  setDisplayUnit('points');const r=fixture();
  r.players=[{id:'me',name:'自己',totalBuyIn:1000,sessionProfit:-1060,cashedOut:0,squidDebt:60},
    {id:'left',name:'对手',totalBuyIn:1000,sessionProfit:1060,cashedOut:2060,squidDebt:0}];
  const result=roomResults(r);assert.equal(result.mine.cashOut,0);assert.equal(result.mine.debt,60);
  assert.equal(result.players.reduce((sum,p)=>sum+p.net,0),0);
  const html=renderRoomResults(r);assert.match(html,/鱿鱼待补/);assert.match(html,/60 积分/);
  assert.match(html,/净盈亏＝累计收回－累计带入－鱿鱼待补/);
  assert.doesNotMatch(html,/<dt>累计收回<\/dt><dd>-60/);
  delete r.players[0].cashedOut;assert.equal(roomResults(r).mine.cashOut,0,'legacy formula must add the separately displayed debt back');
});
