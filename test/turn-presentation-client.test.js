import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {actorClock} from '../public/table-scene.js';
import {createTurnCountdown} from '../public/table-feedback.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('function tick(){'),end=source.indexOf('setInterval(tick,400);',start);
assert.ok(start>=0&&end>start);

// Retain the previous seat nodes, as can happen while an input method defers
// the full table render. Exercise the real tick and clock, not their markup.
class Element {
 constructor(classes='',dataset={}){
  this.classes=new Set(classes.split(' ').filter(Boolean));this.dataset=dataset;
  this.hidden=false;this.attributes={};this.styles={};this.textContent='';
  this.classList={contains:name=>this.classes.has(name),toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};
  this.style={setProperty:(name,value)=>this.styles[name]=value};
 }
 setAttribute(name,value){this.attributes[name]=String(value);}
 closest(selector){return selector==='.seat'?this.seat:null;}
 querySelector(selector){return selector==='[data-seat-clock]'?this.clock:null;}
}
function fixture(){
 let now=1800000000000;class Clock extends Date {static now(){return now;}}
 const room={code:'timing-fixture',meId:'a',status:'playing',settings:{actionSeconds:20},
  hand:{id:'h',status:'playing',actingId:'a',actionSeq:4,actionReadyAt:now-100,turnStartedAt:now-100},
  deadline:now+19900,actions:{turnAvailable:true,canAct:true}};
 const state={clock:createRoomClock({monotonicNow:()=>now,wallNow:()=>now}),room,page:'room',connected:true,feedbackResync:false,busy:false,sound:false};
 const nodes=['a','b'].map(id=>{const seat=new Element(id==='a'?'seat acting':'seat',{playerId:id});const timer=new Element('seat-turn');timer.seat=seat;timer.clock=new Element();return timer;});
 const context=vm.createContext({createRoomClock,isOlderRoomSnapshot,state,Date:Clock,actorClock,turnCountdown:createTurnCountdown(),syncRebuyPrompt(){},
  document:{visibilityState:'visible',querySelectorAll:selector=>selector==='[data-seat-turn]'?nodes:[]}});
 vm.runInContext(source.slice(start,end)+'\nglobalThis.runTick=tick;',context);
 return {room,state,nodes,tick:()=>context.runTick(),at:value=>{now=value;},get now(){return now;}};
}

test('timer clears the previous actor highlight while a full render is deferred during transitions or runout',()=>{
 for(const change of [r=>r.hand.transition={kind:'street'},r=>r.hand.runout={active:true},r=>r.hand.status='complete',r=>r.hand.actingId=null]){
  const f=fixture();change(f.room);f.tick();
  assert.equal(f.nodes[0].hidden,true);assert.equal(f.nodes[0].seat.classList.contains('acting'),false);
 }
});

test('changing the actor clears the old seat and still times the opponent when the viewer cannot act',()=>{
 const f=fixture();f.room.hand.actingId='b';f.room.actions={turnAvailable:false,canAct:false};f.tick();
 assert.equal(f.nodes[0].hidden,true);assert.equal(f.nodes[0].seat.classList.contains('acting'),false);
 assert.equal(f.nodes[1].hidden,false);assert.equal(f.nodes[1].seat.classList.contains('acting'),true);
 assert.equal(f.nodes[1].clock.textContent,'20s');
});

test('own ready gap remains neutral across ticks and activates on the authoritative ready frame',()=>{
 const f=fixture();f.room.actions.canAct=false;f.tick();
 const timer=f.nodes[0];assert.equal(timer.hidden,false);assert.equal(timer.clock.textContent,'发牌中');
 assert.equal(timer.seat.classList.contains('acting'),false);assert.equal(timer.classList.contains('is-preparing'),true);
 f.at(f.now+13000);f.tick();
 assert.equal(timer.clock.textContent,'发牌中');assert.equal(timer.classList.contains('urgent'),false);
 f.room.actions.canAct=true;f.tick();
 assert.equal(timer.classList.contains('is-preparing'),false);assert.equal(timer.seat.classList.contains('acting'),true);
 assert.equal(timer.clock.textContent,'7s');assert.equal(timer.classList.contains('urgent'),true);
});
