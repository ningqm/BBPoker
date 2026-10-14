import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {defaultStatsFilters,statsDateRange,statsQuery,statsFilterValues,statsFilterKey,captureStatsDraft,restoreStatsDraft,renderStatsPage,renderStatsMetricDetails,renderAllInChart,renderProfitChart,renderEquityBadge} from '../public/stats.js';

const sample = () => ({hands:100,net:80,holdemNet:100,miniNet:-20,winHands:20,lossHands:50,evenHands:30,preflopHands:90,bbPer100:12.25,
  metrics:{vpip:{count:27,opportunities:90,percent:30},pfr:{count:0,opportunities:90,percent:0},fiveBet:{count:0,opportunities:0,percent:null}},
  allIn:{count:2,eligibleCount:4,unavailableCount:2,expectedNet:60,actualNet:100,difference:40,estimatedCount:1,
    curve:[{at:'2026-10-12T10:00:00Z',actual:100,expected:60}],hands:[{id:'hand-1',number:12,roomCode:'123456',roomName:'周末局',at:'2026-10-12T10:00:00Z',street:'flop',actualNet:100,expectedNet:60,difference:40,method:'exact'}]}});

test('analytics quick periods use local calendar days including today, even across year changes',()=>{
  const url=new URL('../public/stats.js',import.meta.url).href;
  const code=`import {statsDateRange} from ${JSON.stringify(url)};const now=new Date(2026,0,2,12);console.log(JSON.stringify(['1','3','7','30','all'].map(period=>statsDateRange({period},now))));`;
  const [day,three,week,month,all]=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TZ:'Asia/Shanghai'},encoding:'utf8'}));
  assert.deepEqual(day,{from:'2026-01-01T16:00:00.000Z',to:'2026-01-02T15:59:59.999Z'});
  assert.equal(three.from,'2025-12-30T16:00:00.000Z');assert.equal(week.from,'2025-12-26T16:00:00.000Z');assert.equal(month.from,'2025-12-03T16:00:00.000Z');assert.deepEqual(all,{});
  for(const filters of [{period:'other'},{period:'custom'},{period:'custom',from:'2026-02-30'},{period:'custom',from:'2026-10-14',to:'2026-10-13'}])assert.throws(()=>statsDateRange(filters));
});

test('hand count filters intersect dates and room, validate integers, and omit unlimited limits',()=>{
  assert.equal(statsQuery({filters:defaultStatsFilters()}).toString(),'');
  const query=statsQuery({room:'123456',filters:{period:'custom',from:'2026-10-13',to:'2026-10-13',maxHands:'500'}});
  assert.equal(query.get('maxHands'),'500');assert.equal(query.get('room'),'123456');assert.ok(query.get('from'));assert.ok(query.get('to'));
  assert.equal(statsQuery({filters:{maxHands:'custom',handCount:'100000'}}).get('maxHands'),'100000');
  for(const handCount of ['0','-1','1.5','1e3','100001','NaN','', '4abc'])assert.throws(()=>statsQuery({filters:{maxHands:'custom',handCount}}));
  assert.throws(()=>statsQuery({filters:{maxHands:'50'}}));
  const fd=new Map([['handCount','700'],['maxHands','custom'],['room','123456'],['period','all']]);
  const filters=statsFilterValues(fd,{period:'7'});assert.equal(filters.period,'7');assert.equal(filters.handCount,'700');assert.equal(filters.maxHands,'custom');assert.equal(filters.room,undefined);
});

test('zero opportunities display a dash while a real zero percent remains zero',()=>{
  const html=renderStatsPage(sample(),{});
  assert.match(html,/data-metric="fiveBet"[^>]*>.*?<strong>—<\/strong>.*?0 \/ 0 <small>暂无机会/s);
  assert.match(html,/data-metric="pfr"[^>]*>.*?<strong>0%<\/strong>.*?0 \/ 90 <small>手/s);
  assert.match(html,/data-metric="vpip"[^>]*>.*?<strong>30%<\/strong>.*?27 \/ 90/s);
  assert.match(renderStatsMetricDetails('rfi'),/前面没有人主动跟注或加注/);
  assert.match(renderStatsMetricDetails('threeBet'),/首次加注为 2-Bet/);
  assert.match(renderStatsMetricDetails('fiveBet'),/不是 0%/);
  assert.doesNotMatch(renderStatsMetricDetails('<script>'),/<script>/);
});

