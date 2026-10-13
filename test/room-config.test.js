import test from 'node:test';
import assert from 'node:assert/strict';
import {reusableRoomSettings} from '../public/room-config.js';
import {settingsFor,DEFAULTS} from '../src/room.js';
const defaults={maxPlayers:9,smallBlind:5,bigBlind:10,minBuyInBB:100,maxBuyInBB:1000,maxTotalBuyInBB:null,actionSeconds:15,squid:false,squidUnitBB:2,bombPot:false,bombIntervalMinutes:10,bombAnteBB:2,durationMinutes:60,timeBankCards:3,timeBankSeconds:30};
test('reusing a room copies all supported options but none of its private or running state',()=>{
  const original={...settingsFor({maxPlayers:6,smallBlind:2,bigBlind:5,minBuyInBB:100,maxBuyInBB:1000,maxTotalBuyInBB:2500,actionSeconds:45,squid:true,squidUnitBB:3,bombPot:true,bombIntervalMinutes:8,bombAnteBB:4,durationMinutes:90,timeBankCards:5,timeBankSeconds:60}),invite:'secret',hostId:'private',code:'654321',name:'old name',hand:{cards:['As']},players:[{id:'private'}],startedAt:1,endsAt:2,approvalRequired:true,mushroom:true};
  const result=reusableRoomSettings(original,defaults);
  assert.deepEqual(Object.keys(result),Object.keys(defaults));
  for(const key of Object.keys(defaults))assert.equal(result[key],original[key]);
  assert.equal(result.maxTotalBuyInBB,2500);assert.equal(result.timeBankCards,5);
  assert.doesNotThrow(()=>settingsFor(result));result.smallBlind=1;assert.equal(original.smallBlind,2);assert.equal(defaults.smallBlind,5);
});
test('old point-based rooms get current defaults and whole-BB values without resurrecting retired options',()=>{
  const result=reusableRoomSettings({smallBlind:2,bigBlind:5,minBuyIn:203,maxBuyIn:1003,squidUnit:13,squid:true,mushroom:true},defaults);
  assert.equal(result.minBuyInBB,100);assert.equal(result.maxBuyInBB,1000);assert.equal(result.squidUnitBB,3);
  assert.equal(result.durationMinutes,60);assert.equal(result.bombPot,false);assert.equal(result.timeBankCards,3);assert.equal(result.mushroom,undefined);
  assert.doesNotThrow(()=>settingsFor(result));
  assert.equal(reusableRoomSettings({smallBlind:5,bigBlind:10,minBuyIn:200,maxBuyIn:null},defaults).maxTotalBuyInBB,null);
});
test('legacy projections with fractional BB values are rounded consistently and unlimited caps survive',()=>{
  const result=reusableRoomSettings({...DEFAULTS,minBuyInBB:20.3,maxBuyInBB:100.7,squidUnitBB:1.5},defaults);
  assert.equal(result.minBuyInBB,100);assert.equal(result.maxBuyInBB,1000);assert.equal(result.squidUnitBB,2);assert.doesNotThrow(()=>settingsFor(result));
});
test('invalid or hostile settings fail without a partial configuration or mutating defaults',()=>{
  for(const input of [null,[],{bigBlind:0},{smallBlind:10,bigBlind:10},{maxPlayers:100},{maxTotalBuyInBB:125},{squid:'false'},{timeBankCards:-1},{durationMinutes:Infinity},{bombIntervalMinutes:null},{maxTotalBuyInBB:-50},{bigBlind:'10'}])assert.throws(()=>reusableRoomSettings(input,defaults));
  assert.deepEqual(reusableRoomSettings({},defaults),defaults);
  assert.equal(reusableRoomSettings({__proto__:{bigBlind:0},token:'secret'},defaults).bigBlind,10);
});

test('old hand intervals migrate to the timer default without converting old stack caps into lifetime caps',()=>{
  const old={bombPot:true,bombEveryHands:7,minBuyInBB:20,maxBuyInBB:null};
  const result=reusableRoomSettings(old,defaults);assert.equal(result.bombIntervalMinutes,10);assert.equal(result.bombEveryHands,undefined);assert.equal(result.minBuyInBB,100);assert.equal(result.maxBuyInBB,1000);assert.equal(result.maxTotalBuyInBB,null);
  assert.equal(old.bombEveryHands,7);assert.equal(old.maxBuyInBB,null);
});
