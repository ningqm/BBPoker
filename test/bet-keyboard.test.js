import test from 'node:test';
import assert from 'node:assert/strict';
import {betAmountFromKey} from '../public/table-controls.js';

function room(maximum=2000,minimum=20,bigBlind=10){
  return {settings:{bigBlind},actions:{canRaise:true,minRaiseTo:minimum,maxRaiseTo:maximum}};
}

test('repeated arrow presses leave the minimum and move exactly one legal BB',()=>{
  for(const maximum of [100,155,200,500,1000,2000,5000,10000]){
    const r=room(maximum);let value=20;
    for(const key of ['ArrowUp','ArrowRight','ArrowUp','ArrowRight'])value=betAmountFromKey(r,key,value);
    assert.equal(value,60,`maximum ${maximum}: four presses from 2 BB must reach 6 BB`);
    for(const key of ['ArrowDown','ArrowLeft','ArrowDown','ArrowLeft'])value=betAmountFromKey(r,key,value);
    assert.equal(value,20);
  }
});

test('keyboard all-in can include a partial BB and one down step exits it',()=>{
  const r=room(155);
  assert.equal(betAmountFromKey(r,'ArrowUp',150),155);
  assert.equal(betAmountFromKey(r,'ArrowUp',155),155);
  assert.equal(betAmountFromKey(r,'ArrowDown',155),150);
  assert.equal(betAmountFromKey(r,'End',20),155);
  assert.equal(betAmountFromKey(r,'Home',155),20);
  assert.equal(betAmountFromKey(r,'PageUp',20),120);
  assert.equal(betAmountFromKey(r,'PageDown',155),60);
});

test('keyboard movement respects changed legal minimums and exact all-in-only bounds',()=>{
  const r=room(515,125);
  assert.equal(betAmountFromKey(r,'Home',130),130);
  assert.equal(betAmountFromKey(r,'ArrowDown',130),130);
  assert.equal(betAmountFromKey(r,'ArrowUp',130),140);
  assert.equal(betAmountFromKey(r,'PageDown',230),130);
  const allInOnly=room(155,155);
  for(const key of ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'])assert.equal(betAmountFromKey(allInOnly,key,155),155);
  assert.equal(betAmountFromKey({...r,actions:{...r.actions,canRaise:false}},'ArrowUp',130),null);
  assert.equal(betAmountFromKey(r,'Escape',130),null);
});
