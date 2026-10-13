import test from 'node:test';
import assert from 'node:assert/strict';
import {betPresetOptions,betActionLabel,revealOptions,rebuyPrompt} from '../public/table-controls.js';
import {setDisplayUnit} from '../public/money.js';

function room(){return {code:'room-a',meId:'hero',status:'waiting',hand:{id:'hand-a',status:'complete',currentBet:50,pot:105},players:[{id:'hero',bet:20,cards:['As','Kh'],shownIndices:[],inHand:true}],actions:{canRaise:true,callAmount:30,minRaiseTo:100,maxRaiseTo:2000},autoDeal:{paused:false,rebuyGrace:{handId:'hand-a',eligibleIds:['hero','peer'],pendingIds:['hero'],startsAt:5000,endsAt:10000,active:false}}};}

test('facing a bet, fractions include the call and return a total street bet, rounded down only once',()=>{
  const r=room(),before=JSON.stringify(r),rows=betPresetOptions(r);
  assert.deepEqual(rows.map(({id,amount})=>[id,amount]),[['min',100],['third',95],['half',117],['two-thirds',140],['pot',185],['over',212],['all',2000]]);
  assert.equal(rows.find(p=>p.id==='third').available,false);
  assert.ok(rows.every(p=>Number.isSafeInteger(p.amount)));assert.equal(JSON.stringify(r),before);
  r.hand.currentBet=0;r.hand.pot=101;r.players[0].bet=0;r.actions.callAmount=0;r.actions.minRaiseTo=10;
  assert.deepEqual(betPresetOptions(r).filter(p=>!['min','all'].includes(p.id)).map(p=>p.amount),[33,50,67,101,121]);
});

test('preset bounds disable impossible fractions without relabeling a clamped amount; short all-ins have no normal raise presets',()=>{
  const r=room();r.actions.maxRaiseTo=150;const rows=betPresetOptions(r);
  assert.deepEqual(rows.filter(p=>p.available).map(p=>p.id),['min','half','two-thirds','all']);
  assert.equal(rows.find(p=>p.id==='pot').amount,185);
  r.actions.canRaise=false;r.actions.canAllIn=true;assert.deepEqual(betPresetOptions(r),[]);
  assert.equal(betActionLabel(r,150),'全下至');assert.equal(betActionLabel(r,117),'加至');
  r.hand.currentBet=0;assert.equal(betActionLabel(r,117),'下注');assert.equal(betActionLabel(r,150),'全下至');
});

test('display preferences never affect integer-point preset calculations',()=>{
  const r=room();setDisplayUnit('bb');const bb=betPresetOptions(r);setDisplayUnit('points');assert.deepEqual(betPresetOptions(r),bb);
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
