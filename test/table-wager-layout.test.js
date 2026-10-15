import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { planWagerPositions, layoutTableWagers, layoutTableBubbles } from '../public/table-scene.js';
const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;

function fixture(width,height){
 const scale=width/312;
 const rect=(x,y,w,h)=>({x:x*scale,y:y/540*height,width:w*scale,height:h});
 const reserved=[rect(51,172,210,60),rect(58,271,196,125),rect(126,439,66,46),rect(124,489,70,49),rect(23,489,92,60)];
 const wagers=[
  {id:'hero',anchor:{x:width/2,y:height*.95},side:'center',edge:'bottom',preferred:rect(120,405,72,24)},
  {id:'top-left',anchor:{x:width*.34,y:height*.07},side:'center',edge:'top',preferred:rect(70,100,72,24)},
  {id:'top-right',anchor:{x:width*.66,y:height*.07},side:'center',edge:'top',preferred:rect(169,100,72,24)},
 ];
 for(const [side,x] of [['left',15],['right',297]])for(const [i,y] of [140,270,410].entries()){
  const body=rect(x-35,y-24,70,49),cards=rect(x-27,y-65,54,36);reserved.push(body,cards);
  wagers.push({id:side+i,anchor:{x:x*scale,y:y/540*height},side,edge:side,preferred:rect(side==='left'?57:183,y,72,24)});
 }
 reserved.push(rect(71,13,70,49),rect(171,13,70,49),rect(79,68,54,36),rect(179,68,54,36));
 return{width,height,wagers:wagers.map(w=>({...w,width:Math.min(80,72*scale),height:28,preferred:{x:w.preferred.x,y:w.preferred.y}})),reserved};
}

test('wagers avoid board, settings, player cards and each other at phone and desktop widths',()=>{
 for(const [width,height] of [[312,620],[297,620],[248,620],[900,660]]){
  const data=fixture(width,height),before=structuredClone(data),positions=planWagerPositions(data);
  assert.equal(positions.length,9);
  for(const [i,p] of positions.entries()){
   assert.ok(p.clear,`${width}px ${p.id} has free felt`);
   assert.ok(p.x>=0&&p.y>=0&&p.x+p.width<=width&&p.y+p.height<=height);
   if(p.id.startsWith('left')||p.id.startsWith('right')){const anchor=data.wagers.find(w=>w.id===p.id).anchor;assert.ok(Math.abs(p.y+p.height/2-anchor.y)<65,`${width}px upper wagers stay by their owners, not the next seat`);}
   for(const r of data.reserved)assert.equal(overlaps(p,r),false,`${width}px ${p.id} avoids reserved information`);
   for(const other of positions.slice(0,i))assert.equal(overlaps(p,other),false,`${width}px ${p.id} avoids ${other.id}`);
  }
  assert.deepEqual(data,before,'layout never changes room/rectangle inputs');
  assert.deepEqual(planWagerPositions(data),positions,'same public geometry produces stable positions');
 }
});
test('already clear inward wagers retain their preferred position and a crowded viewport never loses amounts',()=>{
 const free={width:300,height:500,wagers:[{id:'a',side:'left',edge:'left',width:60,height:24,anchor:{x:30,y:200},preferred:{x:80,y:200}}],reserved:[]};
 const [placed]=planWagerPositions(free);assert.equal(placed.x,80);assert.equal(placed.y,200);assert.equal(placed.clear,true);
 const blocked=planWagerPositions({...free,reserved:[{x:0,y:0,width:300,height:500}]});assert.equal(blocked.length,1);assert.equal(blocked[0].id,'a');assert.equal(blocked[0].clear,false);
});


for(const file of ['table-nine-allin-320.json','table-nine-allin-points-320.json','table-nine-allin-bb-320.json'])test(`actual 320px nine-way All-in ${file} has no subpixel overlap or displaced owner`,()=>{
 const data=JSON.parse(readFileSync(new URL('./fixtures/'+file,import.meta.url),'utf8'));
 const positions=planWagerPositions(data);assert.equal(positions.length,9);
 for(const [index,p] of positions.entries()){
  assert.equal(p.clear,true,`seat ${p.id} must not fall back to overlapping geometry`);
  for(const r of data.reserved)assert.equal(overlaps(p,r),false,`seat ${p.id} avoids information`);
  for(const other of positions.slice(0,index))assert.equal(overlaps(p,other),false,`seat ${p.id} avoids seat ${other.id} even below one pixel`);
  const source=data.wagers.find(w=>w.id===p.id);
  if(source.side==='left'){assert.ok(p.x+p.width<=data.width/2-2);assert.ok(Math.abs(p.y+p.height/2-source.anchor.y)<=65);}
  if(source.side==='right'){assert.ok(p.x>=data.width/2+2);assert.ok(Math.abs(p.y+p.height/2-source.anchor.y)<=65);}
 }
});


test('pruned crowded search retains the nearest clear choices and handles off-felt preferred anchors',()=>{
 const cases=[
  {id:'left',side:'left',edge:'left',width:50,height:24,anchor:{x:20,y:180},preferred:{x:60,y:170},expected:[50,132]},
  {id:'center',side:'center',edge:'top',width:50,height:24,anchor:{x:180,y:20},preferred:{x:155,y:50},expected:[155,17]},
  {id:'outside',side:'left',edge:'left',width:50,height:24,anchor:{x:20,y:180},preferred:{x:-10,y:170},expected:[2,132]},
 ];
 for(const {expected,...wager} of cases){
  const [actual]=planWagerPositions({width:360,height:520,wagers:[wager],reserved:[{x:50,y:160,width:80,height:50},{x:140,y:45,width:75,height:40}]});
  assert.equal(actual.clear,true);assert.deepEqual([actual.x,actual.y],expected);
 }
});

