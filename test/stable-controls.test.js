import test from 'node:test';
import assert from 'node:assert/strict';
import {patchStableControls} from '../public/stable-controls.js';

// A DOM attachment fixture: records every disconnected pressed target, rather
// than treating a replacement with identical HTML as the same clickable node.
class Element {
  constructor(tag='div',attrs={},children=[]) {
    this.nodeType=1;this.tagName=tag.toUpperCase();this.attrs={...attrs};this.childNodes=[];this.parentNode=null;this.detaches=0;
    for(const child of children)this.append(typeof child==='string'?new TextNode(child):child);
  }
  get attributes(){return Object.entries(this.attrs).map(([name,value])=>({name,value:String(value)}));}
  get isConnected(){return Boolean(this.root||this.parentNode?.isConnected);}
  get outerHTML(){return `<${this.tagName} ${JSON.stringify(this.attrs)}>${this.childNodes.map(n=>n.outerHTML).join('')}</${this.tagName}>`;}
  get textContent(){return this.childNodes.map(n=>n.textContent).join('');}
  hasAttribute(name){return name in this.attrs;}
  getAttribute(name){return this.attrs[name]??null;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  removeAttribute(name){delete this.attrs[name];}
  append(child){child.remove();this.childNodes.push(child);child.parentNode=this;}
  disconnected(){this.detaches++;for(const child of this.childNodes)child.disconnected();}
  remove(){if(!this.parentNode)return;if(this.isConnected)this.disconnected();this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this),1);this.parentNode=null;}
  replaceWith(next){const parent=this.parentNode,index=parent.childNodes.indexOf(this);next.remove();this.remove();parent.childNodes.splice(index,0,next);next.parentNode=parent;}
  matches(selector){if(selector==='[data-action]')return this.hasAttribute('data-action');if(selector==='img[data-custom-avatar]')return this.tagName==='IMG'&&this.hasAttribute('data-custom-avatar');if(selector.startsWith('.'))return (this.attrs.class||'').split(/\s+/).includes(selector.slice(1));return false;}
  querySelectorAll(selector){return this.childNodes.flatMap(node=>node.nodeType===1?[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]:[]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
class TextNode {
  constructor(value){this.nodeType=3;this.nodeValue=value;this.parentNode=null;this.detaches=0;}
  get outerHTML(){return this.nodeValue;}
  get textContent(){return this.nodeValue;}
  get isConnected(){return Boolean(this.parentNode?.isConnected);}
  disconnected(){this.detaches++;}
  remove(){if(!this.parentNode)return;if(this.isConnected)this.disconnected();this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this),1);this.parentNode=null;}
  replaceWith(next){const parent=this.parentNode,index=parent.childNodes.indexOf(this);next.remove();this.remove();parent.childNodes.splice(index,0,next);next.parentNode=parent;}
}
const el=(tag,attrs,children)=>new Element(tag,attrs,children);
function attach(node){const root=el('main',{},[node]);root.root=true;return node;}
function scene({player='hero',count=6,disabled=false,hand='h1',stack=100,message='',motion='0ms',avatarId='a'.repeat(32),avatarSrc='/fallback.svg'}={}) {
  return el('div',{class:'table-stage'},[
    el('div',{class:'felt'}),
    el('div',{class:'table-center'},[el('span',{class:'board-slot',style:`--motion-age:${motion}`},['♠A'])]),
    el('div',{class:'seat mine','data-player-id':player},[
      el('div',{class:'seat-main','data-action':'player-stats','data-player':player},[
        el('div',{class:'hole-cards'},[el('button',{'data-action':'show-card','data-hand':hand,'data-index':'0'},['♠A'])]),
        el('div',{class:'stack-value'},[String(stack)]),
        el('div',{class:'seat-identity'},[el('button',{class:'seat-avatar-button','data-action':'player-stats','data-player':player},[el('img',{'data-custom-avatar':avatarId,src:avatarSrc})])]),
      ]),
      el('div',{class:'seat-time-tools'},[el('div',{class:'seat-turn'},['14s']),el('button',{class:'seat-timebank-button','data-action':'timebank',...(disabled?{disabled:''}:{})},[`+30秒 · ${count}张`])]),
      el('span',{class:'reaction'},[message]),
    ]),
  ]);
}

