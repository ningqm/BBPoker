const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const number = value => Number(value || 0).toLocaleString('zh-CN');
const signed = value => `${Number(value)>0?'+':''}${number(value)}`;
const profit = value => Number(value)>0?'positive':Number(value)<0?'negative':'muted';
const button = (label, action, attrs='', cls='outline small') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const dateLabel = value => { const d=new Date(value);return Number.isNaN(+d)?'':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); };
export const defaultRecordFilters = () => ({period:'all',from:'',to:'',result:'all',type:'all',status:'all',q:''});
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
  if(!['today','7','30'].includes(period))throw new Error('日期范围无效');
  const from=new Date(now),to=new Date(now);from.setHours(0,0,0,0);to.setHours(23,59,59,999);
  from.setDate(from.getDate()-(period==='today'?0:Number(period)-1));
  return {from:from.toISOString(),to:to.toISOString()};
}
export function recordQuery(kind, state, reset=false, now=new Date()) {
  const filters={...defaultRecordFilters(),...state.filters},query=new URLSearchParams({limit:'20'});
  for(const [key,value]of Object.entries(recordDateRange(filters,now)))query.set(key,value);
  if(filters.result!=='all')query.set('result',filters.result);
  if(filters.q.trim())query.set('q',filters.q.trim());
  if(state.room)query.set('room',state.room);
  if(kind==='hands'){if(state.favorites)query.set('favorites','1');if(filters.type!=='all')query.set('type',filters.type);}
  else if(filters.status!=='all')query.set('status',filters.status);
  if(!reset&&state.nextCursor)query.set('before',state.nextCursor);
  return query;
}
export function filterValues(formData, current={}) {
  const result={...defaultRecordFilters(),...current};
  for(const key of ['result','type','status','q','from','to'])if(formData.has(key))result[key]=String(formData.get(key)||'');
  return result;
}
export function recordFilterKey(state) {
  return JSON.stringify({filters:{...defaultRecordFilters(),...state.filters},room:state.room||'',scope:state.scope||'',favorites:Boolean(state.favorites)});
}
export function captureRecordDraft(form,state,activeElement) {
  const key=recordFilterKey(state);if(!form||form.dataset.recordKey!==key)return null;
  const values=Array.from(form.elements).filter(field=>field.name).map(field=>[field.name,field.value]);
  const focus=activeElement?.name&&form.contains(activeElement)?{name:activeElement.name,start:activeElement.selectionStart,end:activeElement.selectionEnd}:null;
  return {key,values,focus};
}
export function restoreRecordDraft(form,state,draft) {
  if(!form||!draft||draft.key!==recordFilterKey(state)||form.dataset.recordKey!==draft.key)return;
  for(const [name,value]of draft.values){const field=form.elements.namedItem(name);if(field)field.value=value;}
  if(draft.focus){const field=form.elements.namedItem(draft.focus.name);field?.focus({preventScroll:true});if(typeof field?.setSelectionRange==='function'&&typeof draft.focus.start==='number'&&!['number','date','range'].includes(field.type))field.setSelectionRange(draft.focus.start,draft.focus.end);}
}
export function recordFilters(kind,state,rooms=[]) {
  const f={...defaultRecordFilters(),...state.filters},hands=kind==='hands',prefix=hands?'hand-records':'session-records';
  const availableRooms=state.room&&!rooms.some(r=>r.code===state.room)?[{code:state.room,name:'牌桌 '+state.room},...rooms]:rooms;
  const option=(value,label,current)=>`<option value="${value}" ${value===current?'selected':''}>${label}</option>`;
  return `<form id="${prefix}-filter-form" class="record-filters" data-record-kind="${kind}" data-record-key="${escape(recordFilterKey(state))}"><div class="record-periods" role="group" aria-label="日期范围">${[['all','全部日期'],['today','今天'],['7','近 7 天'],['30','近 30 天'],['custom','自选日期']].map(([value,label])=>button(label,'record-period',`data-kind="${kind}" data-period="${value}" aria-pressed="${f.period===value}"`,f.period===value?'selected small':'ghost small')).join('')}</div>${f.period==='custom'?`<div class="field-grid record-date-fields"><label class="field">开始日期<input type="date" name="from" value="${escape(f.from)}"></label><label class="field">结束日期<input type="date" name="to" value="${escape(f.to)}"></label></div>`:''}<div class="record-filter-row"><label class="field">输赢<select name="result" data-record-auto="1">${[['all','全部结果'],['win','我赢积分'],['loss','我输积分'],['even','不输不赢']].map(([v,l])=>option(v,l,f.result)).join('')}</select></label>${hands?`${state.scope==='table'?`<label class="field">牌桌<input readonly aria-label="当前牌桌" value="${escape(rooms.find(r=>r.code===state.room)?.name||'当前牌桌')}"></label>`:`<label class="field">牌桌<select name="room" id="library-room" data-record-auto="1"><option value="">所有牌桌</option>${availableRooms.map(r=>`<option value="${escape(r.code)}" ${state.room===r.code?'selected':''}>${escape(r.name)}</option>`).join('')}</select></label>`}<label class="field">玩法<select name="type" data-record-auto="1">${[['all','全部玩法'],['holdem','普通德州'],['bomb','炸弹池']].map(([v,l])=>option(v,l,f.type)).join('')}</select></label>`:`<label class="field">状态<select name="status" data-record-auto="1">${[['all','全部状态'],['active','未结束'],['closed','已结束']].map(([v,l])=>option(v,l,f.status)).join('')}</select></label>`}</div><div class="record-search-row"><label class="sr-only" for="${prefix}-search">${hands?'搜索牌桌或手牌号':'搜索牌桌名称或房号'}</label><input id="${prefix}-search" name="q" type="search" maxlength="80" placeholder="${hands?'搜索牌桌、手牌号':'搜索牌桌名称或房号'}" value="${escape(f.q)}"><button type="submit" class="outline small">筛选</button>${button('重置','record-reset',`data-kind="${kind}"`,'ghost small')}</div></form>`;
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
