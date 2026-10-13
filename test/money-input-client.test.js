import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as money from '../public/money.js';
import {sliderFromRaise} from '../public/table-feedback.js';
import {betActionLabel,betPresetOptions,revealOptions} from '../public/table-controls.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)+a.length));
function harness(unit='bb') {
  money.setDisplayUnit(unit);
  const state={raise:20,connected:true,feedbackResync:false,room:{meId:'hero',settings:{bigBlind:10},hand:{id:'h1',status:'playing',currentBet:10,pot:105},players:[{id:'hero',bet:20,stack:1980,inHand:true,cards:['As','Kh'],shownIndices:[]}],actions:{canRaise:true,callAmount:30,minRaiseTo:100,maxRaiseTo:2000}}};
  const nodes={'#raise-range':{setAttribute(key,value){this[key]=value;}},'#raise-button':{dataset:{}},'#raise-amount':{}};
  const sent=[],messages=[],presets=['min','third','half','two-thirds','pot','over','all'].map(preset=>({dataset:{preset},classList:{toggle(key,value){this[key]=value;}}}));
  const context=vm.createContext({...money,state,sliderFromRaise,betActionLabel,betPresetOptions,revealOptions,Math,Number,$:s=>nodes[s],esc:String,
    document:{querySelectorAll:selector=>selector==='[data-action="raise-preset"]'?presets:[]},chips:n=>money.formatChips(n,10),toast:message=>messages.push(message),
    command:async(type,payload)=>{sent.push({type,...payload});return true;}});
  vm.runInContext(section('function setRaise(','document.addEventListener('),context);
  vm.runInContext(section('async function handleAction(','function setRaise('),context);
  return {state,nodes,context,sent,messages,presets,act:(action,data={})=>context.handleAction({dataset:{action,...data}})};
}

test('a preset previews exact integer points and only the final raise button submits them in either display unit',async()=>{
  for(const unit of ['bb','points']) {
    const h=harness(unit);await h.act('raise-preset',{preset:'half'});
    assert.equal(h.state.raise,117);assert.equal(h.sent.length,0);assert.equal(h.presets.find(p=>p.dataset.preset==='half').classList.selected,true);
    assert.equal(h.nodes['#raise-button'].textContent,unit==='bb'?'加至 11.7 BB':'加至 117 积分');
    await h.act('raise');assert.deepEqual(h.sent,[{type:'raise',amount:117}]);
  }
  money.setDisplayUnit('points');
});

test('changing display units keeps the chosen amount and exact all-in ceiling',async()=>{
  const h=harness('points');h.context.setRaise(125);assert.equal(h.nodes['#raise-range']['aria-valuetext'],'加至 125 积分');
  money.setDisplayUnit('bb');h.context.setRaise(h.state.raise);assert.equal(h.state.raise,125);assert.equal(h.nodes['#raise-range']['aria-valuetext'],'加至 12.5 BB');
  await h.act('raise-preset',{preset:'all'});assert.equal(h.state.raise,2000);assert.equal(h.nodes['#raise-button'].dataset.allin,'true');assert.equal(h.nodes['#raise-button'].textContent,'全下至 200 BB');
  await h.act('raise');assert.deepEqual(h.sent,[{type:'raise',amount:2000}]);money.setDisplayUnit('points');
});

test('unavailable or stale presets cannot silently clamp to a different wager or submit',async()=>{
  const h=harness();h.state.raise=100;h.state.room.actions.maxRaiseTo=150;
  for(const preset of ['third','pot','over','missing']){await h.act('raise-preset',{preset});assert.equal(h.state.raise,100);assert.equal(h.sent.length,0);}
  h.state.raise=151;await h.act('raise');assert.equal(h.sent.length,0);assert.match(h.messages.at(-1),/下注范围已更新/);
  h.state.raise=125.5;await h.act('raise');assert.equal(h.sent.length,0);
  h.state.raise=125;h.state.room.actions.canRaise=false;await h.act('raise');assert.equal(h.sent.length,0);
  money.setDisplayUnit('points');
});

test('single-card clicks carry their original hand id and consult server-published shown indices on every click',async()=>{
  const h=harness(),room=h.state.room,me=room.players[0];room.hand.status='complete';
  await h.act('show-card',{hand:'h1',index:'0'});assert.deepEqual(JSON.parse(JSON.stringify(h.sent)),[{type:'show',indices:[0],handId:'h1'}]);
  me.shownIndices=[0];await h.act('show-card',{hand:'h1',index:'0'});assert.equal(h.sent.length,1);
  await h.act('show-card',{hand:'h1',index:'1'});assert.deepEqual(JSON.parse(JSON.stringify(h.sent[1])),{type:'show',indices:[1],handId:'h1'});
  me.shownIndices=[0,1];await h.act('show-card',{hand:'h1',index:'1'});assert.equal(h.sent.length,2);
  me.shownIndices=[];room.hand={id:'h2',status:'complete'};await h.act('show-card',{hand:'h1',index:'0'});assert.equal(h.sent.length,2);
  room.hand.status='playing';await h.act('show-card',{hand:'h2',index:'0'});assert.equal(h.sent.length,2);
  room.hand.status='complete';for(const index of ['-1','2','NaN','0.5'])await h.act('show-card',{hand:'h2',index});assert.equal(h.sent.length,2);
  money.setDisplayUnit('points');
});

