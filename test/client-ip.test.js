import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientIp } from '../src/client-ip.js';
import { createApp } from '../server.js';

const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('proxy IP: trust is explicitly opt-in and limited to actual loopback sockets', () => {
  const headers = { 'x-bbpoker-client-ip': '203.0.113.10' };
  for (const mode of ['', undefined, 'true', 'all', 'LOOPBACK']) {
    assert.equal(clientIp(request('127.0.0.1', headers), mode), '127.0.0.1');
  }
  for (const socket of ['198.51.100.4', '10.0.0.1', '192.168.1.1', '::ffff:10.0.0.1', '2001:db8::1', 'fc00::1']) {
    assert.equal(clientIp(request(socket, headers), 'loopback'), socket);
  }
  assert.equal(clientIp(request(undefined, headers), 'loopback'), 'local');
});

test('proxy IP: loopback proxies accept single IPv4 and IPv6 addresses', () => {
  for (const socket of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    for (const address of ['203.0.113.10', '2001:db8::10']) {
      assert.equal(clientIp(request(socket, { 'x-bbpoker-client-ip': address }), 'loopback'), address);
    }
  }
});

test('proxy IP: missing, malformed, duplicate and general forwarding headers cannot select a client IP', () => {
  for (const address of [undefined, '', 'unknown', '203.0.113.10:443', '[2001:db8::10]', '203.0.113.10, 198.51.100.2', ['203.0.113.10'], ' 203.0.113.10', '203.0.113.10 ']) {
    assert.equal(clientIp(request('127.0.0.1', {
      'x-bbpoker-client-ip': address,
      'x-forwarded-for': '198.51.100.3',
      'x-real-ip': '198.51.100.4',
      forwarded: 'for=198.51.100.5',
    }), 'loopback'), '127.0.0.1');
  }
});

async function setup(t, trustProxy) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-proxy-'));
  const app = createApp({ dataDir: directory, publicOrigin: '', clientOrigins: '', trustProxy });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = `http://127.0.0.1:${app.server.address().port}/api/session/restore`;
  return async headers => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ token: 'invalid-test-recovery-token' }),
    });
    await response.arrayBuffer();
    return response.status;
  };
}

test('HTTP rate limits isolate client IPs behind an explicitly trusted loopback proxy', async t => {
  const restore = await setup(t, 'loopback');
  const first = { 'x-bbpoker-client-ip': '203.0.113.10' };
  for (let i = 0; i < 30; i++) assert.equal(await restore(first), 401);
  assert.equal(await restore(first), 429);
  assert.equal(await restore({ 'x-bbpoker-client-ip': '203.0.113.11' }), 401);
  assert.equal(await restore({ 'x-bbpoker-client-ip': '2001:db8::10' }), 401);

  // Generic or invalid forwarded values fall back to one socket bucket.
  for (let i = 0; i < 30; i++) assert.equal(await restore({ 'x-forwarded-for': `198.51.100.${i + 1}` }), 401);
  assert.equal(await restore({ 'x-bbpoker-client-ip': '198.51.100.1, 198.51.100.2' }), 429);
  assert.equal(await restore({ 'x-bbpoker-client-ip': 'not-an-ip' }), 429);
  assert.equal(await restore({ 'x-bbpoker-client-ip': '203.0.113.11' }), 401);
});

test('HTTP rate limits ignore forged forwarding headers when proxy trust is disabled', async t => {
  const restore = await setup(t, '');
  for (let i = 0; i < 30; i++) {
    assert.equal(await restore({ 'x-bbpoker-client-ip': `203.0.113.${i + 1}`, 'x-forwarded-for': `198.51.100.${i + 1}` }), 401);
  }
  assert.equal(await restore({ 'x-bbpoker-client-ip': '203.0.113.100' }), 429);
});
