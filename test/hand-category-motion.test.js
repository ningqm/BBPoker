import test from 'node:test';
import assert from 'node:assert/strict';
import {HAND_CATEGORIES, updateHandCategoryMotion, renderHandCategory, displayedHandCategory} from '../public/hand-category.js';
const room=(board=[],own='高牌',other=null)=>({code:'table',meId:'me',hand:{id:'hand',status:'playing',board},players:[{id:'me',handCategory:own},{id:'other',handCategory:other}]});
const options={live:true,now:1000};
test('own ordinary street upgrades without needing all-in or exposing hidden opponents',()=>{
 const a=room(),b=room(['Kc','2d','7h'],'一对');
 const motion=updateHandCategoryMotion(a,b,[],options);
 assert.deepEqual(motion,[{handId:'hand',playerId:'me',from:'高牌',to:'一对',at:1000}]);
 const c=room([...b.hand.board,'Qc'],'两对');
 assert.equal(updateHandCategoryMotion(b,c,motion,{live:true,now:1500})[0].from,'一对');
 assert.equal(renderHandCategory(null),'');
});
test('chat duplicates retain the timestamp, and completed animation cannot replay',()=>{
 const a=room(),b=room(['Kc','2d','7h'],'一对');
 const m=updateHandCategoryMotion(a,b,[],options);
 const chat={...b,chat:[{text:'nice'}]};
 assert.deepEqual(updateHandCategoryMotion(b,chat,m,{live:true,now:1200}),m);
 const html=renderHandCategory('一对',{motion:m[0],now:1200});
 assert.match(html,/--category-age:200ms/);
 assert.doesNotMatch(renderHandCategory('一对',{motion:m[0],now:2000}),/category-before/);
 assert.deepEqual(updateHandCategoryMotion(b,chat,m,{live:true,now:2000}),[]);
});
test('first view, reconnect, disabled motion and identity or hand changes cannot replay upgrades',()=>{
 const a=room(),b=room(['Kc','2d','7h'],'一对'),m=updateHandCategoryMotion(a,b,[],options);
 for(const previous of [null,{...a,code:'else'},{...a,meId:'else'},{...a,hand:{...a.hand,id:'else'}}])assert.deepEqual(updateHandCategoryMotion(previous,b,m,options),[]);
 assert.deepEqual(updateHandCategoryMotion(a,b,m,{live:false,now:1200}),[]);
});
test('unchanged strength, newly public holes and rabbit cards do not invent upgrades',()=>{
 const a=room(),b=room(['Kc','2d','7h'],'高牌','三条');
 assert.deepEqual(updateHandCategoryMotion(a,b,[],options),[]);
 const ended={...b,hand:{...b.hand,status:'complete'}};
 assert.deepEqual(updateHandCategoryMotion(ended,{...ended,hand:{...ended.hand,rabbit:{board:['Kc','2d','7h','Qc','Kd']}}},[],options),[]);
 const corrupted=room(['Ac','2d','7h','Qc'],'两对');
 assert.deepEqual(updateHandCategoryMotion(b,corrupted,[],options),[]);
 const folded=room([...b.hand.board,'Qc'],'两对');folded.players[0].folded=true;
 assert.deepEqual(updateHandCategoryMotion(b,folded,[],options),[]);
});
test('already public runout hands upgrade independently and only on a real board extension',()=>{
 const a=room(['Js','2s','7d','Ts'],'同花','一对'),b=room([...a.hand.board,'As'],'皇家同花顺','三条');
 const motions=updateHandCategoryMotion(a,b,[],options);
 assert.deepEqual(motions.map(m=>m.playerId),['me','other']);
 assert.equal(motions[0].to,'同花顺');
 assert.match(renderHandCategory('皇家同花顺',{motion:motions[0],now:1100}),/category-after" data-hand-category="straight-flush">同花顺/);
 assert.deepEqual(updateHandCategoryMotion(b,{...b,chat:[]},motions,{live:true,now:1200}),motions);
 assert.deepEqual(updateHandCategoryMotion(b,{...b,players:[{id:'me',handCategory:'皇家同花顺'},{id:'other',handCategory:'四条'}]},[],options),[]);
});
test('legacy ace-high labels share the same badge and never invent a tenth-category upgrade',()=>{
 assert.equal(HAND_CATEGORIES.length,9);
 assert.equal(renderHandCategory('皇家同花顺'),renderHandCategory('同花顺'));
 const a=room(['9s','Ts','Js','Qs'],'同花顺'),b=room([...a.hand.board,'As'],'皇家同花顺');
 assert.deepEqual(updateHandCategoryMotion(a,b,[],options),[]);
 assert.deepEqual(updateHandCategoryMotion(room(a.hand.board,'皇家同花顺'),room(b.hand.board,'同花顺'),[],options),[]);
 assert.doesNotMatch(renderHandCategory('皇家同花顺',{motion:{from:'同花顺',to:'皇家同花顺',at:1000},now:1100}),/皇家|royal-flush|category-before/);
});
test('render ignores mismatched, stale or unsafe labels in animation metadata',()=>{
 assert.equal(renderHandCategory('<img src=x>'), '');
 assert.doesNotMatch(renderHandCategory('一对',{motion:{from:'高牌',to:'两对',at:1000},now:1100}),/category-before/);
 assert.doesNotMatch(renderHandCategory('一对',{motion:{from:'<img>',to:'一对',at:1000},now:1100}),/<img|category-before/);
});

function rabbitRoom(board, display = null) {
 const r=room(['Kc','2d','7h'],'一对');
 r.hand.status='complete';r.hand.rabbit={originalCount:3,board};
 r.players[0].folded=true;r.players[0].displayHandCategory=display;
 return r;
}
test('a folded owner sees supplemental board upgrades without replacing the settled category',()=>{
 const a=rabbitRoom(['Kc','2d','7h']),b=rabbitRoom(['Kc','2d','7h','Qc'],'两对'),c=rabbitRoom(['Kc','2d','7h','Qc','Kd'],'葫芦');
 const m=updateHandCategoryMotion(a,b,[],options);
 assert.deepEqual(m,[{handId:'hand',playerId:'me',from:'一对',to:'两对',at:1000}]);
 assert.equal(b.players[0].handCategory,'一对');
 assert.equal(displayedHandCategory(b.players[0]),'两对');
 const next=updateHandCategoryMotion(b,c,m,{live:true,now:1500});
 assert.equal(next[0].from,'两对');assert.equal(next[0].to,'葫芦');
 assert.match(renderHandCategory(displayedHandCategory(c.players[0]),{motion:next[0],now:1600}),/category-after" data-hand-category="full-house">葫芦/);
 assert.equal(displayedHandCategory({handCategory:'一对'}),'一对','old servers remain compatible');
});
test('supplemental upgrades survive clock and chat updates without restarting, then expire',()=>{
 const a=rabbitRoom(['Kc','2d','7h']),b=rabbitRoom(['Kc','2d','7h','Qc','Kd'],'葫芦');
 const m=updateHandCategoryMotion(a,b,[],options),chat={...b,chat:[{text:'nice'}]};
 assert.deepEqual(updateHandCategoryMotion(b,chat,m,{live:true,now:1200}),m);
 assert.deepEqual(updateHandCategoryMotion(b,chat,m,{live:true,now:2000}),[]);
 assert.equal(updateHandCategoryMotion(a,b,[],{live:false,now:1200}).length,0);
 for(const previous of [null,{...a,meId:'else'},{...a,code:'else'},{...a,hand:{...a.hand,id:'new'}}])assert.deepEqual(updateHandCategoryMotion(previous,b,m,options),[]);
});
test('a visible supplemental board cannot animate a folded opponent or a newly disclosed label',()=>{
 const a=rabbitRoom(['Kc','2d','7h']),b=rabbitRoom(['Kc','2d','7h','Qc','Kd'],'葫芦');
 a.meId=b.meId='viewer';assert.deepEqual(updateHandCategoryMotion(a,b,[],options),[]);
 a.meId=b.meId='me';b.players[0].displayHandCategory=null;
 assert.deepEqual(updateHandCategoryMotion(a,b,[],options),[],'no server-approved changed label');
 const c=rabbitRoom(b.hand.rabbit.board,'葫芦');
 assert.deepEqual(updateHandCategoryMotion(b,c,[],options),[],'same board does not animate a newly disclosed label');
 const corrupt=rabbitRoom(['Ac','2d','7h','Qc','Kd'],'葫芦');
 assert.deepEqual(updateHandCategoryMotion(a,corrupt,[],options),[]);
});
