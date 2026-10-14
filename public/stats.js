import { getDisplayUnit, formatAggregate, unitLabel } from './money.js';
import { roomChoices } from './records.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
const number = (value, precision=0) => finite(value) ? Number(value).toLocaleString('zh-CN', {maximumFractionDigits:precision}) : '—';
// Chart values are already expressed in the selected unit; retain tiny nonzero
// BB values in labels just as the shared money formatter does for other views.
const signed = value => formatAggregate(value, value, { signed: true, unitLabel: false });
const aggregate = (points, bb) => formatAggregate(points, bb, { signed: true });
const moneyTone = (points, bb) => profit(getDisplayUnit()==='bb'?bb:points);
const profit = value => Number(value)>0?'positive':Number(value)<0?'negative':'muted';
const percent = value => finite(value) ? `${number(value,1)}%` : '—';
const date = value => { const at=new Date(value); return Number.isNaN(+at)?'':at.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); };
const button = (label,action,attrs='',cls='ghost small') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;

export const defaultStatsFilters = () => ({period:'all',from:'',to:'',maxHands:'all',handCount:'100'});

function localDay(value,end=false) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('请选择有效的日期');
  const [year,month,day]=value.split('-').map(Number),result=new Date(year,month-1,day);
  if(result.getFullYear()!==year||result.getMonth()!==month-1||result.getDate()!==day)throw new Error('请选择有效的日期');
  if(end)result.setHours(23,59,59,999);
  return result;
}

export function statsDateRange(filters,now=new Date()) {
  const period=filters.period||'all';
  if(period==='all')return {};
  if(period==='custom'){
    const from=filters.from?localDay(filters.from):null,to=filters.to?localDay(filters.to,true):null;
    if(!from&&!to)throw new Error('请选择开始或结束日期');
    if(from&&to&&from>to)throw new Error('结束日期不能早于开始日期');
    return {...(from?{from:from.toISOString()}:{}),...(to?{to:to.toISOString()}: {})};
  }
  if(!['1','3','7','30'].includes(period))throw new Error('日期范围无效');
  const from=new Date(now),to=new Date(now);
  if(!Number.isFinite(+from))throw new Error('当前日期无效');
  from.setHours(0,0,0,0);from.setDate(from.getDate()-Number(period)+1);to.setHours(23,59,59,999);
  return {from:from.toISOString(),to:to.toISOString()};
}

export function statsQuery(view={},now=new Date()) {
  const filters={...defaultStatsFilters(),...view.filters},query=new URLSearchParams(statsDateRange(filters,now));
  if(filters.maxHands!=='all'){
    if(!['100','500','1000','custom'].includes(String(filters.maxHands)))throw new Error('手数范围无效');
    const raw=String(filters.maxHands==='custom'?filters.handCount:filters.maxHands).trim(),value=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<1||value>100000)throw new Error('请输入 1 至 100000 的完整手数');
    query.set('maxHands',String(value));
  }
  if(view.room)query.set('room',view.room);
  return query;
}

export function statsFilterValues(formData,current={}) {
  const filters={...defaultStatsFilters(),...current};
  for(const key of ['from','to','maxHands','handCount'])if(formData.has(key))filters[key]=String(formData.get(key)||'');
  return filters;
}

export function statsFilterKey(view={}) { return JSON.stringify({filters:{...defaultStatsFilters(),...view.filters},room:view.room||''}); }
export function captureStatsDraft(form,view,activeElement) {
  const key=statsFilterKey(view);if(!form||form.dataset.statsKey!==key)return null;
  const values=Array.from(form.elements).filter(field=>field.name).map(field=>[field.name,field.value]);
  const focus=activeElement?.name&&form.contains(activeElement)?{name:activeElement.name,start:activeElement.selectionStart,end:activeElement.selectionEnd}:null;
  return {key,values,focus};
}
export function restoreStatsDraft(form,view,draft) {
  if(!form||!draft||draft.key!==statsFilterKey(view)||form.dataset.statsKey!==draft.key)return;
  for(const [name,value]of draft.values){const field=form.elements.namedItem(name);if(field)field.value=value;}
  const custom=form.querySelector?.('.stats-custom-hands');if(custom){custom.hidden=form.elements.namedItem('maxHands')?.value!=='custom';const input=custom.querySelector('input');if(input)input.required=!custom.hidden;}
  if(draft.focus){const field=form.elements.namedItem(draft.focus.name);field?.focus({preventScroll:true});if(typeof field?.setSelectionRange==='function'&&typeof draft.focus.start==='number'&&!['number','date','range'].includes(field.type))field.setSelectionRange(draft.focus.start,draft.focus.end);}
}

