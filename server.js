import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { EncryptedStore } from './src/store.js';
import { RoomService, cleanName, fail, exportText, exportCsv, now } from './src/room.js';
import { fairnessInfo } from './src/fairness.js';
import { originPolicy } from './src/origins.js';
import { exportPhh } from './src/phh.js';
import { clientIp } from './src/client-ip.js';
import { digest, secret, username, password, hashPassword, verifyPassword, verifySecret, SESSION_MS } from './src/auth.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export function createApp({ dataDir = process.env.DATA_DIR || join(ROOT, 'data'), actionTickMs = 1000, publicOrigin = process.env.PUBLIC_ORIGIN || '', clientOrigins = process.env.CLIENT_ORIGINS || '', trustProxy = process.env.TRUST_PROXY || '', allowGuestSessions = false } = {}) {
  const checkOrigin = originPolicy(publicOrigin, clientOrigins);
  const store = new EncryptedStore(dataDir), service = new RoomService(store);
  const streams = new Map(), rateLimits = new Map();
  store.data.sessions ??= {};
  for (const [key, session] of Object.entries(store.data.sessions)) if (session.expiresAt <= Date.now()) delete store.data.sessions[key];
  // Preserve the exact active deck on restart, while granting a fresh action clock.
  for (const r of Object.values(store.data.rooms)) if (r.hand?.status === 'playing') {
    r.deadline = Date.now() + r.settings.actionSeconds * 1000;
    r.hand.log.push({ seq: r.hand.log.length + 1, street: r.hand.street, type: 'reconnect', amount: 0 });
  }
  store.save();

  function send(res, status, payload, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(payload));
  }
  function limited(key, count, windowMs = 60000) {
    const t = Date.now(); let row = rateLimits.get(key);
    if (!row || row.until <= t) {
      if (rateLimits.size >= 5000) for (const [k, v] of rateLimits) if (v.until <= t) rateLimits.delete(k);
      if (!row && rateLimits.size >= 5000) fail('操作过于频繁，请稍后再试', 429);
      row = { n: 0, until: t + windowMs }; rateLimits.set(key, row);
    }
    if (++row.n > count) fail('操作过于频繁，请稍后再试', 429);
  }
  const userById = id => Object.values(store.data.users).find(u => u.id === id);
  const userByName = name => Object.values(store.data.users).find(u => u.username === name);
  function userForKey(key) {
    const session = store.data.sessions?.[key];
    if (session && session.expiresAt > Date.now()) {
      const user = userById(session.userId);
      if (user?.username && session.version === user.credentialVersion) return user;
    }
    // Old identity tokens remain usable only until that identity binds an account.
    const legacy = store.data.users[key];
    return legacy && !legacy.username ? legacy : null;
  }
  function auth(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(req.headers.authorization ?? '');
    if (!match) fail('请先登录账号', 401);
    const key = digest(match[1]), user = userForKey(key);
    if (!user) fail('登录已失效，请重新登录', 401);
    req.authKey = key;
    return user;
  }
  function publicUser(u) { return { id: u.id, name: u.name, avatar: u.avatar, username: u.username ?? null }; }
  async function body(req) {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 16384) fail('请求内容过大', 413); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请求格式错误'); if (req.authKey) auth(req); return value; }
    catch (e) { if (e.status) throw e; fail('请求格式错误'); }
  }
  function mutate(fn) {
    const previous = structuredClone(store.data);
    try { const result = fn(); store.save(); return result; }
    catch (e) { store.data = previous; service.db = previous; throw e; }
  }
  function issueSession(user) {
    const sessions = store.data.sessions ??= {};
    for (const [key, s] of Object.entries(sessions)) if (s.expiresAt <= Date.now()) delete sessions[key];
    const own = Object.entries(sessions).filter(([, s]) => s.userId === user.id).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (own.length >= 10) delete sessions[own.shift()[0]];
    const token = secret(), createdAt = Date.now();
    sessions[digest(token)] = { userId: user.id, version: user.credentialVersion, createdAt, expiresAt: createdAt + SESSION_MS };
    return token;
  }
  function rotateCredentials(user, passwordHash) {
    const recoveryCode = secret();
    user.passwordHash = passwordHash; user.recoveryHash = digest(recoveryCode);
    user.credentialVersion = (user.credentialVersion ?? 0) + 1;
    for (const [key, s] of Object.entries(store.data.sessions ?? {})) if (s.userId === user.id) delete store.data.sessions[key];
    return { token: issueSession(user), user: publicUser(user), recoveryCode };
  }
  function closeInvalidStreams() {
    for (const set of streams.values()) for (const client of set) if (!userForKey(client.authKey)) {
      if (!client.res.destroyed && !client.res.writableEnded) client.res.end('event: session-expired\ndata: {"error":"登录已失效，请重新登录"}\n\n');
    }
  }
  function accountLimit(kind, ip, name, perIp, perName) {
    limited(`account:${kind}:ip:${ip}`, perIp, 15 * 60000);
    limited(`account:${kind}:name:${digest(name)}`, perName, 15 * 60000);
  }
  function broadcast(code) {
    const room = store.data.rooms[code]; if (!room) return;
    for (const client of streams.get(code) ?? []) {
      try { if (!userForKey(client.authKey)) { closeInvalidStreams(); continue; } if (client.res.writableLength > 512 * 1024) { client.res.destroy(); continue; } client.res.write(`data: ${JSON.stringify(service.state(room, client.userId))}\n\n`); }
      catch { client.res.destroy(); }
    }
  }
  function subscribe(req, res, room, user) {
    service.member(room, user.id);
    const connectionKey = `${room.code}:${user.id}`;
    if ((service.connections.get(connectionKey) ?? 0) >= 5) fail('同一账号打开的牌桌过多，请关闭其他窗口', 429);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const client = { res, userId: user.id, authKey: req.authKey }; if (!streams.has(room.code)) streams.set(room.code, new Set()); streams.get(room.code).add(client);
    service.connections.set(connectionKey, (service.connections.get(connectionKey) ?? 0) + 1);
    broadcast(room.code);
    const heartbeat = setInterval(() => { if (!userForKey(client.authKey)) closeInvalidStreams(); else if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat); streams.get(room.code)?.delete(client);
      service.connections.set(connectionKey, Math.max(0, (service.connections.get(connectionKey) ?? 1) - 1)); broadcast(room.code);
    });
  }
  const server = http.createServer(async (req, res) => {
    const securityHeaders = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    };
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (path.startsWith('/api/')) {
        const ip = clientIp(req, trustProxy); limited(`ip:${ip}`, 600);
        checkOrigin(req, res);
        if (req.method === 'OPTIONS') { if (!req.headers.origin) fail('缺少请求来源', 400); res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
        if (path === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, app: 'BBPoker', version: '0.4.2', time: now() });
        if (path === '/api/fairness' && req.method === 'GET') return send(res, 200, fairnessInfo);
        if (path === '/api/source/poker.js' || path === '/api/source/fairness.js') {
          if (req.method !== 'GET') fail('方法不支持', 405);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(readFileSync(join(ROOT, 'src', path.split('/').at(-1))));
        }
        if (path === '/api/session' && req.method === 'POST') {
          if (!allowGuestSessions) fail('请注册账号或登录；已有旧身份可通过恢复码找回并绑定账号', 410);
          limited(`register:${ip}`, 20); const b = await body(req);
          if (typeof b.name !== 'string' || !b.name.trim()) fail('请填写昵称');
          const token = randomBytes(32).toString('base64url');
          const user = mutate(() => {
            if (Object.keys(store.data.users).length >= 1000) fail('账号数量达到上限');
            const u = { id: randomBytes(12).toString('hex'), name: cleanName(b.name, '朋友'), avatar: Number.isInteger(b.avatar) ? Math.max(0, Math.min(11, b.avatar)) : randomBytes(1)[0] % 12, createdAt: now() };
            store.data.users[digest(token)] = u; return u;
          });
          return send(res, 201, { token, user: publicUser(user) });
        }
        if (path === '/api/session/restore' && req.method === 'POST') {
          limited(`restore:${ip}`, 30); const b = await body(req);
          if (typeof b.token !== 'string' || b.token.length > 100) fail('恢复码格式错误');
          const u = store.data.users[digest(b.token.trim())]; if (!u || u.username) fail('恢复码无效或此身份已绑定账号，请使用账号登录', 401);
          return send(res, 200, { token: b.token.trim(), user: publicUser(u) });
        }
        if (path === '/api/account/register' && req.method === 'POST') {
          limited(`account:register:ip:${ip}`, 10, 60 * 60000);
          const b = await body(req), name = username(b.username); password(b.password);
          if (userByName(name)) fail('这个账号已被使用，请换一个', 409);
          if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) fail('请填写昵称');
          const passwordHash = await hashPassword(b.password);
          const result = mutate(() => {
            // Another request may have committed while scrypt was running.
            if (userByName(name)) fail('这个账号已被使用，请换一个', 409);
            if (Object.keys(store.data.users).length >= 1000) fail('账号数量达到上限');
            const u = { id: randomBytes(12).toString('hex'), username: name, name: cleanName(b.name ?? name, name), avatar: randomBytes(1)[0] % 12, createdAt: now() };
            store.data.users[u.id] = u;
            return rotateCredentials(u, passwordHash);
          });
          return send(res, 201, result);
        }
        if (path === '/api/account/login' && req.method === 'POST') {
          const b = await body(req), name = username(b.username);
          accountLimit('login', ip, name, 60, 15);
          const before = userByName(name), passwordHash = before?.passwordHash, version = before?.credentialVersion;
          const valid = await verifyPassword(b.password, passwordHash);
          const result = mutate(() => {
            const u = userByName(name);
            if (!valid || !u || u.passwordHash !== passwordHash || u.credentialVersion !== version) fail('账号或密码错误', 401);
            return { token: issueSession(u), user: publicUser(u) };
          });
          closeInvalidStreams(); return send(res, 200, result);
        }
        if (path === '/api/account/recover' && req.method === 'POST') {
          const b = await body(req), name = username(b.username); password(b.newPassword);
          accountLimit('recover', ip, name, 20, 5);
          const before = userByName(name), recoveryHash = before?.recoveryHash, version = before?.credentialVersion;
          const valid = verifySecret(b.recoveryCode, recoveryHash);
          // Do identical password work for unknown accounts and wrong recovery codes.
          const passwordHash = await hashPassword(b.newPassword);
          const result = mutate(() => {
            const u = userByName(name);
            if (!valid || !u || u.recoveryHash !== recoveryHash || u.credentialVersion !== version) fail('账号或恢复码错误', 401);
            return rotateCredentials(u, passwordHash);
          });
          closeInvalidStreams(); return send(res, 200, result);
        }
        const user = auth(req);
        if (path === '/api/account/bind' && req.method === 'POST') {
          limited(`account:bind:${user.id}`, 10, 15 * 60000);
          const b = await body(req), name = username(b.username); password(b.password);
          if (user.username) fail('此身份已经绑定账号', 409);
          if (userByName(name)) fail('这个账号已被使用，请换一个', 409);
          const passwordHash = await hashPassword(b.password);
          const result = mutate(() => {
            const u = auth(req);
            if (u.username) fail('此身份已经绑定账号', 409);
            if (userByName(name)) fail('这个账号已被使用，请换一个', 409);
            u.username = name;
            return rotateCredentials(u, passwordHash);
          });
          closeInvalidStreams(); return send(res, 200, result);
        }
        if (path === '/api/account/password' && req.method === 'POST') {
          const b = await body(req); password(b.newPassword);
          accountLimit('password', ip, user.id, 20, 10);
          if (!user.username) fail('请先绑定账号', 409);
          const oldHash = user.passwordHash, version = user.credentialVersion;
          if (!await verifyPassword(b.currentPassword, oldHash)) fail('当前密码错误', 400);
          const passwordHash = await hashPassword(b.newPassword);
          const result = mutate(() => {
            const u = auth(req);
            if (u.passwordHash !== oldHash || u.credentialVersion !== version) fail('登录已失效，请重新登录', 401);
            return rotateCredentials(u, passwordHash);
          });
          closeInvalidStreams(); return send(res, 200, result);
        }
        if (path === '/api/account/logout' && req.method === 'POST') {
          await body(req);
          if (!user.username) fail('旧身份请先绑定账号，再退出登录', 409);
          mutate(() => { auth(req); delete store.data.sessions[req.authKey]; });
          closeInvalidStreams(); return send(res, 200, { ok: true });
        }
        if (path === '/api/me' && req.method === 'GET') return send(res, 200, { user: publicUser(user), createKeyRequired: Boolean(process.env.CREATE_ROOM_KEY), stats: service.stats(user.id), rooms: Object.values(store.data.rooms).filter(r => r.members[user.id]).map(r => ({ code: r.code, name: r.name, status: r.status })) });
        if (path === '/api/stats' && req.method === 'GET') return send(res, 200, service.stats(user.id));
        if (path === '/api/hands' && req.method === 'GET') return send(res, 200, service.handLibrary(user.id, {
          before: url.searchParams.get('before'), limit: url.searchParams.get('limit') ?? '20', favorites: url.searchParams.get('favorites'), room: url.searchParams.get('room'),
        }));
        const favoriteMatch = /^\/api\/hands\/([A-Za-z0-9_-]{1,80})\/favorite$/.exec(path);
        if (favoriteMatch && req.method === 'POST') {
          limited(`favorite:${user.id}`, 120); const b = await body(req);
          return send(res, 200, mutate(() => service.favoriteHand(user.id, favoriteMatch[1], b.favorite)));
        }
        if (path === '/api/rooms' && req.method === 'POST') {
          limited(`create:${user.id}`, 6); const b = await body(req);
          // Optional deployment gate. Leave empty on a private LAN; configure before public hosting.
          if (process.env.CREATE_ROOM_KEY && b.createKey !== process.env.CREATE_ROOM_KEY) fail('需要建房口令，请向部署者索取', 403);
          const room = mutate(() => service.create(user, b)); return send(res, 201, { room: service.state(room, user.id) });
        }
        if (path === '/api/events' && req.method === 'GET') return subscribe(req, res, service.room(url.searchParams.get('room')), user);
        if (path === '/api/export' && req.method === 'GET') {
          const code = url.searchParams.get('room') || undefined, format = url.searchParams.get('format') || 'json';
          if (!['json','txt','csv','phh'].includes(format)) fail('不支持的导出格式');
          const hands = service.exports(user.id, code, url.searchParams.get('from'), url.searchParams.get('to'));
          const adjustments = service.exportAdjustments(user.id, code, url.searchParams.get('from'), url.searchParams.get('to'));
          const data = format === 'json' ? JSON.stringify({ app: 'BBPoker', version: 1, exportedAt: now(), viewerId: user.id, privacy: 'Only your own cards and publicly revealed cards are included.', hands, adjustments }, null, 2) : format === 'txt' ? exportText(hands, adjustments) : format === 'phh' ? exportPhh(hands, adjustments, user.id) : exportCsv(hands, user.id, adjustments);
          res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="bbpoker-${code ?? 'career'}-${new Date().toISOString().slice(0,10)}.${format === 'phh' ? 'phhs' : format}"`, 'Cache-Control': 'no-store' });
          return res.end(data);
        }
        const match = /^\/api\/rooms\/([0-9]{6})(?:\/(join|action|history|hands|chat)(?:\/([a-zA-Z0-9-]+))?)?$/.exec(path);
        if (match) {
          const [, code, endpoint, handId] = match;
          if (endpoint === 'join' && req.method === 'POST') { const b = await body(req); const r = mutate(() => service.join(user, code, b.invite)); broadcast(code); return send(res, 200, { room: service.state(r, user.id) }); }
          const room = service.room(code); service.member(room, user.id);
          if (!endpoint && req.method === 'GET') return send(res, 200, service.state(room, user.id));
          if (endpoint === 'action' && req.method === 'POST') {
            limited(`action:${user.id}`, 180); const b = await body(req); const r = mutate(() => service.command(user, code, b)); broadcast(code); return send(res, 200, { room: service.state(r, user.id) });
          }
          if (endpoint === 'chat' && !handId && req.method === 'POST') {
            const b = await body(req); const message = mutate(() => service.chat(user, code, b, { ip }));
            broadcast(code); return send(res, 200, { message });
          }
          if (endpoint === 'history' && req.method === 'GET') return send(res, 200, service.history(user.id, code));
          if (endpoint === 'hands' && req.method === 'GET') return send(res, 200, service.handFor(user.id, code, handId));
        }
        fail('接口不存在', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') fail('方法不支持', 405);
      const publicDir = resolve(ROOT, 'public'); let decoded;
      try { decoded = decodeURIComponent(path); } catch { fail('无效路径', 400); }
      const file = resolve(publicDir, '.' + (decoded === '/' ? '/index.html' : decoded));
      if (!file.startsWith(publicDir + '/') || decoded.includes('\0') || decoded.split('/').some(x => x.startsWith('.'))) fail('页面不存在', 404);
      if (!existsSync(file)) fail('页面不存在', 404);
      const ext = extname(file); if (!MIME[ext]) fail('页面不存在', 404);
      res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    } catch (e) {
      if (res.headersSent) return res.end();
      const code = e.status || (e.code ? 500 : 400);
      if (code >= 500) console.error('请求失败:', e.message);
      send(res, code, { error: code >= 500 ? '服务暂时不可用，牌局记录会保留，请稍后重试' : e.message });
    }
  });
  server.requestTimeout = 15000;
  const tick = setInterval(() => {
    for (const room of Object.values(store.data.rooms)) {
      if (room.hand?.status !== 'playing' || !room.deadline || Date.now() < room.deadline) continue;
      try { const changed = mutate(() => service.timeout(room)); if (changed) broadcast(room.code); }
      catch (e) { console.error('超时处理失败:', e.message); }
    }
  }, actionTickMs); tick.unref();
  return { server, store, service, broadcast, async close() { clearInterval(tick); for (const set of streams.values()) for (const c of set) c.res.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp(), port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0';
  app.server.listen(port, host, () => console.log(`BBPoker 已启动：http://localhost:${port}\n仅积分 · 邀请入桌 · 存档加密\n数据目录：${app.store.directory}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
}
