import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createAccountManager,renderAccountRows} from '../public/admin-accounts.js';
const admin={id:'admin-id',username:'host',name:'房主',isAdmin:true};
const friend={id:'friend-id',username:'friend',name:'朋友',disabled:false};
const rows=[admin,friend,{id:'old-id',name:'以前的昵称',disabled:false}];
const secret={username:'friend',password:'SYNTHETIC-password-123'};
function harness(copyImpl){
  const requests=[],views=[],copies=[],notices=[],mutations=[];let sequence=0,timestamp=0;let user=admin,modal=null,controller;
  controller=createAccountManager({
    now:()=>timestamp,makeRequestId:()=>`test-request-${++sequence}-unique`,updateMutation:value=>mutations.push(value),
    api(path,body){return new Promise((resolve,reject)=>requests.push({path,body,resolve,reject}));},
    getUser:()=>user,getModal:()=>modal,
    openModal(title,body,kind){controller.changed(kind);modal={title,kind};views.push({title,body,kind});},
    copy:async(...args)=>{copies.push(args);return copyImpl?.(...args);},notice:value=>notices.push(value),
  });
  return {controller,requests,views,copies,notices,mutations,advance:ms=>{timestamp+=ms;},setUser:value=>{user=value;},close(){controller.reset();modal=null;},async open(){const result=controller.open();requests.at(-1).resolve({accounts:rows});await result;}};
}
const form=values=>({get:key=>values[key]});
test('ordinary users cannot list or mutate accounts through client controller',async()=>{
  const h=harness();h.setUser({...friend,isAdmin:false});
  await assert.rejects(h.controller.open(),/只有管理员/);
  await assert.rejects(h.controller.handle('admin-account-status-confirm',{account:friend.id,disabled:'true'}),/只有管理员/);
  assert.equal(h.requests.length,0);
});
test('minimal list omits secrets, supports nickname search, escapes names and protects self',async()=>{
  const h=harness();await h.open();
  const body=h.views.at(-1).body;
  assert.doesNotMatch(body,/passwordHash|recoveryHash|session|createdAt/);
  assert.doesNotMatch(body,/data-account="admin-id"/);
  assert.match(body,/旧昵称身份/);
  const host={innerHTML:''};h.controller.filter('朋友',host);assert.match(host.innerHTML,/朋友/);assert.doesNotMatch(host.innerHTML,/房主/);
  const safe=renderAccountRows([{...friend,name:'<img src=x onerror=alert(1)>'}],admin.id);assert.doesNotMatch(safe,/<img/);assert.match(safe,/&lt;img/);
});
test('creating assigned account sends no password and only exposes server generated credentials once',async()=>{
  const h=harness();await h.open();h.controller.create();
  assert.doesNotMatch(h.views.at(-1).body,/name="password"/);
  const creating=h.controller.submit(form({username:' friend ',name:' 朋友 '}));
  assert.deepEqual(h.requests.at(-1).body,{username:'friend',name:'朋友',requestId:'test-request-1-unique'});
  h.requests.at(-1).resolve({account:friend,credentials:secret});await creating;
  assert.equal(h.views.at(-1).kind,'admin-account-credentials');assert.match(h.views.at(-1).body,/SYNTHETIC-password/);
  await h.controller.handle('admin-account-copy-password');assert.equal(h.copies[0][0],secret.password);
  await h.controller.handle('admin-account-copy-username');assert.equal(h.copies[1][0],secret.username);
  h.close();await h.controller.handle('admin-account-copy-password');assert.equal(h.copies.length,2);
  await h.open();assert.doesNotMatch(h.views.at(-1).body,/SYNTHETIC-password/);
});
test('late create result after closing or changing identity never shows credentials',async()=>{
  for(const changeIdentity of [false,true]){
    const h=harness();await h.open();h.controller.create();const creating=h.controller.submit(form({username:'friend'}));
    h.close();if(changeIdentity)h.setUser({...friend,isAdmin:false});
    const before=h.views.length;h.requests.at(-1).resolve({account:friend,credentials:secret});await creating;
    assert.equal(h.views.length,before);assert.equal(h.copies.length,0);
  }
});
test('reset password requires confirmation, drops secret when another modal opens, and prevents duplicate requests',async()=>{
  const h=harness();await h.open();await h.controller.handle('admin-account-reset',{account:friend.id});
  assert.match(h.views.at(-1).body,/旧密码和旧找回码将失效/);
  const count=h.requests.length;
  const resetting=h.controller.handle('admin-account-reset-confirm',{account:friend.id});
  await h.controller.handle('admin-account-reset-confirm',{account:friend.id});assert.equal(h.requests.length,count+1);
  assert.equal(h.requests.at(-1).path,'/api/admin/accounts/friend-id/reset-password');
  h.requests.at(-1).resolve({account:friend,credentials:secret});await resetting;
  h.controller.changed('profile');await h.controller.handle('admin-account-copy-password');assert.equal(h.copies.length,0);
});
test('disabling preserves account data, enabling reverses status, and self cannot be disabled',async()=>{
  const h=harness();await h.open();
  const previous=h.views.length;await h.controller.handle('admin-account-status',{account:admin.id});assert.equal(h.views.length,previous);
  await h.controller.handle('admin-account-status',{account:friend.id});assert.match(h.views.at(-1).body,/牌谱和积分记录保留/);
  const pending=h.controller.handle('admin-account-status-confirm',{account:friend.id,disabled:'true'});
  assert.equal(h.requests.at(-1).path,'/api/admin/accounts/friend-id/status');assert.deepEqual(h.requests.at(-1).body,{disabled:true});
  h.requests.at(-1).resolve({account:{...friend,disabled:true}});await new Promise(resolve=>setImmediate(resolve));
  h.requests.at(-1).resolve({accounts:[admin,{...friend,disabled:true}]});await pending;
  assert.match(h.views.at(-1).body,/已停用/);assert.match(h.views.at(-1).body,/启用账号/);
});
test('stale account list cannot reopen a closed window and non-secret errors remain actionable',async()=>{
  const h=harness();const loading=h.controller.open();h.close();const count=h.views.length;
  h.requests[0].resolve({accounts:rows});await loading;assert.equal(h.views.length,count);
  const retry=h.controller.open();h.requests.at(-1).reject(new Error('连接中断'));await retry;
  assert.match(h.views.at(-1).body,/连接中断/);assert.match(h.views.at(-1).body,/重新读取/);
});
test('administrator migrates a legacy nickname in place instead of creating a replacement identity',async()=>{
  const h=harness();await h.open();await h.controller.handle('admin-account-reset',{account:'old-id'});
  assert.equal(h.views.at(-1).kind,'admin-account-legacy');assert.match(h.views.at(-1).body,/原有牌谱和积分继续保留/);
  const migration=h.controller.submitLegacy(form({accountId:'old-id',username:' previous_friend '}));
  assert.equal(h.requests.at(-1).path,'/api/admin/accounts/old-id/reset-password');assert.deepEqual(h.requests.at(-1).body,{username:'previous_friend',requestId:'test-request-1-unique'});
  h.requests.at(-1).resolve({account:{id:'old-id',username:'previous_friend'},credentials:{...secret,username:'previous_friend'}});await migration;
  assert.match(h.views.at(-1).body,/previous_friend/);
});