export const STATS_METRICS = Object.freeze({
  vpip:{label:'主动入池',short:'VPIP',description:'翻牌前，主动跟注或加注投入积分的手数，占参与的普通德州手数的比例。仅支付盲注、前注或在大盲位免费过牌不算主动入池。',example:'例如：100 手中有 28 手主动跟注或加注，VPIP 为 28%。'},
  pfr:{label:'翻前加注',short:'PFR',description:'翻牌前至少加注一次的手数，占参与的普通德州手数的比例。同一手多次加注也只记一手。'},
  rfi:{label:'首次开池',short:'RFI',description:'轮到你时，前面没有人主动跟注或加注，你选择加注开池的次数，除以获得这种开池机会的次数。前面有人跟注后再加注不计为首次开池。'},
  threeBet:{label:'再加注',short:'3-Bet',description:'面对首次加注时，选择再次加注的次数，除以有机会这样做的次数。盲注算第一注，首次加注为 2-Bet，再加注为 3-Bet。'},
  fourBet:{label:'再反加注',short:'4-Bet',description:'面对 3-Bet 后，继续加注到 4-Bet 的次数，除以有机会这样做的次数。只统计有加注权的决策。'},
  fiveBet:{label:'再次反加注',short:'5-Bet',description:'面对 4-Bet 后，继续加注到 5-Bet 的次数，除以有机会这样做的次数。没有这种机会时显示「—」，不是 0%。'},
  winRate:{label:'盈利手率',short:'',description:'德州净积分大于 0 的已完成手数，占所选已完成手数的比例。拿回部分底池但整手仍亏损，不算盈利手；小游戏不影响这个指标。'},
  flopSeen:{label:'看到翻牌',short:'',description:'未弃牌并看到翻牌的手数，占所选已完成手数的比例。炸弹池也可能直接进入翻牌，因此它与主动入池率不同。'},
  wtsd:{label:'入摊牌率',short:'WTSD',description:'看到翻牌后继续到摊牌的手数，占看到翻牌手数的比例。全员弃牌、无需比牌的获胜不算摊牌。'},
  wsd:{label:'摊牌获分率',short:'W$SD',description:'到达摊牌后，从主池或边池获得积分的手数，占摊牌手数的比例。包含平分底池；获分不一定代表整手净盈利。'},
});

export function renderStatsMetricDetails(key) {
  const metric=STATS_METRICS[key];if(!metric)return '<p class="note">暂无该指标说明。</p>';
  return `<div class="stats-definition"><h3>${escape(metric.label)}${metric.short?` <small>${escape(metric.short)}</small>`:''}</h3><p>${escape(metric.description)}</p>${metric.example?`<p class="note">${escape(metric.example)}</p>`:''}<p class="note">以当前日期、手数和对局筛选为准。VPIP / PFR 按普通德州手数统计，开池和再加注按有加注权的机会统计；没有机会时显示「—」。翻前指标不计炸弹池。</p></div>`;
}

function metricTile(key,data={}) {
  const definition=STATS_METRICS[key],count=Number(data.count)||0,opportunities=Number(data.opportunities)||0;
  const value=opportunities>0?percent(data.percent):'—',handBased=['vpip','pfr','winRate','flopSeen','wtsd','wsd'].includes(key),unit=handBased?'手':'次机会';
  return `<button type="button" class="stats-metric" data-action="stats-metric" data-metric="${key}" aria-label="${definition.label}${definition.short?' '+definition.short:''}，${value}，${count} / ${opportunities} ${unit}，查看说明"><span class="stats-metric-label">${escape(definition.label)}${definition.short?` <small>${escape(definition.short)}</small>`:''}<span class="stats-help" aria-hidden="true">?</span></span><strong>${value}</strong><span class="stats-metric-count">${number(count)} / ${number(opportunities)} <small>${opportunities?unit:handBased?'暂无手牌':'暂无机会'}</small></span></button>`;
}

