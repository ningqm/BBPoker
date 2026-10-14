import test from 'node:test';
import assert from 'node:assert/strict';
import {updateHandCategoryMotion, renderHandCategory} from '../public/hand-category.js';
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
 assert.deepEqual(updateHandCategoryMotion(a,b,[],options).map(m=>m.playerId),['me','other']);
 assert.deepEqual(updateHandCategoryMotion(b,{...b,players:[{id:'me',handCategory:'皇家同花顺'},{id:'other',handCategory:'四条'}]},[],options),[]);
});
test('render ignores mismatched, stale or unsafe labels in animation metadata',()=>{
 assert.equal(renderHandCategory('<img src=x>'), '');
 assert.doesNotMatch(renderHandCategory('一对',{motion:{from:'高牌',to:'两对',at:1000},now:1100}),/category-before/);
 assert.doesNotMatch(renderHandCategory('一对',{motion:{from:'<img>',to:'一对',at:1000},now:1100}),/<img|category-before/);
});
