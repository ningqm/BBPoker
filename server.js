import http from 'node:http';
import { createStaticAssets } from './src/static-assets.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { EncryptedStore } from './src/store.js';
import { RoomService, DEFAULTS, transitionDelay, fail, exportText, exportCsv, now } from './src/room.js';
import { fairnessInfo } from './src/fairness.js';
import { originPolicy } from './src/origins.js';
import { exportPhh } from './src/phh.js';
import { clientIp } from './src/client-ip.js';
import { digest, secret, username, password, hashPassword, verifyPassword, verifySecret, SESSION_MS } from './src/auth.js';
import { nickname, profilePatch, AVATAR_COUNT, NICKNAME_LIMIT } from './src/profile.js';
import { AvatarStore, avatarImageId, normalizeAvatarUpload, AVATAR_PROFILE_BODY_BYTES } from './src/avatar.js';
import { lobbyDirectory } from './src/lobby.js';
import { turnDeliveryReceipt, publicTurnDelivery, turnDeliveryKey } from './src/turn-delivery.js';
import { createRequestTiming } from './src/request-timing.js';
import { createConnectionDiagnostics, connectionBrowser, connectionCorrelation, validateConnectionReport } from './src/connection-diagnostics.js';
import { configuredAdminIds, isAccountAdmin, requireAccountAdmin, assignedPassword, accountSummary, revokeAccountSessions, accountOperation, replayAccountOperation, rememberAccountOperation, pruneAccountReceipts } from './src/account-admin.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav' };
export function createApp({ dataDir = process.env.DATA_DIR || join(ROOT, 'data'), actionTickMs = 100, publicOrigin = process.env.PUBLIC_ORIGIN || '', clientOrigins = process.env.CLIENT_ORIGINS || '', trustProxy = process.env.TRUST_PROXY || '', adminUserIds = process.env.ADMIN_USER_IDS || '', diagnosticsSink } = {}) {
  const checkOrigin = originPolicy(publicOrigin, clientOrigins);
  const sendStatic = createStaticAssets();
  const adminIds = configuredAdminIds(adminUserIds);
  const store = new EncryptedStore(dataDir), service = new RoomService(store);
  const avatars = new AvatarStore(store);
  const streams = new Map(), rateLimits = new Map();
  const diagnostics = createConnectionDiagnostics({ version: VERSION, sink: diagnosticsSink });
  let loopExpected = performance.now() + 1000, recentLoopLagMs = 0;
  const loopLag = () => Math.max(recentLoopLagMs, Math.round(Math.max(0, performance.now() - loopExpected)));
  const loopProbe = setInterval(() => {
    const current = performance.now(); recentLoopLagMs = Math.round(Math.max(0, current - loopExpected)); loopExpected = current + 1000;
    for (const clients of streams.values()) for (const client of clients) client.maxLoopLagMs = Math.max(client.maxLoopLagMs, recentLoopLagMs);
  }, 1000); loopProbe.unref();
  // A timely receipt is kept in memory and saved by the next normal mutation.
  // If the process restarts before that save, do not offer new grace on the
  // already running turn. Real grace and its budget are always durably saved.
  const startupTurns = new Set(Object.values(store.data.rooms).filter(r => r.hand?.status === 'playing').map(turnDeliveryKey));
  pruneAccountReceipts(store.data);
  store.data.sessions ??= {};
  for (const [key, session] of Object.entries(store.data.sessions)) if (session.expiresAt <= Date.now()) delete store.data.sessions[key];
  // Preserve the active deck and a previously saved clock, including used time cards.
  for (const r of Object.values(store.data.rooms)) {
    service.releaseLegacySquidReserves(r);
    if (r.hand?.rabbit?.active && !Number.isFinite(r.hand.rabbit.nextAt)) {
      r.hand.rabbit.nextAt = Date.now() + 650;
      const archived = store.data.hands.find(hand => hand.id === r.hand.id);
      if (archived) archived.rabbit = structuredClone(r.hand.rabbit);
    }
    if (r.hand?.status !== 'playing') continue;
    if (r.hand.transition) {
      r.deadline = null;
      if (!Number.isFinite(r.hand.transition.nextAt)) r.hand.transition.nextAt = Date.now() + transitionDelay(r.hand);
      continue;
    }
    if (r.hand.runout?.active) {
      r.deadline = null;
      if (!Number.isFinite(r.hand.runout.nextAt)) r.hand.runout.nextAt = Date.now() + 1800;
      continue;
    }
    if (!Number.isFinite(r.deadline) || r.deadline <= 0) {
      const readyAt = r.presentation?.handId === r.hand.id && Number.isFinite(r.presentation.actionReadyAt) ? r.presentation.actionReadyAt : 0;
      r.deadline = Math.max(Date.now(), readyAt) + DEFAULTS.actionSeconds * 1000;
    }
  }
  store.save();

  function send(res, status, payload, extra = {}, timing = null) {
    if (timing) {
      const encoded = timing.measure('serialize', () => JSON.stringify(payload));
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra, 'Server-Timing': timing.header() });
      return res.end(encoded);
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(payload));
  }
  function limited(key, count, windowMs = 60000) {
    const deny = () => {
      const category = key.split(':', 1)[0];
      throw Object.assign(new Error('操作过于频繁，请稍后再试'), { status: 429,
        rateScope: ['ip','table-sync-ip','table-sync','turn-seen','action'].includes(category) ? category : 'other' });
    };
    const t = Date.now(); let row = rateLimits.get(key);
    if (!row || row.until <= t) {
      if (rateLimits.size >= 5000) for (const [k, v] of rateLimits) if (v.until <= t) rateLimits.delete(k);
      if (!row && rateLimits.size >= 5000) deny();
      row = { n: 0, until: t + windowMs }; rateLimits.set(key, row);
    }
    if (++row.n > count) deny();
  }
  const userById = id => Object.values(store.data.users).find(u => u.id === id);
  const userByName = name => Object.values(store.data.users).find(u => u.username === name);
  function userForKey(key) {
    const session = store.data.sessions?.[key];
    if (session && session.expiresAt > Date.now()) {
      const user = userById(session.userId);
      if (user?.username && user.disabled !== true && session.version === user.credentialVersion) return user;
    }
    // Old identity tokens remain usable only until that identity binds an account.
    const legacy = store.data.users[key];
    return legacy && !legacy.username && legacy.disabled !== true ? legacy : null;
  }
  function auth(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(req.headers.authorization ?? '');
    if (!match) fail('请先登录账号', 401);
    const key = digest(match[1]), user = userForKey(key);
    if (!user) fail('登录已失效，请重新登录', 401);
    req.authKey = key;
    return user;
  }
  function publicUser(u) { return { id: u.id, name: u.name, avatar: Number.isInteger(u.avatar) && u.avatar >= 0 && u.avatar < AVATAR_COUNT ? u.avatar : 0, avatarImage: avatarImageId(u.avatarImage), username: u.username ?? null }; }
  async function body(req, maxBytes = 16384) {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > maxBytes) fail('请求内容过大', 413); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请求格式错误'); if (req.authKey) auth(req); return value; }
    catch (e) { if (e.status) throw e; fail('请求格式错误'); }
  }
  function mutate(fn, { chatRates = false, timing = null } = {}) {
    const previous = timing ? timing.measure('clone', () => structuredClone(store.data)) : structuredClone(store.data);
    const previousRates = chatRates ? new Map(service.chatRates) : null;
    try {
      const result = timing ? timing.measure('command', fn) : fn();
      if (timing) timing.measure('persist', () => store.save()); else store.save();
      return result;
    }
    catch (e) { store.data = previous; service.db = previous; if (previousRates) service.chatRates = previousRates; throw e; }
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
      if (!client.res.destroyed && !client.res.writableEnded) { client.closeReason = 'session_expired'; client.res.end('event: session-expired\ndata: {"error":"登录已失效，请重新登录"}\n\n'); }
    }
  }
  function accountLimit(kind, ip, name, perIp, perName) {
    limited(`account:${kind}:ip:${ip}`, perIp, 15 * 60000);
    limited(`account:${kind}:name:${digest(name)}`, perName, 15 * 60000);
  }
  function roomState(room, viewerId) {
    const state = service.state(room, viewerId);
    if (state.hand) state.hand.deliveryGrace = publicTurnDelivery(room);
    return state;
  }
  function writeStream(client, text, snapshot = false) {
    if (client.res.destroyed || client.res.writableEnded) return;
    client.maxBufferedBytes = Math.max(client.maxBufferedBytes, client.res.writableLength);
    if (client.res.writableLength > 512 * 1024) { client.closeReason = 'backpressure'; client.res.destroy(); return; }
    try {
      const written = client.res.write(text), at = performance.now();
      client.lastWriteAt = at;
      if (snapshot) {
        if (client.lastSnapshotAt === null) client.firstSnapshotDelayMs = Math.round(at - client.openedAt);
        client.lastSnapshotAt = at; client.snapshots++;
      } else client.heartbeats++;
      client.bytesWritten += Buffer.byteLength(text);
      if (!written) client.backpressureCount++;
      client.maxBufferedBytes = Math.max(client.maxBufferedBytes, client.res.writableLength);
    } catch { client.closeReason = 'write_error'; client.res.destroy(); }
  }
  function broadcast(code) {
    const room = store.data.rooms[code]; if (!room) return;
    for (const client of streams.get(code) ?? []) {
      try { if (!userForKey(client.authKey)) { closeInvalidStreams(); continue; } writeStream(client, `data: ${JSON.stringify(roomState(room, client.userId))}\n\n`, true); }
      catch { client.closeReason = 'write_error'; client.res.destroy(); }
    }
  }
  let closing = false;
  function syncConnection(room, reconnected = false, disconnectedId = null) {
    if (closing) return true;
    try {
      // Presence changes also maintain departure/wait clocks before a first
      // hand exists, so they cannot be gated only on an auto-deal plan change.
      mutate(() => service.connectionChanged(service.room(room.code), Date.now(), { reconnected, disconnectedId }));
      return true;
    } catch (error) { console.error('牌桌连接恢复失败:', error.message); return false; }
  }
  function subscribe(req, res, room, user) {
    service.member(room, user.id);
    const connectionKey = `${room.code}:${user.id}`;
    if ((service.connections.get(connectionKey) ?? 0) >= 5) { req.connectionReason = 'room_stream_limit'; fail('同一账号打开的牌桌过多，请关闭其他窗口', 429); }
    const accountConnections = [...service.connections].reduce((count, [key, n]) => count + (key.endsWith(`:${user.id}`) ? n : 0), 0);
    if (accountConnections >= 10) { req.connectionReason = 'account_stream_limit'; fail('打开的牌桌窗口过多，请先关闭一些窗口', 429); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const openedAt = performance.now();
    const identity = { ...req.connectionIdentity, ...req.connectionCorrelation, room: room.code };
    const client = { res, userId: user.id, authKey: req.authKey, identity, openedAt, lastWriteAt: null, lastSnapshotAt: null,
      snapshots: 0, heartbeats: 0, bytesWritten: 0, backpressureCount: 0, maxBufferedBytes: 0, maxLoopLagMs: 0, closeReason: null };
    if (!streams.has(room.code)) streams.set(room.code, new Set()); streams.get(room.code).add(client);
    diagnostics.emit('server', { ...identity, type: 'stream_open', reason: req.connectionCorrelation?.reason ?? 'initial', activeStreams: (service.connections.get(connectionKey) ?? 0) + 1 });
    const reconnected = service.autoBlockReason(room) === '等待入座玩家回到牌桌';
    service.connections.set(connectionKey, (service.connections.get(connectionKey) ?? 0) + 1);
    const heartbeat = setInterval(() => { if (!userForKey(client.authKey)) closeInvalidStreams(); else writeStream(client, ': heartbeat\n\n'); }, 3000);
    res.on('error', () => { client.closeReason ??= 'write_error'; res.destroy(); });
    res.on('close', () => {
      const at = performance.now();
      clearInterval(heartbeat); streams.get(room.code)?.delete(client);
      if (!streams.get(room.code)?.size) streams.delete(room.code);
      const remaining = Math.max(0, (service.connections.get(connectionKey) ?? 1) - 1);
      if (remaining) service.connections.set(connectionKey, remaining); else service.connections.delete(connectionKey);
      const presenceStarted = performance.now(), presenceSyncOk = syncConnection(service.room(room.code), false, remaining ? null : user.id);
      const presenceSyncDurationMs = Math.round(performance.now() - presenceStarted); broadcast(room.code);
      diagnostics.emit('server', { ...identity, type: 'stream_close', reason: client.closeReason ?? 'network_close', presenceSyncOk,
        presenceSyncDurationMs, openPresenceDurationMs: client.openPresenceDurationMs ?? 0, firstSnapshotDelayMs: client.firstSnapshotDelayMs ?? null,
        durationMs: Math.round(at - client.openedAt), lastWriteAgeMs: client.lastWriteAt === null ? null : Math.round(at - client.lastWriteAt),
        lastSnapshotAgeMs: client.lastSnapshotAt === null ? null : Math.round(at - client.lastSnapshotAt), activeStreams: remaining,
        bytesWritten: client.bytesWritten, snapshots: client.snapshots, heartbeats: client.heartbeats,
        backpressureCount: client.backpressureCount, maxBufferedBytes: client.maxBufferedBytes, maxLoopLagMs: Math.max(client.maxLoopLagMs, loopLag()),
        syncRequests: client.syncRequests ?? 0, syncErrors: client.syncErrors ?? 0, syncUnchanged: client.syncUnchanged ?? 0, maxSyncDurationMs: client.maxSyncDurationMs ?? 0 });
    });
    const presenceStarted = performance.now(), connected = syncConnection(service.room(room.code), reconnected);
    client.openPresenceDurationMs = Math.round(performance.now() - presenceStarted);
    if (!connected) { client.closeReason = 'persistence_failure'; res.destroy(); return; }
    broadcast(room.code);
  }
  const server = http.createServer(async (req, res) => {
    // Timing starts at action-route recognition. Socket/network queueing
    // before this callback is deliberately outside this server duration.
    let requestTiming = null;
    const securityHeaders = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    };
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      const observedRoom = /^\/api\/rooms\/([0-9]{6})(?:\/(sync|action|turn-seen))?$/.exec(path);
      const observedRoute = path === '/api/events' ? 'events' : observedRoom ? (observedRoom[2] ?? 'room').replace('-', '_') : null;
      if (observedRoute) {
        req.connectionCorrelation = connectionCorrelation(url.searchParams);
        const started = performance.now(), roomCode = observedRoom?.[1] ?? url.searchParams.get('room');
        let reported = false;
        const report = finished => {
          if (reported) return; reported = true;
          if (observedRoute === 'events' && res.statusCode === 200 && res.headersSent) return;
          const elapsed = Math.round(performance.now() - started), status = finished ? res.statusCode : 0;
          const identity = req.connectionIdentity ?? { browser: connectionBrowser(req.headers['user-agent']) };
          const room = identity.userId && store.data.rooms[roomCode]?.members?.[identity.userId] ? roomCode : undefined;
          if (observedRoute === 'sync' && req.connectionCorrelation.pageId && req.connectionCorrelation.streamId) {
            for (const client of streams.get(room) ?? []) if (client.userId === identity.userId
              && client.identity.pageId === req.connectionCorrelation.pageId && client.identity.streamId === req.connectionCorrelation.streamId) {
              client.syncRequests = (client.syncRequests ?? 0) + 1;
              client.syncErrors = (client.syncErrors ?? 0) + (!finished || status >= 400 ? 1 : 0);
              client.syncUnchanged = (client.syncUnchanged ?? 0) + (req.syncUnchanged ? 1 : 0);
              client.maxSyncDurationMs = Math.max(client.maxSyncDurationMs ?? 0, elapsed);
            }
          }
          // Normal tiny /sync responses are summarized on stream close. Keep
          // individual failed or slow requests; never log response bodies.
          if (finished && status < 400 && elapsed < 750) return;
          if (!diagnostics.allow(`server-request:${identity.userId ?? 'unauthenticated'}`, 180)) return;
          diagnostics.emit('server', { ...identity, ...req.connectionCorrelation, ...(room ? { room } : {}),
            type: observedRoute === 'events' ? 'request_rejected' : 'request_result', route: observedRoute,
            reason: req.connectionReason ?? (!finished ? 'network_close' : status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : status >= 400 ? 'http_error' : 'slow_response'),
            ...(req.connectionRateScope ? { rateScope: req.connectionRateScope } : {}), status, durationMs: elapsed, maxLoopLagMs: loopLag() });
        };
        res.once('finish', () => report(true)); res.once('close', () => report(false));
      }
      if (req.method === 'POST' && /^\/api\/rooms\/[0-9]{6}\/action(?:\/[a-zA-Z0-9-]+)?$/.test(path)) requestTiming = createRequestTiming();
      if (path.startsWith('/api/')) {
        const ip = clientIp(req, trustProxy), tableSync = /^\/api\/rooms\/[0-9]{6}\/(sync|turn-seen)$/.test(path), connectionReport = path === '/api/diagnostics/connection';
        // Lightweight authenticated synchronization has its own budget so a
        // shared Wi-Fi/table cannot exhaust the normal action/auth allowance.
        if (connectionReport) { if (!diagnostics.allow(`upload-ip:${ip}`, 180)) fail('诊断请求过于频繁', 429); }
        else limited(`${tableSync ? 'table-sync-ip' : 'ip'}:${ip}`, tableSync ? 2400 : 600);
        checkOrigin(req, res);
        if (req.method === 'OPTIONS') { if (!req.headers.origin) fail('缺少请求来源', 400); res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
        if (path === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, app: 'BBPoker', version: VERSION, time: now() });
        if (path === '/api/fairness' && req.method === 'GET') return send(res, 200, fairnessInfo);
        if (path === '/api/source/poker.js' || path === '/api/source/fairness.js') {
          if (req.method !== 'GET') fail('方法不支持', 405);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(readFileSync(join(ROOT, 'src', path.split('/').at(-1))));
        }
        // A hidden registration form is not access control: old clients and
        // direct HTTP callers must be rejected without creating any identity.
        if (['/api/session', '/api/account/register', '/api/auth/register', '/api/account/bind'].includes(path) && req.method === 'POST') {
          fail('本站账号由管理员分配，请联系管理员领取账号', 403);
        }
        if (path === '/api/session/restore' && req.method === 'POST') {
          limited(`restore:${ip}`, 30); const b = await body(req);
          if (typeof b.token !== 'string' || b.token.length > 100) fail('恢复码格式错误');
          const u = store.data.users[digest(b.token.trim())]; if (!u || u.username || u.disabled === true) fail('恢复码无效或此身份已绑定账号，请使用账号登录', 401);
          return send(res, 200, { token: b.token.trim(), user: publicUser(u) });
        }
        if (path === '/api/account/login' && req.method === 'POST') {
          const b = await body(req), name = username(b.username);
          accountLimit('login', ip, name, 60, 15);
          const before = userByName(name), passwordHash = before?.passwordHash, version = before?.credentialVersion;
          const valid = await verifyPassword(b.password, passwordHash);
          const result = mutate(() => {
            const u = userByName(name);
            if (!valid || !u || u.disabled === true || u.passwordHash !== passwordHash || u.credentialVersion !== version) fail('账号或密码错误', 401);
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
            if (!valid || !u || u.disabled === true || u.recoveryHash !== recoveryHash || u.credentialVersion !== version) fail('账号或恢复码错误', 401);
            return rotateCredentials(u, passwordHash);
          });
          closeInvalidStreams(); return send(res, 200, result);
        }
        const user = auth(req);
        req.connectionIdentity = { userId: user.id, ...(user.username ? { username: user.username } : {}), browser: connectionBrowser(req.headers['user-agent']) };
        if (connectionReport) {
          if (req.method !== 'POST') fail('方法不支持', 405);
          if (!diagnostics.allow(`upload-user:${user.id}`, 30)) fail('诊断请求过于频繁', 429);
          const report = validateConnectionReport(await body(req, 16384));
          // auth() in body() rechecks credentials after a potentially delayed
          // upload; reports neither save the store nor change room presence.
          const result = diagnostics.reports(report, req.connectionIdentity, code => Boolean(store.data.rooms[code]?.members?.[user.id]));
          return send(res, 200, { ok: true, ...result });
        }
        if (path === '/api/admin/accounts' || path.startsWith('/api/admin/accounts/')) {
          requireAccountAdmin(auth(req), adminIds);
          if (path === '/api/admin/accounts' && req.method === 'GET') {
            const accounts = Object.values(store.data.users).map(u => accountSummary(u, adminIds))
              .sort((a, b) => String(a.username ?? a.name).localeCompare(String(b.username ?? b.name)));
            return send(res, 200, { accounts, canManage: true });
          }
          limited(`account:admin:${user.id}`, 30, 15 * 60000);
          if (path === '/api/admin/accounts' && req.method === 'POST') {
            const b = await body(req), name = username(b.username);
            const displayName = nickname(b.name === undefined || (typeof b.name === 'string' && !b.name.trim()) ? Array.from(name).slice(0, NICKNAME_LIMIT).join('') : b.name);
            requireAccountAdmin(auth(req), adminIds);
            const operation = accountOperation(user.id, b.requestId, { type: 'create', username: name, name: displayName });
            const prior = replayAccountOperation(store.data, store.key, operation, adminIds);
            if (prior) return send(res, 201, prior);
            if (userByName(name)) fail('这个账号已被使用，请换一个', 409);
            const temporaryPassword = assignedPassword(), passwordHash = await hashPassword(temporaryPassword);
            const result = mutate(() => {
              // Scrypt yields: re-check authorization, the receipt and uniqueness.
              const admin = requireAccountAdmin(auth(req), adminIds);
              const replay = replayAccountOperation(store.data, store.key, operation, adminIds);
              if (replay) return replay;
              if (userByName(name)) fail('这个账号已被使用，请换一个', 409);
              if (Object.keys(store.data.users).length >= 1000) fail('账号数量达到上限');
              const u = { id: randomBytes(12).toString('hex'), username: name, name: displayName, avatar: randomInt(AVATAR_COUNT),
                passwordHash, credentialVersion: 1, disabled: false, createdAt: now(), assignedBy: admin.id };
              store.data.users[u.id] = u;
              rememberAccountOperation(store.data, store.key, operation, u, temporaryPassword);
              return { account: accountSummary(u, adminIds), credentials: { username: name, password: temporaryPassword } };
            });
            return send(res, 201, result);
          }
          const command = /^\/api\/admin\/accounts\/([A-Za-z0-9_-]{1,80})\/(reset-password|status)$/.exec(path);
          if (!command || req.method !== 'POST') fail('账号管理接口不存在', 404);
          const [, targetId, operation] = command, b = await body(req);
          const before = userById(targetId);
          if (!before) fail('账号不存在', 404);
          if (operation === 'reset-password') {
            if (targetId === user.id) fail('请在个人资料中修改自己的密码，账号分配仅重置朋友的密码', 409);
            // Include submitted migration input even after migration succeeds,
            // so retrying that exact operation still matches its first receipt.
            const submittedName = b.username === undefined ? null : username(b.username);
            requireAccountAdmin(auth(req), adminIds);
            const operation = accountOperation(user.id, b.requestId, { type: 'reset-password', targetId, username: submittedName });
            const prior = replayAccountOperation(store.data, store.key, operation, adminIds);
            if (prior) return send(res, 200, prior);
            const migratedName = before.username ? null : username(b.username);
            if (migratedName && userByName(migratedName)) fail('这个账号已被使用，请换一个', 409);
            const previousVersion = before.credentialVersion, previousHash = before.passwordHash, previousName = before.username;
            const temporaryPassword = assignedPassword(), passwordHash = await hashPassword(temporaryPassword);
            const result = mutate(() => {
              requireAccountAdmin(auth(req), adminIds);
              const replay = replayAccountOperation(store.data, store.key, operation, adminIds);
              if (replay) return replay;
              const target = userById(targetId);
              if (!target || target.credentialVersion !== previousVersion || target.passwordHash !== previousHash || target.username !== previousName) fail('账号已变更，请刷新后重试', 409);
              if (migratedName && userByName(migratedName)) fail('这个账号已被使用，请换一个', 409);
              if (migratedName) target.username = migratedName;
              target.passwordHash = passwordHash;
              delete target.recoveryHash;
              revokeAccountSessions(store.data, target);
              rememberAccountOperation(store.data, store.key, operation, target, temporaryPassword);
              return { account: accountSummary(target, adminIds), credentials: { username: target.username, password: temporaryPassword } };
            });
            closeInvalidStreams();
            return send(res, 200, result);
          }
          if (typeof b.disabled !== 'boolean') fail('请选择启用或停用账号');
          const account = mutate(() => {
            const admin = requireAccountAdmin(auth(req), adminIds), target = userById(targetId);
            if (!target) fail('账号不存在', 404);
            if (b.disabled && (target.id === admin.id || adminIds.has(target.id))) fail('管理员账号不可在这里停用，请通过服务器配置调整', 409);
            if (b.disabled) revokeAccountSessions(store.data, target);
            target.disabled = b.disabled;
            return accountSummary(target, adminIds);
          });
          closeInvalidStreams(); return send(res, 200, { account });
        }
        if (path.startsWith('/api/avatars/') && req.method === 'GET') {
          const imageId = avatarImageId(path.slice('/api/avatars/'.length));
          const owner = imageId && Object.values(store.data.users).find(candidate => candidate.avatarImage === imageId);
          if (!owner || (owner.id !== user.id && !Object.values(store.data.rooms).some(room => Object.hasOwn(room.members, owner.id) && Object.hasOwn(room.members, user.id)))) fail('头像不存在', 404);
          let bytes;
          try { bytes = avatars.read(imageId); } catch { fail('头像不存在', 404); }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
          return res.end(bytes);
        }
        if (path === '/api/profile' && req.method === 'POST') {
          limited(`profile:${user.id}`, 12);
          const patch = profilePatch(await body(req, AVATAR_PROFILE_BODY_BYTES));
          const thumbnail = Object.hasOwn(patch, 'avatarUpload') ? normalizeAvatarUpload(patch.avatarUpload) : null;
          delete patch.avatarUpload;
          let newImage = null, oldImage = null, result;
          try {
            result = mutate(() => {
              // Re-resolve after reading the body: concurrent persistence rollback may replace data.
              const current = auth(req); oldImage = avatarImageId(current.avatarImage);
              if (thumbnail) patch.avatarImage = newImage = avatars.write(thumbnail);
              else if (Object.hasOwn(patch, 'avatar') && oldImage) patch.avatarImage = null;
              Object.assign(current, patch);
              const rooms = Object.values(store.data.rooms).filter(room => Object.hasOwn(room.members, current.id));
              for (const room of rooms) service.touch(room);
              return { user: publicUser(current), roomCodes: rooms.map(room => room.code) };
            });
          } catch (error) {
            // An image must never become visible before its profile update is durable.
            if (newImage) try { avatars.remove(newImage); } catch { /* A later maintenance pass may remove an unreachable encrypted file. */ }
            throw error;
          }
          if (store.lastSaveDurable && oldImage && oldImage !== result.user.avatarImage) try { avatars.remove(oldImage); } catch { /* A failed cleanup must not roll back a committed profile. */ }
          for (const code of result.roomCodes) broadcast(code);
          return send(res, 200, { user: result.user });
        }
        if (path === '/api/account/password' && req.method === 'POST') {
          const b = await body(req); password(b.newPassword);
          accountLimit('password', ip, user.id, 20, 10);
          if (!user.username) fail('旧身份请联系管理员分配登录账号', 409);
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
          if (!user.username) fail('旧身份请先联系管理员分配登录账号，再退出登录', 409);
          mutate(() => { auth(req); delete store.data.sessions[req.authKey]; });
          closeInvalidStreams(); return send(res, 200, { ok: true });
        }
        if (path === '/api/me' && req.method === 'GET') return send(res, 200, { user: publicUser(user), isAdmin: isAccountAdmin(user, adminIds), createKeyRequired: false, stats: service.stats(user.id), rooms: Object.values(store.data.rooms).filter(r => r.members[user.id]).map(r => ({ code: r.code, name: r.name, status: r.status, startedAt: r.startedAt ?? null, createdAt: r.createdAt })) });
        if (path === '/api/lobby' && req.method === 'GET') return send(res, 200, lobbyDirectory(store.data, user.id));
        if (path === '/api/stats' && req.method === 'GET') return send(res, 200, service.stats(user.id, Object.fromEntries(url.searchParams)));
        if (path === '/api/opponents' && req.method === 'GET') return send(res, 200, service.opponents(user.id, Object.fromEntries(url.searchParams)));
        if (path === '/api/sessions' && req.method === 'GET') return send(res, 200, service.sessions(user.id, Object.fromEntries(url.searchParams)));
        const sessionMatch = /^\/api\/sessions\/([0-9]{6})$/.exec(path);
        if (sessionMatch && req.method === 'GET') return send(res, 200, service.sessionFor(user.id, sessionMatch[1]));
        if (path === '/api/hands' && req.method === 'GET') return send(res, 200, service.handLibrary(user.id, Object.fromEntries(url.searchParams)));
        const favoriteMatch = /^\/api\/hands\/([A-Za-z0-9_-]{1,80})\/favorite$/.exec(path);
        if (favoriteMatch && req.method === 'POST') {
          limited(`favorite:${user.id}`, 120); const b = await body(req);
          return send(res, 200, mutate(() => service.favoriteHand(user.id, favoriteMatch[1], b.favorite)));
        }
        if (path === '/api/rooms' && req.method === 'POST') {
          limited(`create:${user.id}`, 6); const b = await body(req);
          const room = mutate(() => service.create(user, b)); return send(res, 201, { room: roomState(room, user.id) });
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
        const playerStatsMatch = /^\/api\/rooms\/([0-9]{6})\/players\/([a-zA-Z0-9_-]{1,80})\/stats$/.exec(path);
        if (playerStatsMatch && req.method === 'GET') return send(res, 200, service.playerStats(user.id, playerStatsMatch[1], playerStatsMatch[2], Object.fromEntries(url.searchParams)));
        const match = /^\/api\/rooms\/([0-9]{6})(?:\/(join|action|history|hands|chat|sync|turn-seen)(?:\/([a-zA-Z0-9-]+))?)?$/.exec(path);
        if (match) {
          const [, code, endpoint, handId] = match;
          if (endpoint === 'join' && req.method === 'POST') { limited(`join:${user.id}`, 60); const b = await body(req); const r = mutate(() => service.join(user, code, b.invite)); broadcast(code); return send(res, 200, { room: roomState(r, user.id) }); }
          const room = service.room(code); service.member(room, user.id);
          if (!endpoint && req.method === 'GET') return send(res, 200, roomState(room, user.id));
          if (endpoint === 'sync' && !handId && req.method === 'GET') {
            limited(`table-sync:${user.id}`, 90);
            const ready = room.hand?.status === 'playing' && room.hand.actingId === user.id
              && !room.hand.transition && !room.hand.runout?.active
              && (!Number.isFinite(room.presentation?.actionReadyAt) || Date.now() >= room.presentation.actionReadyAt);
            if (url.searchParams.get('revision') === String(room.revision)
              && url.searchParams.get('canAct') === (ready ? '1' : '0')) {
              req.syncUnchanged = true;
              return send(res, 200, { unchanged: true, code, meId: user.id, revision: room.revision, serverTime: Date.now() });
            }
            return send(res, 200, { room: roomState(room, user.id) });
          }
          if (endpoint === 'turn-seen' && !handId && req.method === 'POST') {
            limited(`turn-seen:${user.id}`, 90); const receipt = await body(req);
            const options = { allowGrace: !startupTurns.has(turnDeliveryKey(service.room(code))) }, deliveredAt = Date.now();
            const plan = turnDeliveryReceipt(service.room(code), user.id, receipt, deliveredAt, { ...options, commit: false });
            const result = !plan.changed ? plan : plan.grace === 0
              ? turnDeliveryReceipt(service.room(code), user.id, receipt, deliveredAt, options) : mutate(() => {
              const current = service.room(code), result = turnDeliveryReceipt(current, user.id, receipt, deliveredAt, options);
              if (result.grace > 0) service.touch(current);
              return result;
            });
            // Normal sub-second delivery needs no table-wide re-render. Only
            // a real deadline change broadcasts; failed/old receipts resync the
            // caller. A retry with granted grace returns that saved deadline.
            const current = service.room(code), grace = publicTurnDelivery(current);
            if (result.grace > 0) broadcast(code);
            return send(res, 200, { accepted: result.accepted,
              ...(!result.accepted || grace?.seconds > 0 ? { room: roomState(current, user.id) } : {}) });
          }
          if (endpoint === 'action' && req.method === 'POST') {
            limited(`action:${user.id}`, 180); const b = await body(req);
            const r = mutate(() => service.command(user, code, b), { timing: requestTiming });
            requestTiming.measure('broadcast', () => broadcast(code));
            const state = requestTiming.measure('state', () => roomState(r, user.id));
            return send(res, 200, { room: state }, {}, requestTiming);
          }
          if (endpoint === 'chat' && !handId && req.method === 'POST') {
            const b = await body(req); const message = mutate(() => service.chat(user, code, b, { ip }), { chatRates: true });
            broadcast(code); return send(res, 200, { message });
          }
          if (endpoint === 'history' && req.method === 'GET') return send(res, 200, service.history(user.id, code, Object.fromEntries(url.searchParams)));
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
      await sendStatic(req, res, file, MIME[ext]);
    } catch (e) {
      if (['ip','table-sync-ip','table-sync','turn-seen','action','other'].includes(e.rateScope)) req.connectionRateScope = e.rateScope;
      if (req.connectionCorrelation && !req.connectionIdentity) try {
        const user = auth(req); req.connectionIdentity = { userId: user.id, ...(user.username ? { username: user.username } : {}), browser: connectionBrowser(req.headers['user-agent']) };
      } catch { /* Failed authentication must not invent a user attribution. */ }
      if (res.headersSent) return res.end();
      const code = e.status || (e.code ? 500 : 400);
      if (code >= 500) console.error('请求失败:', e.message);
      send(res, code, { error: code >= 500 ? '服务暂时不可用，牌局记录会保留，请稍后重试' : e.message,
        ...(/^ACCOUNT_OPERATION_(MISMATCH|EXPIRED|CHANGED|UNAVAILABLE)$/.test(e.publicCode ?? '') ? { code: e.publicCode } : {}) }, {}, requestTiming);
    }
  });
  server.requestTimeout = 15000;
  const tick = setInterval(() => {
    const timestamp = Date.now();
    // Each table commits before broadcasting. A malformed or failed table
    // must not roll back another table's already due action or stop its clock.
    for (const code of Object.keys(store.data.rooms)) {
      try {
        if (!service.needsTick(store.data.rooms[code], timestamp)) continue;
        if (mutate(() => service.tick(store.data.rooms[code], timestamp))) broadcast(code);
      } catch (e) { console.error('牌桌计时处理失败:', code, e.message); }
    }
  }, actionTickMs); tick.unref();
  return { server, store, service, broadcast, async close() {
    closing = true; clearInterval(tick); clearInterval(loopProbe);
    const closedStreams = [];
    for (const set of streams.values()) for (const c of set) {
      closedStreams.push(new Promise(resolve => c.res.once('close', resolve)));
      c.closeReason = 'server_shutdown'; c.res.destroy();
    }
    await Promise.all([new Promise(resolve => server.close(resolve)), ...closedStreams]); diagnostics.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp(), port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0';
  app.server.listen(port, host, () => console.log(`BBPoker 已启动：http://localhost:${port}\n仅积分 · 邀请入桌 · 存档加密\n数据目录：${app.store.directory}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
}
