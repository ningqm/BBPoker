import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {layoutTableBubbles} from '../public/table-scene.js';
const rect=(x,y,width,height)=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height});
const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
function scene({width=300,height=200,obstacles=[],count=1,normal={width:120,height:45},compact={width:110,height:24}}={}){
 const nodes=obstacles.map(r=>({getBoundingClientRect:()=>rect(r.x,r.y,r.width,r.height)})),bubbles=[];
 const stage={getBoundingClientRect:()=>rect(0,0,width,height),querySelectorAll(selector){return selector==='.seat-reaction'?bubbles:selector==='.bet-chip'?[]:nodes}};
 for(let i=0;i<count;i++){
  const seat={dataset:{side:'left'},getBoundingClientRect:()=>rect(10,78+i*35,20,30)};
  const bubble={parentElement:seat,textContent:'牌友：测试聊天内容，不修改消息',dataset:{messageId:'m'+i},style:{},attrs:{},setAttribute(k,v){this.attrs[k]=v},closest:()=>seat,getBoundingClientRect(){const size=this.dataset.bubbleLayout==='compact'?compact:normal;return rect(10+(parseFloat(this.style.left)||0),78+i*35+(parseFloat(this.style.top)||0),size.width,size.height)}};
  bubbles.push(bubble);
 }
 return {stage,bubbles,nodes};
}

test('a crowded felt uses a one-line table bubble only when its measured compact size fits clear space',()=>{
 const obstacles=[{x:0,y:0,width:300,height:78},{x:0,y:110,width:300,height:90}],{stage,bubbles}=scene({obstacles});
 layoutTableBubbles(stage);const [bubble]=bubbles;
 assert.equal(bubble.dataset.bubbleLayout,'compact');assert.equal(bubble.style.visibility,'');assert.equal(bubble.attrs['aria-hidden'],'false');
 for(const r of obstacles)assert.equal(overlaps(bubble.getBoundingClientRect(),rect(r.x,r.y,r.width,r.height)),false);
 assert.equal(bubble.textContent,'牌友：测试聊天内容，不修改消息');assert.equal(bubble.dataset.messageId,'m0');
});

test('no free felt hides the table copy instead of covering information, without removing or editing the message',()=>{
 const {stage,bubbles,nodes}=scene({obstacles:[{x:0,y:0,width:300,height:200}]}),[bubble]=bubbles,parent=bubble.parentElement;
 layoutTableBubbles(stage);assert.equal(bubble.dataset.bubbleLayout,'hidden');assert.equal(bubble.style.visibility,'hidden');assert.equal(bubble.attrs['aria-hidden'],'true');
 assert.equal(bubble.parentElement,parent);assert.equal(bubble.textContent,'牌友：测试聊天内容，不修改消息');assert.equal(bubble.dataset.messageId,'m0');
 nodes.length=0;layoutTableBubbles(stage);assert.equal(bubble.dataset.bubbleLayout,'normal','available space restores the original full bubble');assert.equal(bubble.style.visibility,'');assert.equal(bubble.attrs['aria-hidden'],'false');
});

test('nine-way All-in, two pots and exposed hands never lose clear wagers to simultaneous text bubbles',()=>{
 const geometry=JSON.parse(readFileSync(new URL('./fixtures/table-nine-allin-compact-320.json',import.meta.url),'utf8'));
 const obstacles=[...geometry.reserved,...geometry.wagers.map(w=>({...w.preferred,width:w.width,height:w.height}))].filter(r=>r.width>0&&r.height>0);
 const {stage,bubbles}=scene({width:geometry.width,height:geometry.height,obstacles,count:9,normal:{width:105,height:57},compact:{width:110,height:24}});
 layoutTableBubbles(stage);const visible=bubbles.filter(bubble=>bubble.style.visibility!=='hidden');
 assert.ok(visible.length>0,'at least one compact message remains readable in this real layout');
 for(const [index,bubble] of visible.entries()){
  const actual=bubble.getBoundingClientRect();assert.ok(actual.left>=0&&actual.top>=0&&actual.right<=geometry.width&&actual.bottom<=geometry.height);
  for(const r of obstacles)assert.equal(overlaps(actual,rect(r.x,r.y,r.width,r.height)),false,'visible text never covers cards, equity, wagers or pots');
  for(const other of visible.slice(0,index))assert.equal(overlaps(actual,other.getBoundingClientRect()),false,'simultaneous messages do not cover each other');
 }
 assert.equal(bubbles.length,9);assert.equal(bubbles.every(b=>b.textContent==='牌友：测试聊天内容，不修改消息'),true,'all messages remain intact, including temporarily hidden table copies');
});

test('a compact bubble larger than the felt is hidden rather than clamped outside the table',()=>{
 const {stage,bubbles}=scene({width:80,height:20});layoutTableBubbles(stage);
 assert.equal(bubbles[0].dataset.bubbleLayout,'hidden');assert.equal(bubbles[0].style.visibility,'hidden');
});
