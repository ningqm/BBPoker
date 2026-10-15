import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import * as statsUI from '../public/stats.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDisplayUnit, formatChips, formatAggregate, getDisplayUnit, unitLabel } from '../public/money.js';
test.beforeEach(() => setDisplayUnit('points'));
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import * as records from '../public/records.js';
import {formatHandBB} from '../public/hand-overview.js';
import {createRequestGuard} from '../public/platform.js';
import {historyBoard} from '../public/replay.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function harness({dom=false,realCards=false}={}){
  const calls=[],modals=[],toasts=[],navigations=[],events={};let client;
  const documentRef={currentForm:null,activeElement:null,querySelector(selector){return this.currentForm&&selector==='#'+this.currentForm.id?this.currentForm:null;},addEventListener(name,callback){events[name]=callback;}};
  function rebuild(kind){
    if(!dom)return;if(documentRef.currentForm)documentRef.currentForm.isConnected=false;
    const list=kind==='hands'?client.state.library:client.state.sessions,fields=['q','from','to'].map(name=>({name,value:list.filters?.[name]||'',type:name==='q'?'search':'date',selectionStart:2,selectionEnd:2,focus(){documentRef.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}}));fields.namedItem=name=>fields.find(field=>field.name===name);
    const form={id:kind==='hands'?'hand-records-filter-form':'session-records-filter-form',dataset:{recordKind:kind,recordKey:records.recordFilterKey(list)},isConnected:true,elements:fields,contains:field=>fields.includes(field)};for(const field of fields)field.form=form;documentRef.currentForm=form;
  }
  const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,statsUI,records,formatHandBB,formatChips,formatAggregate,getDisplayUnit,unitLabel,createRequestGuard,historyBoard,URLSearchParams,Date,Set,Map,FormData:class extends URLSearchParams{constructor(form){super(Array.from(form.elements||[]).filter(f=>f.name).map(f=>[f.name,f.value]));}},
    api(path){return new Promise((resolve,reject)=>calls.push({path,resolve,reject}));},document:dom?documentRef:undefined,app:{contains:()=>client.state.page!=='room'},render(){if(client.state.page==='hands'||client.state.page==='sessions')rebuild(client.state.page);},
    openModal(title,body,kind){client.state.modal={kind,title};modals.push({title,body,kind});if(kind==='hand-library')rebuild('hands');if(kind==='session-list')rebuild('sessions');},closeModal(){client.state.modal=null;},
    toast(message){toasts.push(message);},navigate(path){navigations.push(path);},
    avatar:()=>'',avatarCache:{hydrate(){}},num:n=>String(n||0),signed:n=>`${n>0?'+':''}${n||0}`,profitClass:()=>'',fmtDate:String,cards:()=>'',card:()=>'',
    btn:(label,action,cls='',attrs='')=>`<button data-action="${action}" class="${cls}" ${attrs}>${label}</button>`,renderReplay(){},
  });
  vm.runInContext(['const requests=createRequestGuard();',section('const state=','const num='),...(realCards?[section('const card=','const feedback=')]:[]),section('function finishComposition(', 'function flushTableFeedback('),
    section('function renderHandLibrary(','const layouts='),...(dom?[section("document.addEventListener('compositionstart'","document.addEventListener('input'")]:[]),'globalThis.client={state,requests,loadLibrary,handLibrary,loadSessions,sessionLibrary,sessionDetailModal,openHandLibrary,openSessions,handSummary,handLibraryContent,applyRecordFilters,setRecordPeriod,resetRecordFilters,setLibraryView,setOpponentMode,sortLibraryOpponents,searchLibraryOpponents,clearOpponentSearch,selectLibraryOpponent,loadOpponents,opponentLibrary,openOpponentHands,sortDirectOpponents};'].join('\n'),context);
  client=context.client;client.state.user={id:'me',name:'me'};client.state.page='hands';return {...client,calls,modals,toasts,navigations,events,document:documentRef};
}
test('custom dates and quick ranges use local day boundaries across timezone and calendar changes',()=>{
  const moduleUrl=new URL('../public/records.js',import.meta.url).href;
  const code=`import {recordDateRange} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify([recordDateRange({period:'custom',from:'2026-10-13',to:'2026-10-13'}),recordDateRange({period:'7'},new Date(2026,0,2,12)),recordDateRange({period:'today'},new Date(2026,9,13,12))]));`;
  const [custom,week,today]=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TZ:'Asia/Shanghai'},encoding:'utf8'}));
  assert.deepEqual(custom,{from:'2026-10-12T16:00:00.000Z',to:'2026-10-13T15:59:59.999Z'});assert.equal(week.from,'2025-12-26T16:00:00.000Z');assert.equal(week.to,'2026-01-02T15:59:59.999Z');assert.deepEqual(today,custom);
  for(const filters of [{period:'custom',from:'2026-02-30'},{period:'custom',from:'2026-10-14',to:'2026-10-13'},{period:'custom'},{period:'bad'}])assert.throws(()=>records.recordDateRange(filters));
});
test('query resets discard old cursors while keeping current filters; hand and session options stay separate',()=>{
  const state={clock:createRoomClock(),filters:{period:'all',result:'loss',q:'  朋友局  ',handNumber:'12',type:'bomb',status:'closed'},favorites:true,room:'123456',nextCursor:'old-page'};
  const hand=records.recordQuery('hands',state,true);assert.equal(hand.get('before'),null);assert.equal(hand.get('favorites'),'1');assert.equal(hand.get('room'),'123456');assert.equal(hand.get('type'),'bomb');assert.equal(hand.get('result'),'loss');assert.equal(hand.get('q'),null);assert.equal(hand.has('handNumber'),false);assert.equal(hand.has('status'),false);
  const sessions=records.recordQuery('sessions',state);assert.equal(sessions.get('before'),'old-page');assert.equal(sessions.get('status'),'closed');assert.equal(sessions.get('q'),'朋友局');assert.equal(sessions.has('handNumber'),false);assert.equal(sessions.has('favorites'),false);assert.equal(sessions.has('type'),false);
});
test('record markup escapes names and filters while displaying server totals, separate mini net and no private fields',()=>{
  const evil='<img src=x onerror=alert(1)>',totals=records.recordTotals({count:120,net:12,holdemNet:9,miniNet:3},'hands');assert.match(totals,/120/);assert.match(totals,/\+12/);
  for(const html of [records.recordFilters('sessions',{filters:{q:evil}}),records.sessionRow({code:'123456',name:evil,at:'2026-10-13T00:00:00Z',meNet:-20}),records.sessionDetail({players:[{id:'a',name:evil,net:20,holdemNet:15,miniNet:5,totalBuyIn:1000,cards:['As','Ah']}],handInProgress:true},'a')]){assert.doesNotMatch(html,/<img|onerror="|As|Ah/);assert.match(html,/&lt;img/);}
  assert.match(records.sessionDetail({players:[],handInProgress:true},'a'),/只统计已结算手牌/);
});
test('switching date and result filters rejects old hand data and old aggregate totals',async()=>{
  const c=harness(),old=c.loadLibrary(true);c.state.library.filters={period:'all',result:'win',type:'bomb'};const fresh=c.loadLibrary(true);
  c.calls[1].resolve({hands:[{id:'new',net:7}],totals:{count:30,net:70},nextCursor:'new-page'});await fresh;
  c.calls[0].resolve({hands:[{id:'old',net:-4}],totals:{count:400,net:-999},nextCursor:'old-page'});await old;
  assert.equal(c.state.library.hands[0].id,'new');assert.equal(c.state.library.totals.net,70);assert.equal(c.state.library.nextCursor,'new-page');assert.match(c.calls[1].path,/result=win/);assert.match(c.calls[1].path,/type=bomb/);
});
test('session pagination cannot append stale rows after a newer filter, and totals cover all server matches',async()=>{
  const c=harness();c.state.page='sessions';c.state.sessions.rows=[{code:'111111'}];c.state.sessions.nextCursor='cursor';const old=c.loadSessions();
  c.state.sessions.filters={period:'all',result:'loss',status:'closed'};const fresh=c.loadSessions(true);
  c.calls[1].resolve({sessions:[{code:'333333'}],totals:{count:40,net:-120},nextCursor:'new'});await fresh;c.calls[0].resolve({sessions:[{code:'222222'}],totals:{count:2,net:10},nextCursor:null});await old;
  assert.equal(c.state.sessions.rows.length,1);assert.equal(c.state.sessions.rows[0].code,'333333');assert.equal(c.state.sessions.totals.count,40);assert.equal(c.state.sessions.nextCursor,'new');assert.match(c.calls[1].path,/status=closed/);
});
test('identity changes and closing a detail modal cannot expose a late session result',async()=>{
  const c=harness(),request=c.sessionDetailModal('123456');c.requests.invalidate();c.state.modal=null;c.calls[0].resolve({session:{name:'old private name',players:[]}});await request;assert.equal(c.modals.length,1);
  const old=c.sessionDetailModal('123456'),fresh=c.sessionDetailModal('654321');c.calls[2].resolve({session:{name:'<script>new</script>',players:[]}});await fresh;c.calls[1].resolve({session:{name:'old private name',players:[]}});await old;
  assert.equal(c.modals.at(-1).title,'&lt;script&gt;new&lt;/script&gt;');assert.equal(c.state.modal.kind,'session-detail');
});
test('table hand filters stay in a modal and use the authorized room-history API, including observed hand labels',async()=>{
  const c=harness();c.state.page='room';c.state.room={code:'123456'};const pending=c.openHandLibrary('123456','table');assert.equal(c.state.modal.kind,'hand-library');assert.match(c.calls[0].path,/^\/api\/rooms\/123456\/history\?limit=20/);assert.doesNotMatch(c.calls[0].path,/room=/);
  c.calls[0].resolve({hands:[{id:'observed',roomCode:'123456',participated:false,totalNet:0}],totals:{count:1,net:0},nextCursor:null});await pending;
  assert.equal(c.state.page,'room');assert.equal(c.state.room.code,'123456');assert.match(c.modals.at(-1).body,/观战/);assert.doesNotMatch(c.handSummary(c.state.library.hands[0]),/data-action="favorite"/);
  assert.doesNotMatch(c.modals.at(-1).body,/name="(?:from|to|room)"|data-action="record-period"/);
  assert.match(c.modals.at(-1).body,/data-history-turn/);assert.match(c.modals.at(-1).body,/返回牌桌/);
  assert.match(c.handSummary(c.state.library.hands[0]),/data-action="hand-overview"/);assert.doesNotMatch(c.handSummary(c.state.library.hands[0]),/data-action="replay"/);
});

test('static hand cards show net BB and preserve absent-player squid settlements',()=>{
  setDisplayUnit('bb');
  const c=harness();
  const won=c.handSummary({id:'won',roomCode:'123456',bigBlind:4,number:8,net:82,miniNet:-2,totalNet:80,pot:200});
  assert.match(won,/data-action="hand-overview"/);assert.match(won,/\+20 BB/);assert.match(won,/德州 \+20\.5 BB · 小游戏 -0\.5 BB/);assert.match(won,/底池 50 BB/);
  const absent=c.handSummary({id:'squid',roomCode:'123456',number:9,bigBlind:2,participated:false,net:0,miniNet:-40,totalNet:-40,pot:20});
  assert.match(absent,/鱿鱼结算/);assert.match(absent,/-20 BB/);assert.doesNotMatch(absent,/观战|data-action="favorite"/);
  const legacy=c.handSummary({id:'legacy',roomCode:'123456',number:1,net:3,pot:10});assert.match(legacy,/— BB/);assert.doesNotMatch(legacy,/NaN|Infinity|undefined BB/);
});

test('actual history row renders public turn and river previews in their board slots while private holes stay hidden',()=>{
  const c=harness({realCards:true}),hand={id:'flop-fold',roomCode:'123456',number:9,bigBlind:10,net:20,pot:100,
    cards:[null,null],board:['2c','3d','4h'],rabbit:{originalCount:3,board:['2c','3d','4h','Js','Qh']}};
  const before=structuredClone(hand),html=c.handSummary(hand),board=html.split(/<div class="record-board"[^>]*>/)[1].split('</div>')[0];
  assert.match(board,/aria-label="♠J"/);assert.match(board,/aria-label="♥Q"/);
  assert.equal((board.match(/rabbit-card/g)||[]).length,2);
  assert.equal((board.match(/aria-label="尚未发出"/g)||[]).length,0);
  assert.equal((html.match(/aria-label="未公开的牌"/g)||[]).length,2);
  assert.match(html,/补看|不计输赢/);assert.deepEqual(hand,before);
  const old=c.handSummary({...hand,rabbit:null}),oldBoard=old.split(/<div class="record-board"[^>]*>/)[1].split('</div>')[0];
  assert.equal((oldBoard.match(/aria-label="尚未发出"/g)||[]).length,2);
  assert.doesNotMatch(oldBoard,/♠J|♥Q/);
});

test('list refreshes preserve unsubmitted drafts and caret without changing applied filters or restoring a different filter',()=>{
  const state={clock:createRoomClock(),filters:{period:'custom',from:'2026-10-01',to:'2026-10-13',q:'applied'},room:'123456'};
  const form=values=>{const fields=Object.entries(values).map(([name,value])=>({name,value,type:'text',selectionStart:2,selectionEnd:4,focused:false,focus(){this.focused=true;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}}));fields.namedItem=name=>fields.find(field=>field.name===name);return{dataset:{recordKey:records.recordFilterKey(state)},elements:fields,contains:field=>fields.includes(field)};};
  const original=form({q:'正在输入的搜索词',from:'2026-10-02',to:'2026-10-12'}),active=original.elements.namedItem('q');const draft=records.captureRecordDraft(original,state,active),fresh=form({q:'applied',from:'2026-10-01',to:'2026-10-13'});
  records.restoreRecordDraft(fresh,state,draft);assert.equal(fresh.elements.namedItem('q').value,'正在输入的搜索词');assert.equal(fresh.elements.namedItem('from').value,'2026-10-02');assert.equal(fresh.elements.namedItem('q').focused,true);assert.equal(fresh.elements.namedItem('q').selectionEnd,4);assert.equal(state.filters.q,'applied');assert.equal(state.filters.from,'2026-10-01');
  state.filters.result='win';const replaced=form({q:'new query'});records.restoreRecordDraft(replaced,state,draft);assert.equal(replaced.elements.namedItem('q').value,'new query');assert.equal(records.captureRecordDraft(original,state,active),null);
});

test('Chinese IME stays attached while modal and page record requests finish, then renders the committed draft',async()=>{
  for(const kind of ['hands','sessions']){
    const c=harness({dom:true});c.state.page=kind==='hands'?'room':'sessions';if(kind==='hands')c.state.modal={kind:'hand-library'};
    const pending=kind==='hands'?c.loadLibrary(true):c.loadSessions(true),form=c.document.currentForm,input=form.elements.namedItem('q');c.document.activeElement=input;
    c.events.compositionstart({target:input});input.value='zhong';const modalCount=c.modals.length;
    c.calls[0].resolve(kind==='hands'?{hands:[],totals:{count:0,net:0},nextCursor:null}:{sessions:[],totals:{count:0,net:0},nextCursor:null});await pending;
    assert.equal(c.document.currentForm,form,'the composing node must not be detached by a response');assert.equal(c.modals.length,modalCount);assert.equal(c.state.recordRenderDeferred,true);
    input.value='中文搜索';if(kind==='sessions')c.state.renderDeferred=true;c.events.compositionend({target:input});
    assert.notEqual(c.document.currentForm,form);assert.equal(c.document.currentForm.elements.namedItem('q').value,'中文搜索');assert.equal(c.state.recordComposition,null);assert.equal(c.state.recordRenderDeferred,false);assert.equal(c.state.renderDeferred,false);assert.equal((kind==='hands'?c.state.library:c.state.sessions).filters.q,undefined);assert.equal(c.calls.length,1);
  }
});


test('session detail distinguishes squid settlements from legacy mushroom refunds and keeps hand counts unchanged',()=>{
  const html=records.sessionDetail({handCount:0,squidSettlementCount:1,adjustments:2,players:[{id:'me',hands:0,net:40,miniNet:40}]},'me');
  assert.match(html,/0 手/);assert.match(html,/1 笔鱿鱼结算/);assert.match(html,/手外结算不增加手数/);assert.match(html,/旧蘑菇池退回/);
});

test('table history ignores every date state and never displays date or room controls',()=>{
  for(const filters of [{period:'custom',from:'2026-02-30',to:'bad'},{period:'7'},{period:'invalid'}]){
    const state={clock:createRoomClock(),scope:'table',room:'123456',filters},query=records.recordQuery('hands',state);
    assert.equal(query.has('from'),false);assert.equal(query.has('to'),false);
    const html=records.recordFilters('hands',state,[{code:'123456',name:'这张桌'}]);
    assert.doesNotMatch(html,/name="(?:from|to|room)"|data-action="record-period"|当前牌桌|日期范围/);
    assert.match(html,/<details class="record-table-options record-main-options" data-record-disclosure="filters">/);
    assert.doesNotMatch(html,/找第几手|每场从 1 计数|name="(?:q|handNumber)"/);
  }
  const personal=records.recordFilters('hands',{scope:'personal',room:'',filters:{period:'custom',from:'2026-10-01',to:'2026-10-13'}});
  assert.match(personal,/name="from"/);assert.match(personal,/name="to"/);assert.match(personal,/name="room"/);assert.match(personal,/近 3 天/);
});

test('BB thresholds use strict greater-than result modes and validate only active hand thresholds',()=>{
  for(const result of ['winOver','lossOver']){
    const query=records.recordQuery('hands',{filters:{result,minBB:'20.50'}});
    assert.equal(query.get('result'),result);assert.equal(query.get('minBB'),'20.5');
    for(const value of ['',-1,'20.001','Infinity','1e3','1000000000.01'])assert.throws(()=>records.recordQuery('hands',{filters:{result,minBB:value}}),/BB 门槛/);
    for(const value of ['0','0.01','1000000000'])assert.doesNotThrow(()=>records.recordQuery('hands',{filters:{result,minBB:value}}));
  }
  assert.equal(records.recordQuery('hands',{filters:{result:'all',minBB:'unfinished'}}).has('minBB'),false);
  const sessionQuery=records.recordQuery('sessions',{filters:{result:'winOver',minBB:'20'}});assert.equal(sessionQuery.get('result'),'winOver');assert.equal(sessionQuery.get('minBB'),'20');
  const html=records.recordFilters('hands',{filters:{result:'lossOver',minBB:'25'}});
  assert.match(html,/value="lossOver" selected/);assert.match(html,/name="minBB"[^>]*value="25"/);assert.match(html,/严格大于此数/);assert.match(html,/输超过 25 BB/);
});

test('legacy starting-card filters migrate to independent ranks without leaking into session queries',()=>{
  const query=records.recordQuery('hands',{filters:{holeRanks:'ak',holeType:'suited',result:'win'}});
  assert.equal(query.get('holeRank1'),'A');assert.equal(query.get('holeRank2'),'K');assert.equal(query.has('holeRanks'),false);assert.equal(query.get('holeType'),'suited');assert.equal(query.get('result'),'win');
  assert.equal(records.recordQuery('hands',{filters:{holeRanks:'A'}}).get('holeRank1'),'A');
  assert.equal(records.recordQuery('hands',{filters:{holeType:'pair'}}).get('holeType'),'pair');
  assert.equal(records.recordQuery('hands',{filters:{holeRanks:'AA',holeType:'pair'}}).get('holeRank2'),'A');
  for(const filters of [{holeRanks:'AKQ'},{holeRanks:'As'},{holeRanks:'<>'},{holeType:'unknown'}])assert.throws(()=>records.recordQuery('hands',{filters}),/起手牌/);
  const sessions=records.recordQuery('sessions',{filters:{holeRanks:'AK',holeType:'suited',minBB:'20'}});
  assert.equal(sessions.has('holeRanks'),false);assert.equal(sessions.has('holeType'),false);assert.equal(sessions.has('minBB'),false);
});

test('quick starting-card choices use declared form values, then custom ranks combine correctly',()=>{
  const fields=new Map(['holePreset','holeRank1','holeSuit1','holeRank2','holeSuit2','holeType'].map(name=>[name,{value:''}]));
  const form={dataset:{recordKind:'hands'},elements:{namedItem:name=>fields.get(name)}};
  assert.equal(records.applyHolePreset(form,{holePreset:'suitedConnector'}),true);
  assert.deepEqual([...fields.values()].map(f=>f.value),['suitedConnector','','','','','all']);
  assert.equal(records.applyHolePreset(form,{holePreset:'pair'}),true);
  assert.deepEqual([...fields.values()].map(f=>f.value),['pair','','','','','all']);
  assert.equal(records.applyHolePreset(form,{holePreset:'<img>'}),false);
  assert.equal(records.applyHolePreset({...form,dataset:{recordKind:'sessions'}},{holePreset:'pair'}),false);
  const filters=records.filterValues(new URLSearchParams({holeRank1:'',holeRank2:'Q',holeType:'offsuit',minBB:'12.5'}),{period:'7'});
  assert.equal(filters.holeRank2,'Q');assert.equal(filters.holeRanks,undefined);assert.equal(filters.holeType,'offsuit');assert.equal(filters.minBB,'12.5');assert.equal(filters.period,'7');
  const html=records.recordFilters('hands',{filters:{holePreset:'suitedConnector'}});
  assert.match(html,/data-action="record-hole-preset"[^>]*data-hole-preset="suitedConnector"[^>]*aria-pressed="true"/);
  assert.match(html,/只筛自己的两张底牌/);assert.match(html,/花色相同、非对子/);assert.match(html,/花色不同、非对子/);
  assert.doesNotMatch(html,/<select name="holeRank[12]"[^>]*data-record-auto|name="minBB"[^>]*data-record-auto/);
});

test('record refresh preserves unfinished BB and rank drafts plus disclosure state',()=>{
  const state={clock:createRoomClock(),filters:{...records.defaultRecordFilters(),result:'winOver',minBB:'20'},scope:'table',room:'123456'};
  const form=(values,open)=>{const fields=Object.entries(values).map(([name,value])=>({name,value,type:'text',selectionStart:3,selectionEnd:3,focus(){this.focused=true;},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}}));fields.namedItem=name=>fields.find(f=>f.name===name);const disclosures=[{dataset:{recordDisclosure:'table'},open},{dataset:{recordDisclosure:'hole'},open}];return{dataset:{recordKey:records.recordFilterKey(state)},elements:fields,contains:f=>fields.includes(f),querySelectorAll:()=>disclosures,disclosures};};
  const original=form({minBB:'12.',holeRank1:'A',holeRank2:'Q',holeType:'suited'},true),fresh=form({minBB:'20',holeRank1:'',holeRank2:'',holeType:'all'},false);
  const draft=records.captureRecordDraft(original,state,original.elements.namedItem('minBB'));records.restoreRecordDraft(fresh,state,draft);
  assert.equal(fresh.elements.namedItem('minBB').value,'12.');assert.equal(fresh.elements.namedItem('minBB').selectionStart,3);assert.equal(fresh.elements.namedItem('minBB').focused,true);
  assert.equal(fresh.elements.namedItem('holeRank1').value,'A');assert.equal(fresh.elements.namedItem('holeRank2').value,'Q');assert.equal(fresh.elements.namedItem('holeType').value,'suited');
  assert.ok(fresh.disclosures.every(d=>d.open));assert.equal(state.filters.minBB,'20');assert.equal(state.filters.holeRank1,'');
});

test('mobile date styling uses a single column and native date fields can shrink inside the form',()=>{
  const css=readFileSync(new URL('../public/hand-records.css',import.meta.url),'utf8');
  assert.match(css,/@media\(max-width:640px\)/);assert.match(css,/\.record-filters \.record-date-fields\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/input\[type=date\][^{]*\{[^}]*min-width:0/);
});

test('session records share BB thresholds while keeping starting-card controls out',()=>{
  const state={clock:createRoomClock(),filters:{result:'lossOver',minBB:'50.25',holeRanks:'AK',holeType:'suited'}};
  const query=records.recordQuery('sessions',state);assert.equal(query.get('result'),'lossOver');assert.equal(query.get('minBB'),'50.25');assert.equal(query.has('holeRanks'),false);
  const html=records.recordFilters('sessions',state);assert.match(html,/name="minBB"[^>]*value="50.25"/);assert.match(html,/按每桌大盲折算/);assert.doesNotMatch(html,/name="holeRank[12]"|起手牌条件/);
  for(const value of ['', '1.001', '-1'])assert.throws(()=>records.recordQuery('sessions',{filters:{result:'winOver',minBB:value}}),/BB 门槛/);
});

test('personal hand context filters serialize strictly and never leak into sessions or table history',()=>{
  const filters={opponent:'friend_123-abc',position:'UTG+1',potType:'headsUp',tableSize:'short',maxHands:'500'},query=records.recordQuery('hands',{scope:'personal',filters});
  for(const [key,value]of Object.entries(filters))assert.equal(query.get(key),value);
  assert.equal(records.recordQuery('hands',{filters:{...filters,maxHands:100000}}).get('maxHands'),'100000');
  for(const [key,values]of Object.entries({opponent:['../me','someone x','<img>',12],position:['button','BTN/SB',5],potType:['flop','',false],tableSize:['1','10','full-ring'],maxHands:['0','01','1.5','1e3','100001','',null,false]})){
    for(const value of values)assert.throws(()=>records.recordQuery('hands',{filters:{...filters,[key]:value}}),undefined,`${key}: ${value}`);
  }
  const all=records.recordQuery('hands',{filters:records.defaultRecordFilters()});
  for(const key of Object.keys(filters))assert.equal(all.has(key),false);
  for(const [kind,scope]of [['hands','table'],['sessions','personal']]){
    const separate=records.recordQuery(kind,{scope,filters});for(const key of Object.keys(filters))assert.equal(separate.has(key),false);
    assert.doesNotMatch(records.recordFilters(kind,{scope,filters}),/name="(?:opponent|position|potType|tableSize|maxHands)"/);
  }
});

test('personal advanced options start collapsed, escape opponent names and explain first-flop semantics',()=>{
  const evil='<img src=x onerror=alert(1)>',plain=records.recordFilters('hands',{scope:'personal',filters:{},opponentOptions:[{id:'friend',name:evil}]});
  assert.match(plain,/<details class="record-table-options record-main-options" data-record-disclosure="filters">/);
  assert.match(plain,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(plain,/<img/);
  assert.match(plain,/本人未进入翻牌/);assert.match(plain,/翻后人数按翻牌发出时计算/);assert.match(plain,/实际获牌人数|实际发牌人数/);assert.match(plain,/我的整手盈亏/);assert.match(plain,/含本手小游戏/);
  const active=records.recordFilters('hands',{scope:'personal',filters:{opponent:'friend',position:'BTN',maxHands:'100'},opponentOptions:[{id:'friend',name:'牌友'}]});
  assert.match(active,/data-record-disclosure="filters"/);assert.match(active,/value="friend" selected/);assert.match(active,/对手：牌友/);assert.match(active,/最近 100 手/);
  const draft=records.filterValues(new URLSearchParams({opponent:'friend',position:'CO',potType:'multiway',tableSize:'full',maxHands:'1000'}),{period:'7',holeRanks:'AK'});
  for(const [key,value]of Object.entries({opponent:'friend',position:'CO',potType:'multiway',tableSize:'full',maxHands:'1000',holeRanks:'AK',period:'7'}))assert.equal(draft[key],value);assert.equal(records.recordQuery('hands',{filters:draft}).get('holeRank2'),'K');
});

test('opponent report uses server aggregates, prevents summing rows and never reveals cards',()=>{
  setDisplayUnit('bb');
  const rows=[{id:'one',name:'<img src=x>',hands:25,net:150,netBB:75,bbHands:25,wins:15,losses:9,even:1,headsUpHands:10,headsUpNet:80,headsUpNetBB:40,headsUpBBHands:8,lastAt:'2026-10-13T00:00:00Z',cards:['As','Ah']},{id:'two',name:'牌友乙',hands:10,net:-100,netBB:-50,bbHands:10,wins:2,losses:8,headsUpHands:0,headsUpBBHands:0}];
  const data={rows,uniqueHands:28,net:80,netBB:40,bbHands:28},html=records.opponentRecords(data);
  assert.match(html,/28 手已去重/);assert.match(html,/\+75 BB/);assert.doesNotMatch(html,/\+40 BB/);assert.match(html,/并非直接从对方赢得/);assert.match(html,/各行不可相加/);
  assert.doesNotMatch(html,/opponent-details|15 赢|9 输/);assert.match(html,/可能包含其他玩家翻前留下的积分/);assert.match(html,/data-action="library-opponent" data-opponent="one"/);
  assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img|As|Ah|NaN|Infinity/);
  const loss=records.opponentRecords(data,'loss');assert.ok(loss.indexOf('data-opponent="two"')<loss.indexOf('data-opponent="one"'));
  const absent=records.opponentRecords({rows:[{id:'old',name:'旧记录',hands:3,bbHands:0,net:15,netBB:0,headsUpHands:2,headsUpBBHands:0,headsUpNet:8,headsUpNetBB:0}],uniqueHands:3,net:15,netBB:0,bbHands:0});
  assert.match(absent,/— BB/);assert.match(absent,/缺少.*大盲/);
});

test('opponent totals and options ignore stale responses and paginating hands cannot duplicate records or multiply totals',async()=>{
  const c=harness(),old=c.loadLibrary(true);c.state.library.filters={opponent:'new',position:'BTN',potType:'headsUp',maxHands:'100'};const fresh=c.loadLibrary(true);
  const opponents={rows:[{id:'new',name:'新对手',hands:25,net:9,netBB:9,bbHands:25}],uniqueHands:25,net:9,netBB:9,bbHands:25};
  c.calls[1].resolve({hands:[{id:'h1',position:'BTN',potType:'headsUp',flopPlayers:2,tableSize:6}],totals:{count:25},opponents,opponentOptions:[{id:'new',name:'新对手'}],nextCursor:'page2'});await fresh;
  c.calls[0].resolve({hands:[{id:'old'}],opponents:{rows:[{id:'old',name:'旧对手'}]},opponentOptions:[{id:'old',name:'旧对手'}]});await old;
  assert.equal(c.state.library.opponents.uniqueHands,25);assert.equal(c.state.library.opponentOptions[0].id,'new');assert.match(c.calls[1].path,/opponent=new/);assert.match(c.calls[1].path,/maxHands=100/);
  const next=c.loadLibrary();c.calls[2].resolve({hands:[{id:'h1'},{id:'h2'},{id:'h2'}],totals:{count:25},opponents,opponentOptions:[{id:'new',name:'新对手'}]});await next;
  assert.equal(c.state.library.hands.length,2);assert.equal(c.state.library.opponents.uniqueHands,25);assert.equal(c.state.library.opponents.rows.length,1);
  assert.match(c.handSummary(c.state.library.hands[0]),/context-position">庄位 BTN/);assert.match(c.handSummary(c.state.library.hands[0]),/翻后单挑/);
  assert.doesNotMatch(c.handLibraryContent(),/牌谱视图|data-action="library-view"|同桌手牌/);
});

test('independent opponent route never inherits hand-only filters and shared-hand drilldown is explicit',async()=>{
  const c=harness();c.state.library.filters={period:'7',result:'loss',holePreset:'premium',position:'BB',type:'bomb',squid:'unlimited',maxHands:'500'};c.state.library.favorites=true;
  c.state.page='opponents';c.state.opponents.filters={period:'3'};c.state.opponents.room='123456';
  const pending=c.loadOpponents(),query=new URL('https://local'+c.calls[0].path).searchParams;
  assert.match(c.calls[0].path,/^\/api\/opponents\?/);assert.equal(query.get('room'),'123456');assert.ok(query.get('from'));
  for(const key of ['result','holePreset','position','type','squid','maxHands','favorites'])assert.equal(query.has(key),false,key);
  c.calls[0].resolve({opponents:{rows:[{id:'friend',name:'朋友甲',hands:2}],summary:{}},opponentOptions:[{id:'friend',name:'朋友甲'}]});await pending;
  assert.equal(c.state.library.filters.position,'BB');assert.equal(c.state.library.favorites,true);
  const saved=c.state.opponents.filters;c.openOpponentHands('friend');assert.equal(c.navigations.at(-1),'/hands');
  assert.equal(c.state.opponents.filters,saved);assert.equal(c.state.library.filters.opponent,'friend');assert.equal(c.state.library.filters.period,'3');assert.equal(c.state.library.room,'123456');assert.equal(c.state.library.filters.position,'all');assert.equal(c.state.library.favorites,false);
  assert.match(c.handLibraryContent(),/与 朋友甲 的共同牌谱/);assert.match(c.handLibraryContent(),/两人直接输赢请看对手页/);
});

test('changing the opponent after drilling in never leaves another friend in the heading',()=>{
  const c=harness();c.state.library.opponentDrilldown={id:'a',name:'朋友甲'};c.state.library.opponentOptions=[{id:'b',name:'朋友乙'}];c.state.library.filters.opponent='b';
  let html=c.handLibraryContent();assert.match(html,/与 朋友乙 的共同牌谱/);assert.doesNotMatch(html,/与 朋友甲 的共同牌谱/);assert.match(html,/返回对手/);
  c.state.library.filters.opponent='';html=c.handLibraryContent();assert.match(html,/当前条件的牌谱/);assert.doesNotMatch(html,/与 朋友甲 的共同牌谱/);
});

test('opponent requests reject slow results and resetting only clears opponent filters',async()=>{
  const c=harness();c.state.page='opponents';c.state.library.filters={position:'BB',holePreset:'pair'};
  const old=c.loadOpponents();c.state.opponents.filters={period:'7',opponent:'new'};const fresh=c.loadOpponents();
  c.calls[1].resolve({opponents:{rows:[{id:'new',name:'新朋友'}],summary:{}},opponentOptions:[{id:'new',name:'新朋友'}]});await fresh;
  c.calls[0].resolve({opponents:{rows:[{id:'old',name:'旧朋友'}]},opponentOptions:[{id:'old',name:'旧朋友'}]});await old;
  assert.equal(c.state.opponents.data.rows[0].id,'new');assert.equal(c.state.opponents.opponentOptions[0].id,'new');assert.equal(c.state.opponents.loading,false);
  const reset=c.resetRecordFilters('opponents');assert.equal(new URL('https://local'+c.calls[2].path).searchParams.size,0);c.calls[2].resolve({opponents:{rows:[],summary:{}},opponentOptions:[]});await reset;
  assert.equal(c.state.library.filters.position,'BB');assert.equal(c.state.library.filters.holePreset,'pair');
  const late=c.loadOpponents();c.requests.invalidate();c.calls[3].resolve({opponents:{rows:[{name:'private'}]},opponentOptions:[{name:'private'}]});await late;
  assert.equal(c.state.opponents.data,null);assert.equal(c.state.opponents.opponentOptions.length,0);
});

test('context chips distinguish combined heads-up positions and never describe a spectator as a participant',()=>{
  const chips=records.handContextChips({position:'BTN/SB',potType:'multiway',flopPlayers:3,tableSize:9});assert.match(chips,/庄位兼小盲/);assert.match(chips,/翻后 3 人池/);assert.match(chips,/9 人发牌/);
  assert.equal(records.handContextChips({participated:false,position:'BB',potType:'headsUp'}),'');
  const unknown=records.handContextChips({position:'unknown',potType:'unknown',flopPlayers:null,tableSize:null});assert.match(unknown,/位置未记录/);assert.match(unknown,/翻后人数未记录/);assert.doesNotMatch(unknown,/null|NaN/);
  const css=readFileSync(new URL('../public/hand-records.css',import.meta.url),'utf8');assert.match(css,/\.record-personal-fields\{grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/\.opponent-list\{[^}]*display:grid/);assert.match(css,/\.opponent-identity strong\{[^}]*text-overflow:ellipsis/);
});

test('advanced disclosures and unsubmitted selections survive view redraws without becoming applied filters',()=>{
  const state={clock:createRoomClock(),scope:'personal',filters:records.defaultRecordFilters(),view:'hands'};
  const make=(values,open)=>{const fields=Object.entries(values).map(([name,value])=>({name,value,type:'select-one'}));fields.namedItem=name=>fields.find(f=>f.name===name);const disclosure={dataset:{recordDisclosure:'personal'},open};return{dataset:{recordKey:records.recordFilterKey(state)},elements:fields,querySelectorAll:()=>[disclosure],contains:f=>fields.includes(f),disclosure};};
  const original=make({opponent:'friend',position:'CO',potType:'multiway',tableSize:'short',maxHands:'1000'},true),draft=records.captureRecordDraft(original,state,null);
  const fresh=make({opponent:'',position:'all',potType:'all',tableSize:'all',maxHands:'all'},false);records.restoreRecordDraft(fresh,state,draft);
  assert.equal(fresh.elements.namedItem('opponent').value,'friend');assert.equal(fresh.elements.namedItem('maxHands').value,'1000');assert.equal(fresh.disclosure.open,true);assert.equal(state.filters.opponent,'');assert.equal(state.filters.maxHands,'all');
  state.view='opponents';const separate=make({opponent:'',maxHands:'all'},false);records.restoreRecordDraft(separate,state,draft);assert.equal(separate.elements.namedItem('opponent').value,'');assert.equal(separate.disclosure.open,false);
});

test('late opponent responses after identity invalidation cannot populate private names or statistics',async()=>{
  const c=harness(),pending=c.loadLibrary(true);c.requests.invalidate();
  c.calls[0].resolve({hands:[{id:'private-hand'}],totals:{count:100},opponents:{rows:[{id:'private-user',name:'private-name'}]},opponentOptions:[{id:'private-user',name:'private-name'}]});await pending;
  assert.equal(c.state.library.hands.length,0);assert.equal(c.state.library.opponents,null);assert.equal(c.state.library.opponentOptions.length,0);
});

test('unconvertible BB rows stay after measured opponents in profit or loss ranking',()=>{
  setDisplayUnit('bb');
  const data={rows:[{id:'unknown',name:'未知大盲',hands:100,bbHands:0,netBB:0},{id:'measured',name:'已记录',hands:10,bbHands:10,netBB:-50}]};
  for(const sort of ['profit','loss']){const html=records.opponentRecords(data,sort);assert.ok(html.indexOf('data-opponent="measured"')<html.indexOf('data-opponent="unknown"'));}
});

function startingHandForm(state,values={}) {
  const defaults=records.defaultRecordFilters(),names=['holePreset','holeRank1','holeSuit1','holeRank2','holeSuit2','holeType','handNumber'];
  const fields=names.map(name=>({name,value:values[name]??defaults[name],type:name==='holePreset'?'hidden':'select-one',focus(){}}));fields.namedItem=name=>fields.find(field=>field.name===name);
  const node=()=>({textContent:'',classes:new Set(),classList:{toggle(name,on){on?this.owner.classes.add(name):this.owner.classes.delete(name);}}});
  const nodes=Object.fromEntries(['summary','preview','description','draft-help'].map(name=>{const item=node();item.classList.owner=item;return [name,item];}));
  const presets=['all','pair','bigPair','suitedConnector','suitedGapper','suitedAce','broadway','premium'].map(id=>{const item=node();item.dataset={holePreset:id};item.classList.owner=item;item.setAttribute=(key,value)=>item[key]=value;return item;});
  const disclosures=['hole','hole-custom'].map(name=>({dataset:{recordDisclosure:name},open:false}));
  const form={dataset:{recordKind:'hands',recordKey:records.recordFilterKey(state)},elements:fields,contains:field=>fields.includes(field),
    querySelector(selector){if(selector==='[data-record-disclosure="hole-custom"]')return disclosures[1];const key=selector.match(/^\[data-hole-(.+)\]$/)?.[1];return nodes[key]||null;},
    querySelectorAll(selector){return selector==='[data-record-disclosure]'?disclosures:selector==='[data-action="record-hole-preset"]'?presets:[];},nodes,presets,disclosures};
  for(const field of fields)field.form=form;return form;
}

test('card ranks, specific suits and colors serialize separately; custom wins over stale preset and legacy values',()=>{
  const filters={holePreset:'premium',holeRank1:' a ',holeSuit1:'h',holeRank2:'K',holeSuit2:'red',holeType:'offsuit',holeRanks:'QQ'};
  const query=records.recordQuery('hands',{filters});
  for(const [key,value]of Object.entries({holeRank1:'A',holeSuit1:'h',holeRank2:'K',holeSuit2:'red',holeType:'offsuit'}))assert.equal(query.get(key),value);
  assert.equal(query.has('holeRanks'),false);assert.equal(query.has('holePreset'),false);
  for(const preset of ['pair','bigPair','suitedConnector','suitedGapper','suitedAce','broadway','premium'])assert.equal(records.recordQuery('hands',{filters:{holePreset:preset}}).get('holePreset'),preset);
  assert.equal(records.recordQuery('hands',{filters:{holeSuit2:'black'}}).get('holeSuit2'),'black');
  for(const filters of [{holeRank1:'AK'},{holeRank2:2},{holeSuit1:'hearts'},{holeSuit2:[]},{holePreset:'unknown'},{holeType:'bad'},{holeRank1:'A',holeSuit1:'h',holeRank2:'A',holeSuit2:'h'}])assert.throws(()=>records.recordQuery('hands',{filters}));
  const cleared=records.filterValues(new URLSearchParams({holePreset:'all',holeRank1:'',holeSuit1:'',holeRank2:'',holeSuit2:'',holeType:'all'}),{holeRanks:'AK',holeType:'suited'});
  assert.equal(cleared.holeRanks,undefined);assert.equal(records.recordQuery('hands',{filters:cleared}).size,1);
  assert.equal(records.recordQuery('hands',{filters:{holeRanks:'AK',holeRank1:''}}).size,1,'explicit empty custom fields override legacy ranks');
  assert.equal(records.recordQuery('hands',{filters:{holeRanks:'AK',holePreset:'pair'}}).get('holePreset'),'pair');
  const sessions=records.recordQuery('sessions',{filters});for(const key of ['holePreset','holeRank1','holeSuit1','holeRank2','holeSuit2','holeType'])assert.equal(sessions.has(key),false);
});

test('preset clicks clear custom cards and custom edits update only draft preview and selection state',()=>{
  const state={clock:createRoomClock(),filters:records.defaultRecordFilters()},form=startingHandForm(state,{holeRank1:'A',holeSuit1:'h',holeRank2:'A',holeSuit2:'h',holeType:'pair'});
  form.disclosures[1].open=true;
  assert.equal(records.applyHolePreset(form,{holePreset:'suitedConnector'}),true);
  assert.equal(form.elements.namedItem('holeRank1').value,'');assert.equal(form.elements.namedItem('holeSuit2').value,'');assert.equal(form.elements.namedItem('holeType').value,'all');
  assert.equal(form.disclosures[1].open,false);assert.match(form.nodes.preview.textContent,/相邻点数且同花/);assert.equal(form.presets.find(p=>p.dataset.holePreset==='suitedConnector')['aria-pressed'],'true');
  const suit=form.elements.namedItem('holeSuit2');suit.value='red';records.updateHoleDraft(form,suit);
  assert.equal(form.elements.namedItem('holePreset').value,'all');assert.match(form.nodes.preview.textContent,/红色 任意点数/);assert.match(form.nodes['draft-help'].textContent,/尚未应用/);assert.ok(form.presets.every(p=>p['aria-pressed']==='false'));assert.equal(state.filters.holeSuit2,'');
  form.elements.namedItem('holeRank1').value='A';form.elements.namedItem('holeSuit1').value='h';form.elements.namedItem('holeRank2').value='A';suit.value='h';assert.doesNotThrow(()=>records.updateHoleDraft(form,suit));
  assert.match(form.nodes.preview.textContent,/同一张牌/);assert.ok(form.nodes.preview.classes.has('invalid'));
  suit.value='d';records.updateHoleDraft(form,suit);assert.ok(!form.nodes.preview.classes.has('invalid'));assert.match(form.nodes.preview.textContent,/红桃 A \+ 方块 A/);
  assert.equal(state.filters.holePreset,'all');assert.equal(state.filters.holeRank1,'');
  records.applyHolePreset(form,{holePreset:'premium'});records.updateHoleDraft(form,form.elements.namedItem('handNumber'));
  assert.equal(form.elements.namedItem('holePreset').value,'premium','unrelated changes must not clear the preset');
});

test('restoring a starting-hand draft refreshes preview and pressed buttons without resetting its preset',()=>{
  const state={clock:createRoomClock(),filters:records.defaultRecordFilters()},original=startingHandForm(state),fresh=startingHandForm(state);
  records.applyHolePreset(original,{holePreset:'premium'});original.disclosures[0].open=true;
  const draft=records.captureRecordDraft(original,state,null);records.restoreRecordDraft(fresh,state,draft);
  assert.equal(fresh.elements.namedItem('holePreset').value,'premium');for(const rank of ['QQ','KK','AA','AK'])assert.ok(fresh.nodes.preview.textContent.includes(rank));assert.equal(fresh.presets.find(p=>p.dataset.holePreset==='premium')['aria-pressed'],'true');assert.equal(fresh.disclosures[0].open,true);assert.equal(state.filters.holePreset,'all');
  original.elements.namedItem('holeSuit1').value='black';records.updateHoleDraft(original,original.elements.namedItem('holeSuit1'));original.disclosures[1].open=true;
  records.restoreRecordDraft(fresh,state,records.captureRecordDraft(original,state,null));
  assert.match(fresh.nodes.preview.textContent,/黑色 任意点数/);assert.equal(fresh.elements.namedItem('holePreset').value,'all');assert.ok(fresh.presets.every(p=>p['aria-pressed']==='false'));assert.equal(fresh.disclosures[1].open,true);assert.equal(state.filters.holeSuit1,'');
});

test('removed hand-number and even filters never silently narrow old saved views',()=>{
  for(const handNumber of ['12','1e3',{},null]){const query=records.recordQuery('hands',{filters:{handNumber,result:'even',q:'old'}});assert.equal(query.has('handNumber'),false);assert.equal(query.has('q'),false);assert.equal(query.has('result'),false);}
  const html=records.recordFilters('hands',{filters:{q:'old hidden search',handNumber:'12',result:'even'}});assert.doesNotMatch(html,/name="(?:q|handNumber)"|找第几手|第 12 手|value="even"|含搜索词/);assert.match(html,/全部手牌/);
  const sessions=records.recordFilters('sessions',{filters:{q:'朋友'}});assert.match(sessions,/搜索对局名称/);assert.match(sessions,/name="q"/);assert.doesNotMatch(sessions,/name="handNumber"|value="even"/);
  const values=records.filterValues(new URLSearchParams(),{handNumber:'99',result:'even'});assert.equal(values.handNumber,undefined);assert.equal(values.result,'all');
});

test('invalid card drafts cannot replace applied filters through submit or date buttons',async()=>{
  for(const values of [{holeRank1:'A',holeSuit1:'h',holeRank2:'A',holeSuit2:'h'}]){
    const c=harness(),applied={...records.defaultRecordFilters(),period:'7',holePreset:'pair'};c.state.library.filters=applied;c.state.library.room='123456';
    const form=startingHandForm(c.state.library,values);form.elements.push({name:'room',value:'654321'});
    await c.applyRecordFilters(form);assert.equal(c.state.library.filters,applied);assert.equal(c.state.library.room,'123456');assert.equal(c.calls.length,0);assert.equal(c.toasts.length,1);
    await c.setRecordPeriod({dataset:{kind:'hands',period:'today'},closest:()=>form});assert.equal(c.state.library.filters,applied);assert.equal(c.state.library.room,'123456');assert.equal(c.calls.length,0);assert.equal(c.toasts.length,2);
  }
});

test('room choices show dated names in recent order and disambiguate repeated names without exposing a bare code',()=>{
  const html=records.recordFilters('hands',{scope:'personal',room:'old',filters:{}},[
    {code:'old',name:'周末局',createdAt:'2026-10-01T12:00:00Z'},
    {code:'new',name:'周末局',startedAt:Date.parse('2026-10-14T12:00:00Z')},
    {code:'unsafe',name:'<img src=x>',createdAt:'2026-10-13T12:00:00Z'}
  ]);
  assert.match(html,/选择对局/);assert.match(html,/全部对局/);assert.match(html,/周末局 · /);assert.ok(html.indexOf('value="new"')<html.indexOf('value="old"'));assert.match(html,/value="old" selected/);assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img/);
  const twins=records.recordFilters('hands',{filters:{}},[{code:'111111',name:'同名局'},{code:'222222',name:'同名局'}]);assert.match(twins,/同名局 · 房间 111111/);assert.match(twins,/同名局 · 房间 222222/);
  const absent=records.recordFilters('hands',{room:'123456',filters:{}});assert.match(absent,/>已选择的对局</);assert.doesNotMatch(absent,/>123456</);
});

test('starting-hand controls use shrinking two-card columns and preserve fixed BB threshold semantics',()=>{
  const css=readFileSync(new URL('../public/hand-records.css',import.meta.url),'utf8');assert.match(css,/\.record-hole-cards\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);assert.match(css,/\.record-hole-card\{[^}]*min-width:0/);assert.match(css,/\.record-hole-card select,[^}]*font-size:16px/);assert.match(css,/\.record-search-help\{grid-column:1\/-1/);
  const plain=records.recordFilters('hands',{filters:{}});assert.match(plain,/data-record-disclosure="hole" >/);assert.match(plain,/data-record-disclosure="hole-custom" >/);assert.match(plain,/value="red"/);assert.match(plain,/value="black"/);assert.match(plain,/aria-label="第 2 张牌花色或颜色"/);
  assert.doesNotMatch(plain,/<select name="hole(?:Rank|Suit)[12]"[^>]*data-record-auto/);
  setDisplayUnit('points');const query=records.recordQuery('hands',{filters:{result:'winOver',minBB:'12.5',holePreset:'pair'}});assert.equal(query.get('minBB'),'12.5');assert.match(records.recordFilters('hands',{filters:{result:'winOver',minBB:'12.5'}}),/固定阈值/);
});

test('applied hand filter summary names the selected table, date, favorites and every narrowing condition',()=>{
  const rooms=[{code:'old-table',name:'重复朋友局',startedAt:'2026-10-13T09:00:00Z'}];
  const state={clock:createRoomClock(),scope:'personal',room:'old-table',favorites:true,opponentOptions:[{id:'p2',name:'朋友甲'}],filters:{period:'7',result:'winOver',minBB:'25',holePreset:'pairs',type:'bomb',opponent:'p2',position:'BTN',potType:'headsUp',tableSize:'short',maxHands:'100',handNumber:'12'}};
  // Use an existing recognized preset to avoid relying on a legacy alias.
  state.filters.holePreset='all';state.filters.holeType='pair';
  const summary=records.recordFilters('hands',state,rooms).match(/aria-label="当前筛选条件">([^<]+)<\/p>/)[1];
  for(const phrase of ['对局：重复朋友局','近 7 天','仅收藏','赢超过 25 BB','口袋对','炸弹池','对手：朋友甲','BTN','翻后单挑','3–6 人发牌','最近 100 手'])assert.ok(summary.includes(phrase),phrase);
  assert.doesNotMatch(summary,/全部手牌/);
  const onlyTable=records.recordFilters('hands',{scope:'personal',room:'old-table',filters:{}},rooms).match(/aria-label="当前筛选条件">([^<]+)<\/p>/)[1];
  assert.match(onlyTable,/对局：重复朋友局/);assert.doesNotMatch(onlyTable,/全部手牌/);
});

test('date summaries include open bounds, missing selected tables and escaped names without affecting table history',()=>{
  for(const [dates,label]of [[{from:'2026-10-01'},'2026-10-01 起'],[{to:'2026-10-14'},'截至 2026-10-14'],[{from:'2026-10-01',to:'2026-10-14'},'2026-10-01 至 2026-10-14']]){
    const html=records.recordFilters('hands',{scope:'personal',room:'missing',filters:{period:'custom',...dates}});
    const summary=html.match(/aria-label="当前筛选条件">([^<]+)<\/p>/)[1];assert.ok(summary.includes(label));assert.match(summary,/已选择的对局/);
  }
  const html=records.recordFilters('hands',{scope:'personal',room:'attack',filters:{}},[{code:'attack',name:'<img src=x>'}]);
  assert.match(html,/对局：&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img/);
  const table=records.recordFilters('hands',{scope:'table',room:'same',filters:{period:'custom',from:'2026-01-01'}},[{code:'same',name:'当前房间'}]);
  assert.match(table,/当前筛选条件">全部手牌/);assert.doesNotMatch(table.match(/aria-label="当前筛选条件">([^<]+)<\/p>/)[1],/对局：|2026-01-01/);
});

test('record destinations are peers and neither opponent page nor table history exposes hand-only opponent filters',()=>{
  const nav=records.recordNavigation('opponents');
  assert.equal((nav.match(/data-action=/g)||[]).length,4);for(const label of ['概览','对局','牌谱','对手'])assert.ok(nav.includes(label));assert.match(nav,/data-action="opponents" aria-current="page"/);
  const html=records.opponentFilters({filters:{period:'all',position:'BB',maxHands:'100',type:'bomb',squid:'unlimited'}});
  assert.match(html,/data-record-kind="opponents"/);assert.doesNotMatch(html,/name="(?:position|type|squid|potType|holePreset|maxHands|result|handNumber)"/);
  assert.doesNotMatch(html,/同桌手牌|翻后单挑/);
});
test('direct opponent queries only carry explicit date room opponent scope and ignore stale hand-only fields',()=>{
  const query=records.opponentQuery({room:'room-1',filters:{period:'7',opponent:'friend',position:'BB',type:'bomb',squid:'unlimited',result:'loss',handNumber:'3',maxHands:'100',holePreset:'pair'}});
  assert.deepEqual([...query.keys()].sort(),['from','opponent','room','to']);assert.equal(query.get('opponent'),'friend');
  assert.throws(()=>records.opponentQuery({filters:{opponent:'../other'}}),/有效的对手/);
  const filters=records.opponentFilterValues(new URLSearchParams({room:'ignored',opponent:'friend',holePreset:'pair'}),{period:'3',position:'BB',type:'bomb'});
  assert.deepEqual(filters,{period:'3',from:'',to:'',opponent:'friend'});
});
const bucket=(won,lost,extra={})=>({events:2,coveredEvents:2,unknownEvents:0,bbEvents:2,complete:true,bbComplete:true,won,lost,net:won-lost,wonBB:won/10,lostBB:lost/10,netBB:(won-lost)/10,...extra});
test('direct opponent cards use direct buckets, split poker and fish, escape data and explain allocation',()=>{
  const total=bucket(150,50),holdem=bucket(120,50),squid=bucket(30,0),data={rows:[{id:'friend',name:'<img src=x>',hands:10,transferHands:4,allocatedHands:2,total,holdem,squid,net:999999,cards:['As','Ah']}],summary:{hands:10,total,holdem,squid},excludedMiniEvents:3};
  let html=records.directOpponentRecords(data);assert.match(html,/合计 · 德州＋鱿鱼/);assert.match(html,/从对方赢得/);assert.match(html,/输给对方/);assert.match(html,/\+100/);assert.match(html,/\+70/);assert.match(html,/\+30/);assert.match(html,/3 笔旧小游戏/);assert.match(html,/各赢家净盈利比例/);assert.match(html,/共同牌谱显示整手结果/);
  assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img|999999|As|Ah|NaN|Infinity/);
  setDisplayUnit('bb');html=records.directOpponentRecords(data);assert.match(html,/\+10 BB/);assert.match(html,/\+7 BB/);assert.match(html,/\+3 BB/);
});
test('unknown attribution never falls back to covered partial totals and stays below measured ranks',()=>{
  setDisplayUnit('bb');const known=bucket(0,100),unknown=bucket(null,null,{net:null,wonBB:null,lostBB:null,netBB:null,complete:false,bbComplete:false,unknownEvents:1,covered:{net:9999,netBB:9999}});
  const data={rows:[{id:'unknown',name:'未知',total:unknown},{id:'known',name:'已核对',total:known}],summary:{total:unknown,holdem:unknown,squid:bucket(0,0)}};
  for(const sort of ['profit','loss']){const html=records.directOpponentRecords(data,sort);assert.ok(html.indexOf('opponent-known')<html.indexOf('opponent-unknown'));assert.match(html,/无法完整计算/);assert.match(html,/历史记录无法完整归属/);assert.doesNotMatch(html,/9,999|9999/);}
  const zero=records.directOpponentRecords({rows:[{id:'zero',name:'零',total:bucket(0,0)}],summary:{total:bucket(0,0),holdem:bucket(0,0),squid:bucket(0,0)}});assert.match(zero,/0 BB/);assert.match(zero,/暂无净输赢/);
});
test('hand game filters combine bomb pots with either squid mode without filtering the opponent report',()=>{
  for(const type of ['holdem','bomb'])for(const squid of ['none','normal','unlimited']){
    const query=records.recordQuery('hands',{filters:{type,squid}});assert.equal(query.get('type'),type);assert.equal(query.get('squid'),squid);
    const html=records.recordFilters('hands',{filters:{type,squid}}),summary=html.match(/aria-label="当前筛选条件">([^<]+)/)[1];assert.ok(summary.includes(type==='bomb'?'炸弹池':'普通发牌'));assert.ok(summary.includes({none:'无鱿鱼',normal:'普通鱿鱼',unlimited:'无限鱿鱼'}[squid]));
  }
  assert.throws(()=>records.recordQuery('hands',{filters:{squid:'invalid'}}));
  const html=records.recordFilters('hands',{filters:{}});assert.match(html,/杂色连张/);
});
test('actual dealt size controls positions, discards impossible drafts and labels bomb pots without imaginary blinds',()=>{
  for(let size=2;size<=9;size++)assert.equal(records.recordQuery('hands',{filters:{tableSize:String(size)}}).get('tableSize'),String(size));
  const make=(size,position,type='all')=>{const values={tableSize:{value:size},position:{value:position,innerHTML:''},type:{value:type},result:{value:'all'}};return {elements:{namedItem:name=>values[name]},querySelector:()=>null,values};};
  const short=make('4','UTG');records.updateRecordFields(short,{name:'tableSize'});assert.equal(short.values.position.value,'all');assert.doesNotMatch(short.values.position.innerHTML,/value="UTG"/);assert.match(short.values.position.innerHTML,/庄前一位 CO/);
  const bomb=make('9','BB','bomb');records.updateRecordFields(bomb,{name:'type'});assert.equal(bomb.values.position.value,'all');assert.doesNotMatch(bomb.values.position.innerHTML,/value="(?:SB|BB|UTG)"/);assert.match(bomb.values.position.innerHTML,/炸弹池无盲位/);
  const valid=make('4','CO');records.updateRecordFields(valid,{name:'tableSize'});assert.equal(valid.values.position.value,'CO');
  const chips=records.handContextChips({position:'bomb',bombPot:true,tableSize:4});assert.match(chips,/炸弹池无盲位/);assert.match(chips,/4 人发牌/);assert.doesNotMatch(chips,/位置未记录/);
});

test('custom dates have a visible apply action outside collapsed advanced filters and submit as one draft',async()=>{
  for(const kind of ['hands','sessions','opponents']){
    const c=harness(),list=kind==='hands'?c.state.library:kind==='sessions'?c.state.sessions:c.state.opponents;
    list.filters={period:'custom',from:'2026-10-01',to:'2026-10-14'};
    const html=kind==='opponents'?records.opponentFilters(list):records.recordFilters(kind,list);
    const dateSection=html.match(/<section class="record-date-group"[\s\S]*?<\/section>/)[0];
    assert.match(dateSection,/<button type="submit" class="outline small">应用日期<\/button>/);assert.doesNotMatch(dateSection,/<details|data-record-auto/);
    assert.ok(html.indexOf('应用日期')<html.indexOf('data-record-disclosure="filters"'));
    const elements=[{name:'from',value:'2026-10-03'},{name:'to',value:'2026-10-12'}],form={dataset:{recordKind:kind},elements};
    assert.equal(list.filters.from,'2026-10-01');assert.equal(c.calls.length,0);
    const pending=c.applyRecordFilters(form);assert.equal(c.calls.length,1);const query=new URL('https://local'+c.calls[0].path).searchParams;
    assert.equal(query.get('from'),records.recordDateRange({period:'custom',from:'2026-10-03',to:'2026-10-12'}).from);
    assert.equal(query.get('to'),records.recordDateRange({period:'custom',from:'2026-10-03',to:'2026-10-12'}).to);
    c.calls[0].resolve(kind==='hands'?{hands:[]}:kind==='sessions'?{sessions:[]}:{opponents:{rows:[],summary:{}},opponentOptions:[]});await pending;
    assert.equal(list.filters.from,'2026-10-03');assert.equal(list.filters.to,'2026-10-12');
  }
});
test('opponent component counts distinguish attributable and unknown events',()=>{
  const partial=bucket(null,null,{events:5,coveredEvents:3,unknownEvents:2,net:null,netBB:null,complete:false,bbComplete:false});
  const html=records.directOpponentRecords({rows:[{id:'friend',name:'朋友',holdem:partial,squid:partial,total:partial}],summary:{}});
  assert.match(html,/3 手可核对 · 2 手待核对/);assert.match(html,/3 轮可核对 · 2 轮待核对/);assert.doesNotMatch(html,/5 手有归属记录|5 轮结算/);
});
