// Connection reports are evidence, never gameplay input. Keep this schema
// intentionally narrow: do not add URLs, headers, arbitrary errors or state.
export const CLIENT_CONNECTION_TYPES = new Set(['connect_start','stream_open','stream_first_fresh','stream_snapshot','stream_close','reconnect_scheduled','stream_stop','watchdog','probe_start','probe_result','probe_reconnect','foreground_start','foreground_result','resync_end','lifecycle']);
export const CONNECTION_REASONS = new Set(['initial','route','identity_change','network_offline','network_online','visible','hidden','pageshow','pagehide','native_resume','command_conflict','command_uncertain','watchdog_timeout','stream_eof','http_error','network_error','decode_error','buffer_limit','missing_body','session_expired','retry','abort','superseded','idle','ready','deadline','presentation','timer_resume','ok','unchanged','stale_snapshot','wrong_snapshot','timeout','probe_failures','stalled_refresh_failed','foreground_timeout','foreground_failed','foreground_stale','connected','client_apply_error']);
const ID = /^[a-f0-9-]{16,64}$/i;
const ROOM = /^[0-9]{6}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.-]{1,24})?$/i;
const NUMBERS = ['attempt','durationMs','lastByteAgeMs','lastFreshAgeMs','snapshotAgeMs','revision','status','failures','delayMs','timerLagMs'];
const BOOLEANS = ['visible','online','connected','resync','persisted'];
const validNumber = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const invalid = () => { throw Object.assign(new Error('连接诊断格式错误'), { status: 400 }); };

export function connectionBrowser(ua = '') {
  if (typeof ua !== 'string') return 'Other';
  if (/Quark/i.test(ua)) return 'Quark';
  if (/MicroMessenger|WeChat/i.test(ua)) return 'WeChat';
  if (/HuaweiBrowser/i.test(ua)) return 'Huawei';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'Other';
}

export function connectionCorrelation(params) {
  const result = {};
  for (const key of ['pageId', 'streamId']) {
    const value = params.get(key); if (typeof value === 'string' && ID.test(value)) result[key] = value.toLowerCase();
  }
  const reason = params.get('reason'); if (CONNECTION_REASONS.has(reason)) result.reason = reason;
  return result;
}

export function validateConnectionReport(body) {
  if (!body || body.v !== 1 || typeof body.pageId !== 'string' || !ID.test(body.pageId)
    || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 20) invalid();
  const events = body.events.map(event => {
    if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.seq) || event.seq < 1
      || !validNumber(event.at) || !CLIENT_CONNECTION_TYPES.has(event.type) || !CONNECTION_REASONS.has(event.reason)) invalid();
    const clean = { seq: event.seq, clientAtMs: event.at, type: event.type, reason: event.reason };
    if (typeof event.room === 'string' && ROOM.test(event.room)) clean.room = event.room;
    if (typeof event.streamId === 'string' && ID.test(event.streamId)) clean.streamId = event.streamId.toLowerCase();
    if (typeof event.version === 'string' && VERSION.test(event.version)) clean.version = event.version;
    if (event.phase === 'idle' || event.phase === 'full') clean.phase = event.phase;
    for (const key of NUMBERS) if (validNumber(event[key]) && (key !== 'status' || event[key] <= 599)) clean[key] = Math.round(event[key]);
    for (const key of BOOLEANS) if (typeof event[key] === 'boolean') clean[key] = event[key];
    return clean;
  });
  return { pageId: body.pageId.toLowerCase(), events };
}

// In-memory, bounded and independent of action rate budgets and durable store.
// Queueing never serializes on the action path; a slow/failed sink drops records.
export function createConnectionDiagnostics({ version, sink, schedule = setImmediate, clock = Date.now, maxQueue = 512 } = {}) {
  const queue = [], seen = new Map(), rates = new Map();
  let scheduled = false, waitingDrain = false, dropped = 0, stopped = false;
  const output = sink ?? (line => process.stdout.write(line));
  function run() {
    scheduled = false;
    if (waitingDrain || stopped) return;
    for (let count = 0; queue.length && count < 64; count++) {
      const row = queue.shift();
      if (dropped) { row.droppedBefore = dropped; dropped = 0; }
      try {
        if (output(JSON.stringify(row) + '\n') === false) {
          // Native stdout backpressure: wait without accumulating an unbounded
          // stream buffer. Custom sinks return void and are independently safe.
          if (!sink) { waitingDrain = true; process.stdout.once('drain', resume); }
          else { dropped += queue.length; queue.length = 0; }
          break;
        }
      } catch { dropped++; }
    }
    if (queue.length && !waitingDrain) plan();
  }
  function resume() { waitingDrain = false; plan(); }
  function plan() { if (!scheduled && !stopped) { scheduled = true; schedule(run); } }
  function emit(source, row) {
    if (stopped) return;
    if (queue.length >= maxQueue) { dropped++; return; }
    queue.push({ ...row, event: 'connection_diagnostic', v: 1, source, at: clock(), serverVersion: version }); plan();
  }
  function allow(key, count, windowMs = 60000) {
    const at = clock(); let row = rates.get(key);
    if (!row || row.until <= at) {
      if (rates.size >= 2048) for (const [id, value] of rates) if (value.until <= at) rates.delete(id);
      if (!row && rates.size >= 2048) return false;
      rates.set(key, row = { n: 0, until: at + windowMs });
    }
    return ++row.n <= count;
  }
  function reports(report, identity, member) {
    const at = clock(), key = `${identity.userId}:${report.pageId}`;
    if (seen.size >= 2048) for (const [id, value] of seen) if (at - value.at > 3600000) seen.delete(id);
    if (!seen.has(key) && seen.size >= 2048) seen.delete(seen.keys().next().value);
    let page = seen.get(key);
    if (!page) seen.set(key, page = { seqs: new Set(), highest: 0, at });
    page.at = at;
    let accepted = 0, duplicates = 0;
    for (const raw of report.events) {
      if (page.seqs.has(raw.seq) || raw.seq <= page.highest - 256) { duplicates++; continue; }
      page.highest = Math.max(page.highest, raw.seq);
      page.seqs.add(raw.seq); if (page.seqs.size > 256) page.seqs.delete(page.seqs.values().next().value);
      const event = { ...raw };
      // Client-reported room labels must be authorized independently of the
      // client's claim; payload identity/source can never override auth.
      if (event.room && !member(event.room)) delete event.room;
      emit('client_report', { ...event, ...identity, pageId: report.pageId }); accepted++;
    }
    return { accepted, duplicates };
  }
  return { emit, allow, reports, flush: run,
    close() {
      while (queue.length && !waitingDrain) run();
      stopped = true; process.stdout.removeListener('drain', resume); queue.length = 0;
    },
  };
}
