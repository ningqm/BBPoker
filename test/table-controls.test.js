import test from 'node:test';
import assert from 'node:assert/strict';
import {betPresetOptions,betActionLabel,betAmountBounds,normalizeBetAmount,betAmountFromSlider,betSliderFromAmount,revealOptions,rebuyPrompt,betSelection,syncBetControls,betTurnKey,betSliderKeyPosition,betActionEnabled} from '../public/table-controls.js';
import {setDisplayUnit} from '../public/money.js';

function room(){return {code:'room-a',meId:'hero',status:'waiting',settings:{bigBlind:10},hand:{id:'hand-a',status:'complete',currentBet:50,pot:105},players:[{id:'hero',bet:20,cards:['As','Kh'],shownIndices:[],inHand:true}],actions:{canRaise:true,callAmount:30,minRaiseTo:100,maxRaiseTo:2000},autoDeal:{paused:false,rebuyGrace:{handId:'hand-a',eligibleIds:['hero','peer'],pendingIds:['hero'],startsAt:5000,endsAt:10000,active:false}}};}

test('fraction presets round the total street bet to the nearest BB and remain usable at the legal minimum',()=>{
  const r=room(),before=JSON.stringify(r),rows=betPresetOptions(r);
  assert.deepEqual(rows.map(({id,amount})=>[id,amount]),[['third',100],['half',120],['two-thirds',140],['pot',190]]);
  assert.ok(rows.every(p=>p.available&&Number.isSafeInteger(p.amount)&&p.amount%10===0));
  assert.equal(JSON.stringify(r),before);
  r.hand.currentBet=0;r.hand.pot=101;r.players[0].bet=0;r.actions.callAmount=0;r.actions.minRaiseTo=10;
  assert.deepEqual(betPresetOptions(r).map(p=>p.amount),[30,50,70,100]);
  r.hand.pot=1;
  assert.ok(betPresetOptions(r).every(p=>p.available&&p.amount===10));
});

test('initial half-blind call has an available third-pot shortcut and never changes the call amount',()=>{
  const r=room();r.players[0].bet=5;r.actions.callAmount=5;r.actions.minRaiseTo=20;r.hand.pot=15;r.hand.currentBet=10;
  const before=JSON.stringify(r),rows=betPresetOptions(r);
  assert.deepEqual(rows.map(p=>p.amount),[20,20,20,30]);
  assert.ok(rows.every(p=>p.available));assert.equal(JSON.stringify(r),before);
  assert.ok(!rows.some(p=>p.id==='min'));
});

test('oversize presets become an exact all-in including a fractional BB balance',()=>{
  const r=room();r.actions.maxRaiseTo=155;const rows=betPresetOptions(r);
  assert.ok(rows.every(p=>p.available));
  assert.deepEqual(rows.map(p=>p.amount),[100,120,140,155]);
  assert.equal(betActionLabel(r,155),'All-in');assert.equal(betActionLabel(r,120),'加至');
  r.hand.currentBet=0;assert.equal(betActionLabel(r,120),'下注');assert.equal(betActionLabel(r,155),'All-in');
  r.actions.canRaise=false;r.actions.canAllIn=true;assert.deepEqual(betPresetOptions(r),[]);
});

test('minimum rounds upward to legal full BB after fractional legacy action or short all-in',()=>{
  const r=room();r.actions.minRaiseTo=125;r.actions.maxRaiseTo=155;
  assert.deepEqual(betAmountBounds(r),{minimum:130,maximum:155,bigBlind:10});
  assert.equal(normalizeBetAmount(r,125),130);assert.equal(normalizeBetAmount(r,134),130);assert.equal(normalizeBetAmount(r,135),140);
  assert.equal(normalizeBetAmount(r,154),150);assert.equal(normalizeBetAmount(r,155),155);assert.equal(normalizeBetAmount(r,1000),155);
  r.actions.minRaiseTo=151;
  assert.deepEqual(betAmountBounds(r),{minimum:155,maximum:155,bigBlind:10});
  assert.ok(betPresetOptions(r).every(p=>p.available&&p.amount===155));
  assert.equal(betAmountFromSlider(r,0),155);assert.equal(betAmountFromSlider(r,1000),155);
});

test('all slider positions select monotonically increasing whole BB totals or exact all-in',()=>{
  for(const [blind,min,max] of [[10,20,10005],[5,13,507],[100,100,10000],[3,5,301]]){
    const r=room();r.settings.bigBlind=blind;r.actions.minRaiseTo=min;r.actions.maxRaiseTo=max;
    const before=JSON.stringify(r),amounts=Array.from({length:1001},(_,position)=>betAmountFromSlider(r,position));
    assert.equal(amounts[0],Math.ceil(min/blind)*blind);assert.equal(amounts.at(-1),max);
    for(let i=0;i<amounts.length;i++){
      assert.ok(Number.isSafeInteger(amounts[i])&&amounts[i]>=min&&amounts[i]<=max);
      assert.ok(amounts[i]===max||amounts[i]%blind===0);
      if(i)assert.ok(amounts[i]>=amounts[i-1]);
    }
    assert.equal(betSliderFromAmount(r,amounts[0]),0);assert.equal(betSliderFromAmount(r,max),1000);
    assert.equal(betAmountFromSlider(r,-100),amounts[0]);assert.equal(betAmountFromSlider(r,1001),max);
    assert.equal(JSON.stringify(r),before);
  }
});

