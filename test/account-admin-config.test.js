import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore } from '../src/store.js';
import { prepareAccountAdmin } from '../deploy/configure-account-admin.mjs';

function fixture(t, env = 'HOST=127.0.0.1\nPUBLIC_ORIGIN=https://example.invalid\nADMIN_USER_IDS=\n') {
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-private-admin-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EncryptedStore(join(dir,'data'));
  store.data.users = { owner: { id: 'stable-owner-id', username: 'owner_login', name: '随时可改的昵称', passwordHash: 'test-fixture-only' },
    friend: { id:'friend-id', username:'friend_login', name:'owner_login', passwordHash:'test-fixture-only' } };
  store.data.ledger = [{ id:'unaltered' }];store.save();
  const envFile = join(dir,'original.env'), output = join(dir,'next.env');
  writeFileSync(envFile, env, {mode:0o600});
  return {store,dir,envFile,output,options:{dataDir:store.directory,envFile,output,username:' OWNER_LOGIN '}};
}

test('private configuration resolves only the login name to the existing stable ID and never rewrites game data', t => {
  const f=fixture(t), bytes=readFileSync(f.store.file), key=readFileSync(join(f.store.directory,'key')), env=readFileSync(f.envFile);
  assert.deepEqual(prepareAccountAdmin(f.options),{configured:true,accountsModified:0});
  assert.equal(readFileSync(f.output,'utf8'),'HOST=127.0.0.1\nPUBLIC_ORIGIN=https://example.invalid\nADMIN_USER_IDS=stable-owner-id\n');
  assert.equal(statSync(f.output).mode & 0o777,0o600);
  assert.deepEqual(readFileSync(f.store.file),bytes);assert.deepEqual(readFileSync(join(f.store.directory,'key')),key);assert.deepEqual(readFileSync(f.envFile),env);
  assert.throws(()=>prepareAccountAdmin(f.options), {code:'EEXIST'});
});

test('private configuration refuses missing, disabled or ambiguous identities, nickname and replacing other admins', t => {
  const f=fixture(t);
  for(const username of ['new_account','随时可改的昵称']) assert.throws(()=>prepareAccountAdmin({...f.options,username}));
  f.store.data.users.owner.disabled=true;f.store.save();assert.throws(()=>prepareAccountAdmin(f.options),/有效/);
  f.store.data.users.owner.disabled=false;f.store.data.users.duplicate={...f.store.data.users.owner,id:'duplicate'};f.store.save();
  assert.throws(()=>prepareAccountAdmin(f.options),/唯一/);delete f.store.data.users.duplicate;f.store.save();
  writeFileSync(f.envFile,'ADMIN_USER_IDS=friend-id\n');assert.throws(()=>prepareAccountAdmin(f.options),/不同管理员/);
  assert.equal(existsSync(f.output),false);
});

test('private configuration refuses duplicate env keys, invalid input, output overwrite and symlinks', t => {
  const f=fixture(t);
  assert.throws(()=>prepareAccountAdmin({...f.options,output:f.envFile}),/覆盖/);
  writeFileSync(f.envFile,'ADMIN_USER_IDS=\nADMIN_USER_IDS=\n');assert.throws(()=>prepareAccountAdmin(f.options),/重复/);
  writeFileSync(f.envFile,'not-an-env-line');assert.throws(()=>prepareAccountAdmin(f.options),/格式/);
  writeFileSync(f.envFile,'ADMIN_USER_IDS=stable-owner-id\n');
  const link=join(f.dir,'env-link');symlinkSync(f.envFile,link);assert.throws(()=>prepareAccountAdmin({...f.options,envFile:link}),/符号链接/);
  symlinkSync(f.envFile,f.output);assert.throws(()=>prepareAccountAdmin(f.options),{code:'EEXIST'});
  assert.equal(readFileSync(f.envFile,'utf8'),'ADMIN_USER_IDS=stable-owner-id\n');
});

test('already configured same administrator can be prepared without duplicating or changing its privilege', t => {
  const f=fixture(t,'# existing private configuration\nADMIN_USER_IDS="stable-owner-id"\nOTHER_CONFIG=value\n');
  prepareAccountAdmin(f.options);
  const result=readFileSync(f.output,'utf8');assert.equal((result.match(/ADMIN_USER_IDS=/g)||[]).length,1);
  assert.match(result,/OTHER_CONFIG=value/);assert.match(result,/ADMIN_USER_IDS=stable-owner-id/);
});
