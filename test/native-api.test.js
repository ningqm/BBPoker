import { seedLegacyAccount } from './helpers/accounts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { clientConfig, apiUrl, inviteUrl, parseInvite } from '../public/platform.js';

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tongzhuo-native-'));
  const app = createApp({ dataDir: directory, publicOrigin: '', clientOrigins: '', ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

test('native API: only configured exact origins can preflight bearer requests', async t => {
  const { base } = await setup(t, { clientOrigins: 'app://localhost,capacitor://localhost,https://localhost' });
  for (const origin of ['app://localhost', 'capacitor://localhost', 'https://localhost']) {
    const res = await fetch(base + '/api/session', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(res.status, 204); assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
    assert.equal(res.headers.get('vary'), 'Origin');
  }
  for (const origin of ['null', 'https://localhost.evil.test', 'capacitor://evil.test', 'http://localhost', 'app://localhost:8080']) {
    const res = await fetch(base + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"name":"拒绝此来源"}' });
    assert.equal(res.status, 403); assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  const invalid = await fetch(base + '/api/session', { method: 'OPTIONS', headers: { Origin: 'app://localhost', 'Access-Control-Request-Method': 'DELETE' } });
  assert.equal(invalid.status, 403);
});

test('native API: allowed origins still require identity and member authorization', async t => {
  const { app, base } = await setup(t, { clientOrigins: 'app://localhost' });
  const origin = 'app://localhost';
  assert.equal((await fetch(base + '/api/me', { headers: { Origin: origin } })).status, 401);
  const res = await fetch(base + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '客户端验证' }) });
  assert.equal(res.status, 403, 'native clients cannot create public accounts either'); const user = seedLegacyAccount(app, { name: '客户端验证' });
  const me = await fetch(base + '/api/me', { headers: { Origin: origin, Authorization: `Bearer ${user.token}` } });
  assert.equal(me.status, 200); assert.equal((await me.json()).user.id, user.user.id);
  const data = await fetch(base + '/api/export?format=phh', { headers: { Origin: origin, Authorization: `Bearer ${user.token}` } });
  assert.equal(data.status, 200); assert.match(data.headers.get('content-disposition'), /\.phhs/);
  assert.equal(data.headers.get('cache-control'), 'no-store');
  assert.equal(data.headers.get('access-control-expose-headers'), 'Content-Disposition');
});

test('web API remains same-origin by default; native access is opt-in', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(base + '/api/health', { headers: { Origin: base } })).status, 200);
  assert.equal((await fetch(base + '/api/health', { headers: { Origin: 'app://localhost' } })).status, 403);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('a deployed public origin supports reverse proxies without wildcard origins', async t => {
  const { base } = await setup(t, { publicOrigin: 'https://friends.example.test' });
  const good = await fetch(base + '/api/health', { headers: { Origin: 'https://friends.example.test' } });
  assert.equal(good.status, 200);
  assert.equal((await fetch(base + '/api/health', { headers: { Origin: 'https://friends.example.test.evil.test' } })).status, 403);
  assert.throws(() => createApp({ publicOrigin: 'https://friends.example.test/api', clientOrigins: '' }));
  assert.throws(() => createApp({ clientOrigins: '*' }));
});

test('packaged client fails closed without a server and never leaks tokens to invite-selected hosts', () => {
  const config = clientConfig({ native: true, apiBase: 'https://poker.example.test', publicBase: 'https://play.example.test' }, 'app://localhost/');
  assert.equal(apiUrl('/api/me', config), 'https://poker.example.test/api/me');
  assert.throws(() => apiUrl('//evil.test/api/me', config));
  assert.throws(() => apiUrl('/api/../../other', config));
  assert.throws(() => clientConfig({ native: true }, 'app://localhost/'));
  assert.throws(() => clientConfig({ native: true, apiBase: 'http://poker.example.test' }));
  assert.throws(() => clientConfig({ native: true, apiBase: 'https://secret@poker.example.test' }));
  const invitation = inviteUrl({ code: '123456', invite: 'abcdefghijklmnopqrstuvwx' }, config);
  assert.match(invitation, /^https:\/\/play\.example\.test\/#\/room\//);
  assert.equal(parseInvite(invitation, config), '/room/123456/abcdefghijklmnopqrstuvwx');
  assert.throws(() => parseInvite(invitation.replace('play.example.test', 'evil.test'), config));
  assert.throws(() => parseInvite('https://evil.test/#/room/123456/abcdefghijklmnopqrstuvwx', config));
});
