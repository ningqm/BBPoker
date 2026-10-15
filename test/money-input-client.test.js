import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as money from '../public/money.js';
import {betActionLabel,betPresetOptions,betSubmission,normalizeBetAmount,betAmountFromSlider,betSliderFromAmount,betSelection,syncBetControls,betTurnKey,betSliderKeyPosition,betAmountFromKey,betActionEnabled,revealOptions} from '../public/table-controls.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)+a.length));
function harness(unit='bb') {
  money.setDisplayUnit(unit);
  const state={raise:20,connected:true,feedbackResync:false,room:{code:'room-a',meId:'hero',settings:{bigBlind:10},hand:{id:'h1',status:'playing',actionSeq:1,actingId:'hero',currentBet:10,pot:105},players:[{id:'hero',bet:20,stack:1980,inHand:true,cards:['As','Kh'],shownIndices:[]}],actions:{canAct:true,canRaise:true,callAmount:30,minRaiseTo:100,maxRaiseTo:2000}}};
  const nodes={'#raise-range':{value:0,setAttribute(key,value){this[key]=value;},focus(){this.focused=true;}},'#raise-button':{dataset:{}},'#raise-amount':{},'#raise-panel':{hidden:true},'#raise-toggle':{setAttribute(key,value){this[key]=value;},focus(){this.focused=true;}}};
  const listeners=new Map(),sent=[],messages=[],presets=['third','half','two-thirds','pot'].map(preset=>({dataset:{preset},setAttribute(key,value){this[key]=value;},classList:{toggle(key,value){this[key]=value;}}}));
  const context=vm.createContext({...money,state,betActionLabel,betPresetOptions,betSubmission,normalizeBetAmount,betAmountFromSlider,betSliderFromAmount,betSelection,syncBetControls,betTurnKey,betSliderKeyPosition,betAmountFromKey,betActionEnabled,revealOptions,Math,Number,$:s=>nodes[s],esc:String,
    document:{querySelectorAll:selector=>selector==='[data-action="raise-preset"]'?presets:[],addEventListener:(type,listener)=>listeners.set(type,listener)},updateSettingConstraints(){},updateBuyinSummary(){},chips:n=>money.formatChips(n,10),toast:message=>messages.push(message),
    command:async(type,payload)=>{sent.push({type,...payload});return true;}});
  vm.runInContext(section('function setRaise(','document.addEventListener('),context);
  vm.runInContext(section('async function handleAction(','function setRaise('),context);
  vm.runInContext(section("document.addEventListener('input'","document.addEventListener('change'"),context);
  vm.runInContext(section("document.addEventListener('keydown',event=>{if(event.key===","document.addEventListener('pointerup'"),context);
  vm.runInContext(section("document.addEventListener('pointerdown',event=>{if(state.raisePanelOpen","document.addEventListener('keydown'"),context);
  state.raiseTurnKey=betTurnKey(state.room);
  return {state,nodes,context,sent,messages,presets,listeners,input:value=>listeners.get('input')({target:{id:'raise-range',value:String(value),dataset:{}}}),act:(action,data={})=>context.handleAction({dataset:{action,...(action==='raise'?nodes['#raise-button'].dataset:{}),...data}})};
}

function quote(h,preset){const p=betPresetOptions(h.state.room).find(p=>p.id===preset);return {preset,betTurn:betTurnKey(h.state.room),amount:String(p.amount)};}
async function custom(h){await h.act('toggle-raise-panel');h.context.setRaise(h.state.raise);}

test('one preset click submits its displayed whole-BB total in either display unit',async()=>{
  for(const unit of ['bb','points']) {
    const h=harness(unit);await h.act('raise-preset',quote(h,'half'));
    assert.deepEqual(h.sent,[{type:'raise',amount:120}]);assert.equal(h.state.raisePanelOpen,false);
  }
  money.setDisplayUnit('points');
});

test('changing display units keeps the chosen amount and exact all-in ceiling inside the custom picker',async()=>{
  const h=harness('points');h.state.room.actions.maxRaiseTo=2005;await custom(h);h.context.setRaise(125);assert.equal(h.nodes['#raise-range']['aria-valuetext'],'加至 130 积分');
  money.setDisplayUnit('bb');h.context.setRaise(h.state.raise);assert.equal(h.state.raise,130);assert.equal(h.nodes['#raise-range']['aria-valuetext'],'加至 13 BB');
  h.input(1000);assert.equal(h.state.raise,2005);assert.equal(h.nodes['#raise-button'].dataset.allin,'true');assert.equal(h.nodes['#raise-button'].textContent,'All-in 200.5 BB');assert.equal(h.sent.length,0);
  money.setDisplayUnit('points');h.context.setRaise(h.state.raise);assert.equal(h.nodes['#raise-button'].textContent,'All-in 2,005 积分');
  await h.act('raise');assert.deepEqual(h.sent,[{type:'raise',amount:2005}]);assert.equal(h.state.raisePanelOpen,false);
});

