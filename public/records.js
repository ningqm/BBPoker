const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const number = value => Number(value || 0).toLocaleString('zh-CN');
const signed = value => `${Number(value)>0?'+':''}${number(value)}`;
const profit = value => Number(value)>0?'positive':Number(value)<0?'negative':'muted';
const button = (label, action, attrs='', cls='outline small') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const dateLabel = value => { const d=new Date(value);return Number.isNaN(+d)?'':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); };
export const defaultRecordFilters = () => ({period:'all',from:'',to:'',result:'all',minBB:'20',holeRanks:'',holeType:'all',type:'all',status:'all',q:''});
function localDay(value,end=false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效的日期');
  const [year,month,day]=value.split('-').map(Number),date=new Date(year,month-1,day);
  if (date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day) throw new Error('请选择有效的日期');
  if(end)date.setHours(23,59,59,999);
  return date;
}
export function recordDateRange(filters, now=new Date()) {
  const period=filters.period||'all';
  if(period==='all')return {};
  if(period==='custom') {
    const from=filters.from?localDay(filters.from):null,to=filters.to?localDay(filters.to,true):null;
    if(!from&&!to)throw new Error('请选择开始或结束日期');
    if(from&&to&&from>to)throw new Error('结束日期不能早于开始日期');
    return {...(from?{from:from.toISOString()}:{}),...(to?{to:to.toISOString()}:{})};
  }
  if(!['today','3','7','30'].includes(period))throw new Error('日期范围无效');
  const from=new Date(now),to=new Date(now);from.setHours(0,0,0,0);to.setHours(23,59,59,999);
  from.setDate(from.getDate()-(period==='today'?0:Number(period)-1));
  return {from:from.toISOString(),to:to.toISOString()};
}
export function recordQuery(kind, state, reset=false, now=new Date()) {
  const filters={...defaultRecordFilters(),...state.filters},query=new URLSearchParams({limit:'20'}),hands=kind==='hands';
  // A table's hand library is always its complete authorized history. Stale
  // date drafts from the lobby must never hide hands in this view.
  if(!(hands&&state.scope==='table'))for(const [key,value]of Object.entries(recordDateRange(filters,now)))query.set(key,value);
  const results=['all','win','loss','even','winOver','lossOver'];
  if(!results.includes(filters.result))throw new Error('请选择有效的输赢条件');
  if(filters.result!=='all')query.set('result',filters.result);
  if(['winOver','lossOver'].includes(filters.result)) {
    const value=String(filters.minBB??'').trim();
    if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)||Number(value)>1e9)throw new Error('BB 门槛请填 0–1,000,000,000，最多两位小数');
    query.set('minBB',String(Number(value)));
  }
  if(String(filters.q||'').trim())query.set('q',String(filters.q).trim());
  if(state.room)query.set('room',state.room);
  if(hands){
    if(state.favorites)query.set('favorites','1');if(filters.type!=='all')query.set('type',filters.type);
    const ranks=String(filters.holeRanks||'').trim().toUpperCase(),holeType=filters.holeType||'all';
    if(ranks&&!/^[2-9TJQKA]{1,2}$/.test(ranks))throw new Error('起手牌请选择一到两个点数');
    if(!['all','pair','suited','offsuit'].includes(holeType))throw new Error('请选择有效的起手牌类型');
    if(ranks)query.set('holeRanks',ranks);if(holeType!=='all')query.set('holeType',holeType);
  }
  else if(filters.status!=='all')query.set('status',filters.status);
  if(!reset&&state.nextCursor)query.set('before',state.nextCursor);
  return query;
}
export function filterValues(formData, current={}) {
  const result={...defaultRecordFilters(),...current};
  for(const key of ['result','minBB','type','status','q','from','to','holeType'])if(formData.has(key))result[key]=String(formData.get(key)||'');
  if(formData.has('holeRank1')||formData.has('holeRank2'))result.holeRanks=String(formData.get('holeRank1')||'')+String(formData.get('holeRank2')||'');
  else if(formData.has('holeRanks'))result.holeRanks=String(formData.get('holeRanks')||'');
  return result;
}
// The app delegates clicks to this helper, then applies the normal record form.
// Only these declared values become filters; no page state or private cards are read.
export function applyHolePreset(form,preset) {
  if(!form||form.dataset.recordKind!=='hands')return false;
  const ranks=String(preset.ranks||''),type=String(preset.holeType||'all');
  if(ranks&&!/^[2-9TJQKA]{1,2}$/.test(ranks)||!['all','pair','suited','offsuit'].includes(type))return false;
  const fields=['holeRank1','holeRank2','holeType'].map(name=>form.elements.namedItem(name));
  if(fields.some(field=>!field))return false;
  fields[0].value=ranks[0]||'';fields[1].value=ranks[1]||'';fields[2].value=type;
  return true;
}
export function recordFilterKey(state) {
  return JSON.stringify({filters:{...defaultRecordFilters(),...state.filters},room:state.room||'',scope:state.scope||'',favorites:Boolean(state.favorites)});
}
export function captureRecordDraft(form,state,activeElement) {
  const key=recordFilterKey(state);if(!form||form.dataset.recordKey!==key)return null;
  const values=Array.from(form.elements).filter(field=>field.name).map(field=>[field.name,field.value]);
  const focus=activeElement?.name&&form.contains(activeElement)?{name:activeElement.name,start:activeElement.selectionStart,end:activeElement.selectionEnd}:null;
  const disclosures=Array.from(form.querySelectorAll?.('[data-record-disclosure]')||[]).map(el=>[el.dataset.recordDisclosure,el.open]);
  return {key,values,focus,disclosures};
}
export function restoreRecordDraft(form,state,draft) {
  if(!form||!draft||draft.key!==recordFilterKey(state)||form.dataset.recordKey!==draft.key)return;
  for(const [name,value]of draft.values){const field=form.elements.namedItem(name);if(field)field.value=value;}
  for(const [name,open]of draft.disclosures||[]){const disclosure=Array.from(form.querySelectorAll?.('[data-record-disclosure]')||[]).find(el=>el.dataset.recordDisclosure===name);if(disclosure)disclosure.open=open;}
  if(draft.focus){const field=form.elements.namedItem(draft.focus.name);field?.focus({preventScroll:true});if(typeof field?.setSelectionRange==='function'&&typeof draft.focus.start==='number'&&!['number','date','range'].includes(field.type))field.setSelectionRange(draft.focus.start,draft.focus.end);}
}
function filterSummary(kind,state) {
  const f={...defaultRecordFilters(),...state.filters},labels=[];
  const result={win:'赢积分',loss:'输积分',even:'持平',winOver:`赢超过 ${f.minBB} BB`,lossOver:`输超过 ${f.minBB} BB`}[f.result];if(result)labels.push(result);
  if(kind==='hands'){
    if(f.holeRanks)labels.push(f.holeRanks.length===1?`含 ${f.holeRanks}`:f.holeRanks);
    if(f.holeType!=='all')labels.push(({pair:'口袋对',suited:'同花',offsuit:'杂色非对子'})[f.holeType]||'起手牌');
    if(f.type!=='all')labels.push(f.type==='bomb'?'炸弹池':'普通德州');
  }else if(f.status!=='all')labels.push(f.status==='closed'?'已结束':'未结束');
  if(String(f.q||'').trim())labels.push('含搜索词');
  return labels.length?labels.join(' · '):'全部手牌';
}
export function recordFilters(kind,state,rooms=[]) {
  const f={...defaultRecordFilters(),...state.filters},hands=kind==='hands',table=hands&&state.scope==='table',prefix=hands?'hand-records':'session-records';
  const availableRooms=state.room&&!rooms.some(r=>r.code===state.room)?[{code:state.room,name:'牌桌 '+state.room},...rooms]:rooms;
  const option=(value,label,current)=>`<option value="${escape(value)}" ${value===current?'selected':''}>${escape(label)}</option>`;
  const summary=filterSummary(kind,state),filtered=summary!=='全部手牌';
  const dateFields=table?'':`<section class="record-date-group" aria-label="筛选日期"><div class="record-periods" role="group" aria-label="日期范围">${[['all','全部日期'],['today','今天'],['3','近 3 天'],['7','近 7 天'],['30','近 30 天'],['custom','自选日期']].map(([value,label])=>button(label,'record-period',`data-kind="${kind}" data-period="${value}" aria-pressed="${f.period===value}"`,f.period===value?'selected small':'ghost small')).join('')}</div>${f.period==='custom'?`<div class="record-date-fields"><label class="field">开始日期<input type="date" name="from" value="${escape(f.from)}"></label><label class="field">结束日期<input type="date" name="to" value="${escape(f.to)}"></label><p class="record-date-note">开始或结束可留空；按本地日期筛选。</p></div>`:''}</section>`;
  const resultOptions=[['all','全部结果'],['win','赢积分'],['loss','输积分'],['even','持平'],['winOver','赢超过 N BB'],['lossOver','输超过 N BB']];
  const results=`<div class="record-result-group"><label class="field">我的盈亏<select name="result" data-record-auto="1">${resultOptions.map(([v,l])=>option(v,l,f.result)).join('')}</select></label>${`<label class="field record-bb-threshold">超过多少 BB<input type="text" name="minBB" inputmode="decimal" maxlength="13" aria-label="超过多少 BB" value="${escape(f.minBB)}"><small>按${hands?'每手':'每桌'}大盲折算，严格大于此数；填写后点筛选。</small></label>`}</div>`;
  const roomField=hands&&!table?`<label class="field record-room-field">牌桌<select name="room" id="library-room" data-record-auto="1"><option value="">所有牌桌</option>${availableRooms.map(r=>`<option value="${escape(r.code)}" ${state.room===r.code?'selected':''}>${escape(r.name)}</option>`).join('')}</select></label>`:'';
  const typeField=hands?`<label class="field">玩法<select name="type" data-record-auto="1">${[['all','全部玩法'],['holdem','普通德州'],['bomb','炸弹池']].map(([v,l])=>option(v,l,f.type)).join('')}</select></label>`:`<label class="field">状态<select name="status" data-record-auto="1">${[['all','全部状态'],['active','未结束'],['closed','已结束']].map(([v,l])=>option(v,l,f.status)).join('')}</select></label>`;
  const rankOptions=current=>[['','不限'],...['A','K','Q','J','T','9','8','7','6','5','4','3','2'].map(rank=>[rank,rank==='T'?'10':rank])].map(([v,l])=>option(v,l,current)).join('');
  const hole=hands?`<details class="record-hole-options" data-record-disclosure="hole" ${f.holeRanks||f.holeType!=='all'?'open':''}><summary>起手牌条件 <span>${escape([f.holeRanks?f.holeRanks.length===1?'含 '+f.holeRanks:f.holeRanks:'',({pair:'口袋对',suited:'同花',offsuit:'杂色非对子'})[f.holeType]].filter(Boolean).join(' · ')||'不限')}</span></summary><div class="record-hole-presets" role="group" aria-label="常用起手牌">${[['','all','不限'],['A','all','含 A'],['AK','all','AK'],['AK','suited','AK 同花'],['','pair','口袋对']].map(([ranks,type,label])=>button(label,'record-hole-preset',`data-kind="hands" data-ranks="${ranks}" data-hole-type="${type}" aria-pressed="${f.holeRanks===ranks&&f.holeType===type}"`,f.holeRanks===ranks&&f.holeType===type?'selected small':'ghost small')).join('')}</div><div class="record-hole-fields"><label class="field">点数一<select name="holeRank1">${rankOptions(String(f.holeRanks||'')[0]||'')}</select></label><label class="field">点数二<select name="holeRank2">${rankOptions(String(f.holeRanks||'')[1]||'')}</select></label><label class="field">牌型<select name="holeType">${[['all','不限花色'],['pair','口袋对'],['suited','同花非对子'],['offsuit','杂色非对子']].map(([v,l])=>option(v,l,f.holeType)).join('')}</select></label></div><p class="record-filter-help">点数与牌型需同时满足；同花、杂色均不含对子。只筛自己的两张底牌，自定义后点筛选。</p></details>`:'';
  const search=`<div class="record-search-row"><label class="sr-only" for="${prefix}-search">${hands?table?'搜索手牌号':'搜索牌桌或手牌号':'搜索牌桌名称或房号'}</label><input id="${prefix}-search" name="q" type="search" maxlength="80" placeholder="${hands?table?'搜索手牌号':'搜索牌桌、手牌号':'搜索牌桌名称或房号'}" value="${escape(f.q)}"><button type="submit" class="outline small">筛选</button>${button('重置','record-reset',`data-kind="${kind}"`,'ghost small')}</div>`;
  const fields=`${dateFields}<div class="record-filter-row">${results}${roomField}${typeField}</div>${hole}${search}`;
  return `<form id="${prefix}-filter-form" class="record-filters ${hands?'hand-record-filters':''} ${table?'table-record-filters':''}" data-record-kind="${kind}" data-record-key="${escape(recordFilterKey(state))}">${table?`<details class="record-table-options" data-record-disclosure="table" ${filtered?'open':''}><summary>筛选 <span>${escape(summary)}</span></summary><div class="record-table-fields">${fields}</div></details>`:`${fields}${hands?`<p class="record-filter-summary" aria-label="当前筛选条件">${escape(summary)}</p>`:''}`}</form>`;
}
export function recordTotals(totals,kind) {
  if(!totals)return '';
  return `<div class="record-totals" aria-label="当前筛选汇总"><div><small>${kind==='hands'?'符合条件手数':'符合条件场次'}</small><strong>${number(totals.count)}</strong></div><div><small>我的净积分</small><strong class="${profit(totals.net)}">${signed(totals.net)}</strong></div><div><small>德州</small><strong class="${profit(totals.holdemNet)}">${signed(totals.holdemNet)}</strong></div><div><small>小游戏</small><strong class="${profit(totals.miniNet)}">${signed(totals.miniNet)}</strong></div></div>`;
}
export function sessionRow(session) {
  return `<button type="button" class="session-record" data-action="session-detail" data-code="${escape(session.code)}"><span class="session-record-info"><strong>${escape(session.name)}</strong><small>${escape(dateLabel(session.at))} · ${session.status==='closed'?'已结束':'未结束'} · ${number(session.handCount)} 手</small><small>${number(session.playerCount)} 人 · 盲注 ${number(session.smallBlind)} / ${number(session.bigBlind)}</small></span><span class="session-record-result"><b class="${profit(session.meNet)}">${signed(session.meNet)}</b><small>我的净积分</small><small>查看全桌 →</small></span></button>`;
}
export function sessionDetail(session,meId) {
  const players=[...(session.players||[])].sort((a,b)=>Number(b.net)-Number(a.net));
  return `<div class="session-detail-heading"><p class="note">${escape(dateLabel(session.at))} · ${session.status==='closed'?'已结束':'未结束'} · ${number(session.handCount)} 手 · 盲注 ${number(session.smallBlind)} / ${number(session.bigBlind)}</p>${session.handInProgress?'<p class="note">当前一手还在进行，以下只统计已结算手牌。</p>':''}</div><div class="session-player-list">${players.map(p=>`<article class="session-player"><div class="session-player-title"><strong>${escape(p.name)}${p.id===meId?' <span class="you-tag">我</span>':''}</strong><b class="${profit(p.net)}">${signed(p.net)}</b></div><div class="session-player-breakdown"><span>德州 <b class="${profit(p.holdemNet)}">${signed(p.holdemNet)}</b></span><span>小游戏 <b class="${profit(p.miniNet)}">${signed(p.miniNet)}</b></span></div><small>${number(p.hands)} 手 · 累计带入 ${number(p.totalBuyIn)} 积分</small></article>`).join('')}</div><p class="privacy-footnote">净积分不包含带入、补码和离桌取回。${session.adjustments?'小游戏包含旧蘑菇池退回记录。':''}${session.squidSettlementCount?`本场你的小游戏包含 ${number(session.squidSettlementCount)} 笔鱿鱼结算；手外结算不增加手数。`:''}</p><div class="modal-footer">${button('返回对局','sessions','', 'ghost')}${button('本场牌谱','session-hands',`data-code="${escape(session.code)}"`,'primary')}</div>`;
}
