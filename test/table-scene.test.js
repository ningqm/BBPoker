import test from 'node:test';
import assert from 'node:assert/strict';
import {seatPlacement,seatCommitment,chipPots,payoutAwards,liveReactions,actorClock,POT_AWARD_DURATION,mountPotAwards,layoutTableBubbles} from '../public/table-scene.js';
test('all seats rotate with self; nine-player seats have distinct positions and inward edge',()=>{
 for(let n=2;n<=9;n++)for(let self=0;self<n;self++){const r={settings:{maxPlayers:n},meId:'me',players:[{id:'me',seat:self}]};const positions=Array.from({length:n},(_,i)=>seatPlacement(r,i));assert.equal(positions[self].relative,0);assert.equal(positions[self].edge,'bottom');assert.equal(new Set(positions.map(p=>p.x+':'+p.y)).size,n);}
});
test('real side pots stay distinct, dead-money tiers with identical eligibility merge, inputs unchanged',()=>{
 const hand={status:'playing',pot:200,pots:[{amount:30,eligibleIds:['a','b','c']},{amount:60,eligibleIds:['c','a','b']},{amount:100,eligibleIds:['a','b']}],uncalledBets:[{playerId:'a',amount:10}]};const before=structuredClone(hand),rows=chipPots(hand);assert.deepEqual(rows.map(p=>[p.label,p.amount]),[['主池',90],['边池 1',100]]);assert.equal(rows.reduce((n,p)=>n+p.amount,0)+10,hand.pot);assert.deepEqual(hand,before);
});
test('side-pot-only winners and ties all get exact awarded chip motion, never net profit',()=>{
 const hand={status:'complete',result:{mainWinnerIds:['a'],payouts:{a:90,b:100,c:0}}};assert.deepEqual(payoutAwards(hand),[{playerId:'a',amount:90},{playerId:'b',amount:100}]);assert.deepEqual(payoutAwards({...hand,status:'playing'}),[]);
});
test('chat and emoji show once, no old replay after reconnect or background, using synchronized clock',()=>{
 const now=1800000000000,base={code:'r',meId:'a',chat:[]},r={...base,chat:[{id:'x',kind:'text',text:'hello',at:new Date(now).toISOString()},{id:'y',kind:'emote',emote:'nice',at:new Date(now).toISOString()},{id:'z',kind:'throw',at:new Date(now).toISOString()}]};assert.equal(liveReactions(base,r,{now}).length,2);assert.equal(liveReactions(r,r,{now}).length,0);for(const opt of [{reconnected:true},{live:false},{visible:false},{muted:true}])assert.equal(liveReactions(base,r,{now,...opt}).length,0);assert.equal(liveReactions(base,r,{now:now+8000}).length,0);
});
test('actor gets full twenty seconds after board reveal and orange warning at seven seconds',()=>{
 const r={settings:{actionSeconds:20},hand:{status:'playing',actingId:'a',actionReadyAt:1000,turnStartedAt:1000},deadline:21000};assert.deepEqual(actorClock(r,500),{playerId:'a',waiting:true,remaining:20,ratio:1,urgent:false});assert.equal(actorClock(r,14000).remaining,7);assert.equal(actorClock(r,14000).urgent,true);assert.equal(actorClock({...r,hand:{status:'complete'}},14000),null);
});
test('first actor waits for the ready snapshot rather than showing an actionable timer ahead of disabled controls',()=>{
 const r={meId:'a',settings:{actionSeconds:20},hand:{id:'first-turn',status:'playing',actingId:'a',actionReadyAt:1100,turnStartedAt:1100},deadline:21100,actions:{turnAvailable:true,canAct:false}};
 const frozen=structuredClone(r);
 for(const now of [0,1099,1100,1500,14100]){
  const clock=actorClock(r,now);assert.equal(clock.waiting,true);assert.equal(clock.urgent,false);
 }
 assert.deepEqual(r,frozen,'displaying a turn never grants action permission locally');
 const ready={...r,actions:{...r.actions,canAct:true}};
 assert.deepEqual(actorClock(ready,1100),{playerId:'a',waiting:false,remaining:20,ratio:1,urgent:false});
 assert.equal(actorClock(ready,14100).urgent,true);
});
test('another player gets their timer after reveal even though the viewer cannot act',()=>{
 const r={meId:'spectator',settings:{actionSeconds:20},hand:{status:'playing',actingId:'a',actionReadyAt:900,turnStartedAt:900},deadline:20900,actions:{turnAvailable:false,canAct:false}};
 assert.equal(actorClock(r,899).waiting,true);
 assert.equal(actorClock(r,900).waiting,false);
 assert.equal(actorClock(r,13900).remaining,7);
});
test('All-in runout never keeps an actor clock from an older action frame',()=>{
 const r={meId:'a',settings:{actionSeconds:20},hand:{status:'playing',actingId:'a',actionReadyAt:900,turnStartedAt:900,runout:{active:true}},deadline:20900,actions:{turnAvailable:true,canAct:true}};
 assert.equal(actorClock(r,1000),null);
 r.hand.runout.active=false;assert.equal(actorClock(r,1000).playerId,'a');
});