test('rounded and clamped presets submit once per click and unknown or unavailable actions never submit',async()=>{
  for(const [preset,amount] of [['third',100],['half',120],['two-thirds',140],['pot',155]]){
    const h=harness();h.state.room.actions.maxRaiseTo=155;
    await h.act('raise-preset',quote(h,preset));assert.deepEqual(h.sent,[{type:'raise',amount}]);
  }
  const h=harness();
  for(const preset of ['min','over','all','missing'])await h.act('raise-preset',{preset,betTurn:betTurnKey(h.state.room),amount:'120'});
  assert.equal(h.sent.length,0);const old=quote(h,'pot');h.state.room.actions.canRaise=false;await h.act('raise-preset',old);assert.equal(h.sent.length,0);
  money.setDisplayUnit('points');
});

test('submission rejects stale bounds, stale custom amounts and off-grid targets without changing the wager',async()=>{
  const h=harness();h.state.room.actions.maxRaiseTo=155;await custom(h);
  for(const amount of [99,156,125.5,125,NaN,Infinity]){
    h.state.raise=amount;await h.act('raise',{amount:String(amount),betTurn:betTurnKey(h.state.room)});assert.equal(h.sent.length,0);
    assert.match(h.messages.at(-1),/下注范围已更新/);
  }
  h.state.raise=120;h.state.room.actions.minRaiseTo=125;await h.act('raise',{amount:'120',betTurn:betTurnKey(h.state.room)});assert.equal(h.sent.length,0);
  h.state.raise=130;await h.act('raise',{amount:'140',betTurn:betTurnKey(h.state.room)});assert.equal(h.sent.length,0);
  h.state.room.actions.canRaise=false;await h.act('raise',{amount:'130',betTurn:betTurnKey(h.state.room)});assert.equal(h.sent.length,0);
  money.setDisplayUnit('points');
});

test('dragging and keyboard changes only update the custom quote; its one submit commits the shown amount',async()=>{
  const h=harness();h.state.room.actions.maxRaiseTo=2005;await custom(h);
  for(const position of [0,250,500,750,999,1000]){
    h.input(position);assert.equal(h.sent.length,0);
    assert.ok(h.state.raise===2005||h.state.raise%10===0);
    assert.equal(h.nodes['#raise-range'].value,betSliderFromAmount(h.state.room,h.state.raise));
  }
  assert.equal(h.state.raise,2005);assert.equal(h.nodes['#raise-button'].textContent,'All-in 200.5 BB');
  await h.act('raise');assert.deepEqual(h.sent,[{type:'raise',amount:2005}]);
  await h.act('raise');assert.equal(h.sent.length,1,'closed picker cannot submit a second time');
  money.setDisplayUnit('points');
});

test('half-BB calls keep their exact amount while a third-pot direct wager rounds to the legal raise minimum',async()=>{
  const h=harness(),r=h.state.room;r.hand.currentBet=10;r.hand.pot=15;r.players[0].bet=5;
  r.actions.callAmount=5;r.actions.minRaiseTo=20;
  await h.act('raise-preset',quote(h,'third'));assert.deepEqual(h.sent,[{type:'raise',amount:20}]);assert.equal(r.actions.callAmount,5);
  const caller=harness();caller.state.room.actions.callAmount=5;await caller.act('call');assert.deepEqual(caller.sent,[{type:'call'}]);money.setDisplayUnit('points');
});

test('fresh table snapshots align an old selection to new legal BB bounds while preserving exact all-in',()=>{
  const h=harness();h.state.user={id:'hero'};
  Object.assign(h.context,{captureRoomChanges(){},rememberCommitment:()=>false,render(){}});
  vm.runInContext(section('function normalizeState(','async function command('),h.context);
  h.state.raise=125;h.context.normalizeState(structuredClone(h.state.room));assert.equal(h.state.raise,130);
  const raised=structuredClone(h.state.room);raised.actions.minRaiseTo=135;raised.actions.maxRaiseTo=155;
  h.context.normalizeState(raised);assert.equal(h.state.raise,140);
  const short=structuredClone(h.state.room);short.actions.minRaiseTo=100;short.actions.maxRaiseTo=125;
  h.context.normalizeState(short);assert.equal(h.state.raise,125);assert.equal(h.sent.length,0);
  const next=structuredClone(h.state.room);next.hand.id='next-hand';next.actions.minRaiseTo=20;next.actions.maxRaiseTo=2000;
  h.context.normalizeState(next);assert.equal(h.state.raise,20);assert.equal(h.sent.length,0);
  money.setDisplayUnit('points');
});

