import test from 'node:test';
import assert from 'node:assert/strict';
import {tableModeNotice, mountTableModeEffects, renderSquidResult, renderSquidHistory} from '../public/table-mode-effects.js';
import {setDisplayUnit} from '../public/money.js';

const now = 100000;
const bomb = {id:'bomb:h2',handId:'h2',type:'bomb-start',at:now,until:now+1100,ante:30,bigBlind:10};
const squid = {id:'squid:2',handId:'h2',type:'squid-start',at:now,until:now+1100,mode:'unlimited',round:2,tokenBudget:12,bigBlind:10};
const ended = {id:'squid:end:1',handId:'h1',type:'squid-end',at:now,until:now+2600,mode:'unlimited',round:1,ownDelta:120,bigBlind:10};

test('simultaneous bomb and squid opening share one notice and do not extend their lifetime',()=>{
  setDisplayUnit('bb');
  const notice=tableModeNotice([bomb,squid],{now:now+400});
  assert.equal(notice.type,'combined-start');assert.equal(notice.title,'炸弹池 × 无限鱿鱼');
  assert.equal(notice.detail,'每人 3 BB');assert.equal(notice.until,now+1100);
  assert.equal(tableModeNotice([bomb,squid],{now:now+1100}),null);
});

test('different hands do not merge and a new round takes over stale settlement notice',()=>{
  assert.equal(tableModeNotice([bomb,{...squid,handId:'h3',at:now+10}],{now:now+20}).type,'squid-start');
  assert.equal(tableModeNotice([ended,{...squid,at:now+300,until:now+1400}],{now:now+400}).type,'squid-start');
});

test('single openings explain posted ante or fish budget using the active display unit',()=>{
  setDisplayUnit('points');
  assert.equal(tableModeNotice([bomb],{now}).detail,'每人 30 积分 · 直接翻牌');
  assert.equal(tableModeNotice([squid],{now}).detail,'第 2 轮 · 12 条鱼');
  assert.equal(tableModeNotice([{...squid,mode:'normal'}],{now}).title,'新一轮 鱿鱼');
});

test('settlement reports only the current player public fish delta, never whole-pot totals',()=>{
  setDisplayUnit('bb');
  const won=tableModeNotice([{...ended,amount:12000}],{now});
  assert.equal(won.detail,'本轮 +12 BB');assert.equal(won.positive,true);assert.equal(won.negative,false);
  const lost=tableModeNotice([{...ended,ownDelta:-50}],{now});
  assert.equal(lost.detail,'本轮 -5 BB');assert.equal(lost.negative,true);
  assert.equal(tableModeNotice([{...ended,ownDelta:0}],{now}).detail,'本轮 0 BB');
  for(const ownDelta of [null,undefined,NaN,'50'])assert.equal(tableModeNotice([{...ended,ownDelta}],{now}).detail,'结算完成');
});

test('closed results receive only ending feedback and future, expired or malformed events stay absent',()=>{
  const room={status:'closed'};
  assert.equal(tableModeNotice([bomb,squid],{now,room}),null);
  assert.equal(tableModeNotice([ended],{now,room}).type,'squid-end');
  for(const event of [{...bomb,type:'unknown'},{...bomb,id:''},{...bomb,at:now+1},{...bomb,until:now},{...bomb,until:now+10000},{...bomb,at:NaN}])assert.equal(tableModeNotice([event],{now}),null);
  assert.equal(tableModeNotice(null,{now}),null);assert.equal(tableModeNotice([bomb],{now:NaN}),null);
});

function fixture({results=false}={}) {
  const doc={visibilityState:'visible',createElement:tag=>new Element(tag)};
  class Element {
    constructor(tag='div'){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.className='';this.dataset={};this.props={};this.events={};this.textContent='';this.style={setProperty:(k,v)=>this.props[k]=v};
      this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...names])].join(' ');},remove:(...names)=>{this.className=this.className.split(' ').filter(n=>!names.includes(n)).join(' ');},toggle:(name,on)=>{this.classList[on?'add':'remove'](name);}};}
    append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}
    matches(selector){if(selector==='.results-heading p')return this.tagName==='p'&&this.parentNode?.className.includes('results-heading');return selector.startsWith('.')&&this.className.split(' ').includes(selector.slice(1));}
    querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    setAttribute(key,value){this[key]=value;}
    addEventListener(name,handler){this.events[name]=handler;}
  }
  const root=new Element(),heading=new Element(),host=new Element(results?'p':'div');
  if(results){heading.className='results-heading';host.textContent='原牌桌名称';heading.append(host);root.append(heading);}else{host.className='room-status-bar';const button=new Element('button');button.textContent='盲注 5 / 10';host.append(button);root.append(host);}
  return {doc,root,host};
}

