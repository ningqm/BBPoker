import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClient, clientConfig } from '../scripts/build-clients.mjs';
import { exportFile } from '../apps/mobile/src/export-file.js';

const { isLocalPage, assetPath, validateExport, validateIdentity } = createRequire(import.meta.url)('../apps/desktop/src/security.cjs');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tongzhuo-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public/index.html'), '<html><head><title>同桌</title><script src="/client-config.js"></script><script src="/app.js" defer></script></head><body><div id="app"></div></body></html>');
  await writeFile(join(root, 'public/app.js'), 'window.appLoaded=true');
  await writeFile(join(root, 'public/sw.js'), 'private cache forbidden');
  await writeFile(join(root, 'server.js'), 'server private');
  return root;
}

test('native configuration requires explicit HTTPS origins, never silently choosing a development server', () => {
  assert.deepEqual(clientConfig(), { apiBase: '', publicBase: '', native: true });
  assert.deepEqual(clientConfig({ apiBase: 'https://poker.example.test/' }), { apiBase: 'https://poker.example.test', publicBase: 'https://poker.example.test', native: true });
  for (const apiBase of ['http://localhost:8787', 'http://192.168.1.2', 'https://localhost', 'https://u:p@host.test', 'https://host.test/api', 'https://host.test/?token=x', 'file:///tmp/app', 'javascript:alert(1)']) assert.throws(() => clientConfig({ apiBase }));
  assert.throws(() => clientConfig({ publicBase: 'https://poker.example.test' }));
  assert.equal(clientConfig({ apiBase: 'http://localhost:8791', allowLocalhost: true }).development, true);
  assert.throws(() => clientConfig({ apiBase: 'http://192.168.1.2', allowLocalhost: true }));
});

test('native build only copies public assets, replaces configuration and applies narrow network policy', async t => {
  const root = await fixture(t);
  const result = await buildClient('desktop', { root, apiBase: 'https://poker.example.test' });
  assert.deepEqual((await readdir(result.output)).sort(), ['app.js', 'client-config.js', 'client-config.json', 'index.html']);
  const html = await readFile(join(result.output, 'index.html'), 'utf8');
  assert.equal((html.match(/src="\/client-config.js"/g) ?? []).length, 1);
  assert.ok(html.indexOf('/client-config.js') < html.indexOf('/app.js'));
  assert.ok(html.includes("connect-src 'self' https://poker.example.test;"));
  assert.equal(JSON.parse(await readFile(join(result.output, 'client-config.json'), 'utf8')).apiBase, 'https://poker.example.test');
});

test('a build without deployment configuration shows a visible error instead of starting the game', async t => {
  const root = await fixture(t), result = await buildClient('desktop', { root });
  const html = await readFile(join(result.output, 'index.html'), 'utf8');
  assert.ok(html.includes('还没有连接牌桌服务'));
  assert.ok(!html.includes('/app.js'));
  assert.ok(!html.includes('localhost:8787'));
});

test('packaging rejects symlinks that could copy files outside the public assets', async t => {
  const root = await fixture(t);
  await symlink(join(root, 'server.js'), join(root, 'public/secret.js'));
  await assert.rejects(buildClient('desktop', { root }), /符号链接/);
});

test('desktop navigation and asset lookup reject remote pages, credentials, and traversal', () => {
  assert.equal(isLocalPage('app://localhost/index.html#/room/123456/invite'), true);
  for (const url of ['https://localhost/index.html', 'app://attacker/index.html', 'app://user@localhost/index.html', 'app://localhost/other.html', 'file:///index.html']) assert.equal(isLocalPage(url), false);
  assert.equal(assetPath('/safe/web', 'app://localhost/app.js'), '/safe/web/app.js');
  for (const url of ['app://localhost/%2f../secret', 'app://localhost/.secret', 'app://localhost/%5csecret', 'https://localhost/app.js', 'app://other/app.js']) assert.throws(() => assetPath('/safe/web', url));
});

test('desktop bridge accepts only small text poker exports and bounded identity tokens', () => {
  assert.equal(validateExport({ name: 'hands.json', content: '{}', mime: 'application/json; charset=utf-8' }).extension, 'json');
  const phh = { name: 'tongzhuo-my-hands.phhs', content: "variant = 'NT'\nactions = ['d dh p1 AsKs', 'p1 f']\n", mime: 'text/plain; charset=utf-8' };
  assert.equal(validateExport(phh).extension, 'phhs');
  assert.deepEqual(exportFile(phh), { name: phh.name, content: phh.content });
  for (const invalid of [{ ...phh, name: 'hands.exe' }, { ...phh, mime: 'text/csv' }, { ...phh, name: '../hands.phhs' }]) { assert.throws(() => validateExport(invalid)); assert.throws(() => exportFile(invalid)); }
  for (const payload of [{ name: '../hands.json', content: '{}', mime: 'application/json' }, { name: 'run.exe', content: 'x', mime: 'text/plain' }, { name: '.profile', content: 'x', mime: 'text/plain' }, { name: 'hands.csv', content: Buffer.from('x'), mime: 'text/csv' }, { name: 'hands.txt', content: 'x'.repeat(16 * 1024 * 1024 + 1), mime: 'text/plain' }]) assert.throws(() => validateExport(payload));
  assert.equal(validateIdentity('a'.repeat(43)), 'a'.repeat(43));
  assert.throws(() => validateIdentity('../token'));
});
