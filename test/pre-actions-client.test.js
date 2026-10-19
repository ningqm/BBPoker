import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createPreActions,preActionOptions} from '../public/pre-actions.js';
import * as controls from '../public/table-controls.js';
import * as lifecycle from '../public/lifecycle.js';
import {formatChips,getDisplayUnit,setDisplayUnit} from '../public/money.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function setup(){
 const room={code:'table',meId:'me',hostId:'other',status:'playing',serverTime:1000,
  settings:{bigBlind:10,maxPlayers:9},autoDeal:{},
  hand:{id:'hand',status:'playing',street:'preflop',actionSeq:2,actingId:'other',currentBet:10,pot:15},
  actions:{canAct:false,turnAvailable:false,canCheck:false,canFold:false,callAmount:0},
  players:[{id:'me',seat:0,stack:995,bet:5,inHand:true},{id:'other',seat:1,stack:990,bet:10,inHand:true}]};
 const state={room,token:'test-identity',page:'room',connected:true,busy:false,feedbackResync:false},calls=[];
 const doc={visibilityState:'visible',querySelectorAll:()=>[]};let renders=0;
 const ctx=vm.createContext({...controls,lifecycle,createPreActions,preActionOptions,state,document:doc,navigator:{onLine:true},
  command:(type,payload)=>{calls.push({type,payload});return Promise.resolve(false);},render:()=>{renders++;},getDisplayUnit,
  chips:n=>formatChips(n,10),num:String,esc:s=>String(s??'').replaceAll('"','&quot;'),
  autoDealText:()=>'',seatHoleCards:()=>'',seatTimeBankEnabled:()=>false,setRaisePanel(){},syncInteractionPanel(){},
  btn:(label,action,cls='',attrs='')=>`<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`});
 vm.runInContext(source.slice(source.indexOf('function installPreActions('),source.indexOf('function career(')),ctx);
 vm.runInContext(source.slice(source.indexOf('function updateConnection('),source.indexOf('async function loadMe(')),ctx);
 ctx.installPreActions();
 const select=kind=>state.togglePreAction({dataset:{preKind:kind,preKey:preActionOptions(room).key}});
 return {state,room,doc,ctx,calls,select,draw:()=>ctx.actionArea(room,room.players[0],false),renders:()=>renders};
}
function ownTurn(h){h.room.hand.actingId='me';h.room.actions={canAct:true,turnAvailable:true,canCheck:false,canFold:true,callAmount:5};}

test('waiting buttons send only an intent; selection appears after server acknowledgment',async()=>{
 setDisplayUnit('points');const h=setup();assert.match(h.draw(),/跟当前注 5 积分/);
 await h.select('call-current');assert.equal(h.calls.length,1);assert.equal(h.calls[0].type,'preAction');assert.equal(h.calls[0].payload.callAmount,5);
 assert.doesNotMatch(h.draw(),/aria-pressed="true"/);
 h.room.preAction={id:'confirmed',kind:'call-current'};h.room.preActionVersion=1;
 assert.match(h.draw(),/aria-pressed="true"/);assert.match(h.draw(),/已预选 · 再点取消/);
 await h.select('call-current');assert.equal(h.calls[1].payload.kind,null);assert.equal(h.calls[1].payload.preActionId,'confirmed');assert.equal(h.calls[1].payload.preActionVersion,1);
 assert.match(h.draw(),/已预选/,'cancel also needs acknowledgment');h.room.preAction=null;assert.doesNotMatch(h.draw(),/已预选/);
 setDisplayUnit('bb');assert.match(h.draw(),/跟当前注 0.5 BB/);setDisplayUnit('points');
});
test('a detached old quote cannot authorize a higher amount',()=>{
 const h=setup(),preKey=preActionOptions(h.room).key;h.room.hand.currentBet=40;h.room.players[1].bet=40;
 h.state.togglePreAction({dataset:{preKind:'call-current',preKey}});assert.deepEqual(h.calls,[]);
});
test('foreground renders never submit a poker action on behalf of a server intent',()=>{
 const h=setup();h.room.preAction={kind:'call-current'};ownTurn(h);h.room.actions.canAct=false;h.state.syncPreAction();
 h.room.actions.canAct=true;h.state.syncPreAction();h.state.syncPreAction();assert.deepEqual(h.calls,[]);
 assert.doesNotMatch(h.draw(),/data-action="pre-action"/);
});
test('server removal after a raise clears selected UI and never follows the price locally',()=>{
 const h=setup();h.room.preAction={kind:'call-current'};assert.match(h.draw(),/aria-pressed="true"/);
 h.room.preAction=null;h.room.hand.currentBet=40;h.room.players[1].bet=40;h.state.syncPreAction();
 assert.doesNotMatch(h.draw(),/aria-pressed="true"/);ownTurn(h);h.state.syncPreAction();assert.deepEqual(h.calls,[]);
});
test('connection refresh disables edits without erasing authoritative intent or resubmitting it',()=>{
 const h=setup(),buttons=[{dataset:{action:'pre-action'},disabled:true},{dataset:{action:'raise-preset'},disabled:false}];
 h.doc.querySelectorAll=s=>s==='[data-game-action]'?buttons:[];h.ctx.updateConnection();assert.equal(buttons[0].disabled,false);
 h.room.preAction={kind:'check-fold'};h.state.feedbackResync=true;h.ctx.updateConnection();assert.ok(buttons.every(b=>b.disabled));
 assert.equal(h.room.preAction.kind,'check-fold');ownTurn(h);h.state.syncPreAction();h.state.feedbackResync=false;h.state.syncPreAction();assert.deepEqual(h.calls,[]);
});
test('replacement sends server version and old id so another device cannot silently overwrite it',async()=>{
 const h=setup();h.room.preAction={id:'old-id',kind:'call-current'};h.room.preActionVersion=5;await h.select('check-fold');
 assert.equal(h.calls[0].payload.preActionVersion,5);assert.equal(h.calls[0].payload.kind,'check-fold');
 assert.equal(h.calls[0].payload.preActionId,'old-id');assert.equal(h.room.preAction.kind,'call-current');
});
test('folded, all-in, spectating and hidden players never get active editing controls',()=>{
 for(const change of [h=>h.room.players[0].folded=true,h=>h.room.players[0].allIn=true,h=>h.room.players[0].seat=null,h=>h.doc.visibilityState='hidden']){
  const h=setup();change(h);assert.doesNotMatch(h.draw(),/data-action="pre-action"/);
 }
});