test('optional empty or whitespace nickname is omitted so backend can use the account name',async()=>{
  for(const name of ['', '   ', undefined]){
    const h=harness();await h.open();h.controller.create();const pending=h.controller.submit(form({username:'new_friend',name}));
    assert.deepEqual(h.requests.at(-1).body,{username:'new_friend',requestId:'test-request-1-unique'});
    h.requests.at(-1).resolve({account:{...friend,username:'new_friend'},credentials:{...secret,username:'new_friend'}});await pending;
    assert.equal(h.views.at(-1).kind,'admin-account-credentials');
  }
});
function clipboardHarness(){
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('async function copy('),app.indexOf('\nfunction profileModal('));
  const writes=[],notices=[],appended=[];let resolve,reject;
  const dialog={open:true,append:node=>appended.push(node)};
  const document={body:{append:node=>appended.push(node)},createElement:()=>({style:{},select(){},remove(){this.removed=true;}}),execCommand:()=>true};
  const context=vm.createContext({navigator:{clipboard:{writeText:text=>{writes.push(text);return new Promise((yes,no)=>{resolve=yes;reject=no;});}}},dialog,document,toast:text=>notices.push(text)});
  vm.runInContext(source+'\nglobalThis.copyText=copy;',context);
  return{copy:context.copyText,writes,notices,appended,resolve:()=>resolve(),reject:()=>reject(new Error('Clipboard denied'))};
}
async function generatedCredentials(h){
  await h.open();h.controller.create();const pending=h.controller.submit(form({username:'friend'}));h.requests.at(-1).resolve({account:friend,credentials:secret});await pending;
}
for(const mode of ['closed','identity-change','other-modal'])test(`pending credential copy cannot fall back into the DOM after ${mode}`,async()=>{
  const c=clipboardHarness(),h=harness(c.copy);await generatedCredentials(h);
  const pending=h.controller.handle('admin-account-copy-password');assert.equal(c.writes.length,1);
  if(mode==='closed')h.close();
  else if(mode==='identity-change'){h.close();h.setUser({...friend,isAdmin:false});}
  else h.controller.changed('profile');
  c.reject();await pending;assert.equal(c.appended.length,0);assert.equal(c.notices.length,0);
});
test('successful clipboard completion after closing has no stale password success notification',async()=>{
  const c=clipboardHarness(),h=harness(c.copy);await generatedCredentials(h);
  const pending=h.controller.handle('admin-account-copy-password');h.close();c.resolve();await pending;
  assert.equal(c.appended.length,0);assert.equal(c.notices.length,0);
});
test('credential copy fallback works while the same result is open and removes its temporary field',async()=>{
  const c=clipboardHarness(),h=harness(c.copy);await generatedCredentials(h);
  const pending=h.controller.handle('admin-account-copy-password');c.reject();await pending;
  assert.equal(c.appended.length,1);assert.equal(c.appended[0].removed,true);assert.match(c.notices[0],/密码已复制/);
});
test('non-secret copy callers keep ordinary clipboard fallback without a guard',async()=>{
  const c=clipboardHarness(),pending=c.copy('normal room invitation');c.reject();await pending;
  assert.equal(c.appended.length,1);assert.equal(c.appended[0].removed,true);assert.equal(c.notices[0],'已复制');
});