// Geometry double implements the browser primitives consumed by the actual
// helpers. It does not substitute placement, payout or replay policy logic.
const box=(x,y,width,height)=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height});
class SceneNode {
 constructor(className='',rect=box(0,0,0,0),dataset={}){Object.assign(this,{className,rect,dataset,style:{},attributes:{},children:[],parentElement:null});}
 append(node){node.remove();node.parentElement=this;node.ownerDocument=this.ownerDocument;this.children.push(node);}
 remove(){if(this.parentElement){const index=this.parentElement.children.indexOf(this);this.parentElement.children.splice(index,1);this.parentElement=null;}}
 setAttribute(key,value){this.attributes[key]=value;}
 matches(selector){if(selector.includes(','))return selector.split(',').some(part=>this.matches(part));const [css,attribute]=selector.split('[');return css.startsWith('.')&&this.className.split(' ').includes(css.slice(1))&&(!attribute||attribute==='data-player-id]'&&typeof this.dataset.playerId==='string');}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
 getBoundingClientRect(){if(this.className.includes('seat-reaction')&&this.style.left!==undefined){const seat=this.closest('.seat').getBoundingClientRect();return box(seat.x+parseFloat(this.style.left),seat.y+parseFloat(this.style.top),this.rect.width,this.rect.height);}return this.rect;}
}
function sceneFixture(){
 const stage=new SceneNode('table-stage',box(100,200,800,600)),doc={createElement:()=>new SceneNode()};stage.ownerDocument=doc;
 const add=(className,rect,dataset={},parent=stage)=>{const node=new SceneNode(className,rect,dataset);parent.append(node);return node;};
 return {stage,add};
}
const overlaps=(a,b)=>Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top);

test('collection motion routes actual main-pot, side-pot and tied awards to every winning seat, no loser or refund',()=>{
 const {stage,add}=sceneFixture();add('pot-cluster',box(450,450,100,50));
 for(const [id,x] of [['a',150],['b',450],['c',750],['loser',850]])add('seat',box(x,650,80,60),{playerId:id});
 const hand={status:'complete',result:{mainWinnerIds:['a','b'],payouts:{a:45,b:145,c:50,loser:0}},log:[{type:'refund',playerId:'loser',amount:20}]};
 mountPotAwards(stage,{at:1000,awards:payoutAwards(hand)},{now:1000});
 const layer=stage.querySelector('.pot-flight-layer');assert.equal(layer.attributes['aria-hidden'],'true');assert.equal(layer.children.length,3);
 assert.deepEqual(layer.children.map(group=>group.dataset.playerId),['a','b','c']);
 for(const group of layer.children){assert.equal(group.querySelectorAll('.pot-flight').length,3);assert.equal(group.querySelectorAll('.pot-arrival-ring').length,1);assert.deepEqual(group.querySelectorAll('.pot-flight').map(icon=>icon.children.length),[3,3,3]);}
 assert.match(layer.children[0].children[1].style.cssText,/left:400px;top:272px;--award-x:-310px;--award-y:208px/);
 assert.match(layer.children[1].children[1].style.cssText,/--award-x:-10px/);assert.match(layer.children[2].children[1].style.cssText,/--award-x:290px/);
 assert.match(layer.children[0].querySelector('.pot-arrival-ring').style.cssText,/left:47px;top:447px;width:86px;height:66px;animation-delay:800ms/);
 assert.deepEqual(payoutAwards(hand).map(award=>award.amount),[45,145,50]);
});

test('chat rerenders resume collection age instead of stacking or restarting the animation',()=>{
 const {stage,add}=sceneFixture();add('pot-cluster',box(450,450,100,50));add('seat',box(150,650,80,60),{playerId:'a'});
 const motion={at:1000,awards:[{playerId:'a',amount:200}]};
 mountPotAwards(stage,motion,{now:1200});const first=stage.querySelector('.pot-flight-layer');assert.match(first.querySelector('.pot-flight').style.cssText,/animation-delay:-200ms/);
 mountPotAwards(stage,motion,{now:1700});const next=stage.querySelector('.pot-flight-layer');assert.notEqual(first,next);assert.equal(first.parentElement,null);assert.equal(stage.querySelectorAll('.pot-flight-layer').length,1);assert.match(next.querySelector('.pot-flight').style.cssText,/animation-delay:-700ms/);
 assert.match(next.querySelector('.pot-arrival-ring').style.cssText,/animation-delay:100ms/);
 mountPotAwards(stage,motion,{now:1000+POT_AWARD_DURATION});assert.equal(stage.querySelector('.pot-flight-layer'),null,'expired collection is removed, never restarted');
});