test('all-in actual and expected cover the same sample and missing historical EV is never rendered as zero luck',()=>{
  const html=renderStatsPage(sample(),{});
  assert.match(html,/已记录 2 \/ 4 手/);assert.match(html,/2 手缺少当时的记录/);assert.match(html,/1 手使用抽样估算/);
  assert.match(html,/实际 − 期望/);assert.match(html,/\+40/);assert.match(html,/不能预测下一手/);
  assert.match(html,/data-action="replay" data-hand="hand-1" data-room="123456"/);
  const empty=sample();empty.allIn={count:0,eligibleCount:3,unavailableCount:3,actualNet:null,expectedNet:null,difference:null,hands:[],curve:[]};
  const emptyHtml=renderStatsPage(empty,{});assert.match(emptyHtml,/还没有可计算的全下样本/);assert.match(emptyHtml,/3 手缺少当时的记录/);assert.doesNotMatch(emptyHtml,/stats-allin-totals/);assert.doesNotMatch(emptyHtml,/运气很好|手气差|公平分数/);
});

test('curves share one scale, include the zero origin, and keep flat or malformed samples finite',()=>{
  const html=renderAllInChart([{actual:-100,expected:50,at:'2026-10-13T10:00:00Z'},{actual:0,expected:0,at:'2026-10-13T11:00:00Z'}]);
  assert.match(html,/stats-chart-expected/);assert.match(html,/stats-chart-actual/);assert.match(html,/实际 0，期望 0/);assert.doesNotMatch(html,/NaN|Infinity/);
  assert.match(renderAllInChart([{actual:0,expected:0}]),/points="58\.00,98\.50 644\.00,98\.50"/);
  assert.doesNotMatch(renderAllInChart([{actual:Infinity,expected:NaN}]),/<svg/);
});

test('overall profit history remains separate from all-in EV and the existing export remains available',()=>{
  const data=sample();data.curve=[{net:80,at:'2026-10-12T10:00:00Z'}];data.adjustmentCount=1;
  const html=renderStatsPage(data,{});assert.match(html,/stats-overall-curve/);assert.match(html,/累计净积分，最后为 \+80/);assert.match(html,/全下跑牌累计积分：实际 \+100，期望 \+60/);assert.match(html,/data-action="export"/);assert.match(html,/1 笔旧蘑菇池退回/);
  assert.doesNotMatch(renderProfitChart([{net:0}]),/NaN|Infinity/);
});

test('record names, errors, identifiers and filter drafts are escaped, and unrelated private fields never render',()=>{
  const attack='"><img src=x onerror=alert(1)>',data=sample();data.allIn.hands[0]={...data.allIn.hands[0],id:attack,roomCode:attack,roomName:attack,deck:'PRIVATE_DECK',cards:'PRIVATE_CARDS'};data.token='PRIVATE_TOKEN';
  for(const html of [renderStatsPage(data,{room:attack,filters:{period:'custom',from:attack,handCount:attack}},{rooms:[{code:attack,name:attack}],compact:true}),renderStatsPage(data,{error:attack})]){
    assert.doesNotMatch(html,/<img|PRIVATE_DECK|PRIVATE_CARDS|PRIVATE_TOKEN/);assert.match(html,/&lt;img/);
  }
  assert.match(renderStatsPage(data,{}, {compact:true}),/^<div class="stats-overlay stats-page">/);
  assert.doesNotMatch(renderStatsPage(data,{}, {compact:true}),/<main/);
});

test('loading and errors do not present data from another filter as the current result',()=>{
  const loading=renderStatsPage(sample(),{loading:true});assert.match(loading,/aria-busy="true"/);assert.match(loading,/正在读取我的数据/);assert.doesNotMatch(loading,/累计净积分|stats-allin-totals/);
  const error=renderStatsPage(sample(),{error:'无法连接'});assert.match(error,/role="alert"/);assert.match(error,/stats-retry/);assert.doesNotMatch(error,/stats-allin-totals/);
});