function measuredStage(){
 const trace=[],bounds={left:0,top:0,x:0,y:0,width:360,height:620},nodes=[];
 const stage={isConnected:true,getBoundingClientRect(){trace.push('read-stage');return {...bounds};},querySelectorAll(selector){if(selector==='.bet-chip')return nodes;if(selector==='.seat-reaction')return [];return []}};
 for(const [index,x] of [30,330].entries()){
  const anchor={left:x-30,top:210,x:x-30,y:210,width:60,height:60};
  const seat={dataset:{side:index===0?'left':'right',edge:index===0?'left':'right'},getBoundingClientRect(){trace.push('read-seat');return {...anchor}}};
  const css={animation:'',removeProperty(key){trace.push('reset-'+key);delete this[key]}};
  const node={dataset:{},closest(){return seat},style:new Proxy(css,{set(target,key,value){trace.push('write-'+key);target[key]=value;return true}}),getBoundingClientRect(){trace.push('read-chip');return {left:index===0?70:230,top:228,width:60,height:24}}};nodes.push(node);
 }
 return {stage,trace,bounds,nodes};
}

test('wager placement batches all seat reads before final style writes instead of forcing layout per player',()=>{
 const {stage,trace,nodes}=measuredStage();layoutTableWagers(stage);
 assert.equal(nodes.every(node=>node.dataset.wagerLayout==='clear'),true);
 const firstCommit=trace.indexOf('write-left');assert.ok(firstCommit>0);
 assert.equal(trace.slice(firstCommit).some(event=>event.startsWith('read-')),false,'final placement loop must not alternate writes and layout reads');
});

test('ResizeObserver initial notification does not repeat layout and a real size change recalculates it',()=>{
 const Original=globalThis.ResizeObserver,observers=[];
 globalThis.ResizeObserver=class {constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){}};
 try{
  const {stage,trace,bounds}=measuredStage();layoutTableBubbles(stage);trace.length=0;
  observers.at(-1).callback();assert.deepEqual(trace,['read-stage'],'already laid-out dimensions do not reset or rewrite wager nodes');
  bounds.width=390;trace.length=0;observers.at(-1).callback();assert.ok(trace.includes('write-left'),'actual viewport change still updates placement');
 }finally{if(Original===undefined)delete globalThis.ResizeObserver;else globalThis.ResizeObserver=Original;}
});


test('compact 540px table has room for nine All-in wagers, exposed hands, equity and two pots at 320px',()=>{
 // Browser-captured FINAL positions from the compact layout. These are feasible
 // preferred positions, not raw CSS anchors; this regression protects actual
 // available space and seat ownership, while earlier fixtures cover correction.
 const data=JSON.parse(readFileSync(new URL('./fixtures/table-nine-allin-compact-320.json',import.meta.url),'utf8'));
 assert.equal(data._capture.viewportCssWidth,320);assert.equal(data.height,540);
 const before=structuredClone(data),positions=planWagerPositions(data),reserved=data.reserved.filter(r=>r.width>0&&r.height>0);
 assert.equal(positions.length,9);assert.equal(new Set(positions.map(p=>p.id)).size,9);
 for(const [index,position] of positions.entries()){
  const owner=data.wagers.find(wager=>wager.id===position.id),captured={...owner.preferred,width:owner.width,height:owner.height};
  assert.equal(position.clear,true,`seat ${position.id} retains a clear All-in amount`);
  assert.ok(position.x>=0&&position.y>=0&&position.x+position.width<=data.width&&position.y+position.height<=data.height);
  for(const obstacle of reserved){
   assert.equal(overlaps(captured,obstacle),false,`captured seat ${position.id} did not cover actual information`);
   assert.equal(overlaps(position,obstacle),false,`planned seat ${position.id} avoids hand, equity, board and pots`);
  }
  for(const other of positions.slice(0,index))assert.equal(overlaps(position,other),false,`seat ${position.id} does not cover seat ${other.id}`);
  if(owner.side==='left'||owner.side==='right'){
   assert.ok(Math.abs(position.y+position.height/2-owner.anchor.y)<=65,'side wagers remain close to their owner, not the next player');
   if(owner.side==='left')assert.ok(position.x+position.width<=data.width/2-2);
   else assert.ok(position.x>=data.width/2+2);
  }else{
   assert.ok(Math.abs(position.x+position.width/2-owner.anchor.x)<=Math.max(68,data.width*.2));
   if(owner.edge==='top')assert.ok(position.y+position.height/2>=owner.anchor.y&&position.y+position.height/2<=data.height*.45);
   else assert.ok(position.y+position.height/2<=owner.anchor.y&&position.y+position.height/2>=data.height*.62);
  }
 }
 assert.deepEqual(data,before,'geometry validation never mutates the captured scene');
});

for(const width of [320,390])test(`real ${width}px phone keeps nine all-in wagers clear after viewport compaction`,()=>{
 const data=JSON.parse(readFileSync(new URL(`./fixtures/table-ux-nine-${width}.json`,import.meta.url),'utf8'));
 assert.equal(data._capture.viewportCssWidth,width);
 const placed=planWagerPositions(data),reserved=data.reserved.filter(r=>r.width>0&&r.height>0);
 assert.equal(placed.length,9);
 for(const [i,p] of placed.entries()){
  assert.equal(p.clear,true,`seat ${p.id} has space`);
  const w=data.wagers.find(w=>w.id===p.id),captured={...w.preferred,width:w.width,height:w.height};
  for(const r of reserved){assert.equal(overlaps(captured,r),false,'captured actual wager avoids information');assert.equal(overlaps(p,r),false,'planned wager avoids information');}
  for(const other of placed.slice(0,i))assert.equal(overlaps(p,other),false);
 }
});
