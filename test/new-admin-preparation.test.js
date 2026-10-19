import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNewAdmin } from '../deploy/prepare-new-admin.mjs';
import { verifyPassword } from '../src/auth.js';
import { createApp } from '../server.js';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'bbpoker-new-admin-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {directory,output:join(directory,'private-account.json')};
}

test('new admin preparation accepts chosen credentials, stores only hash, creates no server and refuses overwrite',async t=>{
  const f=fixture(t),password='fixture8';
  const result=await prepareNewAdmin({accountName:'NEW_OWNER',password,output:f.output});
  assert.deepEqual(result,{prepared:true,activated:false});
  const bytes=readFileSync(f.output),proposal=JSON.parse(bytes);
  assert.equal(proposal.account.username,'new_owner');assert.equal(proposal.format,'bbpoker-new-admin-v1');
  assert.deepEqual(proposal.adminUserIds,[proposal.account.id]);
  assert.equal(statSync(f.output).mode&0o777,0o600);assert.equal(bytes.includes(Buffer.from(password)),false);
  assert.equal(await verifyPassword(password,proposal.account.passwordHash),true);
  assert.equal(await verifyPassword('wrong8xx',proposal.account.passwordHash),false);
  assert.equal('password' in proposal.account,false);assert.equal('token' in proposal,false);
  await assert.rejects(prepareNewAdmin({accountName:'new_owner',password,output:f.output}),{code:'EEXIST'});
  assert.deepEqual(readFileSync(f.output),bytes);
});

test('preparing a new administrator does not bypass password rules or write inside public source',async t=>{
  const f=fixture(t);
  await assert.rejects(prepareNewAdmin({accountName:'new_owner',password:'short',output:f.output}),/6–128/);
  assert.equal(existsSync(f.output),false);
  await assert.rejects(prepareNewAdmin({accountName:'new_owner',password:'fixture8',output:new URL('../public/never-created.json',import.meta.url).pathname}),/源码目录外/);
  assert.equal(existsSync(new URL('../public/never-created.json',import.meta.url)),false);
});

test('prepared account works as administrator and ordinary player only after explicit isolated installation',async t=>{
  const f=fixture(t);
  await prepareNewAdmin({accountName:'new_owner',password:'fixture8',output:f.output});
  const proposal=JSON.parse(readFileSync(f.output));
  const app=createApp({dataDir:join(f.directory,'isolated-data'),adminUserIds:proposal.adminUserIds.join(','),actionTickMs:100000});
  app.store.data.users[proposal.account.id]=proposal.account;app.store.save();
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const login=await fetch(base+'/api/account/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'new_owner',password:'fixture8'})});
  assert.equal(login.status,200);const identity=await login.json();const headers={Authorization:`Bearer ${identity.token}`,'Content-Type':'application/json'};
  const me=await (await fetch(base+'/api/me',{headers})).json();assert.equal(me.isAdmin,true);
  const accounts=await fetch(base+'/api/admin/accounts',{headers});assert.equal(accounts.status,200);
  const create=await fetch(base+'/api/rooms',{method:'POST',headers,body:'{}'});assert.equal(create.status,201);
  const {room}=await create.json();assert.equal(room.hostId,proposal.account.id);
});

test('an external-looking symlink parent cannot write an account hash into source',async t=>{
  const f=fixture(t),link=join(f.directory,'outside-looking-path');
  symlinkSync(new URL('../public',import.meta.url).pathname,link);
  await assert.rejects(prepareNewAdmin({accountName:'new_owner',password:'fixture8',output:join(link,'never-created.json')}),/源码目录外/);
  assert.equal(existsSync(new URL('../public/never-created.json',import.meta.url)),false);
});