test('single-card clicks carry their original hand id and consult server-published shown indices on every click',async()=>{
  const h=harness(),room=h.state.room,me=room.players[0];room.hand.status='complete';
  await h.act('show-card',{hand:'h1',index:'0'});assert.deepEqual(JSON.parse(JSON.stringify(h.sent)),[{type:'show',indices:[0],handId:'h1'}]);
  assert.equal(h.messages.length,0,'successful reveals use the card animation without a toast');
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

test('equally clamped presets are independent direct actions, with no selected shortcut state',async()=>{
  for(const preset of ['two-thirds','pot']){
    const h=harness();h.state.room.actions.maxRaiseTo=125;await h.act('raise-preset',quote(h,preset));
    assert.deepEqual(h.sent,[{type:'raise',amount:125}]);assert.equal(h.presets.filter(p=>p.classList.selected).length,0);
  }
  money.setDisplayUnit('points');
});

test('old displayed preset totals and old-turn nodes never silently become a new bet',async()=>{
  for(const change of [r=>r.hand.actionSeq++,r=>r.hand.id='h2',r=>r.hand.actingId='other',r=>r.code='elsewhere',r=>r.hand.pot+=300,r=>r.actions.maxRaiseTo=110,r=>r.actions.canAct=false,r=>r.hand.runout={active:true}]){
    const h=harness(),old=quote(h,'half');change(h.state.room);await h.act('raise-preset',old);assert.equal(h.sent.length,0);
  }
  for(const flag of ['busy','feedbackResync']){const h=harness();h.state[flag]=true;await h.act('raise-preset',quote(h,'half'));assert.equal(h.sent.length,0);}
  const h=harness();h.state.connected=false;await h.act('raise-preset',quote(h,'half'));assert.equal(h.sent.length,0);money.setDisplayUnit('points');
});

test('rapid repeated direct bets share the real mutation lock and an advanced action rejects the old button',async()=>{
  const h=harness(),data=quote(h,'half');let resolve;
  Object.assign(h.context,{requests:{capture:()=>({valid:()=>true,check(){}})},commandId:()=> 'synthetic-one-click',render(){},
    api:async(path,payload)=>{h.sent.push({...payload});return new Promise(done=>{resolve=done;});},
    normalizeState(room){h.state.room=room;}});
  vm.runInContext(section('async function command(','function stopStream('),h.context);
  const first=h.act('raise-preset',data);assert.equal(h.state.busy,true);
  await h.act('raise-preset',data);assert.equal(h.sent.length,1);assert.equal(h.sent[0].amount,120);assert.equal(h.sent[0].actionSeq,1);assert.equal(h.sent[0].handId,'h1');
  resolve({room:{...h.state.room,hand:{...h.state.room.hand,actionSeq:2}}});await first;
  await h.act('raise-preset',data);assert.equal(h.sent.length,1);money.setDisplayUnit('points');
});

test('a legal short-stack all-in has its own exact quote and cannot exceed an unopened raise right',async()=>{
  const h=harness(),r=h.state.room;r.hand.currentBet=100;r.actions={...r.actions,canRaise:false,canAllIn:true,minRaiseTo:200,maxRaiseTo:155};
  const data={amount:'155',betTurn:betTurnKey(r)};await h.act('allin',data);assert.deepEqual(h.sent,[{type:'allin'}]);
  r.actions.canAllIn=false;await h.act('allin',data);assert.equal(h.sent.length,1);money.setDisplayUnit('points');
});

test('amount panel is a reversible preview: open, keyboard adjust, Escape, and outside press never submit',async()=>{
  const h=harness();await h.act('toggle-raise-panel');h.context.setRaise(h.state.room.actions.minRaiseTo);
  assert.equal(h.state.raisePanelOpen,true);assert.equal(h.nodes['#raise-panel'].hidden,false);assert.equal(h.nodes['#raise-toggle']['aria-expanded'],'true');assert.equal(h.nodes['#raise-range'].focused,true);
  const key=event=>h.listeners.get('keydown')({target:{id:'raise-range',value:h.nodes['#raise-range'].value},preventDefault(){this.prevented=true;},...event});
  key({key:'ArrowUp'});assert.equal(h.state.raise,110);key({key:'ArrowRight'});assert.equal(h.state.raise,120);key({key:'ArrowDown'});assert.equal(h.state.raise,110);
  key({key:'End'});assert.equal(h.state.raise,2000);assert.equal(h.sent.length,0);
  key({key:'Escape'});assert.equal(h.state.raisePanelOpen,false);assert.equal(h.nodes['#raise-panel'].hidden,true);assert.equal(h.nodes['#raise-toggle'].focused,true);
  await h.act('toggle-raise-panel');h.listeners.get('pointerdown')({target:{id:'raise-range',closest:()=>({})}});assert.equal(h.state.raisePanelOpen,true);
  h.listeners.get('pointerdown')({target:{id:'table',closest:()=>null}});assert.equal(h.state.raisePanelOpen,false);assert.equal(h.sent.length,0);
  money.setDisplayUnit('points');
});

test('a stale turn or lost connection cannot open the amount panel or submit its old raise',async()=>{
  const h=harness();h.state.room.actions.canAct=false;
  await h.act('toggle-raise-panel');assert.equal(h.state.raisePanelOpen,false);await h.act('raise');assert.equal(h.sent.length,0);
  h.state.room.actions.canAct=true;h.state.connected=false;await h.act('toggle-raise-panel');assert.equal(h.state.raisePanelOpen,false);
  h.state.connected=true;h.state.busy=true;await h.act('toggle-raise-panel');assert.equal(h.state.raisePanelOpen,false);
  money.setDisplayUnit('points');
});