test('chat snapshots never detach the pressed time card, player card or avatar ancestry',()=>{
  const current=attach(scene()),seat=current.querySelector('.seat'),main=current.querySelector('.seat-main'),avatar=current.querySelector('.seat-avatar-button'),time=current.querySelector('.seat-timebank-button');
  for(let i=0;i<9;i++)assert.equal(patchStableControls(current,scene({message:`玩家${i}: hi`,motion:`${i*20}ms`})),true);
  for(const node of [current,seat,main,avatar,time]){assert.equal(node.isConnected,true);assert.equal(node.detaches,0);}
  assert.equal(current.querySelector('.seat-timebank-button'),time);
  assert.equal(current.querySelector('.reaction').textContent,'玩家8: hi');
  assert.equal(current.querySelector('.board-slot').getAttribute('style'),'--motion-age:160ms');
});

test('time-card depletion and disconnect disable the same control without delaying permission changes',()=>{
  const current=attach(scene()),time=current.querySelector('.seat-timebank-button');
  patchStableControls(current,scene({count:5,disabled:true}));
  assert.equal(time.hasAttribute('disabled'),true);assert.equal(time.textContent,'+30秒 · 5张');assert.equal(time.detaches,0);
  patchStableControls(current,scene({count:5,disabled:false}));assert.equal(time.hasAttribute('disabled'),false);assert.equal(time.detaches,0);
});

test('the exact pressed descendant of a player card remains attached when its stack text changes',()=>{
  const current=attach(scene()),stack=current.querySelector('.stack-value'),text=stack.childNodes[0];
  patchStableControls(current,scene({stack:120}));
  assert.equal(current.querySelector('.stack-value'),stack);assert.equal(stack.detaches,0);assert.equal(text.detaches,0);assert.equal(stack.textContent,'120');
});

test('a replacement player or different hand cannot inherit the old player or show-card target',()=>{
  const current=attach(scene()),main=current.querySelector('.seat-main'),oldCard=current.querySelector('.hole-cards').childNodes[0];
  patchStableControls(current,scene({hand:'h2'}));
  assert.equal(oldCard.isConnected,false);assert.equal(main.isConnected,true);
  const card=current.querySelector('.hole-cards').childNodes[0];assert.equal(card.getAttribute('data-hand'),'h2');
  patchStableControls(current,scene({player:'new-player',hand:'h2'}));
  assert.equal(main.isConnected,false);assert.equal(current.querySelector('.seat-main').getAttribute('data-player'),'new-player');
});

test('header balance changes retain the pressed top-up button and update its visible balance',()=>{
  const header=amount=>el('div',{class:'room-head'},[
    el('div',{class:'room-head-tools'},[
      el('div',{class:'table-topup'},[el('button',{'data-action':'buyin'},['补码']),el('span',{class:'table-topup-status'},[`筹码 ${amount} BB`])]),
    ]),
  ]);
  const current=attach(header(100)),button=current.querySelector('[data-action]');
  patchStableControls(current,header(120));assert.equal(button.isConnected,true);assert.equal(button.detaches,0);assert.match(current.textContent,/120 BB/);
});

test('hydrated avatars keep the same private source only while their content identifier matches',()=>{
  const current=attach(scene({avatarSrc:'blob:private-avatar'}));
  patchStableControls(current,scene({message:'new'}));assert.equal(current.querySelectorAll('img[data-custom-avatar]')[0].getAttribute('src'),'blob:private-avatar');
  patchStableControls(current,scene({avatarId:'b'.repeat(32)}));assert.equal(current.querySelectorAll('img[data-custom-avatar]')[0].getAttribute('src'),'/fallback.svg');
});
