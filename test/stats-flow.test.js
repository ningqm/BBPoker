import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as statsUI from '../public/stats.js';
import {createRequestGuard} from '../public/platform.js';
import {createReplayPlayback} from '../public/replay.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`${start} exists`);return source.slice(a,b);};
const response=(hands,net=0)=>({hands,net,holdemNet:net,miniNet:0,preflopHands:hands,metrics:{},allIn:{count:0,eligibleCount:0}});

function harness(){
  const calls=[],draws=[],modals=[],toasts=[];let client,currentForm=null;
  const document={activeElement:null,visibilityState:'hidden',querySelector:selector=>selector==='#stats-filter-form'?currentForm:null};
  const dialog={scrollTop:42,querySelector:selector=>selector==='#stats-filter-form'?currentForm:null};
  function rebuild(html){
    if(!html.includes('id="stats-filter-form"')){currentForm=null;return;}
    const values=new Map();
    for(const match of html.matchAll(/<input\b([^>]*)>/g)){
      const attrs=match[1],name=attrs.match(/\bname="([^"]*)"/)?.[1];if(name)values.set(name,{value:attrs.match(/\bvalue="([^"]*)"/)?.[1]||'',type:attrs.match(/\btype="([^"]*)"/)?.[1]||'text'});
    }
    for(const match of html.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
      const options=[...match[2].matchAll(/<option\b([^>]*)>/g)],selected=options.find(option=>/\bselected\b/.test(option[1]))||options[0];values.set(match[1],{type:'select',value:selected?.[1].match(/\bvalue="([^"]*)"/)?.[1]||''});
    }
    const fields=[...values].map(([name,value])=>({name,...value,focus(){document.activeElement=this;}}));fields.namedItem=name=>fields.find(field=>field.name===name);
    const custom={hidden:/class="field stats-custom-hands" hidden/.test(html),querySelector:()=>fields.namedItem('handCount')};
    currentForm={id:'stats-filter-form',dataset:{statsKey:statsUI.statsFilterKey(client.state.statsView)},elements:fields,contains:field=>fields.includes(field),querySelector:selector=>selector==='.stats-custom-hands'?custom:null};
  }
  const context=vm.createContext({statsUI,createRequestGuard,createReplayPlayback,URLSearchParams,Date,Set,Map,document,dialog,
    FormData:class{constructor(form){this.form=form;}get(name){return this.form.elements.namedItem(name)?.value??null;}has(name){return Boolean(this.form.elements.namedItem(name));}},
    api(path){return new Promise((resolve,reject)=>calls.push({path,resolve,reject}));},
    render(){const body=statsUI.renderStatsPage(client.state.statsView.data,client.state.statsView);draws.push(body);rebuild(body);},
    openModal(title,body,kind){client.state.modal={title,kind};modals.push({title,body,kind});rebuild(body);},
    closeModal(){client.state.modal=null;currentForm=null;},navigate(){assert.fail('stats dialogs must not navigate away from the table');},
    renderReplay(){client.state.modal={kind:'replay'};},playReplay(){},toast(message){toasts.push(message);},
  });
  vm.runInContext(['const requests=createRequestGuard();',section('const state=','const num='),section('const btn=','const avatar='),section('function paintStats(){','function equityDetails('),section('async function replayModal(','function renderReplay('),section('async function handleAction(','function setRaise('),'globalThis.client={state,requests,loadStats,paintStats,careerModal,applyStatsFilters,setStatsPeriod,replayModal,handleAction};'].join('\n'),context);
  client=context.client;client.state.user={id:'me'};client.state.page='career';return {...client,calls,draws,modals,toasts,dialog,document,get form(){return currentForm;}};
}