for(const failure of ['timeout','http500','invalid-response'])test(`uncertain create ${failure} retries the original operation without generating another password`,async()=>{
  const h=harness();await h.open();h.controller.create();
  const fd=form({username:'retry_friend',name:'小伙伴'}),first=h.controller.submit(fd);
  const id=h.requests.at(-1).body.requestId;
  const rejected=assert.rejects(first,/重试并取回密码/);
  if(failure==='invalid-response')h.requests.at(-1).resolve({account:friend});
  else h.requests.at(-1).reject(Object.assign(new Error('unknown outcome'),failure==='http500'?{status:503}:{}));
  await rejected;assert.deepEqual(h.mutations.at(-1),{pending:false,retry:true});
  const second=h.controller.submit(fd);assert.equal(h.requests.at(-1).body.requestId,id);
  h.requests.at(-1).resolve({account:friend,credentials:secret});await second;
  assert.equal(h.views.at(-1).kind,'admin-account-credentials');
});
test('edited creation parameters receive a different request id while original values can recover their attempt',async()=>{
  const h=harness();await h.open();h.controller.create();
  const ids=[];
  for(const username of ['first_friend','second_friend','first_friend']){
    const request=h.controller.submit(form({username}));ids.push(h.requests.at(-1).body.requestId);
    const rejected=assert.rejects(request,/结果尚未确认/);h.requests.at(-1).reject(new TypeError('network'));await rejected;
  }
  assert.notEqual(ids[0],ids[1]);assert.equal(ids[0],ids[2]);
});
test('closing during creation hides late credentials and reopening can recover with original request id',async()=>{
  const h=harness();await h.open();h.controller.create();const fd=form({username:'friend'});
  const request=h.controller.submit(fd),old=h.requests.at(-1);h.close();old.resolve({account:friend,credentials:secret});await request;
  h.controller.create();const retry=h.controller.submit(fd);assert.equal(h.requests.at(-1).body.requestId,old.body.requestId);
  h.requests.at(-1).resolve({account:friend,credentials:secret});await retry;
  assert.equal(h.views.at(-1).kind,'admin-account-credentials');
});
test('request ids and pending credentials are isolated across administrator identities',async()=>{
  const h=harness();await h.open();h.controller.create();const fd=form({username:'friend'});
  const request=h.controller.submit(fd),old=h.requests.at(-1);h.close();h.setUser({...admin,id:'another-admin'});
  h.controller.create();const second=h.controller.submit(fd);assert.notEqual(h.requests.at(-1).body.requestId,old.body.requestId);
  old.resolve({account:friend,credentials:secret});await request;
  assert.equal(h.views.at(-1).kind,'admin-account-create');
  h.requests.at(-1).resolve({account:friend,credentials:secret});await second;
});
test('lost reset response reuses request id; a subsequent confirmed reset after success is a new operation',async()=>{
  const h=harness();await h.open();await h.controller.handle('admin-account-reset',{account:friend.id});
  const start=()=>h.controller.handle('admin-account-reset-confirm',{account:friend.id});
  const first=start(),id=h.requests.at(-1).body.requestId,rejected=assert.rejects(first,/结果尚未确认/);
  h.requests.at(-1).reject(new Error('timeout'));await rejected;
  const retry=start();assert.equal(h.requests.at(-1).body.requestId,id);
  h.requests.at(-1).resolve({account:friend,credentials:secret});await retry;
  await h.open();await h.controller.handle('admin-account-reset',{account:friend.id});
  const later=start();assert.notEqual(h.requests.at(-1).body.requestId,id);
  h.requests.at(-1).resolve({account:friend,credentials:secret});await later;
});
test('definite duplicate or permission errors stay explicit and are not presented as recoverable passwords',async()=>{
  for(const status of [409,403]){
    const h=harness();await h.open();h.controller.create();const request=h.controller.submit(form({username:'friend'}));
    const rejected=assert.rejects(request,/具体错误/);h.requests.at(-1).reject(Object.assign(new Error('具体错误'),{status}));await rejected;
    assert.deepEqual(h.mutations.at(-1),{pending:false,retry:false});
  }
});