test('a pending reveal keeps the captured old hand id even if the table advances before its response',async()=>{
  const h=harness();h.state.room.hand.status='complete';let resolve;
  h.context.command=(type,payload)=>{h.sent.push({type,...payload});return new Promise(done=>{resolve=done;});};
  const first=h.act('show-card',{hand:'h1',index:'1'});h.state.room.hand={id:'h2',status:'playing'};
  await h.act('show-card',{hand:'h1',index:'0'});resolve(false);await first;
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent)),[{type:'show',indices:[1],handId:'h1'}]);assert.equal(h.messages.length,0);money.setDisplayUnit('points');
});

// Execute the real mutation wrapper as well as the click handler above: a lost
// response must not leave a reusable confirmation for a buy-in that may exist.
function commandHarness({error,online=true,visible=true,modal='buyin',api}={}){
  const state={page:'room',busy:false,connected:true,feedbackResync:false,room:{code:'synthetic-room',hand:{id:'h1',actionSeq:1}},modal:{kind:modal}};
  const events=[],calls=[],messages=[];let ids=0;
  const context=vm.createContext({state,requests:{capture:()=>({valid:()=>true,check(){}})},commandId:()=>`synthetic-command-${++ids}`,
    api:async(path,payload)=>{calls.push({path,payload});if(api)return api(path,payload);throw error;},
    render(){},normalizeState(room){state.room=room;},closeModal(){events.push('close');state.modal=null;},
    connectStream(code){events.push(`reconnect:${code}`);state.connected=false;state.feedbackResync=true;},
    toast:message=>messages.push(message),navigator:{onLine:online},document:{visibilityState:visible?'visible':'hidden'},
  });
  vm.runInContext(section('async function command(','function stopStream('),context);
  return {state,events,calls,messages,command:(type,payload)=>context.command(type,payload)};
}

test('uncertain or conflicting sit and rebuy results dismiss confirmation before resynchronizing without retrying the charge',async()=>{
  for(const type of ['sit','buyin'])for(const problem of [{resync:true},{status:409}]){
    const h=commandHarness({error:Object.assign(new Error('需要重新同步'),problem)});
    assert.equal(await h.command(type,{amountBB:200,...(type==='sit'?{seat:2,entryMode:'wait'}:{})}),false);
    assert.deepEqual(h.events,['close','reconnect:synthetic-room']);assert.equal(h.state.modal,null);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].payload.type,type);assert.equal(h.calls[0].payload.amountBB,200);
    assert.equal(h.state.feedbackResync,true);assert.equal(h.state.busy,false);assert.equal(h.messages.length,1);
  }
});

test('uncertain buy-ins still discard confirmation while offline or hidden, and do not close unrelated dialogs',async()=>{
  for(const blocked of [{online:false},{visible:false}]){
    const h=commandHarness({...blocked,error:Object.assign(new Error('请求结果不明'),{resync:true})});
    await h.command('buyin',{amountBB:200});assert.deepEqual(h.events,['close']);assert.equal(h.state.modal,null);assert.equal(h.calls.length,1);
  }
  const rejected=commandHarness({error:Object.assign(new Error('超过累计上限'),{status:400})});
  await rejected.command('buyin',{amountBB:200});assert.deepEqual(rejected.events,[]);assert.equal(rejected.state.modal.kind,'buyin');
  const unrelated=commandHarness({modal:'hand-library',error:Object.assign(new Error('需要重新同步'),{status:409})});
  await unrelated.command('buyin',{amountBB:200});assert.deepEqual(unrelated.events,['reconnect:synthetic-room']);assert.equal(unrelated.state.modal.kind,'hand-library');
});

test('a pending buy-in admits only one mutation even if confirmation is triggered again before its outcome',async()=>{
  let reject;const h=commandHarness({api:()=>new Promise((resolve,no)=>{reject=no;})});
  const pending=h.command('buyin',{amountBB:200});assert.equal(h.state.busy,true);
  await h.command('buyin',{amountBB:200});assert.equal(h.calls.length,1);
  reject(Object.assign(new Error('响应丢失，需要同步'),{resync:true}));await pending;
  assert.equal(h.calls.length,1);assert.deepEqual(h.events,['close','reconnect:synthetic-room']);assert.equal(h.state.busy,false);
});