function filtersMarkup(view,rooms,currentRoom) {
  const f={...defaultStatsFilters(),...view.filters};
  const availableRooms=[...rooms];for(const code of [currentRoom,view.room])if(code&&!availableRooms.some(room=>room.code===code))availableRooms.unshift({code,name:code===currentRoom?'当前对局':`房间 ${code} 的对局`});
  const option=(value,label,current)=>`<option value="${escape(value)}" ${String(value)===String(current)?'selected':''}>${escape(label)}</option>`;
  return `<form id="stats-filter-form" class="stats-filters" data-stats-key="${escape(statsFilterKey(view))}"><div class="stats-periods" role="group" aria-label="数据日期范围">${[['all','全部'],['1','近 1 天'],['3','近 3 天'],['7','近 7 天'],['30','近 30 天'],['custom','自选日期']].map(([value,label])=>button(label,'stats-period',`data-period="${value}" aria-pressed="${f.period===value}"`,f.period===value?'selected small':'ghost small')).join('')}</div>${f.period==='custom'?`<div class="stats-date-fields"><label class="field">开始日期<input type="date" name="from" value="${escape(f.from)}"></label><label class="field">结束日期<input type="date" name="to" value="${escape(f.to)}"></label></div>`:''}<div class="stats-filter-fields"><label class="field">手数<select name="maxHands" data-stats-auto="1">${[['all','全部手数'],['100','最近 100 手'],['500','最近 500 手'],['1000','最近 1000 手'],['custom','自定手数']].map(([value,label])=>option(value,label,f.maxHands)).join('')}</select></label><label class="field stats-custom-hands" ${f.maxHands==='custom'?'':'hidden'}>最近几手<input type="number" name="handCount" min="1" max="100000" step="1" inputmode="numeric" value="${escape(f.handCount)}" ${f.maxHands==='custom'?'required':''}></label><label class="field stats-room-field">选择对局<select name="room" data-stats-auto="1"><option value="">全部对局</option>${roomChoices(availableRooms,view.room).map(room=>option(room.code,`${room.label}${room.code===currentRoom?' · 当前':''}`,view.room)).join('')}</select></label><div class="stats-filter-actions"><button type="submit" class="outline small">应用</button>${button('重置','stats-reset')}</div></div><p class="stats-filter-note">${f.period==='1'?'近 1 天按今天统计。':f.period==='all'?'':'日期包含今天，按本设备时区统计。'}${f.maxHands==='all'?'只统计已完成的手牌。':'在所选日期和对局内，取最近完成的手牌。'}</p></form>`;
}

