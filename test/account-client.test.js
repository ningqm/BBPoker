import { createRoomClock, isOlderRoomSnapshot } from '../public/room-clock.js';
import * as records from '../public/records.js';
import {createTableFunTracker} from '../public/table-fun.js';
import * as statsUI from '../public/stats.js';
import {createTableFeedback,createTurnCountdown} from '../public/table-feedback.js';
import * as tableScene from '../public/table-scene.js';
import * as tableControls from '../public/table-controls.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequestGuard } from '../public/platform.js';
import { avatarMarkup,avatarEditorMarkup,createAvatarCache } from '../public/avatar.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
}
const clientSource = [
  'const requests=createRequestGuard();',
  section('const state=', 'const num='),
  section('const btn=', 'const card='),
  section('async function api(', 'function updateConnection('),
  section('async function loadMe(', 'function navigate('),
  section('function usernameField(', 'function errorPage('),
  section('function profileModal(', 'function roomMenu('),
  section('function resetPrivateView(', 'function resumeTable('),
  section('function finishComposition(', 'function flushTableFeedback('),
    section('function resumeTable(', "window.addEventListener('hashchange'"),
  'globalThis.client={state,requests,api,connectStream,loadMe,route,welcome,recoveryPage,profileModal,saveProfile,changePasswordModal,recoverModal,restoreModal,submitAccount,acceptAccount,logout,adoptIdentity,expireIdentity};',
].join('\n');

function harness() {
  const calls = [], writes = [], toasts = [], timers = new Map(), modals = [], cleared = [], rendered = [];
  let timerId = 0, client, avatarPatch={};
  const context = vm.createContext({createRoomClock,isOlderRoomSnapshot,...tableScene,...tableControls,funTracker:createTableFunTracker(),statsUI,records,feedback:createTableFeedback(),turnCountdown:createTurnCountdown(),tableSounds:{play(){},playFeedback(){},suspend(){}, restore() {}},
    createRequestGuard, AbortController, TextDecoder, Uint8Array, URLSearchParams, avatarMarkup,avatarEditorMarkup,createAvatarCache,
    $:()=>({}),createAvatarEditor:()=>({patch:()=>avatarPatch,setSaving(){},setError(){},destroy(){}}),
    apiUrl: p => `https://poker.test${p}`,
    fetch(url, options) { return new Promise((resolve, reject) => calls.push({url,options,resolve,reject})); },
    writeIdentity: async token => writes.push(token), clearIdentity: async () => cleared.push(true),
    render: () => rendered.push(client.state.page),
    openModal(title,body,kind='custom') { client.state.modal={title,kind};modals.push({title,body,kind}); },
    closeModal() { client.state.modal=null; },
    toast: (...args) => toasts.push(args),
    updateConnection() {}, rememberCommitment: () => false,
    document: {visibilityState:'visible'}, navigator: {onLine:true},
    location: {hash:''}, commandId: () => 'command',
    setTimeout(fn,ms) {const id=++timerId;timers.set(id,{fn,ms});return id;},
    clearTimeout: id => timers.delete(id), setInterval() {return ++timerId;}, clearInterval() {},
  });
  vm.runInContext(clientSource, context);
  client=context.client;
  const respond=(call,data,status=200)=>call.resolve({ok:status>=200&&status<300,status,json:async()=>data});
  return {...client,calls,writes,toasts,timers,modals,cleared,rendered,location:context.location,respond,setAvatarPatch:patch=>{avatarPatch=patch;}};
}
const fd = data => ({get: key => data[key]??null});
const account = {id:'existing-id',name:'朋友',username:'friend_1'};

test('entry is login only even when an old client preference requests registration',()=>{
  const c=harness();
  assert.match(c.welcome(),/id="login-form"/);
  assert.match(c.welcome(),/autocomplete="current-password"/);
  assert.match(c.welcome(),/账号由管理员分配/);
  assert.doesNotMatch(c.welcome(),/data-action="(?:recover|restore)"|找回以前的昵称/);
  c.state.authMode='register';
  assert.match(c.welcome(),/id="login-form"/);
  assert.doesNotMatch(c.welcome(),/register-form|auth-register|注册账号|name="name"|type="tel"|name="email"/);
});

