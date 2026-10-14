import test from 'node:test';
import assert from 'node:assert/strict';
import {betPresetOptions,betActionLabel,betAmountBounds,normalizeBetAmount,betAmountFromSlider,betSliderFromAmount,revealOptions,rebuyPrompt} from '../public/table-controls.js';
import {setDisplayUnit} from '../public/money.js';

function room(){return {code:'room-a',meId:'hero',status:'waiting',settings:{bigBlind:10},hand:{id:'hand-a',status:'complete',currentBet:50,pot:105},players:[{id:'hero',bet:20,cards:['As','Kh'],shownIndices:[],inHand:true}],actions:{canRaise:true,callAmount:30,minRaiseTo:100,maxRaiseTo:2000},autoDeal:{paused:false,rebuyGrace:{handId:'hand-a',eligibleIds:['hero','peer'],pendingIds:['hero'],startsAt:5000,endsAt:10000,active:false}}};}

test('fraction presets round the total street bet to the nearest BB and remain usable at the legal minimum',()=>{
  const r=room(),before=JSON.stringify(r),rows=betPresetOptions(r);
  assert.deepEqual(rows.map(({id,amount})=>[id,amount]),[['third',100],['half',120],['two-thirds',140],['pot',190],['over',210],['all',2000]]);
  assert.ok(rows.every(p=>p.available&&Number.isSafeInteger(p.amount)&&p.amount%10===0));
  assert.equal(JSON.stringify(r),before);
  r.hand.currentBet=0;r.hand.pot=101;r.players[0].bet=0;r.actions.callAmount=0;r.actions.minRaiseTo=10;
  assert.deepEqual(betPresetOptions(r).filter(p=>p.id!=='all').map(p=>p.amount),[30,50,70,100,120]);
  r.hand.pot=1;
  assert.ok(betPresetOptions(r).filter(p=>p.id!=='all').every(p=>p.available&&p.amount===10));
});

test('initial half-blind call has an available third-pot shortcut and never changes the call amount',()=>{
  const r=room();r.players[0].bet=5;r.actions.callAmount=5;r.actions.minRaiseTo=20;r.hand.pot=15;r.hand.currentBet=10;
  const before=JSON.stringify(r),rows=betPresetOptions(r);
  assert.deepEqual(rows.map(p=>p.amount),[20,20,20,30,30,2000]);
  assert.ok(rows.every(p=>p.available));assert.equal(JSON.stringify(r),before);
  assert.ok(!rows.some(p=>p.id==='min'));
});

test('oversize presets become an exact all-in including a fractional BB balance',()=>{
  const r=room();r.actions.maxRaiseTo=155;const rows=betPresetOptions(r);
  assert.ok(rows.every(p=>p.available));
  assert.deepEqual(rows.map(p=>p.amount),[100,120,140,155,155,155]);
  assert.equal(betActionLabel(r,155),'全下至');assert.equal(betActionLabel(r,120),'加至');
  r.hand.currentBet=0;assert.equal(betActionLabel(r,120),'下注');assert.equal(betActionLabel(r,155),'全下至');
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
