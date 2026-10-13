import * as statsUI from '../public/stats.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import * as records from '../public/records.js';
import {createRequestGuard} from '../public/platform.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function harness({dom=false}={}){
  const calls=[],modals=[],toasts=[],events={};let client;
  const documentRef={currentForm:null,activeElement:null,querySelector(selector){return this.currentForm&&selector==='#'+this.currentForm.id?this.currentForm:null;},addEventListener(name,callback){events[name]=callback;}};
  function rebuild(kind){
    if(!dom)return;if(documentRef.currentForm)documentRef.currentForm.isConnected=false;
    const list=kind==='hands'?client.state.library:client.state.sessions,fields=['q','from','to'].map(name=>({name,value:list.filters?.[name]||'',type:name==='q'?'search':'date',selectionStart:2,selectionEnd:2,focus(){documentRef.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}}));fields.namedItem=name=>fields.find(field=>field.name===name);
    const form={id:kind==='hands'?'hand-records-filter-form':'session-records-filter-form',dataset:{recordKind:kind,recordKey:records.recordFilterKey(list)},isConnected:true,elements:fields,contains:field=>fields.includes(field)};for(const field of fields)field.form=form;documentRef.currentForm=form;
  }
  const context=vm.createContext({statsUI,records,createRequestGuard,URLSearchParams,Date,Set,Map,
    api(path){return new Promise((resolve,reject)=>calls.push({path,resolve,reject}));},document:dom?documentRef:undefined,app:{contains:()=>client.state.page!=='room'},render(){if(client.state.page==='hands'||client.state.page==='sessions')rebuild(client.state.page);},
    openModal(title,body,kind){client.state.modal={kind,title};modals.push({title,body,kind});if(kind==='hand-library')rebuild('hands');if(kind==='session-list')rebuild('sessions');},closeModal(){client.state.modal=null;},
    toast(message){toasts.push(message);},navigate(){assert.fail('table overlays must not navigate');},
    num:n=>String(n||0),signed:n=>`${n>0?'+':''}${n||0}`,profitClass:()=>'',fmtDate:String,cards:()=>'',card:()=>'',
    btn:(label,action,cls='',attrs='')=>`<button data-action="${action}" class="${cls}" ${attrs}>${label}</button>`,renderReplay(){},
  });
  vm.runInContext(['const requests=createRequestGuard();',section('const state=','const num='),section('function renderHandLibrary(','const layouts='),...(dom?[section("document.addEventListener('compositionstart'","document.addEventListener('input'")]:[]),'globalThis.client={state,requests,loadLibrary,handLibrary,loadSessions,sessionLibrary,sessionDetailModal,openHandLibrary,openSessions,handSummary};'].join('\n'),context);
  client=context.client;client.state.user={id:'me',name:'me'};client.state.page='hands';return {...client,calls,modals,toasts,events,document:documentRef};
}
test('custom dates and quick ranges use local day boundaries across timezone and calendar changes',()=>{
  const moduleUrl=new URL('../public/records.js',import.meta.url).href;
  const code=`import {recordDateRange} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify([recordDateRange({period:'custom',from:'2026-10-13',to:'2026-10-13'}),recordDateRange({period:'7'},new Date(2026,0,2,12)),recordDateRange({period:'today'},new Date(2026,9,13,12))]));`;
  const [custom,week,today]=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TZ:'Asia/Shanghai'},encoding:'utf8'}));
  assert.deepEqual(custom,{from:'2026-10-12T16:00:00.000Z',to:'2026-10-13T15:59:59.999Z'});assert.equal(week.from,'2025-12-26T16:00:00.000Z');assert.equal(week.to,'2026-01-02T15:59:59.999Z');assert.deepEqual(today,custom);
  for(const filters of [{period:'custom',from:'2026-02-30'},{period:'custom',from:'2026-10-14',to:'2026-10-13'},{period:'custom'},{period:'bad'}])assert.throws(()=>records.recordDateRange(filters));
});
test('query resets discard old cursors while keeping current filters; hand and session options stay separate',()=>{
  const state={filters:{period:'all',result:'loss',q:'  朋友局  ',type:'bomb',status:'closed'},favorites:true,room:'123456',nextCursor:'old-page'};
  const hand=records.recordQuery('hands',state,true);assert.equal(hand.get('before'),null);assert.equal(hand.get('favorites'),'1');assert.equal(hand.get('room'),'123456');assert.equal(hand.get('type'),'bomb');assert.equal(hand.get('result'),'loss');assert.equal(hand.get('q'),'朋友局');assert.equal(hand.has('status'),false);
  const sessions=records.recordQuery('sessions',state);assert.equal(sessions.get('before'),'old-page');assert.equal(sessions.get('status'),'closed');assert.equal(sessions.has('favorites'),false);assert.equal(sessions.has('type'),false);
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
});

test('list refreshes preserve unsubmitted drafts and caret without changing applied filters or restoring a different filter',()=>{
  const state={filters:{period:'custom',from:'2026-10-01',to:'2026-10-13',q:'applied'},room:'123456'};
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