test('slider retains a gentle start and quick finish and inverse preserves reachable amounts',()=>{
  const r=room();r.actions.minRaiseTo=20;r.actions.maxRaiseTo=10005;
  assert.ok(betAmountFromSlider(r,900)-betAmountFromSlider(r,800)>betAmountFromSlider(r,200)-betAmountFromSlider(r,100));
  for(const amount of [20,30,40,50,100,200,10005])assert.equal(betAmountFromSlider(r,betSliderFromAmount(r,amount)),amount);
  assert.equal(normalizeBetAmount(r,NaN),20);assert.equal(normalizeBetAmount(r,Infinity),20);
  assert.equal(normalizeBetAmount(r,-100),20);
});

test('invalid or unavailable raise bounds cannot produce usable shortcuts',()=>{
  assert.equal(betAmountBounds(null),null);assert.equal(normalizeBetAmount(null,100),0);
  assert.equal(betAmountFromSlider(null,500),0);assert.equal(betSliderFromAmount(null,100),0);
  for(const mutate of [r=>r.actions.canRaise=false,r=>r.actions.minRaiseTo=2010,r=>r.actions.maxRaiseTo=0,r=>r.actions.minRaiseTo=NaN,r=>r.actions.maxRaiseTo=100.5]){
    const r=room();mutate(r);assert.equal(betAmountBounds(r),null);assert.deepEqual(betPresetOptions(r),[]);
  }
});

test('display preferences never affect integer-point preset and slider calculations',()=>{
  const r=room();setDisplayUnit('bb');const bb=betPresetOptions(r),amount=betAmountFromSlider(r,412);setDisplayUnit('points');
  assert.deepEqual(betPresetOptions(r),bb);assert.equal(betAmountFromSlider(r,412),amount);
});

test('reveal permissions are per-card server state, restricted to own completed dealt hand including a closed table',()=>{
  const r=room(),me=r.players[0];let rows=revealOptions(r,me);
  assert.deepEqual(rows.map(p=>[p.index,p.shown,p.canReveal]),[[0,false,true],[1,false,true]]);
  me.shownIndices=[1];rows=revealOptions(r,me);assert.deepEqual(rows.map(p=>[p.index,p.shown,p.canReveal]),[[0,false,true],[1,true,false]]);
  r.status='closed';me.seat=null;assert.equal(revealOptions(r,me)[0].canReveal,true);
  for(const change of [()=>r.hand.status='playing',()=>{r.hand.status='complete';me.inHand=false;},()=>{me.inHand=true;r.meId='peer';}]){change();assert.ok(revealOptions(r,me).every(p=>!p.canReveal));}
  r.meId='hero';me.cards=[null,'Kh'];assert.equal(revealOptions(r,me)[0].canReveal,false);
});

test('rebuy prompt uses exact server window boundaries and a stable identity/room/hand key',()=>{
  const r=room(),before=JSON.stringify(r);
  assert.equal(rebuyPrompt(r,4999).active,false);assert.equal(rebuyPrompt(r,5000).active,true);
  assert.equal(rebuyPrompt(r,5000).remaining,5);assert.equal(rebuyPrompt(r,9999).remaining,1);assert.equal(rebuyPrompt(r,10000).active,false);assert.equal(rebuyPrompt(r,10000).remaining,0);
  assert.equal(rebuyPrompt(r,100000).remaining,0);assert.equal(rebuyPrompt(r,5000).key,rebuyPrompt(r,9999).key);assert.equal(JSON.stringify(r),before);
  const original=rebuyPrompt(r,5000).key;r.code='room-b';assert.notEqual(rebuyPrompt(r,5000).key,original);
});

test('rebuy prompt ignores spectators, replenished stacks, pauses, wrong hands and closed/playing tables',()=>{
  for(const mutate of [r=>r.meId='observer',r=>r.autoDeal.rebuyGrace.pendingIds=[],r=>r.autoDeal.paused=true,r=>r.hand.id='another',r=>r.status='closed',r=>r.hand.status='playing']){
    const r=room();mutate(r);assert.equal(rebuyPrompt(r,6000),null);
  }
  assert.equal(rebuyPrompt(null,6000),null);
});