test('repeated ticks keep the same DOM and original animation delay, full rerender resumes event age',()=>{
  const f=fixture();mountTableModeEffects(f.root,[bomb],{now});
  const node=f.host.querySelector('.table-mode-notice'),button=f.host.children[0];
  assert.equal(node.props['--mode-age'],'0ms');assert.equal(node['role'],'status');
  mountTableModeEffects(f.root,[bomb],{now:now+400});
  assert.equal(f.host.querySelector('.table-mode-notice'),node);assert.equal(node.props['--mode-age'],'0ms');assert.equal(f.host.children[0],button);
  const rebuilt=fixture();mountTableModeEffects(rebuilt.root,[bomb],{now:now+600});
  assert.equal(rebuilt.host.querySelector('.table-mode-notice').props['--mode-age'],'600ms');
});

test('static reduced-motion notice still expires and restores the original status row',()=>{
  const f=fixture();mountTableModeEffects(f.root,[squid],{now,animated:false});
  const node=f.host.querySelector('.table-mode-notice');assert.ok(node);assert.equal(node.className.includes('is-animated'),false);
  mountTableModeEffects(f.root,[squid],{now:now+1100,animated:false});
  assert.equal(f.host.querySelector('.table-mode-notice'),null);assert.equal(f.host.className,'room-status-bar');assert.equal(f.host.children[0].textContent,'盲注 5 / 10');
});

test('hidden, disabled or empty event updates remove decoration without removing underlying controls',()=>{
  for(const option of [{enabled:false},{hidden:true},{empty:true}]){
    const f=fixture();mountTableModeEffects(f.root,[bomb],{now});
    if(option.hidden)f.doc.visibilityState='hidden';
    mountTableModeEffects(f.root,option.empty?[]:[bomb],{now,...option});
    assert.equal(f.host.querySelector('.table-mode-notice'),null);assert.equal(f.host.children.length,1);
  }
});

test('room results temporarily use the room-name line and keep original text for restoration',()=>{
  const f=fixture({results:true});const room={status:'closed'};
  mountTableModeEffects(f.root,[ended],{now,room});
  assert.equal(f.host.className,'has-mode-notice mode-notice-results');assert.equal(f.host.textContent,'原牌桌名称');
  assert.equal(f.host.querySelector('.table-mode-title').textContent,'鱿鱼结算');
  mountTableModeEffects(f.root,[ended],{now:now+2600,room});
  assert.equal(f.host.className,'');assert.equal(f.host.textContent,'原牌桌名称');assert.equal(f.host.children.length,0);
});

test('changing BB display updates settlement text in place without replaying its entry',()=>{
  const f=fixture();setDisplayUnit('bb');mountTableModeEffects(f.root,[ended],{now});
  const node=f.host.querySelector('.table-mode-notice');assert.equal(node.querySelector('.table-mode-detail').textContent,'本轮 +12 BB');
  setDisplayUnit('points');mountTableModeEffects(f.root,[ended],{now:now+400});
  assert.equal(f.host.querySelector('.table-mode-notice'),node);assert.equal(node.querySelector('.table-mode-detail').textContent,'本轮 +120 积分');assert.equal(node.props['--mode-age'],'0ms');
});

 test('fish detail separates poker, preserves signed settlements and escapes player names',()=>{
 const result={round:2,mode:'unlimited',changes:{a:-120,b:80,c:40},counts:{a:0,b:2,c:1}};
 const room={meId:'a',settings:{bigBlind:10},players:[{id:'a',name:'<img onerror=x>'},{id:'b',name:'B'},{id:'c',name:'C'}],mini:{squid:{history:[result]}}};
 setDisplayUnit('points');const html=renderSquidHistory(room);
 assert.match(html,/罚鱼 -120 积分/);assert.match(html,/收鱼 \+80 积分/);assert.match(html,/收鱼 \+40 积分/);
 assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/不含德州收池/);
 assert.match(renderSquidResult(result,room,{compact:true}),/compact/);
 });
 test('settlement starts after collection, expires before next deal and never covers playing controls',()=>{
 const e={...ended,at:now+1800,until:now+4400};
 assert.equal(tableModeNotice([e],{now:now+1799}),null);
 assert.equal(tableModeNotice([e],{now:now+1800}).type,'squid-end');
 assert.equal(tableModeNotice([e],{now:now+4400}),null);
 assert.equal(tableModeNotice([e],{now:now+2000,room:{hand:{status:'playing'}}}),null);
 });