test('change-password and recovery forms advertise and enforce the six-character minimum',()=>{
  const c=harness();c.state.user={...account};
  for(const show of [()=>c.changePasswordModal(),()=>c.recoverModal()]){
    show();const body=c.modals.at(-1).body;
    assert.match(body,/<input name="newPassword"[^>]*minlength="6"[^>]*maxlength="128"/);
    assert.match(body,/至少 6 位/);
    assert.doesNotMatch(body,/minlength="10"|至少 10 位/);
  }
});

test('registration cannot be called through the client account dispatcher',async()=>{
  const c=harness();c.location.hash='#/room/123456/invitation';
  await assert.rejects(c.submitAccount('register',fd({username:'friend_1',password:'my long password'})),/账号由房主分配/);
  assert.equal(c.calls.length,0);assert.equal(c.writes.length,0);assert.equal(c.state.user,null);
  assert.equal(c.location.hash,'#/room/123456/invitation');
});

test('account management entry is visible only with a verified boolean administrator flag',()=>{
  const c=harness();
  for(const isAdmin of [undefined,false,'true',1]){
    c.state.user={...account,isAdmin};c.profileModal();
    assert.doesNotMatch(c.modals.at(-1).body,/data-action="admin-accounts"/);
  }
  c.state.user={...account,isAdmin:true};c.profileModal();
  assert.match(c.modals.at(-1).body,/data-action="admin-accounts"/);
});

test('legacy identity remains usable but cannot assign its own login credentials',async()=>{
  const c=harness();Object.assign(c.state,{token:'legacy-secret',user:{id:account.id,name:account.name},page:'lobby'});
  c.profileModal();assert.match(c.modals.at(-1).body,/联系房主分配/);assert.doesNotMatch(c.modals.at(-1).body,/data-action="bind-account"/);
  await assert.rejects(c.submitAccount('bind',fd({username:'friend_1',password:'long password'})),/账号由房主分配/);
  assert.equal(c.calls.length,0);assert.equal(c.state.user.id,account.id);assert.equal(c.state.token,'legacy-secret');
});

test('wrong login/password proof errors do not revoke the current identity',async()=>{
  const c=harness();Object.assign(c.state,{token:'current-session',user:account,page:'lobby'});
  const pending=c.submitAccount('password',fd({currentPassword:'incorrect',newPassword:'new password 123'}));
  c.respond(c.calls[0],{error:'密码不正确'},400);
  await assert.rejects(pending,/密码不正确/);
  assert.equal(c.state.token,'current-session');
  assert.equal(c.state.user.id,account.id);
  assert.equal(c.cleared.length,0);
});

test('password recovery uses distinct recovery field anonymously and never stores it as identity',async()=>{
  const c=harness();c.state.token='old-browser-token';
  const pending=c.submitAccount('recover',fd({username:'friend_1',recoveryCode:'saved-code',newPassword:'a new password'}));
  assert.equal(c.calls[0].options.headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(c.calls[0].options.body),{username:'friend_1',recoveryCode:'saved-code',newPassword:'a new password'});
  c.respond(c.calls[0],{token:'new-session',user:account,recoveryCode:'replacement-code'});
  await pending;
  assert.deepEqual(c.writes,['new-session']);
  assert.equal(c.state.pendingRecovery.code,'replacement-code');
});