test('disabled or cleared motion removes old collection nodes and missing seats never redirect winnings',()=>{
 const {stage,add}=sceneFixture();add('pot-cluster',box(450,450,100,50));add('seat',box(150,650,80,60),{playerId:'a'});
 const motion={at:1000,awards:[{playerId:'gone',amount:200},{playerId:'a',amount:100}]};
 mountPotAwards(stage,motion,{now:1100});assert.equal(stage.querySelector('.pot-flight-layer').children.length,1);
 mountPotAwards(stage,motion,{now:1200,enabled:false});assert.equal(stage.querySelector('.pot-flight-layer'),null);
 mountPotAwards(stage,null,{now:1200});assert.equal(stage.querySelector('.pot-flight-layer'),null);
 mountPotAwards(stage,null,{now:1300,enabled:true});assert.equal(stage.querySelector('.pot-flight-layer'),null,'reenabling with cleared state cannot replay');
});

test('bubble placement avoids actual cards, seat, combined time controls, chip, equity/type and board rectangles',()=>{
 const {stage,add}=sceneFixture(),seat=add('seat',box(120,450,80,60),{side:'left'});
 const reserved=[add('seat-main',box(120,450,80,60)),add('hole-cards',box(120,398,80,45)),add('seat-turn',box(200,452,45,25)),add('seat-time-tools',box(150,520,104,64)),add('bet-chip',box(250,462,60,25)),add('seat-hand-info',box(205,485,100,45)),add('board',box(390,440,220,80)),add('pot-cluster',box(420,390,160,45))];
 const bubble=add('seat-reaction',box(0,0,120,45),{},seat);layoutTableBubbles(stage);
 const actual=bubble.getBoundingClientRect(),outer=stage.getBoundingClientRect();
 assert.ok(actual.left>=outer.left&&actual.right<=outer.right&&actual.top>=outer.top&&actual.bottom<=outer.bottom);
 for(const node of reserved)assert.equal(overlaps(actual,node.getBoundingClientRect()),false,`bubble must not cover ${node.className}`);
 const before={...bubble.style};layoutTableBubbles(stage);assert.deepEqual(bubble.style,before,'same geometry does not make bubbles jump on repeated renders');
});

test('simultaneous table bubbles keep free-space placements separate and do not mutate message data',()=>{
 const {stage,add}=sceneFixture(),seat=add('seat',box(120,450,80,60),{side:'left'});
 add('seat-main',box(120,450,80,60));add('board',box(390,440,220,80));
 const bubbles=[add('seat-reaction',box(0,0,120,45),{messageId:'one'},seat),add('seat-reaction',box(0,0,120,45),{messageId:'two'},seat)];
 layoutTableBubbles(stage);assert.equal(overlaps(...bubbles.map(node=>node.getBoundingClientRect())),false);assert.deepEqual(bubbles.map(node=>node.dataset.messageId),['one','two']);
});

test('bubbles never cross room or identity and never revive old messages after a hidden baseline',()=>{
 const now=1800000000000,base={code:'r',meId:'a',chat:[]},message={id:'m',playerId:'b',kind:'text',text:'hello',at:new Date(now).toISOString()},next={...base,chat:[message]};
 assert.deepEqual(liveReactions(base,{...next,code:'elsewhere'},{now}),[]);assert.deepEqual(liveReactions(base,{...next,meId:'b'},{now}),[]);
 assert.deepEqual(liveReactions(base,next,{now,visible:false}),[]);assert.deepEqual(liveReactions(next,next,{now:now+100}),[]);
 assert.deepEqual(message,{id:'m',playerId:'b',kind:'text',text:'hello',at:new Date(now).toISOString()});
});

test('an unfinished street or showdown has no actor clock, even if an old actor remains in a stale frame',()=>{
 const room={settings:{actionSeconds:20},hand:{status:'playing',actingId:'a',actionReadyAt:null,transition:{kind:'street',nextAt:19000}},deadline:20000};
 for(const kind of ['street','showdown','award']){room.hand.transition.kind=kind;assert.equal(actorClock(room,18500),null);}
});


