import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin']);
const OFFLINE_LIMIT = 15 * 60_000;

function endpoint(baseUrl, path) {
  const base = new URL(baseUrl), url = new URL(path, base);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || url.origin !== base.origin || !url.pathname.startsWith('/api/')) {
    throw new Error('Invalid API endpoint');
  }
  // Unencrypted transport is allowed only for isolated local testing.
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('HTTPS required');
  return url;
}

function httpError(response) {
  const error = new Error(`Practice bot API request failed (${response.status})`);
  error.status = response.status;
  const retry = response.headers.get('retry-after');
  const seconds = Number(retry);
  error.retryAfterMs = retry && Number.isFinite(seconds) ? Math.min(300_000, Math.max(1000, seconds * 1000)) : 30_000;
  return error;
}

/** Ordinary authenticated API access. Never follows redirects or logs response bodies. */
export async function apiRequest({ baseUrl, token, path, method = 'GET', body, timeoutMs = 8000 }) {
  const response = await fetch(endpoint(baseUrl, path), {
    method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) { await response.body?.cancel(); throw httpError(response); }
  return response.json();
}

/** A normal player client for one newly-created, bot-hosted two-seat practice room. */
export class PracticeBotClient {
  constructor({ baseUrl, token, roomCode, decideAction, thinkMs = 1200, onEvent = () => {}, maxWaitMs = 45 * 60_000, maxRunMs = 2 * 60 * 60_000, maxShutdownMs = 120_000 }) {
    if (typeof token !== 'string' || !token || !/^\d{6}$/.test(String(roomCode)) || typeof decideAction !== 'function') throw new Error('Invalid practice bot configuration');
    endpoint(baseUrl, '/api/health');
    for (const n of [thinkMs, maxWaitMs, maxRunMs, maxShutdownMs]) if (!Number.isFinite(n) || n < 0) throw new Error('Invalid practice bot timing');
    this.baseUrl = baseUrl; this.token = token; this.roomCode = String(roomCode);
    this.decideAction = decideAction; this.thinkMs = thinkMs; this.onEvent = onEvent;
    this.maxWaitMs = maxWaitMs; this.maxRunMs = maxRunMs; this.maxShutdownMs = maxShutdownMs;
    this.state = null; this.meId = null; this.running = false; this.stopReason = null;
    this.pending = null; this.completedHands = new Set(); this.acceptedActions = new Set(); this.controls = new Map();
    this.streamController = null; this.connected = false; this.cooldownUntil = 0; this.lastRefresh = 0;
    this.everSeatedHuman = false; this.lastHumanOnline = null; this.fatal = null;
  }

  emit(type, detail = {}) {
    // Callbacks receive operational metadata only, never projected cards, chat, or auth.
    try { this.onEvent({ type, roomCode: this.roomCode, ...detail }); } catch { /* Monitoring must not interrupt a hand. */ }
  }

  accept(state) {
    if (!state || state.code !== this.roomCode || typeof state.meId !== 'string' || state.hostId !== state.meId || state.access !== 'invite' || state.settings?.maxPlayers !== 2 || (this.meId && state.meId !== this.meId)) {
      const error = new Error('Refusing to operate outside the dedicated practice room'); error.fatal = true; throw error;
    }
    if (!Array.isArray(state.players) || !state.players.some(p => p.id === state.meId)) throw new Error('Invalid room projection');
    this.meId = state.meId;
    // A delayed REST response must not roll back a more recent SSE event.
    if (this.state && (state.revision < this.state.revision || (state.revision === this.state.revision && state.serverTime < this.state.serverTime))) return;
    this.state = state; this.receivedAt = Date.now();
    const humans = state.players.filter(p => p.id !== this.meId);
    if (humans.some(p => p.seat !== null)) {
      this.everSeatedHuman = true;
      this.lastHumanOnline ??= Date.now();
    }
    if (this.everSeatedHuman && humans.some(p => p.connected)) this.lastHumanOnline = Date.now();
    const h = state.hand;
    if (h && h.status !== 'playing' && !this.completedHands.has(h.id)) {
      this.completedHands.add(h.id);
      this.emit('hand_complete', { handId: h.id, handNumber: h.number });
    }
  }

  async refresh() {
    const state = await apiRequest({ baseUrl: this.baseUrl, token: this.token, path: `/api/rooms/${this.roomCode}` });
    this.accept(state); this.lastRefresh = Date.now(); return this.state;
  }

  serverNow() { return this.state.serverTime + Date.now() - this.receivedAt; }
  actionKey(state = this.state) { return state?.hand ? `${state.hand.id}:${state.hand.actionSeq}` : null; }
  canAct(key) {
    const s = this.state;
    return s?.status !== 'closed' && s?.hand?.status === 'playing' && !s.hand.transition && !s.hand.runout?.active && s.hand.actingId === this.meId && s.actions?.canAct && (!Number.isFinite(s.hand.actionReadyAt) || this.serverNow() >= s.hand.actionReadyAt) && this.actionKey(s) === key && Number.isFinite(s.deadline) && this.serverNow() + 250 < s.deadline;
  }

  handleError(error, phase) {
    if (error.fatal || [401, 403, 404].includes(error.status)) { this.fatal = error.status === 401 ? 'authentication_expired' : 'room_unavailable'; return; }
    const delay = error.status === 429 ? error.retryAfterMs ?? 30_000 : 2000;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
    this.emit('retry', { phase, status: error.status ?? null, delayMs: delay });
  }

  async stream() {
    let backoff = 1000;
    while (this.running && !this.fatal) {
      if (Date.now() < this.cooldownUntil) { await sleep(Math.min(1000, this.cooldownUntil - Date.now())); continue; }
      const controller = new AbortController(); this.streamController = controller;
      let lastByte = Date.now(), reader, opened = false;
      const watchdog = setInterval(() => { if (Date.now() - lastByte > 45_000) controller.abort(); }, 5000);
      const headerTimer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(endpoint(this.baseUrl, `/api/events?room=${this.roomCode}`), {
          redirect: 'error', signal: controller.signal,
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${this.token}` },
        });
        clearTimeout(headerTimer);
        if (!response.ok) { await response.body?.cancel(); throw httpError(response); }
        if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Invalid event stream');
        reader = response.body.getReader(); opened = true; this.connected = true;
        const decoder = new TextDecoder(); let buffer = '';
        while (this.running && !this.fatal) {
          const { value, done } = await reader.read();
          if (done) break;
          lastByte = Date.now(); buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 2 * 1024 * 1024) throw new Error('Event stream frame too large');
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            // The server sends a comment heartbeat every 15 seconds.
            if (data) {
              this.accept(JSON.parse(data)); backoff = 1000;
              if (!this.readyEmitted) { this.readyEmitted = true; this.emit('ready'); }
            }
          }
        }
      } catch (error) {
        if (this.running) this.handleError(error, 'connection');
      } finally {
        clearTimeout(headerTimer); clearInterval(watchdog); this.connected = false;
        controller.abort(); try { await reader?.cancel(); } catch { /* Already closed. */ }
        if (this.streamController === controller) this.streamController = null;
      }
      if (this.running && !this.fatal) {
        if (opened) this.emit('retry', { phase: 'connection', status: null, delayMs: backoff });
        await sleep(backoff); backoff = Math.min(10_000, backoff * 2);
      }
    }
  }

  async command(body, relevant, key) {
    if (this.pending) return false;
    this.pending = { body: { ...body, commandId: randomUUID() }, relevant, key };
    return this.sendPending();
  }

  async sendPending() {
    const pending = this.pending; if (!pending) return false;
    // Every retry uses the same id; refreshing first avoids replaying an already
    // accepted action after a network failure or after the next turn started.
    if (pending.tried) {
      await this.refresh();
      if (!pending.relevant(this.state)) { this.pending = null; return false; }
    }
    pending.tried = true;
    try {
      const response = await apiRequest({ baseUrl: this.baseUrl, token: this.token, path: `/api/rooms/${this.roomCode}/action`, method: 'POST', body: pending.body });
      this.accept(response.room);
      if (ACTIONS.has(pending.body.type)) this.acceptedActions.add(pending.key);
      else this.controls.set(pending.key, Date.now());
      this.pending = null; return true;
    } catch (error) {
      // Validation failures definitely did not commit. Transport failures and
      // server failures are ambiguous, so keep the command id for reconciliation.
      if (error.status && error.status < 500 && error.status !== 429) {
        this.pending = null; this.controls.set(pending.key, Date.now());
        if (error.status === 409 || error.status === 400) { await this.refresh(); return false; }
      }
      throw error;
    }
  }

  async control(body, relevant, key) {
    if (Date.now() - (this.controls.get(key) ?? 0) < 5000 || !relevant(this.state)) return;
    await this.command(body, relevant, key);
  }

  async tick() {
    const now = Date.now();
    if (now - this.startedAt >= this.maxRunMs) this.stopReason ??= 'time_limit';
    if (!this.everSeatedHuman && now - this.startedAt >= this.maxWaitMs) this.stopReason ??= 'waiting_timeout';
    if (this.everSeatedHuman && this.lastHumanOnline !== null && now - this.lastHumanOnline >= OFFLINE_LIMIT) this.stopReason ??= 'human_disconnected';
    if (!this.state || now - this.lastRefresh >= 15_000) await this.refresh();
    if (this.state.status === 'closed') return;
    if (this.pending) { await this.sendPending(); return; }
    if (this.stopReason) {
      // Pause the following deal even while the last hand is running. Closing
      // itself is strictly between hands and remains subject to server checks.
      if (!this.state.autoDeal?.paused) {
        await this.control({ type: 'autoDeal', paused: true }, s => s.status !== 'closed' && !s.autoDeal?.paused, 'stop-pause'); return;
      }
      if (this.state.hand?.status !== 'playing') {
        await this.control({ type: 'close' }, s => s.status !== 'closed' && s.hand?.status !== 'playing', 'stop-close'); return;
      }
    }
    const key = this.actionKey();
    if (this.canAct(key) && !this.acceptedActions.has(key) && Date.now() - (this.controls.get(key) ?? 0) >= 5000) {
      await sleep(Math.min(this.thinkMs, Math.max(0, this.state.deadline - this.serverNow() - 1000)));
      await this.refresh();
      if (!this.canAct(key)) return;
      const decision = await this.decideAction(structuredClone(this.state));
      if (!decision || !ACTIONS.has(decision.action) || (decision.action === 'raise' && !Number.isSafeInteger(decision.amount))) throw new Error('Invalid practice bot decision');
      if (!this.canAct(key)) return;
      await this.command({ type: decision.action, ...(decision.action === 'raise' ? { amount: decision.amount } : {}), handId: this.state.hand.id, actionSeq: this.state.hand.actionSeq }, () => this.canAct(key), key);
      return;
    }
    if (this.stopReason || this.state.hand?.status === 'playing') return;
    const me = this.state.players.find(p => p.id === this.meId), bb = this.state.settings.bigBlind;
    if (me?.seat !== null && me.stack < 20 * bb) {
      const limit = this.state.settings.maxTotalBuyInBB;
      if (limit != null && me.totalBuyIn + 200 * bb > limit * bb) { this.stopReason = 'buyin_limit'; return; }
      const handId = this.state.hand?.id ?? 'first';
      const controlKey = `buyin:${handId}`;
      if (!this.controls.has(controlKey)) {
        const before = me.totalBuyIn;
        await this.control({ type: 'buyin', amountBB: 200 }, s => s.hand?.status !== 'playing' && s.players.find(p => p.id === this.meId)?.totalBuyIn === before, controlKey); return;
      }
    }
    if (me?.sittingOut) {
      await this.control({ type: 'sitout', value: false, entryMode: 'post' }, s => s.hand?.status !== 'playing' && Boolean(s.players.find(p => p.id === this.meId)?.sittingOut), `resume:${this.state.hand?.id ?? 'first'}`); return;
    }
    const ready = s => !this.stopReason && s.status !== 'closed' && !s.hand && s.players.filter(p => p.seat !== null && p.connected && p.stack > 0 && !p.sittingOut).length >= 2;
    if (this.connected && ready(this.state)) await this.control({ type: 'start' }, ready, 'first-start');
  }

  run() {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.runLoop(); return this.runPromise;
  }

  async runLoop() {
    this.running = true; this.startedAt = Date.now(); let streamTask;
    try {
      await this.refresh();
      streamTask = this.stream();
      while (this.running && !this.fatal && this.state.status !== 'closed') {
        // A broken network must not keep this temporary player alive forever.
        // Stop the local client after a grace period; never claim a remote close
        // succeeded when it could not be confirmed. The server keeps its rules.
        if (Date.now() - this.startedAt >= this.maxRunMs) this.stopReason ??= 'time_limit';
        if (this.stopReason) {
          this.stopRequestedAt ??= Date.now();
          if (Date.now() - this.stopRequestedAt >= this.maxShutdownMs) { this.fatal = 'shutdown_timeout'; break; }
        }
        try { if (Date.now() >= this.cooldownUntil) await this.tick(); }
        catch (error) { this.handleError(error, 'action'); }
        if (!this.fatal && this.state.status !== 'closed') await sleep(250);
      }
    } catch (error) { this.handleError(error, 'startup'); this.fatal ??= 'startup_failed'; }
    finally {
      this.running = false; this.streamController?.abort(); await streamTask;
      const result = { reason: this.fatal ?? this.stopReason ?? 'room_closed', roomCode: this.roomCode, closed: this.state?.status === 'closed' };
      this.emit('stopped', { reason: result.reason, closed: result.closed });
      this.result = result;
    }
    return this.result;
  }

  stop() { this.stopReason ??= 'requested'; return this.runPromise ?? Promise.resolve({ reason: 'not_started', roomCode: this.roomCode, closed: false }); }
}