test('custom date and hand count drafts preserve caret only within the same filter and account lifecycle',()=>{
  const state={filters:{period:'custom',from:'2026-10-01',to:'2026-10-13',maxHands:'custom',handCount:'100'},room:'123456'};
  const form=values=>{const fields=Object.entries(values).map(([name,value])=>({name,value,type:name==='handCount'?'number':'date',focus(){this.focused=true;}}));fields.namedItem=name=>fields.find(field=>field.name===name);return {dataset:{statsKey:statsFilterKey(state)},elements:fields,contains:field=>fields.includes(field)};};
  const old=form({handCount:'200',from:'2026-10-02',to:'2026-10-12'}),draft=captureStatsDraft(old,state,old.elements.namedItem('handCount')),fresh=form({handCount:'100'});
  restoreStatsDraft(fresh,state,draft);assert.equal(fresh.elements.namedItem('handCount').value,'200');assert.equal(fresh.elements.namedItem('handCount').focused,true);assert.equal(state.filters.handCount,'100');
  state.room='654321';const other=form({handCount:'500'});restoreStatsDraft(other,state,draft);assert.equal(other.elements.namedItem('handCount').value,'500');assert.equal(captureStatsDraft(old,state,null),null);
});

test('live equity badges distinguish approximate main-pot shares from win and tie percentages',()=>{
  assert.equal(renderEquityBadge({equity:null}),'');assert.equal(renderEquityBadge({equity:Infinity}),'');
  const html=renderEquityBadge({equity:42.8571,winPct:30,tiePct:20},{approximate:true});assert.match(html,/≈42.9%/);assert.match(html,/主池权益/);assert.match(html,/含平分份额/);assert.match(html,/此百分比不代表各边池权益/);assert.doesNotMatch(html,/边池详见全下详情/);assert.doesNotMatch(html,/胜率 42/);
  assert.match(renderEquityBadge({equity:0}),/>0%/);assert.match(renderEquityBadge({equity:100}),/>100%/);
});


test('hand-external squid profit remains visible without played hands and hand filters explain excluded settlements',()=>{
  const data={hands:0,net:40,holdemNet:0,miniNet:40,squidSettlementCount:1,standaloneSquidSettlementCount:1,curve:[{net:40,at:'2026-10-13T10:00:00Z'}]};
  const html=renderStatsPage(data,{});assert.match(html,/小游戏净积分.*?\+40/);assert.match(html,/1 笔在手牌外结算/);assert.match(html,/不增加手数/);assert.doesNotMatch(html,/换个日期或牌桌试试/);
  const limited=renderStatsPage({...data,hands:100,squidSettlementCount:2,standaloneSquidSettlementCount:0,adjustmentsExcluded:true},{});assert.match(limited,/最近 N 手/);assert.match(limited,/不包含手外结算/);assert.doesNotMatch(limited,/笔在手牌外/);
});

test('personal stats table selector reuses dated labels and disambiguates repeated table names',()=>{
  const rooms=[{code:'old',name:'朋友局',startedAt:'2026-10-12T10:00:00Z'},{code:'same-a',name:'朋友局',startedAt:'2026-10-13T10:00:00Z'},{code:'same-b',name:'朋友局',startedAt:'2026-10-13T10:00:00Z'}];
  const html=renderStatsPage(sample(),{room:'same-a'},{rooms,currentRoom:'same-a'});
  const selector=html.match(/<select name="room"[^>]*>(.*?)<\/select>/s)[1];
  assert.ok(selector.indexOf('value="same-a"')<selector.indexOf('value="old"'));
  assert.match(selector,/<option value="same-a" selected>朋友局 · .*?房间 same-a · 当前<\/option>/);
  assert.match(selector,/<option value="same-b" >朋友局 · .*?房间 same-b<\/option>/);
  assert.match(selector,/10\/1[23]|10月1[23]/);
});