for(const code of ['ACCOUNT_OPERATION_EXPIRED','ACCOUNT_OPERATION_CHANGED','ACCOUNT_OPERATION_UNAVAILABLE'])test(`terminal reset ${code} needs a fresh confirmation, never silently rotates the password`,async()=>{
  const h=harness();await h.open();await h.controller.handle('admin-account-reset',{account:friend.id});
  const start=()=>h.controller.handle('admin-account-reset-confirm',{account:friend.id});
  const first=start(),old=h.requests.at(-1).body.requestId,rejected=assert.rejects(first,/请返回/);
  h.requests.at(-1).reject(Object.assign(new Error('请返回账号列表'),{status:409,code}));await rejected;
  const count=h.requests.length;await assert.rejects(start(),/请返回/);assert.equal(h.requests.length,count);
  await h.open();await h.controller.handle('admin-account-reset',{account:friend.id});
  const fresh=start();assert.notEqual(h.requests.at(-1).body.requestId,old);
  h.requests.at(-1).resolve({account:friend,credentials:secret});await fresh;
});
test('a very late retry cannot outlive the server deduplication retention and execute another reset',async()=>{
  const h=harness();await h.open();await h.controller.handle('admin-account-reset',{account:friend.id});
  const start=()=>h.controller.handle('admin-account-reset-confirm',{account:friend.id});
  const first=start(),rejected=assert.rejects(first,/结果尚未确认/);h.requests.at(-1).reject(new Error('timeout'));await rejected;
  const count=h.requests.length;h.advance(25*60*60*1000);
  await assert.rejects(start(),/取回时间已过/);assert.equal(h.requests.length,count);
});

test('a rate-limited retry cannot forget an earlier uncertain reset and silently rotate credentials',async()=>{
  const h=harness();await h.open();await h.controller.handle('admin-account-reset',{account:friend.id});
  const start=()=>h.controller.handle('admin-account-reset-confirm',{account:friend.id}),ids=[];
  for(const status of [undefined,429]){
    const attempt=start();ids.push(h.requests.at(-1).body.requestId);
    const rejected=assert.rejects(attempt);h.requests.at(-1).reject(Object.assign(new Error('retry later'),{status}));await rejected;
  }
  const retry=start();ids.push(h.requests.at(-1).body.requestId);
  assert.equal(new Set(ids).size,1);h.requests.at(-1).resolve({account:friend,credentials:secret});await retry;
});
test('after an expired unconfirmed creation, explicitly reopening the form permits a fresh attempt',async()=>{
  const h=harness();await h.open();h.controller.create();const fd=form({username:'new_friend'});
  const first=h.controller.submit(fd),id=h.requests.at(-1).body.requestId,rejected=assert.rejects(first);
  h.requests.at(-1).reject(new Error('network'));await rejected;h.advance(16*60*1000);
  await assert.rejects(h.controller.submit(fd),/取回时间已过/);
  await h.open();h.controller.create();const retry=h.controller.submit(fd);
  assert.notEqual(h.requests.at(-1).body.requestId,id);
  h.requests.at(-1).resolve({account:friend,credentials:secret});await retry;
});