test('rounded presets remain distinct selections and removed shortcut identities are discarded',()=>{
  const r=room();r.players[0].bet=5;r.actions.callAmount=5;r.actions.minRaiseTo=20;r.hand.pot=15;
  const third=betPresetOptions(r).find(p=>p.id==='third'),half=betPresetOptions(r).find(p=>p.id==='half');
  assert.equal(third.amount,half.amount);
  assert.deepEqual(betSelection(r,third.amount,'third'),{amount:20,preset:'third'});
  assert.deepEqual(betSelection(r,half.amount,'half'),{amount:20,preset:'half'});
  assert.deepEqual(betSelection(r,half.amount),{amount:20,preset:null});
  r.actions.maxRaiseTo=20;
  assert.ok(betPresetOptions(r).every(p=>p.amount===20));
  for(const preset of ['third','half','two-thirds','pot'])assert.equal(betSelection(r,20,preset).preset,preset);
  for(const preset of ['over','all'])assert.equal(betSelection(r,20,preset).preset,null);
});

test('a selected preset and slider remain stable through chat/presence updates in the same action',()=>{
  const r=room();r.hand.status='playing';r.hand.actionSeq=12;r.hand.actingId='hero';r.actions.canAct=true;
  const first=syncBetControls(r,{});assert.equal(first.amount,100);assert.equal(first.panelOpen,false);
  const selected={...first,...betSelection(r,190,'pot'),panelOpen:true};
  r.revision=34;r.chat=[{id:'new-chat'}];r.players.push({id:'observer',seat:null});
  assert.deepEqual(syncBetControls(r,selected),selected);
  r.actions.canUseTimeBank=false;r.deadline=20000;
  assert.deepEqual(syncBetControls(r,selected),selected);
});

test('stale actor, hand, action or permissions close the amount panel and clear its preset',()=>{
  for(const mutate of [r=>r.hand.actingId='other',r=>r.hand.actionSeq++,r=>r.hand.id='new',r=>r.code='other',r=>r.actions.canAct=false,r=>r.hand.status='complete',r=>r.hand.runout={active:true}]){
    const r=room();r.hand.status='playing';r.hand.actionSeq=4;r.hand.actingId='hero';r.actions.canAct=true;
    const old={key:betTurnKey(r),amount:190,preset:'pot',panelOpen:true};mutate(r);
    const next=syncBetControls(r,old);assert.equal(next.panelOpen,false);assert.equal(next.preset,null);
  }
  const r=room();r.hand.status='playing';r.hand.actingId='hero';r.actions.canAct=true;
  const old={key:betTurnKey(r),amount:190,preset:'pot',panelOpen:true};r.actions.canRaise=false;
  const next=syncBetControls(r,old);assert.equal(next.panelOpen,false);assert.equal(next.amount,0);assert.equal(next.preset,null);
});

test('changed limits invalidate a selected amount without choosing another matching preset',()=>{
  const r=room();r.hand.status='playing';r.hand.actionSeq=3;r.hand.actingId='hero';r.actions.canAct=true;
  const old={key:betTurnKey(r),amount:190,preset:'pot',panelOpen:true};
  r.hand.pot=1;
  assert.equal(syncBetControls(r,old).preset,null);
  r.actions.maxRaiseTo=150;
  const next=syncBetControls(r,old);assert.equal(next.amount,150);assert.equal(next.preset,null);
});

test('vertical slider keyboard direction and boundaries are explicit and safe',()=>{
  assert.equal(betSliderKeyPosition('ArrowUp',500),510);assert.equal(betSliderKeyPosition('ArrowDown',500),490);
  assert.equal(betSliderKeyPosition('ArrowRight',500),510);assert.equal(betSliderKeyPosition('ArrowLeft',500),490);
  assert.equal(betSliderKeyPosition('PageUp',500),600);assert.equal(betSliderKeyPosition('PageDown',500),400);
  assert.equal(betSliderKeyPosition('Home',500),0);assert.equal(betSliderKeyPosition('End',500),1000);
  assert.equal(betSliderKeyPosition('ArrowDown',0),0);assert.equal(betSliderKeyPosition('ArrowUp',1000),1000);
  assert.equal(betSliderKeyPosition('Tab',500),null);
});

test('connection refresh cannot enable off-turn or presentation-delayed action buttons',()=>{
  const r=room();r.hand.status='playing';r.actions={...r.actions,canAct:true,canFold:true,canCheck:false,canAllIn:true,canUseTimeBank:true};
  for(const action of ['fold','call','raise','allin','timebank','raise-preset','toggle-raise-panel'])assert.equal(betActionEnabled(r,action),true);
  assert.equal(betActionEnabled(r,'check'),false);
  r.actions.canAct=false;r.actions.turnAvailable=true;
  for(const action of ['fold','check','call','raise','allin','timebank','raise-preset','toggle-raise-panel'])assert.equal(betActionEnabled(r,action),false);
  r.actions.canAct=true;r.status='closed';assert.equal(betActionEnabled(r,'fold'),false);
});