for (const mode of ['http401','revocation-event']) test(`SSE ${mode} removes private data and stops reconnecting`,async()=>{
  const c=harness();Object.assign(c.state,{token:'expired-token',user:account,page:'room',room:{code:'123456',privateCards:['As','Ah']},replay:{private:'holecards'}});
  const pending=c.connectStream('123456');
  if(mode==='http401')c.respond(c.calls[0],{error:'expired'},401);
  else {
    let reads=0;
    c.calls[0].resolve({ok:true,status:200,body:{getReader(){return{async read(){if(reads++)return{done:true};return{done:false,value:new TextEncoder().encode('event: session-expired\ndata: {"error":"expired"}\n\n')};}};}}});
  }
  await pending;
  assert.equal(c.state.page,'welcome');
  assert.equal(c.state.token,'');
  assert.equal(c.state.user,null);
  assert.equal(c.state.room,null);
  assert.equal(c.state.replay,null);
  assert.equal(c.state.stream,null);
  assert.equal(c.state.reconnectTimer,null);
  assert.equal(c.timers.size,0);
});

test('a late 401 from a previous account cannot log out a newer account',async()=>{
  const c=harness();Object.assign(c.state,{token:'old-token',user:{id:'old'},page:'room'});
  const pending=c.api('/api/me');
  await c.adoptIdentity({token:'new-token',user:account});
  c.respond(c.calls[0],{error:'expired'},401);
  await assert.rejects(pending,error=>error.stale===true);
  assert.equal(c.state.token,'new-token');
  assert.equal(c.cleared.length,0);
});

test('account logout revokes server session before clearing current device data',async()=>{
  const c=harness();Object.assign(c.state,{token:'current-session',user:account,page:'lobby',stats:{hands:9}});
  const pending=c.logout();
  assert.equal(c.calls[0].url,'https://poker.test/api/account/logout');
  assert.equal(c.cleared.length,0);
  c.respond(c.calls[0],{ok:true});
  await pending;
  assert.equal(c.cleared.length,1);
  assert.equal(c.state.token,'');
  assert.equal(c.state.stats,null);
  assert.equal(c.state.page,'welcome');
});


test('profile changes preserve the active identity and table without navigating or rotating a session',async()=>{
  const c=harness();Object.assign(c.state,{token:'current-session',user:account,page:'room',room:{code:'123456',players:[{...account,stack:400}]}});
  const room=c.state.room;c.profileModal();c.setAvatarPatch({avatar:11});const pending=c.saveProfile(fd({name:'新昵称'}));
  assert.equal(c.calls[0].url,'https://poker.test/api/profile');
  assert.deepEqual(JSON.parse(c.calls[0].options.body),{name:'新昵称',avatar:11});
  c.respond(c.calls[0],{user:{...account,name:'新昵称',avatar:11}});await pending;
  assert.equal(c.state.room,room);assert.equal(c.state.room.players[0].name,'新昵称');assert.equal(c.state.room.players[0].stack,400);
  assert.equal(c.state.token,'current-session');assert.equal(c.state.page,'room');assert.equal(c.writes.length,0);
});
test('late profile save cannot overwrite a newer login',async()=>{
  const c=harness();Object.assign(c.state,{token:'old-session',user:account,page:'lobby'});
  const pending=c.saveProfile(fd({name:'旧账号改名',avatar:'2'}));
  await c.adoptIdentity({token:'new-session',user:{id:'new-user',name:'新账号'}});
  c.respond(c.calls[0],{user:{...account,name:'旧账号改名',avatar:2}});
  await assert.rejects(pending,error=>error.stale===true);assert.equal(c.state.user.id,'new-user');
});


