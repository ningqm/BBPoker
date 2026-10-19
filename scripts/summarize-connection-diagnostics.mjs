import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_CONNECTION_TYPES, CONNECTION_REASONS } from '../src/connection-diagnostics.js';

const TYPES = new Set([...CLIENT_CONNECTION_TYPES, 'stream_open', 'stream_close', 'request_result', 'request_rejected', 'request_summary']);
const REASONS = new Set([...CONNECTION_REASONS, 'network_close', 'server_shutdown', 'persistence_failure', 'backpressure', 'write_error', 'room_stream_limit', 'account_stream_limit', 'rate_limited', 'server_error', 'slow_response']);
const BROWSERS = new Set(['Quark','WeChat','Huawei','Safari','Chrome','Edge','Firefox','Other']);
const ID = /^[a-f0-9-]{16,64}$/i, ROOM = /^\d{6}$/;
const NUMBERS = ['durationMs','lastByteAgeMs','lastFreshAgeMs','lastWriteAgeMs','lastSnapshotAgeMs','snapshotAgeMs','status','attempt','delayMs','failures','backpressureCount','maxBufferedBytes','maxLoopLagMs','timerLagMs','snapshots','heartbeats','bytesWritten','droppedBefore','syncRequests','syncErrors','syncUnchanged','maxSyncDurationMs','presenceSyncDurationMs','openPresenceDurationMs','firstSnapshotDelayMs','activeStreams'];
const validTime = n => Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000;
const beijing = n => validTime(n) ? new Date(n + 8 * 3600000).toISOString().replace('Z','+08:00') : null;
const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

// Accept plain diagnostic JSONL or journalctl -o json. Never echo a raw line,
// arbitrary error, URL, request body or header from the input.
export function createConnectionSummary({ username, room, from = 0, to = Number.MAX_SAFE_INTEGER, maxStreams = 200 } = {}) {
  if (username !== undefined && !/^[a-z0-9_]{3,24}$/i.test(username)) throw new Error('Invalid username');
  if (room !== undefined && !ROOM.test(room)) throw new Error('Invalid room');
  const counts = {}, reasons = {}, streams = new Map();
  let matched = 0, invalidLines = 0, unrecognized = 0, limitedStreams = 0, first = null, last = null;
  function add(line) {
    if (typeof line !== 'string' || line.length > 32768) { invalidLines++; return; }
    let row;
    try { row = JSON.parse(line); if (typeof row?.MESSAGE === 'string') row = JSON.parse(row.MESSAGE); }
    catch { invalidLines++; return; }
    if (row?.event !== 'connection_diagnostic' || row.v !== 1 || !['server','client_report'].includes(row.source)
      || !TYPES.has(row.type) || !validTime(row.at)) { unrecognized++; return; }
    if ((username && row.username !== username.toLowerCase()) || (room && row.room !== room) || row.at < from || row.at > to) return;
    matched++; first = first === null ? row.at : Math.min(first,row.at); last = last === null ? row.at : Math.max(last,row.at);
    count(counts, `${row.source}:${row.type}`);
    if (REASONS.has(row.reason)) count(reasons, `${row.source}:${row.reason}`);
    if (!ID.test(row.pageId ?? '') || !ID.test(row.streamId ?? '')) return;
    // Identity is part of the key, so coinciding client-supplied random IDs do
    // not merge separate users into a falsely corroborated incident.
    const key = `${row.userId}:${row.pageId}:${row.streamId}`;
    if (!streams.has(key)) {
      if (streams.size >= maxStreams) { limitedStreams++; return; }
      streams.set(key, { pageId: row.pageId, streamId: row.streamId, ...(ROOM.test(row.room ?? '') ? {room:row.room} : {}),
        browser: BROWSERS.has(row.browser) ? row.browser : 'Other', events: [], omittedEvents: 0 });
    }
    const stream = streams.get(key);
    if (stream.events.length >= 40) { stream.omittedEvents++; return; }
    const event = { receivedAt: beijing(row.at), source: row.source, type: row.type };
    if (row.source === 'client_report' && validTime(row.clientAtMs)) event.clientReportedAt = beijing(row.clientAtMs);
    if (REASONS.has(row.reason)) event.reason = row.reason;
    if (['events','sync','room','action','turn_seen'].includes(row.route)) event.route = row.route;
    if (['ip','table-sync-ip','table-sync','turn-seen','action','other'].includes(row.rateScope)) event.rateScope = row.rateScope;
    for (const name of NUMBERS) if (Number.isFinite(row[name]) && row[name] >= 0 && row[name] <= Number.MAX_SAFE_INTEGER) event[name] = row[name];
    for (const name of ['visible','online','connected','resync','persisted','presenceSyncOk']) if (typeof row[name] === 'boolean') event[name] = row[name];
    stream.events.push(event);
  }
  function result() {
    return { scope: { username: username?.toLowerCase() ?? null, room: room ?? null, timeBasis: 'server receipt time', timezone:'Asia/Shanghai' },
      matched, receivedFrom: beijing(first), receivedTo: beijing(last), counts, reasons, invalidLines, unrecognized, limitedStreams,
      streams: [...streams.values()].map(stream => ({ ...stream, events: stream.events.sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)) })),
      evidenceLimits: ['Client reports identify the observed trigger, not an independently proven network root cause.',
        'Client clocks may differ; use server times and page/stream correlation. Extend the receipt window for uploads delayed by disconnection.',
        'Missing records may result from old clients, dropped batches, a closed page or log limits. Counts are records, not network outage counts.'] };
  }
  return { add, result };
}

export async function summarizeConnectionInput(input, options) {
  const summary = createConnectionSummary(options);
  for await (const line of createInterface({ input, crlfDelay: Infinity })) summary.add(line);
  return summary.result();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = ({'--user':'username','--room':'room','--from':'from','--to':'to'})[args[i]], value = args[i+1];
      if (!key || !value) throw new Error('Usage: --user PLAYER [--room ROOM_CODE] [--from ISO-with-offset] [--to ISO-with-offset]');
      if (key === 'from' || key === 'to') {
        if (!/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Time needs an explicit UTC offset');
        options[key] = Date.parse(value);
      } else options[key] = value;
    }
    console.log(JSON.stringify(await summarizeConnectionInput(process.stdin, options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
