// Ordinary player client: no access to server storage or other players' cards.
// Keep --state-dir outside the repository; it contains this bot's credentials.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { PracticeBotClient } from './practice-bot-client.mjs';
import { decideAction } from './practice-bot-strategy.mjs';

const { values } = parseArgs({ options: { base: { type: 'string' }, 'state-dir': { type: 'string' } } });
if (!values.base || !values['state-dir']) throw new Error('Provide --base and a private --state-dir outside the repository');
const base = new URL(values.base);
if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
    !(base.protocol === 'https:' || base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) {
  throw new Error('Use an HTTPS origin or a local test server');
}
const directory = resolve(values['state-dir']);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const lockFile = join(directory, 'runner.lock');
let lock;
try { lock = openSync(lockFile, 'wx', 0o600); }
catch (error) { if (error.code === 'EEXIST') throw new Error('This private bot directory is already locked by another run'); throw error; }
writeSync(lock, String(process.pid));
process.on('exit', () => { closeSync(lock); try { unlinkSync(lockFile); } catch {} });
const accountFile = join(directory, 'account.json');
let account = null;
try { account = JSON.parse(await readFile(accountFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (account && account.base !== base.origin) throw new Error('This bot account belongs to a different server');
async function saveAccount() {
  const temporary = join(directory, `account-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(account), { mode: 0o600, flag: 'wx' });
  await rename(temporary, accountFile);
}
async function api(path, body, authenticated = true) {
  const response = await fetch(base.origin + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { ...(authenticated ? { Authorization: `Bearer ${account.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || `Request failed (${response.status})`), { status: response.status });
  return result;
}
if (!account) {
  account = { base: base.origin, username: `bb_bot_${randomBytes(5).toString('hex')}`, password: randomBytes(32).toString('base64url') };
  // Save the chosen credentials first so an uncertain registration can be recovered.
  await saveAccount();
  const registered = await api('/api/account/register', { username: account.username, password: account.password, name: 'BB陪练机器人' }, false);
  Object.assign(account, registered); await saveAccount();
} else {
  try { await api('/api/me'); }
  catch (error) {
    if (error.status !== 401) throw error;
    Object.assign(account, await api('/api/account/login', { username: account.username, password: account.password }, false));
    await saveAccount();
  }
}
if (!account.roomCode) {
  // Recover a previously accepted create request before creating another room.
  const { rooms } = await api('/api/me');
  const previous = rooms.find(room => room.status !== 'closed');
  const room = previous ? await api(`/api/rooms/${previous.code}`) : (await api('/api/rooms', {
    name: 'BBPoker · 机器人陪练', access: 'invite',
    settings: { maxPlayers: 2, smallBlind: 5, bigBlind: 10, durationMinutes: 60, actionSeconds: 15, squid: false, bombPot: false },
  })).room;
  account.roomCode = room.code; account.invite = room.invite; await saveAccount();
}
let room = await api(`/api/rooms/${account.roomCode}`);
if (room.status === 'closed') throw new Error('This practice room has ended; create a new run explicitly');
if (room.hostId !== account.user.id || room.access !== 'invite' || room.settings.maxPlayers !== 2) throw new Error('Not the dedicated practice room');
const me = room.players.find(player => player.id === account.user.id);
if (me.seat == null) {
  room = (await api(`/api/rooms/${room.code}/action`, { type: 'sit', seat: 0, amountBB: 200, entryMode: 'post', commandId: randomUUID() })).room;
}
const inviteUrl = `${base.origin}/#/room/${room.code}/${room.invite}`;
let lastStatus = { pid: process.pid, roomCode: room.code, inviteUrl, name: 'BB陪练机器人', status: 'connecting', handsCompleted: 0, startedAt: new Date().toISOString() };
let statusWrite = Promise.resolve();
function report(event) {
  // Only lifecycle metadata goes to disk/log; never log payloads, cards or tokens.
  const kind = typeof event === 'string' ? event : event.type ?? event.kind ?? 'status';
  if (kind === 'ready') lastStatus.status = 'ready';
  if (kind === 'hand_complete') lastStatus.handsCompleted++;
  if (kind === 'stopped') lastStatus.status = 'stopped';
  lastStatus.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(lastStatus, null, 2);
  statusWrite = statusWrite.then(() => writeFile(join(directory, 'status.json'), snapshot, { mode: 0o600 }));
  statusWrite.catch(() => {});
  if (['ready', 'hand_complete', 'stopped', 'retry'].includes(kind)) console.log(JSON.stringify({ event: kind, roomCode: room.code, ...(kind === 'ready' ? { inviteUrl } : {}) }));
}
const client = new PracticeBotClient({ baseUrl: base.origin, token: account.token, roomCode: room.code, decideAction, thinkMs: 1200, onEvent: report });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => client.stop());
try { await client.run(); }
finally {
  lastStatus.status = 'stopped'; report('stopped'); await statusWrite;
  try { await api('/api/account/logout', {}); delete account.token; await saveAccount(); } catch { /* Temporary network loss must not expose credentials. */ }
}