export function renderAllInChart(curve=[]) {
  const useBB=getDisplayUnit()==='bb';
  if(useBB&&curve.some(point=>!finite(point.actualBB)||!finite(point.expectedBB)))return '<p class="stats-section-note">部分全下记录缺少历史大盲，BB 走势无法完整折算；切换积分查看。</p>';
  const valid=curve.map(point=>({...point,actual:useBB?point.actualBB:point.actual,expected:useBB?point.expectedBB:point.expected})).filter(point=>finite(point.actual)&&finite(point.expected));
  if(!valid.length)return '<div class="stats-chart-empty">完成有记录的全下跑牌后，这里会显示实际与期望的变化。</div>';
  const samples=[{actual:0,expected:0},...valid],values=samples.flatMap(point=>[Number(point.actual),Number(point.expected)]);
  let min=Math.min(0,...values),max=Math.max(0,...values);if(min===max){min=-1;max=1;}const span=max-min;
  const width=660,height=214,left=58,right=16,top=18,bottom=35,x=index=>left+index*(width-left-right)/(samples.length-1),y=value=>top+(max-Number(value))/span*(height-top-bottom);
  const path=key=>samples.map((point,index)=>`${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(' '),last=valid.at(-1);
  return `<div class="stats-chart"><div class="stats-chart-range">${unitLabel()}范围 ${signed(min)} ～ ${signed(max)}</div><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="全下跑牌累计${unitLabel()}：实际 ${signed(last.actual)}，期望 ${signed(last.expected)}"><title>同一批已记录全下手牌，实际和期望的累计净${unitLabel()}</title>${[max,(max+min)/2,min].map(value=>`<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" stroke="#dfe6df" stroke-dasharray="3 5"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end" fill="#758177" font-size="11">${formatAggregate(value,value,{unitLabel:false,digits:1})}</text>`).join('')}<polyline class="stats-chart-expected" points="${path('expected')}" fill="none" stroke="#ac8232" stroke-width="2.5" stroke-dasharray="6 4" stroke-linejoin="round"/><polyline class="stats-chart-actual" points="${path('actual')}" fill="none" stroke="#146a58" stroke-width="3" stroke-linejoin="round"/>${valid.map((point,index)=>`<circle cx="${x(index+1)}" cy="${y(point.actual)}" r="3" fill="#146a58"><title>${escape(date(point.at))} · 实际 ${signed(point.actual)} / 期望 ${signed(point.expected)}</title></circle>`).join('')}<text x="${left}" y="${height-7}" fill="#758177" font-size="11">按结算顺序</text><text x="${width-right}" y="${height-7}" text-anchor="end" fill="#758177" font-size="11">最近</text></svg><div class="stats-chart-mobile-axis"><span>按结算顺序</span><span>最近</span></div></div>`;
}

export function renderProfitChart(curve=[]) {
  const useBB=getDisplayUnit()==='bb';
  if(useBB&&curve.some(point=>!finite(point.netBB)))return '<p class="stats-section-note">部分记录缺少历史大盲，BB 走势无法完整折算；切换积分查看。</p>';
  const valid=curve.map(point=>({...point,net:useBB?point.netBB:point.net})).filter(point=>finite(point.net));
  if(!valid.length)return '<p class="stats-section-note">完成手牌后显示累计盈亏走势。</p>';
  const samples=[{net:0},...valid],values=samples.map(point=>Number(point.net));
  let min=Math.min(0,...values),max=Math.max(0,...values);if(min===max){min=-1;max=1;}
  const width=660,height=196,left=58,right=16,top=18,bottom=30,x=index=>left+index*(width-left-right)/(samples.length-1),y=value=>top+(max-Number(value))/(max-min)*(height-top-bottom);
  const points=samples.map((point,index)=>`${x(index).toFixed(2)},${y(point.net).toFixed(2)}`).join(' ');
  return `<div class="stats-chart"><div class="stats-chart-range">${unitLabel()}范围 ${signed(min)} ～ ${signed(max)}</div><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="当前筛选内累计净${unitLabel()}，最后为 ${signed(valid.at(-1).net)}"><title>当前筛选内的累计净${unitLabel()}，包含德州与小游戏</title>${[max,(max+min)/2,min].map(value=>`<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" stroke="#dfe6df" stroke-dasharray="3 5"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end" fill="#758177" font-size="11">${formatAggregate(value,value,{unitLabel:false,digits:1})}</text>`).join('')}<polyline points="${points}" fill="none" stroke="#146a58" stroke-width="3" stroke-linejoin="round"/>${valid.map((point,index)=>`<circle cx="${x(index+1)}" cy="${y(point.net)}" r="3" fill="#146a58"><title>${escape(date(point.at))} · ${signed(point.net)} ${unitLabel()}</title></circle>`).join('')}<text x="${left}" y="${height-7}" fill="#758177" font-size="11">按结算顺序</text><text x="${width-right}" y="${height-7}" text-anchor="end" fill="#758177" font-size="11">最近</text></svg><div class="stats-chart-mobile-axis"><span>按结算顺序</span><span>最近</span></div></div>`;
}

function allInMarkup(allIn={}) {
  const hasSamples=Number(allIn.count)>0,covered=Number(allIn.count)||0,eligible=Number(allIn.eligibleCount)||0,unavailable=Number(allIn.unavailableCount)||0;
  const summary=hasSamples?`<div class="stats-allin-totals">${[[getDisplayUnit()==='bb'?'实际净盈亏':'实际净积分',allIn.actualNet,allIn.actualNetBB],['全下期望',allIn.expectedNet,allIn.expectedNetBB],['实际 − 期望',allIn.difference,allIn.differenceBB]].map(([label,value,bb])=>`<div><small>${label}</small><strong class="${moneyTone(value,bb)}">${aggregate(value,bb)}</strong></div>`).join('')}</div><div class="stats-chart-legend"><span><i class="stats-legend-actual"></i>${getDisplayUnit()==='bb'?'实际净盈亏':'实际净积分'}</span><span><i class="stats-legend-expected"></i>全下期望</span><small>同一批手牌 · ${unitLabel()}</small></div>${renderAllInChart(allIn.curve)}`:'<div class="stats-empty-state"><strong>还没有可计算的全下样本</strong><p>全下后仍有公共牌未发完，且保留了当时的计算记录，才会纳入统计。</p></div>';
  const handRows=(allIn.hands||[]).map(hand=>`<button type="button" class="stats-allin-hand" data-action="replay" data-hand="${escape(hand.id)}" data-room="${escape(hand.roomCode)}"><span class="stats-allin-hand-title"><strong>第 ${number(hand.number)} 手 <small>${escape(({preflop:'翻前',flop:'翻牌',turn:'转牌',river:'河牌'})[hand.street]||'')}全下</small></strong><small>${escape(hand.roomName)} · ${escape(date(hand.at))}</small></span><span class="stats-allin-hand-values"><span>实际 <b class="${moneyTone(hand.actualNet,hand.actualNetBB)}">${aggregate(hand.actualNet,hand.actualNetBB)}</b></span><span>期望 <b>${hand.method==='monte-carlo'?'≈':''}${aggregate(hand.expectedNet,hand.expectedNetBB)}</b></span><span>差额 <b class="${moneyTone(hand.difference,hand.differenceBB)}">${aggregate(hand.difference,hand.differenceBB)}</b></span></span><span class="stats-replay-link">回放 →</span></button>`).join('');
  return `<section class="panel stats-allin-panel"><div class="stats-section-head"><div><h3>全下跑牌</h3><p>看结果比当时的期望多了多少、少了多少。</p></div><span class="stats-sample-badge">已记录 ${number(covered)} / ${number(eligible)} 手</span></div>${summary}<div class="stats-coverage-note">${getDisplayUnit()==='bb'&&allIn.bbComplete===false?`${number(covered-Number(allIn.bbHands||0))} 手缺少历史大盲，BB 汇总暂不显示；可切换积分。 `:''}${unavailable?`${number(unavailable)} 手缺少当时的记录，未计入期望与差额。 `:''}${Number(allIn.estimatedCount)>0?`${number(allIn.estimatedCount)} 手使用抽样估算。 `:''}${hasSamples&&covered<30?'样本较少，差额暂不适合解读为长期水平。':''}</div><details class="stats-explainer"><summary>这些数字怎么看？</summary><p>期望按停止下注时的底牌、公共牌和各个底池计算，平分与边池一起考虑。实际与期望只比较同一批已记录的全下手牌，均不包含小游戏。</p><p>例如期望 +60 ${unitLabel()}、实际 +100 ${unitLabel()}，差额就是 +40 ${unitLabel()}；反之差额为负。差额描述已经发生的跑牌结果，不能预测下一手，也不是发牌公平性的证明。</p><p>只有仍需发公共牌的全下才计入。旧牌谱缺少全下时点的记录时，不会用事后的牌倒推期望。</p></details>${handRows?`<details class="stats-allin-list"><summary>逐手查看 <span>${number(Math.min(50,(allIn.hands||[]).length))} 手${covered>(allIn.hands||[]).length?' · 最近记录':''}</span></summary><div>${handRows}</div></details>`:''}</section>`;
}

export function renderStatsPage(data,view={},options={}) {
  const {rooms=[],currentRoom='',compact=false}=options,tag=compact?'div':'main',loading=Boolean(view.loading),error=String(view.error||'');
  const heading=compact?'':`<div class="stats-page-heading"><h1 class="page-title">我的数据</h1>${button('查看牌谱','hands','','outline small')}</div>`;
  let content='';
  if(error)content=`<div class="stats-empty-state" role="alert"><p>${escape(error)}</p>${button('重新读取','stats-retry','','outline small')}</div>`;
  else if(loading||!data)content='<div class="stats-loading" role="status">正在读取我的数据…</div>';
  else {
    const s=data,metrics=s.metrics||{},hands=Number(s.hands)||0;
    content=`<div class="stats-overview" aria-label="当前筛选汇总">${[['完成手数',number(hands),''],[getDisplayUnit()==='bb'?'累计净盈亏':'累计净积分',aggregate(s.net,s.netBB),moneyTone(s.net,s.netBB)],[getDisplayUnit()==='bb'?'德州盈亏':'德州净积分',aggregate(s.holdemNet,s.holdemNetBB),moneyTone(s.holdemNet,s.holdemNetBB)],[getDisplayUnit()==='bb'?'小游戏盈亏':'小游戏净积分',aggregate(s.miniNet,s.miniNetBB),moneyTone(s.miniNet,s.miniNetBB)]].map(([label,value,cls])=>`<div><small>${label}</small><strong class="${cls}">${value}</strong></div>`).join('')}</div>${getDisplayUnit()==='bb'&&s.bbComplete===false?'<p class="stats-section-note">部分记录缺少历史大盲，无法完整折算的 BB 汇总显示 —；切换积分查看完整金额。</p>':''}${s.squidSettlementCount?`<p class="stats-section-note">小游戏包含 ${number(s.squidSettlementCount)} 笔鱿鱼结算。${s.standaloneSquidSettlementCount?`其中 ${number(s.standaloneSquidSettlementCount)} 笔在手牌外结算，计入小游戏盈亏，不增加手数。`:''}</p>`:''}${s.adjustmentsExcluded?'<p class="stats-section-note">选择最近 N 手时，仅统计这些手牌，不包含手外结算。</p>':''}${!hands&&!s.standaloneSquidSettlementCount?'<div class="stats-empty-state"><strong>这个范围内还没有手牌</strong><p>换个日期或牌桌试试，也可以先完成一手牌。</p></div>':''}<section class="panel stats-playing-panel"><div class="stats-section-head"><div><h3>打法数据</h3><p>点指标看说明，次数 / 机会数一起看。</p></div></div><div class="stats-metrics">${['vpip','pfr','rfi','threeBet','fourBet','fiveBet'].map(key=>metricTile(key,metrics[key])).join('')}</div><p class="stats-section-note">翻前指标使用 ${number(s.preflopHands)} 手普通德州记录。炸弹池不计入。</p><details class="stats-more-metrics"><summary>更多数据 <span>盈利、翻牌和摊牌</span></summary><div class="stats-metrics">${['winRate','flopSeen','wtsd','wsd'].map(key=>metricTile(key,metrics[key])).join('')}</div><div class="stats-result-detail"><span>盈利 <b>${number(s.winHands)}</b> 手</span><span>亏损 <b>${number(s.lossHands)}</b> 手</span><span>持平 <b>${number(s.evenHands)}</b> 手</span><span>每百手 <b>${number(s.bbPer100,1)} BB</b></span></div><p class="stats-section-note">盈利、亏损和持平按德州净积分统计；每手先按当桌大盲换算，再计算每百手结果。</p></details></section>${allInMarkup(s.allIn)}`;
  }
  return `<${tag} class="${compact?'stats-overlay':'shell'} stats-page">${heading}${filtersMarkup(view,rooms,currentRoom)}<div class="stats-content" aria-busy="${loading}">${content}</div>${!loading&&!error&&data?`<details class="panel stats-overall-curve"><summary>${unitLabel()}走势 <span>德州与小游戏合计</span></summary>${renderProfitChart(data.curve)}${data.adjustmentCount?`<p class="stats-section-note">小游戏包含 ${number(data.adjustmentCount)} 笔旧蘑菇池退回记录。</p>`:''}<div class="stats-export-action">${button('导出我的记录','export','','outline small')}</div></details>`:''}<p class="stats-footer-note">仅查看你本人的已结算记录，带入和补码不算盈亏。筛选同时作用于指标和全下统计。</p></${tag}>`;
}

export function renderEquityBadge(player={},options={}) {
  const equity=player.equity;
  if(!finite(equity))return '';
  const value=Math.max(0,Math.min(100,Number(equity))),approximate=Boolean(options.approximate);
  return `<span class="equity-badge${approximate?' estimated':''}" title="${approximate?'抽样估算的':'当前'}主池权益：平分按分得的份额计算；此百分比不代表各边池权益" aria-label="${approximate?'估算':''}主池权益 ${number(value,1)}%，含平分份额"><span>${approximate?'≈':''}${number(value,1)}%</span></span>`;
}