test('latest stats filter wins when older success or failure arrives later',async()=>{
  const c=harness(),old=c.loadStats();c.state.statsView.filters.period='3';c.state.statsView.filters.maxHands='100';c.state.statsView.room='123456';const fresh=c.loadStats();
  c.calls[1].resolve(response(6,20));await fresh;c.calls[0].resolve(response(100,-900));await old;
  assert.equal(c.state.statsView.data.hands,6);assert.equal(c.state.statsView.data.net,20);assert.equal(c.state.statsView.loading,false);assert.match(c.calls[1].path,/maxHands=100/);assert.match(c.calls[1].path,/room=123456/);assert.match(c.calls[1].path,/from=/);
  const outdated=c.loadStats(),newer=c.loadStats();c.calls[3].resolve(response(7,25));await newer;c.calls[2].reject(new Error('old failure'));await outdated;
  assert.equal(c.state.statsView.data.hands,7);assert.equal(c.state.statsView.error,'');assert.equal(c.toasts.length,0);
});

test('invalid custom filters invalidate pending totals and do not make a new request',async()=>{
  const c=harness(),old=c.loadStats();c.state.statsView.filters.maxHands='custom';c.state.statsView.filters.handCount='-10';await c.loadStats();
  assert.equal(c.calls.length,1);assert.match(c.state.statsView.error,/完整手数/);c.calls[0].resolve(response(99));await old;assert.equal(c.state.statsView.data,null);assert.equal(c.state.statsView.loading,false);
});

test('identity replacement cannot inherit private stats or late loading flags',async()=>{
  const c=harness(),old=c.loadStats();c.requests.invalidate();c.state.statsView={data:null,filters:statsUI.defaultStatsFilters(),room:'',loading:true,error:'',request:0};
  c.calls[0].resolve(response(123,999));await old;assert.equal(c.state.statsView.data,null);assert.equal(c.state.statsView.loading,true);
});

test('table stats keep unapplied custom hand drafts visible when a response rerenders the modal',async()=>{
  const c=harness();c.state.page='room';c.state.room={code:'123456'};const pending=c.careerModal();
  c.form.elements.namedItem('maxHands').value='custom';c.form.elements.namedItem('handCount').value='250';c.form.querySelector('.stats-custom-hands').hidden=false;c.document.activeElement=c.form.elements.namedItem('handCount');
  c.calls[0].resolve(response(100));await pending;
  assert.equal(c.form.elements.namedItem('maxHands').value,'custom');assert.equal(c.form.elements.namedItem('handCount').value,'250');assert.equal(c.form.querySelector('.stats-custom-hands').hidden,false);assert.equal(c.form.elements.namedItem('handCount').required,true);assert.equal(c.document.activeElement,c.form.elements.namedItem('handCount'));assert.equal(c.state.statsView.filters.maxHands,'all');assert.equal(c.dialog.scrollTop,42);
});

test('table metric and replay return retain the same room and hand filters',async()=>{
  const c=harness();c.state.page='room';c.state.room={code:'123456'};c.state.statsView.room='123456';c.state.statsView.filters.maxHands='500';
  const initial=c.careerModal();c.calls[0].resolve(response(50));await initial;
  await c.handleAction({dataset:{action:'stats-metric',metric:'threeBet'}});assert.equal(c.state.modal.kind,'stats-metric');assert.match(c.modals.at(-1).body,/返回我的数据/);
  const back=c.handleAction({dataset:{action:'stats-return'}});c.calls[1].resolve(response(50));await back;
  assert.equal(c.state.page,'room');assert.equal(c.state.modal.kind,'career');assert.equal(c.state.statsView.filters.maxHands,'500');assert.equal(c.state.statsView.room,'123456');
  const replay=c.replayModal('hand-x','123456');c.calls[2].resolve({hand:{id:'hand-x',log:[]}});await replay;assert.equal(c.state.replay.origin,'stats-modal');
  const replayBack=c.handleAction({dataset:{action:'stats-return'}});c.calls[3].resolve(response(50));await replayBack;assert.equal(c.state.modal.kind,'career');assert.match(c.calls[3].path,/maxHands=500&room=123456/);
});