test('seat commitments retain real street wagers but hide collected amounts throughout runout and showdown',()=>{
 const room={status:'playing',hand:{status:'playing',pot:3000}},player={id:'p',inHand:true,bet:500,contributed:1500,allIn:true,folded:false};
 const before=JSON.stringify({room,player});assert.deepEqual(seatCommitment(room,player),{amount:500,allIn:true,contributed:1500});assert.equal(JSON.stringify({room,player}),before);
 room.hand.runout={active:true};assert.equal(seatCommitment(room,player),null,'runout lock hides wagers before the first board reveal clears bet');
 assert.equal(player.bet,500);assert.equal(player.contributed,1500);assert.equal(room.hand.pot,3000,'display compaction never changes settled amounts');
 room.hand.runout.active=false;room.hand.transition={kind:'showdown',revealed:false};assert.equal(seatCommitment(room,player),null,'river showdown must not flash wagers back');
 room.hand.transition.revealed=true;assert.equal(seatCommitment(room,player),null);
 room.hand.transition={kind:'street'};assert.deepEqual(seatCommitment(room,player),{amount:500,allIn:true,contributed:1500},'normal street animation retains its final wagers');
 room.hand.transition=null;player.bet=0;assert.equal(seatCommitment(room,player),null,'an All-in whose wager was swept has no empty chip label');
 player.allIn=false;assert.equal(seatCommitment(room,player),null);player.bet=200;assert.deepEqual(seatCommitment(room,player),{amount:200,allIn:false,contributed:1500});
 player.folded=true;assert.deepEqual(seatCommitment(room,player),{amount:200,allIn:false,contributed:1500},'a fold does not remove already committed street chips');
 player.bet=0;player.allIn=true;assert.equal(seatCommitment(room,player),null,'stale All-in must not revive folded chips');
 player.folded=false;player.contributed=0;assert.equal(seatCommitment(room,player),null,'zero commitments cannot invent a chip');
 player.bet=100;player.contributed=100;player.inHand=false;assert.equal(seatCommitment(room,player),null);
 player.inHand=true;room.hand.status='complete';assert.equal(seatCommitment(room,player),null);
});


test('all nine paid seats receive their own route and arrival within the result pause',()=>{
 const {stage,add}=sceneFixture();add('pot-cluster',box(450,450,100,100));add('pot-total',box(470,450,80,30));
 const awards=Array.from({length:9},(_,index)=>({playerId:'p'+index,amount:100+index}));
 for(const [index,award] of awards.entries()){
  const seat=add('seat',box(150+index*70,650,80,90),{playerId:award.playerId});
  add('seat-main',box(150+index*70,650,80,60),{},seat);
 }
 mountPotAwards(stage,{at:1000,awards},{now:1000});
 const groups=stage.querySelector('.pot-flight-layer').children;assert.equal(groups.length,9);
 for(const [index,group] of groups.entries()){
  assert.equal(group.dataset.playerId,awards[index].playerId);
  const flights=group.querySelectorAll('.pot-flight'),ring=group.querySelector('.pot-arrival-ring');
  assert.equal(flights.length,3);assert.match(flights[1].style.cssText,new RegExp(`left:410px;top:262px;--award-x:${-320+index*70}px;--award-y:218px`),'route starts at total-pot center and lands inside identity panel, not card/receipt bounding box');
  const delays=flights.map(f=>Number(f.style.cssText.match(/animation-delay:(-?\d+)ms/)[1]));assert.deepEqual(delays,[index*60,index*60+130,index*60+260]);
  const arrival=Number(ring.style.cssText.match(/animation-delay:(-?\d+)ms/)[1]);assert.ok(arrival>=delays[0]+750);assert.ok(arrival+1800<POT_AWARD_DURATION,'last winner pulse finishes before effect expires');
  assert.match(ring.style.cssText,/height:66px/,'ring hugs seat panel without expanding into hole cards');
 }
});

test('malformed time, empty awards and refunds cannot create a payout effect',()=>{
 const {stage,add}=sceneFixture();add('pot-cluster',box(450,450,100,50));add('seat',box(150,650,80,60),{playerId:'a'});
 for(const motion of [{at:1100,awards:[{playerId:'a',amount:100}]},{at:NaN,awards:[{playerId:'a',amount:100}]},{at:1000,awards:[]},{at:1000,awards:[{playerId:'a',amount:0},{playerId:'a',amount:-100},{playerId:'a',amount:NaN}]}]){
  mountPotAwards(stage,motion,{now:1000});assert.equal(stage.querySelector('.pot-flight-layer'),null);
 }
});