test('editing only the nickname preserves a custom avatar and sends no avatar replacement',async()=>{
  const c=harness(),avatarImage='a'.repeat(32);Object.assign(c.state,{token:'current-session',user:{...account,avatarImage},page:'lobby'});c.profileModal();
  const pending=c.saveProfile(fd({name:'只改昵称'}));assert.deepEqual(JSON.parse(c.calls[0].options.body),{name:'只改昵称'});
  c.respond(c.calls[0],{user:{...account,name:'只改昵称',avatarImage}});await pending;assert.equal(c.state.user.avatarImage,avatarImage);
});
test('uploading a cropped avatar sends one unambiguous replacement field and updates room metadata',async()=>{
  const c=harness();Object.assign(c.state,{token:'current-session',user:account,page:'room',room:{players:[{...account}]}});c.profileModal();
  c.setAvatarPatch({avatarUpload:'data:image/png;base64,c3ludGhldGlj'});const pending=c.saveProfile(fd({name:'自定义头像'}));
  assert.deepEqual(JSON.parse(c.calls[0].options.body),{name:'自定义头像',avatarUpload:'data:image/png;base64,c3ludGhldGlj'});
  c.respond(c.calls[0],{user:{...account,name:'自定义头像',avatar:2,avatarImage:'b'.repeat(32)}});await pending;
  assert.equal(c.state.room.players[0].avatarImage,'b'.repeat(32));
});


test('closing and reopening profile cannot start overlapping saves or let a late response replace newer edits',async()=>{
  const c=harness();Object.assign(c.state,{token:'current-session',user:account,page:'lobby'});c.profileModal();
  const first=c.saveProfile(fd({name:'第一份保存'}));c.profileModal();
  await assert.rejects(c.saveProfile(fd({name:'不应并发保存'})),/正在保存/);assert.equal(c.calls.length,1);
  c.respond(c.calls[0],{user:{...account,name:'第一份保存'}});await first;assert.equal(c.state.profileSave,null);
  const next=c.saveProfile(fd({name:'第二份保存'}));c.respond(c.calls[1],{user:{...account,name:'第二份保存'}});await next;assert.equal(c.state.user.name,'第二份保存');
});

test('administrator privilege comes from the current server response and is cleared on identity switch',async()=>{
  const c=harness();Object.assign(c.state,{token:'current-session',user:{...account,isAdmin:true},page:'lobby'});
  const loading=c.loadMe();c.respond(c.calls.at(-1),{user:{...account,isAdmin:true},isAdmin:false,stats:{},rooms:[]});await loading;
  assert.equal(c.state.user.isAdmin,false,'an untrusted nested profile flag does not override server capability');
  const adminLoad=c.loadMe();c.respond(c.calls.at(-1),{user:account,isAdmin:true,stats:{},rooms:[]});await adminLoad;assert.equal(c.state.user.isAdmin,true);
  let cleared=0;c.state.accountManager={reset(){cleared++;}};
  await c.adoptIdentity({token:'new-player-session',user:{id:'new-player',name:'新玩家',isAdmin:true}});
  assert.equal(c.state.user.isAdmin,false);assert.ok(cleared>0,'identity switch clears account manager and one-time credentials');
});
test('profile save preserves server-verified administrator status without elevating an ordinary player',async()=>{
  for(const isAdmin of [true,false]){
    const c=harness();Object.assign(c.state,{token:'current-session',user:{...account,isAdmin},page:'lobby'});c.profileModal();
    const saving=c.saveProfile(fd({name:'修改昵称'}));c.respond(c.calls.at(-1),{user:{...account,name:'修改昵称',isAdmin:!isAdmin}});await saving;
    assert.equal(c.state.user.isAdmin,isAdmin);
  }
});

 test('password change returns to the app without forcing recovery-code storage',async()=>{
 const c=harness();c.state.user={...account};c.state.token='old-session';
 const pending=c.submitAccount('password',fd({currentPassword:'old-secret',newPassword:'new-secret'}));
 c.respond(c.calls[0],{token:'new-session',user:account,recoveryCode:'unused-recovery'});
 for(let i=0;i<20&&c.calls.length<2;i++)await Promise.resolve();
 c.respond(c.calls[1],{user:account,rooms:[],stats:{}});
 for(let i=0;i<20&&c.calls.length<3;i++)await Promise.resolve();
 c.respond(c.calls[2],{rooms:[]});
 await pending;assert.equal(c.state.pendingRecovery,null);assert.equal(c.state.token,'new-session');
 });
