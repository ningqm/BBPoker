import { getDisplayUnit, formatChips, formatAggregate } from './money.js';
import { STARTING_HAND_PRESETS, normalizeStartingHandFilter, startingHandSummary } from './starting-hands.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const number = value => Number(value || 0).toLocaleString('zh-CN');
const profit = value => Number(value)>0?'positive':Number(value)<0?'negative':'muted';
const button = (label, action, attrs='', cls='outline small') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const dateLabel = value => { const d=new Date(value);return Number.isNaN(+d)?'':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); };
const holeDefaults={holePreset:'all',holeRank1:'',holeSuit1:'',holeRank2:'',holeSuit2:'',holeType:'all'};
const holeCardFields=['holeRank1','holeSuit1','holeRank2','holeSuit2'];
const holeCustomFields=['holeRank1','holeSuit1','holeRank2','holeSuit2','holeType'];
export const defaultRecordFilters = () => ({period:'all',from:'',to:'',result:'all',minBB:'20',...holeDefaults,type:'all',status:'all',q:'',handNumber:'',opponent:'',position:'all',potType:'all',tableSize:'all',maxHands:'all'});
// Previously saved filters used one rank string. Adapt it at the boundary;
// all new forms and requests keep each card's rank and suit together.
function holeFilter(filters={}) {
  const input={...filters};
  if(input.holeRanks&&!holeCardFields.some(key=>Object.hasOwn(input,key))&&(!input.holePreset||input.holePreset==='all')) {
    if(typeof input.holeRanks!=='string'||!/^[2-9TJQKA]{1,2}$/i.test(input.holeRanks.trim()))throw new Error('起手牌请选择一到两个点数');
    [input.holeRank1,input.holeRank2]=input.holeRanks.trim().toUpperCase();
  }
  return normalizeStartingHandFilter(input);
}
function holePresentation(filters) {
  try {
    const value=holeFilter(filters),preset=STARTING_HAND_PRESETS.find(p=>p.id===value.holePreset);
    return {value,summary:startingHandSummary(value),description:preset?.description||'',custom:holeCustomFields.some(name=>value[name]!==holeDefaults[name]),error:''};
  }catch(error){return {value:{...holeDefaults,...filters},summary:'请检查起手牌条件',description:'',custom:true,error:error.message};}
}
const positionOptions=[['all','所有位置'],['BTN','BTN · 庄位'],['SB','SB · 小盲'],['BB','BB · 大盲'],['UTG','UTG · 枪口'],['UTG+1','UTG+1'],['MP','MP · 中位'],['LJ','LJ · 前位'],['HJ','HJ · 后位'],['CO','CO · 庄前位'],['unknown','位置未记录']];
const potTypeOptions=[['all','不限翻后人数'],['headsUp','翻后单挑 · 2 人'],['multiway','翻后多人池 · 3 人及以上'],['noFlop','本人未进入翻牌'],['unknown','翻后人数未记录']];
const tableSizeOptions=[['all','不限发牌人数'],['headsUp','2 人发牌'],['short','3–6 人发牌'],['full','7–9 人发牌']];
const maxHandsOptions=[['all','全部符合条件的手牌'],['100','最近 100 手'],['500','最近 500 手'],['1000','最近 1,000 手']];
function personalFilterLabels(state) {
  const f={...defaultRecordFilters(),...state.filters},labels=[];
  if(f.opponent)labels.push('对手：'+(state.opponentOptions?.find(p=>p.id===f.opponent)?.name||'已选择'));
  if(f.position!=='all')labels.push(positionOptions.find(([v])=>v===f.position)?.[1]||'指定位置');
  if(f.potType!=='all')labels.push(potTypeOptions.find(([v])=>v===f.potType)?.[1]||'指定翻后人数');
  if(f.tableSize!=='all')labels.push(tableSizeOptions.find(([v])=>v===f.tableSize)?.[1]||'指定发牌人数');
  if(f.maxHands!=='all')labels.push(`最近 ${number(f.maxHands)} 手`);
  return labels;
}
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
  if(!hands&&String(filters.q||'').trim())query.set('q',String(filters.q).trim());
  if(state.room)query.set('room',state.room);
  if(hands){
    if(state.favorites)query.set('favorites','1');if(filters.type!=='all')query.set('type',filters.type);
    const hole=holeFilter(state.filters);
    for(const key of Object.keys(holeDefaults))if(hole[key]!==holeDefaults[key])query.set(key,hole[key]);
    if(filters.handNumber!=null&&!['string','number'].includes(typeof filters.handNumber))throw new Error('请填写有效的手数，例如 12');
    const handNumber=String(filters.handNumber??'').trim();
    if(handNumber){
      if(!/^\d+$/.test(handNumber)||Number(handNumber)<1||!Number.isSafeInteger(Number(handNumber)))throw new Error('请填写有效的手数，例如 12');
      query.set('handNumber',String(Number(handNumber)));
    }
    if(state.scope!=='table') {
      if(typeof filters.opponent!=='string'||filters.opponent&&!/^[A-Za-z0-9_-]{1,128}$/.test(filters.opponent))throw new Error('请选择有效的对手');
      if(filters.opponent)query.set('opponent',filters.opponent);
      for(const [key,options,label]of [['position',positionOptions,'位置'],['potType',potTypeOptions,'翻后人数'],['tableSize',tableSizeOptions,'发牌人数']]){
        if(!options.some(([value])=>value===filters[key]))throw new Error(`请选择有效的${label}`);
        if(filters[key]!=='all')query.set(key,filters[key]);
      }
      if(!['string','number'].includes(typeof filters.maxHands))throw new Error('手数范围请选 1–100,000 手');
      const maxHands=String(filters.maxHands);
      if(maxHands!=='all'){
        if(!/^[1-9]\d*$/.test(maxHands)||Number(maxHands)>100000)throw new Error('手数范围请选 1–100,000 手');
        query.set('maxHands',maxHands);
      }
    }
  }
  else if(filters.status!=='all')query.set('status',filters.status);
  if(!reset&&state.nextCursor)query.set('before',state.nextCursor);
  return query;
}
export function filterValues(formData, current={}) {
  const result={...defaultRecordFilters(),...current};
  for(const key of ['result','minBB','type','status','q','handNumber','from','to',...Object.keys(holeDefaults),'opponent','position','potType','tableSize','maxHands'])if(formData.has(key))result[key]=String(formData.get(key)||'');
  if(Object.keys(holeDefaults).some(key=>formData.has(key)))delete result.holeRanks;
  else {
    if(formData.has('holeRanks'))result.holeRanks=String(formData.get('holeRanks')||'');
    if(result.holeRanks&&!holeCardFields.some(key=>Object.hasOwn(current,key)))for(const key of holeCardFields)delete result[key];
  }
  return result;
}
// The app delegates clicks to this helper, then applies the normal record form.
// Only these declared values become filters; no page state or private cards are read.
export function applyHolePreset(form,preset) {
  if(!form||form.dataset.recordKind!=='hands')return false;
  if(!STARTING_HAND_PRESETS.some(p=>p.id===preset?.holePreset))return false;
  const fields=Object.keys(holeDefaults).map(name=>form.elements.namedItem(name));
  if(fields.some(field=>!field))return false;
  for(const [name,value]of Object.entries(holeDefaults))form.elements.namedItem(name).value=name==='holePreset'?preset.holePreset:value;
  const custom=form.querySelector?.('[data-record-disclosure="hole-custom"]');if(custom)custom.open=false;
  updateHoleDraft(form);
  return true;
}
// Input edits only update the draft. Restoring a draft calls this without a
// target so an already-selected preset is never accidentally cleared.
export function updateHoleDraft(form,target) {
  if(form?.dataset?.recordKind!=='hands'||target&&!holeCustomFields.includes(target.name))return;
  const presetField=form.elements?.namedItem('holePreset');if(!presetField)return;
  if(target)presetField.value='all';
  const input=Object.fromEntries(Object.keys(holeDefaults).map(name=>[name,form.elements.namedItem(name)?.value??holeDefaults[name]]));
  const presentation=holePresentation(input),selected=presentation.custom||presentation.error?'':presentation.value.holePreset;
  const replace=(selector,text)=>{const node=form.querySelector?.(selector);if(node)node.textContent=text;};
  replace('[data-hole-summary]',presentation.summary);
  replace('[data-hole-preview]',presentation.error||presentation.summary);
  replace('[data-hole-description]',presentation.custom?'点数、花色都可留空，两张牌的顺序不限。':presentation.description);
  const preview=form.querySelector?.('[data-hole-preview]');preview?.classList?.toggle('invalid',Boolean(presentation.error));
  const help=form.querySelector?.('[data-hole-draft-help]');if(help)help.textContent=target?'自定义条件尚未应用，点下方“筛选”生效。':'选择常用牌型可直接筛选；自定义后点下方“筛选”。';
  for(const element of form.querySelectorAll?.('[data-action="record-hole-preset"]')||[]){
    const active=element.dataset.holePreset===selected;element.setAttribute?.('aria-pressed',String(active));element.classList?.toggle('selected',active);element.classList?.toggle('ghost',!active);
  }
}
export function recordFilterKey(state) {
  return JSON.stringify({filters:{...defaultRecordFilters(),...state.filters},room:state.room||'',scope:state.scope||'',view:state.scope==='table'?'hands':state.view||'hands',favorites:Boolean(state.favorites)});
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
  updateHoleDraft(form);
}
function filterSummary(kind,state) {
  const f={...defaultRecordFilters(),...state.filters},labels=[];
  const result={win:'盈利',loss:'亏损',even:'持平',winOver:`赢超过 ${f.minBB} BB`,lossOver:`输超过 ${f.minBB} BB`}[f.result];if(result)labels.push(result);
  if(kind==='hands'){
    const hole=holePresentation(state.filters);if(hole.custom||hole.value.holePreset!=='all')labels.push(hole.summary);
    if(f.type!=='all')labels.push(f.type==='bomb'?'炸弹池':'普通德州');
    if(state.scope!=='table')labels.push(...personalFilterLabels(state));
  }else if(f.status!=='all')labels.push(f.status==='closed'?'已结束':'未结束');
  if(kind==='hands'&&String(f.handNumber||'').trim())labels.push(`第 ${f.handNumber} 手`);
  if(kind!=='hands'&&String(f.q||'').trim())labels.push('含搜索词');
  return labels.length?labels.join(' · '):'全部手牌';
}
function roomChoices(rooms,selected) {
  const timestamp=room=>{const value=room.startedAt??room.createdAt;if(!value)return 0;const time=Number(new Date(value));return Number.isFinite(time)?time:0;};
  const choices=[...rooms].sort((a,b)=>timestamp(b)-timestamp(a)).map(room=>({...room,label:[room.name||'未命名对局',timestamp(room)?dateLabel(timestamp(room)):''].filter(Boolean).join(' · ')}));
  if(selected&&!choices.some(room=>room.code===selected))choices.unshift({code:selected,label:'已选择的对局'});
  const counts=new Map();for(const room of choices)counts.set(room.label,(counts.get(room.label)||0)+1);
  return choices.map(room=>({...room,label:room.label+(counts.get(room.label)>1?` · 房间 ${room.code}`:'')}));
}
function startingHandControls(filters,option) {
  const hole=holePresentation(filters),f=hole.value,active=hole.custom||hole.error?'':f.holePreset;
  const rankOptions=current=>[['','不限点数'],...['A','K','Q','J','T','9','8','7','6','5','4','3','2'].map(rank=>[rank,rank==='T'?'10':rank])].map(([v,l])=>option(v,l,current)).join('');
  const suitOptions=current=>[['','不限花色'],['s','♠ 黑桃'],['h','♥ 红桃'],['d','♦ 方块'],['c','♣ 梅花'],['red','红色 ♥ ♦'],['black','黑色 ♠ ♣']].map(([v,l])=>option(v,l,current)).join('');
  return `<details class="record-hole-options" data-record-disclosure="hole" ${hole.custom||f.holePreset!=='all'?'open':''}>
    <summary>起手牌条件 <span data-hole-summary>${escape(hole.summary)}</span></summary>
    <input type="hidden" name="holePreset" value="${escape(f.holePreset)}">
    <div class="record-hole-presets" role="group" aria-label="常用起手牌">${STARTING_HAND_PRESETS.map(p=>button(p.label,'record-hole-preset',`data-kind="hands" data-hole-preset="${escape(p.id)}" title="${escape(p.description)}" aria-pressed="${active===p.id}"`,active===p.id?'selected small':'ghost small')).join('')}</div>
    <p class="record-hole-description" data-hole-description>${escape(hole.custom?'点数、花色都可留空，两张牌的顺序不限。':hole.description)}</p>
    <details class="record-hole-custom" data-record-disclosure="hole-custom" ${hole.custom?'open':''}>
      <summary>自定义两张牌 <span>点数、花色可选填</span></summary>
      <div class="record-hole-cards">${[1,2].map(n=>`<fieldset class="record-hole-card"><legend>第 ${n} 张牌</legend><label class="field">点数<select name="holeRank${n}" aria-label="第 ${n} 张牌点数">${rankOptions(f['holeRank'+n])}</select></label><label class="field">花色 / 颜色<select name="holeSuit${n}" aria-label="第 ${n} 张牌花色或颜色">${suitOptions(f['holeSuit'+n])}</select></label></fieldset>`).join('')}</div>
      <label class="field record-hole-type">两张牌的关系<select name="holeType">${[['all','不限关系'],['pair','口袋对 · 两张点数相同'],['suited','同花 · 花色相同、非对子'],['offsuit','杂色 · 花色不同、非对子']].map(([v,l])=>option(v,l,f.holeType)).join('')}</select></label>
      <p class="record-filter-help">各项条件需同时满足；前后顺序不限。只筛自己的两张底牌。</p>
    </details>
    <div class="record-hole-preview"><span>已选条件</span><strong data-hole-preview aria-live="polite" class="${hole.error?'invalid':''}">${escape(hole.error||hole.summary)}</strong><small data-hole-draft-help>选择常用牌型可直接筛选；自定义后点下方“筛选”。</small></div>
  </details>`;
}
export function recordFilters(kind,state,rooms=[]) {
  const f={...defaultRecordFilters(),...state.filters},hands=kind==='hands',table=hands&&state.scope==='table',prefix=hands?'hand-records':'session-records';
  const availableRooms=roomChoices(rooms,state.room);
  const option=(value,label,current)=>`<option value="${escape(value)}" ${value===current?'selected':''}>${escape(label)}</option>`;
  const summary=filterSummary(kind,state),filtered=summary!=='全部手牌';
  const dateFields=table?'':`<section class="record-date-group" aria-label="筛选日期"><div class="record-periods" role="group" aria-label="日期范围">${[['all','全部日期'],['today','今天'],['3','近 3 天'],['7','近 7 天'],['30','近 30 天'],['custom','自选日期']].map(([value,label])=>button(label,'record-period',`data-kind="${kind}" data-period="${value}" aria-pressed="${f.period===value}"`,f.period===value?'selected small':'ghost small')).join('')}</div>${f.period==='custom'?`<div class="record-date-fields"><label class="field">开始日期<input type="date" name="from" value="${escape(f.from)}"></label><label class="field">结束日期<input type="date" name="to" value="${escape(f.to)}"></label><p class="record-date-note">开始或结束可留空；按本地日期筛选。</p></div>`:''}</section>`;
  const resultOptions=[['all','全部结果'],['win','盈利'],['loss','亏损'],['even','持平'],['winOver','赢超过 N BB'],['lossOver','输超过 N BB']];
  const results=`<div class="record-result-group"><label class="field">${hands?'我的整手盈亏':'我的盈亏'}<select name="result" data-record-auto="1">${resultOptions.map(([v,l])=>option(v,l,f.result)).join('')}</select>${hands?'<small class="record-result-help">含本手小游戏</small>':''}</label>${`<label class="field record-bb-threshold">超过多少 BB（固定阈值）<input type="text" name="minBB" inputmode="decimal" maxlength="13" aria-label="超过多少 BB" value="${escape(f.minBB)}"><small>按${hands?'每手':'每桌'}大盲折算，严格大于此数；填写后点筛选。</small></label>`}</div>`;
  const roomField=hands&&!table?`<label class="field record-room-field">选择对局<select name="room" id="library-room" data-record-auto="1"><option value="">全部对局</option>${availableRooms.map(r=>option(r.code,r.label,state.room)).join('')}</select></label>`:'';
  const typeField=hands?`<label class="field">玩法<select name="type" data-record-auto="1">${[['all','全部玩法'],['holdem','普通德州'],['bomb','炸弹池']].map(([v,l])=>option(v,l,f.type)).join('')}</select></label>`:`<label class="field">状态<select name="status" data-record-auto="1">${[['all','全部状态'],['active','未结束'],['closed','已结束']].map(([v,l])=>option(v,l,f.status)).join('')}</select></label>`;
  const hole=hands?startingHandControls(state.filters,option):'';
  const personalLabels=personalFilterLabels(state),opponents=state.opponentOptions||[],availableOpponents=f.opponent&&!opponents.some(p=>p.id===f.opponent)?[{id:f.opponent,name:'已选择的对手'},...opponents]:opponents;
  const personal=hands&&!table?`<details class="record-personal-options" data-record-disclosure="personal" ${personalLabels.length?'open':''}><summary>对手与牌局条件 <span>${escape(personalLabels.join(' · ')||'不限')}</span></summary><div class="record-personal-fields"><label class="field record-opponent-field">遇到的对手<select name="opponent" data-record-auto="1">${option('','全部对手',f.opponent)}${availableOpponents.map(p=>option(p.id,p.name,f.opponent)).join('')}</select></label><label class="field">我的位置<select name="position" data-record-auto="1">${positionOptions.map(([v,l])=>option(v,l,f.position)).join('')}</select></label><label class="field">翻后底池<select name="potType" data-record-auto="1">${potTypeOptions.map(([v,l])=>option(v,l,f.potType)).join('')}</select></label><label class="field">发牌人数<select name="tableSize" data-record-auto="1">${tableSizeOptions.map(([v,l])=>option(v,l,f.tableSize)).join('')}</select></label><label class="field record-sample-field">统计手数<select name="maxHands" data-record-auto="1">${maxHandsOptions.map(([v,l])=>option(v,l,String(f.maxHands))).join('')}${f.maxHands!=='all'&&!maxHandsOptions.some(([v])=>v===String(f.maxHands))?option(String(f.maxHands),`最近 ${number(f.maxHands)} 手`,String(f.maxHands)):''}</select></label></div><p class="record-filter-help">翻后人数按翻牌首次发出时计算，且你仍在牌中；3 人池后续变成 2 人，仍算多人池。选了对手时，翻后筛选要求双方都进入翻牌。</p><p class="record-filter-help">位置按每手实际发牌人数计算；双人桌庄位兼小盲。先匹配全部条件，再取最近手数。</p></details>`:'';
  const search=`<div class="record-search-row"><label class="field record-search-field" for="${prefix}-search">${hands?'找第几手':'搜索对局名称'}<input id="${prefix}-search" name="${hands?'handNumber':'q'}" type="${hands?'text':'search'}" ${hands?'inputmode="numeric" maxlength="16" aria-describedby="'+prefix+'-search-help"':'maxlength="80"'} placeholder="${hands?'例如 12，留空看全部':'输入对局名称'}" value="${escape(hands?f.handNumber:f.q)}"></label><button type="submit" class="outline small">筛选</button>${button('重置','record-reset',`data-kind="${kind}"`,'ghost small')}${hands?`<p id="${prefix}-search-help" class="record-search-help">每场从 1 计数${table?'。':'；可先选择对局，再找其中某一手。'}</p>`:''}</div>`;
  const fields=`${dateFields}<div class="record-filter-row">${results}${roomField}${typeField}</div>${personal}${hole}${search}`;
  return `<form id="${prefix}-filter-form" class="record-filters ${hands?'hand-record-filters':''} ${table?'table-record-filters':''}" data-record-kind="${kind}" data-record-key="${escape(recordFilterKey(state))}">${table?`<details class="record-table-options" data-record-disclosure="table" ${filtered?'open':''}><summary>筛选 <span>${escape(summary)}</span></summary><div class="record-table-fields">${fields}</div></details>`:`${fields}${hands?`<p class="record-filter-summary" aria-label="当前筛选条件">${escape(summary)}</p>`:''}`}</form>`;
}
export function opponentFilters(state,rooms=[]) {
  const f={...defaultRecordFilters(),...state.filters},option=(value,label,current)=>`<option value="${escape(value)}" ${value===current?'selected':''}>${escape(label)}</option>`;
  const types=[['all','全部玩法'],['holdem','普通德州'],['bomb','炸弹池']],labels=[];
  for(const [key,options]of [['position',positionOptions],['type',types],['tableSize',tableSizeOptions]])if(f[key]!=='all')labels.push(options.find(([value])=>value===f[key])?.[1]||'已选择');
  const dates=`<section class="record-date-group" aria-label="筛选日期"><div class="record-periods" role="group" aria-label="日期范围">${[['all','全部日期'],['today','今天'],['3','近 3 天'],['7','近 7 天'],['30','近 30 天'],['custom','自选日期']].map(([value,label])=>button(label,'record-period',`data-kind="hands" data-period="${value}" aria-pressed="${f.period===value}"`,f.period===value?'selected small':'ghost small')).join('')}</div>${f.period==='custom'?`<div class="record-date-fields"><label class="field">开始日期<input type="date" name="from" value="${escape(f.from)}"></label><label class="field">结束日期<input type="date" name="to" value="${escape(f.to)}"></label><p class="record-date-note">开始或结束可留空；按本地日期筛选。</p></div>`:''}</section>`;
  return `<form id="hand-records-filter-form" class="record-filters opponent-filters" data-record-kind="hands" data-record-key="${escape(recordFilterKey(state))}">${dates}<div class="opponent-filter-main"><label class="field">选择对局<select name="room" data-record-auto="1">${option('','全部对局',state.room||'')}${roomChoices(rooms,state.room).map(room=>option(room.code,room.label,state.room)).join('')}</select></label><div class="opponent-filter-actions"><button type="submit" class="outline small">筛选</button>${button('重置','record-reset','data-kind="hands"','ghost small')}</div></div><details class="record-personal-options opponent-filter-more" data-record-disclosure="opponent-options" ${labels.length?'open':''}><summary>更多条件 <span>${escape(labels.join(' · ')||'位置、玩法、发牌人数')}</span></summary><div class="opponent-filter-fields"><label class="field">我的位置<select name="position" data-record-auto="1">${positionOptions.map(([v,l])=>option(v,l,f.position)).join('')}</select></label><label class="field">玩法<select name="type" data-record-auto="1">${types.map(([v,l])=>option(v,l,f.type)).join('')}</select></label><label class="field">发牌人数<select name="tableSize" data-record-auto="1">${tableSizeOptions.map(([v,l])=>option(v,l,f.tableSize)).join('')}</select></label></div></details></form>`;
}
export function handContextChips(hand) {
  if(hand.participated===false)return '';
  const tags=[];
  if(hand.position)tags.push([hand.position==='unknown'?'位置未记录':hand.position,'position']);
  const potLabels={headsUp:'翻后单挑',multiway:Number(hand.flopPlayers)>=3?`翻后 ${number(hand.flopPlayers)} 人池`:'翻后多人池',noFlop:'未进翻牌',unknown:'翻后人数未记录'};
  if(potLabels[hand.potType])tags.push([potLabels[hand.potType],hand.potType]);
  if(Number.isInteger(hand.tableSize)&&hand.tableSize>=2)tags.push([`${number(hand.tableSize)} 人发牌`,'size']);
  return tags.length?`<div class="hand-context-chips">${tags.map(([label,tone])=>`<span class="context-chip context-${tone}">${escape(label)}</span>`).join('')}</div>`:'';
}
const aggregate = (points, bb) => formatAggregate(points, bb, { signed: true });
const moneyTone = (points, bb) => profit(getDisplayUnit()==='bb'?bb:points);
const coveredBB = (value, known, total) => Number(known) === Number(total) ? value : null;
const opponentSortOptions=[['hands','手数最多'],['profit','我的盈利最多'],['loss','我的亏损最多'],['recent','最近交手']];
const opponentMode=value=>value==='headsUp'?'headsUp':'all';
function opponentValue(row) {
  const value=getDisplayUnit()==='bb'?coveredBB(row.netBB,row.bbHands,row.hands):row.net;
  return value!=null&&Number.isFinite(Number(value))?Number(value):null;
}
function opponentRows(data,sort,search) {
  const term=String(search||'').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const rows=[...(data.rows||[])].filter(row=>!term||String(row.name||'').normalize('NFKC').toLocaleLowerCase('zh-CN').includes(term));
  const recent=row=>{const time=Number(new Date(row.lastAt));return Number.isFinite(time)?time:0;};
  const sorters={hands:(a,b)=>b.hands-a.hands,profit:(a,b)=>Number(opponentValue(b))-Number(opponentValue(a)),loss:(a,b)=>Number(opponentValue(a))-Number(opponentValue(b)),recent:(a,b)=>recent(b)-recent(a)};
  rows.sort((a,b)=>((sort==='profit'||sort==='loss')?(Number(opponentValue(a)===null)-Number(opponentValue(b)===null)):0)||(sorters[sort]||sorters.hands)(a,b)||b.hands-a.hands||String(a.id).localeCompare(String(b.id)));
  return rows;
}
export function opponentResultList(data,sort='hands',options={}) {
  if(!data)return '';
  const search=String(options.search||''),rows=opponentRows(data,sort,search),mode=opponentMode(options.mode),useBB=getDisplayUnit()==='bb';
  if(!(data.rows||[]).length)return `<div class="opponent-empty"><span aria-hidden="true">♧</span><h3>${mode==='headsUp'?'暂无翻后单挑记录':'暂无共同手牌记录'}</h3><p>${mode==='headsUp'?'当前条件下，还没有你与朋友单独进入翻牌的记录。':'调整日期或对局，或和朋友完成一手后再来看。'}</p>${button('清除筛选','record-reset','data-kind="hands"')}</div>`;
  if(!rows.length)return `<div class="opponent-empty"><h3>没有找到这位朋友</h3><p>当前筛选范围内，没有昵称包含“${escape(search.trim())}”的朋友。</p>${button('清除搜索','library-opponent-clear-search')}</div>`;
  const heading=search.trim()?`找到 ${number(rows.length)} 位朋友`:mode==='headsUp'?'朋友 · 单挑手数':'朋友 · 共同手数';
  return `<div class="opponent-list-heading"><span>${heading}</span><span>这些手牌里我的盈亏</span></div><div class="opponent-list">${rows.map(row=>{
    const bb=coveredBB(row.netBB,row.bbHands,row.hands),shown=opponentValue(row),missingBB=useBB&&shown===null,name=String(row.name||'朋友'),last=row.lastAt?dateLabel(row.lastAt):'';
    const avatar=typeof options.avatar==='function'?options.avatar(row):`<span class="opponent-avatar-fallback" aria-hidden="true">${escape(Array.from(name)[0]||'友')}</span>`;
    const coverage=missingBB?`<small class="opponent-row-coverage">${Number(row.bbHands)>0?`${number(row.bbHands)} / ${number(row.hands)} 手可折算`:'缺少历史大盲'}</small>`:'';
    return `<button type="button" class="opponent-open" data-action="library-opponent" data-opponent="${escape(row.id)}" aria-label="查看与 ${escape(name)} 的${mode==='headsUp'?'翻后单挑':'共同手牌'}牌谱"><span class="opponent-avatar">${avatar}</span><span class="opponent-identity"><strong title="${escape(name)}">${escape(name)}</strong><small class="opponent-meta" ${last?`title="最近交手 ${escape(last)}"`:''}>${mode==='headsUp'?'单挑':'共同'} ${number(row.hands)} 手${last?`<span> · ${escape(last)}</span>`:''}</small></span><span class="opponent-profit"><b class="${profit(shown)}">${escape(aggregate(row.net,bb))}</b>${coverage}</span><span class="opponent-open-arrow" aria-hidden="true">→</span></button>`;
  }).join('')}</div>`;
}
export function opponentRecords(data,sort='hands',options={}) {
  if(!data)return '';
  const mode=opponentMode(options.mode),selected=opponentSortOptions.some(([value])=>value===sort)?sort:'hands',rows=data.rows||[],search=String(options.search||'');
  const modes=`<div class="opponent-mode-tabs segmented" role="group" aria-label="交手范围">${[['all','同桌手牌'],['headsUp','翻后单挑']].map(([value,label])=>button(label,'library-opponent-mode',`data-mode="${value}" aria-pressed="${mode===value}"`,mode===value?'active':'')).join('')}</div>`;
  const summary=`<p class="opponent-scope-summary"><strong>${number(rows.length)} 位朋友</strong><span> · ${number(data.uniqueHands)} 手已去重</span></p>`;
  const controls=`<div class="opponent-controls"><label class="field opponent-search">找朋友<input type="search" data-opponent-search maxlength="80" placeholder="搜索昵称" value="${escape(search)}" autocomplete="off"></label><label class="field opponent-sort">排序<select data-opponent-sort>${opponentSortOptions.map(([value,label])=>`<option value="${value}" ${value===selected?'selected':''}>${label}</option>`).join('')}</select></label></div>`;
  const rules=`<details class="opponent-method"><summary>统计怎么算</summary><p>只统计你和对方都获发底牌的手，不包含观战。金额是你在这些手牌中的德州净盈亏，包含炸弹池，不含鱿鱼等小游戏；同一手可能出现在多位朋友名下，各行不可相加。</p><p>“翻后单挑”要求你和对方在翻牌首次发出时是仅剩的两人。3 人进入翻牌后再变成 2 人，仍不算单挑。盈亏按整手计算，可能包含其他玩家翻前留下的积分。</p><p>BB 按每手当时的大盲分别折算后相加，不能用累计积分除以某一个大盲。缺少大盲记录时显示 —，切换积分可看完整金额。搜索昵称和排序只调整当前列表，不改变统计范围。</p></details>`;
  return `<section class="opponent-records" aria-label="我的对手战绩">${modes}${summary}<p class="opponent-explanation">这些金额是你在双方共同参与的手牌中的输赢，并非直接从对方赢得。</p>${controls}<div data-opponent-results>${opponentResultList(data,selected,{...options,mode,search})}</div>${rules}</section>`;
}
export function recordTotals(totals,kind) {
  if(!totals)return '';
  return `<div class="record-totals" aria-label="当前筛选汇总"><div><small>${kind==='hands'?'符合条件手数':'符合条件场次'}</small><strong>${number(totals.count)}</strong></div><div><small>我的净盈亏</small><strong class="${moneyTone(totals.net,totals.bb?.net)}">${aggregate(totals.net,totals.bb?.net)}</strong></div><div><small>德州</small><strong class="${moneyTone(totals.holdemNet,totals.bb?.holdemNet)}">${aggregate(totals.holdemNet,totals.bb?.holdemNet)}</strong></div><div><small>小游戏</small><strong class="${moneyTone(totals.miniNet,totals.bb?.miniNet)}">${aggregate(totals.miniNet,totals.bb?.miniNet)}</strong></div></div>${getDisplayUnit()==='bb'&&totals.bb?.complete===false?'<p class="note">部分记录缺少历史大盲，无法完整折算的汇总显示 —；切换积分查看完整金额。</p>':''}`;
}
export function sessionRow(session) {
  return `<button type="button" class="session-record" data-action="session-detail" data-code="${escape(session.code)}"><span class="session-record-info"><strong>${escape(session.name)}</strong><small>${escape(dateLabel(session.at))} · ${session.status==='closed'?'已结束':'未结束'} · ${number(session.handCount)} 手</small><small>${number(session.playerCount)} 人 · 盲注 ${formatChips(session.smallBlind,session.bigBlind,{unitLabel:false})} / ${formatChips(session.bigBlind,session.bigBlind)}</small></span><span class="session-record-result"><b class="${moneyTone(session.meNet,session.meNetBB)}">${aggregate(session.meNet,session.meNetBB)}</b><small>我的净盈亏</small><small>查看全桌 →</small></span></button>`;
}
export function sessionDetail(session,meId) {
  const players=[...(session.players||[])].sort((a,b)=>Number(b.net)-Number(a.net));
  return `<div class="session-detail-heading"><p class="note">${escape(dateLabel(session.at))} · ${session.status==='closed'?'已结束':'未结束'} · ${number(session.handCount)} 手 · 盲注 ${formatChips(session.smallBlind,session.bigBlind,{unitLabel:false})} / ${formatChips(session.bigBlind,session.bigBlind)}</p>${session.handInProgress?'<p class="note">当前一手还在进行，以下只统计已结算手牌。</p>':''}</div><div class="session-player-list">${players.map(p=>`<article class="session-player"><div class="session-player-title"><strong>${escape(p.name)}${p.id===meId?' <span class="you-tag">我</span>':''}</strong><b class="${moneyTone(p.net,p.netBB)}">${aggregate(p.net,p.netBB)}</b></div><div class="session-player-breakdown"><span>德州 <b class="${moneyTone(p.holdemNet,p.holdemNetBB)}">${aggregate(p.holdemNet,p.holdemNetBB)}</b></span><span>小游戏 <b class="${moneyTone(p.miniNet,p.miniNetBB)}">${aggregate(p.miniNet,p.miniNetBB)}</b></span></div><small>${number(p.hands)} 手 · 累计带入 ${formatAggregate(p.totalBuyIn,p.totalBuyInBB)}</small>${getDisplayUnit()==='bb'&&(p.bbComplete===false||p.totalBuyInBB===null)?'<small>部分历史金额缺少大盲，可切换积分查看完整记录。</small>':''}</article>`).join('')}</div><p class="privacy-footnote">净盈亏不包含带入、补码和离桌取回。${session.adjustments?'小游戏包含旧蘑菇池退回记录。':''}${session.squidSettlementCount?`本场你的小游戏包含 ${number(session.squidSettlementCount)} 笔鱿鱼结算；手外结算不增加手数。`:''}</p><div class="modal-footer">${button('返回对局','sessions','', 'ghost')}${button('本场牌谱','session-hands',`data-code="${escape(session.code)}"`,'primary')}</div>`;
}
