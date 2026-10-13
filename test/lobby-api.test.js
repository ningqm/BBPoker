import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { lobbyDirectory } from '../src/lobby.js';

async function setup(t, actionTickMs = 1000000) {
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-lobby-'));
  const app = createApp({ dataDir: dir, allowGuestSessions: true, actionTickMs });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const api = async (who, path, data, expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method: data === undefined ? 'GET' : 'POST', headers: { ...(who ? { Authorization: `Bearer ${who.token}` } : {}), 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const users = [];
  for (const name of ['公开房主', '邀请房主', '新朋友', '普通朋友']) users.push(await api(null, '/api/session', { name }, 201));
  const command = (who, code, type, extra = {}, expected = 200) => api(who, `/api/rooms/${code}/action`, { type, commandId: randomUUID(), ...extra }, expected);
  return { app, api, users, command };
}

test('lobby requires login and exposes only a bounded allowlist, never invitation/card/account data', async t => {
  const { app, api, users } = await setup(t);
  await api(null, '/api/lobby', undefined, 401);
  const open = (await api(users[0], '/api/rooms', { access: 'public' }, 201)).room;
  const invite = (await api(users[1], '/api/rooms', {}, 201)).room;
  app.store.data.rooms[invite.code].hand = { status: 'playing', deck: ['SECRET'], audit: 'SECRET', players: [] };
  const before = structuredClone(app.store.data);
  const lobby = await api(users[2], '/api/lobby');
  assert.equal(lobby.limit, 10); assert.equal(lobby.rooms.length, 2);
  const allowed = ['code','name','hostName','status','access','joined','seatedCount','maxPlayers','smallBlind','bigBlind','squid','bombPot','bombIntervalMinutes','handNumber','endsAt','canJoin'].sort();
  for (const row of lobby.rooms) assert.deepEqual(Object.keys(row).sort(), allowed);
  assert.equal(lobby.rooms.find(r => r.code === open.code).canJoin, true);
  assert.equal(lobby.rooms.find(r => r.code === invite.code).canJoin, false);
  assert.equal(lobby.rooms.find(r => r.code === invite.code).status, 'playing');
  for (const secret of [open.invite, invite.invite, users[0].token, 'SECRET']) assert.ok(!JSON.stringify(lobby).includes(secret));
  assert.deepEqual(app.store.data, before, 'directory reads never change lifecycle or data');
});

test('public join works without an invite; an old room remains protected even after discovery', async t => {
  const { app, api, users, command } = await setup(t);
  const open = (await api(users[0], '/api/rooms', { access: 'public' }, 201)).room;
  const privateRoom = (await api(users[1], '/api/rooms', { access: 'invite' }, 201)).room;
  delete app.store.data.rooms[privateRoom.code].access;
  await api(users[2], `/api/rooms/${privateRoom.code}/join`, {}, 403);
  await api(users[2], `/api/rooms/${privateRoom.code}`, undefined, 403);
  await api(users[2], `/api/rooms/${privateRoom.code}/history`, undefined, 403);
  await api(users[2], `/api/rooms/${open.code}/join`, {});
  await api(users[2], `/api/rooms/${privateRoom.code}/join`, { invite: privateRoom.invite });
  const joined = (await api(users[2], '/api/lobby')).rooms;
  assert.ok(joined.every(r => r.joined && r.canJoin));
  await command(users[0], open.code, 'close');
  assert.ok(!(await api(users[2], '/api/lobby')).rooms.some(r => r.code === open.code));
  assert.ok((await api(users[2], '/api/me')).rooms.some(r => r.code === open.code && r.status === 'closed'));
  await api(users[3], `/api/rooms/${open.code}/join`, {}, 400);
});

test('two tables are independent and one account cannot occupy both', async t => {
  const { app, api, users, command } = await setup(t);
  await api(users[0], '/api/rooms', { access: 'wrong' }, 400);
  const a = (await api(users[0], '/api/rooms', { access: 'public' }, 201)).room;
  const b = (await api(users[1], '/api/rooms', { access: 'public' }, 201)).room;
  await api(users[0], '/api/rooms', { access: 'public' }, 409);
  await api(users[2], `/api/rooms/${a.code}/join`, {});
  await api(users[2], `/api/rooms/${b.code}/join`, {});
  await command(users[2], a.code, 'sit', { seat: 0, amountBB: 100 });
  const beforeB = structuredClone(app.store.data.rooms[b.code]);
  await command(users[2], b.code, 'sit', { seat: 0, amountBB: 100 }, 409);
  assert.deepEqual(app.store.data.rooms[b.code], beforeB, 'rejected seating is atomic');
  await command(users[2], a.code, 'stand');
  await command(users[2], b.code, 'sit', { seat: 0, amountBB: 100 });
  const aState = await api(users[2], `/api/rooms/${a.code}`);
  const bState = await api(users[2], `/api/rooms/${b.code}`);
  assert.equal(aState.players.find(p => p.id === users[2].user.id).seat, null);
  assert.equal(bState.players.find(p => p.id === users[2].user.id).seat, 0);
  await command(users[0], a.code, 'close');
  assert.equal((await api(users[2], `/api/rooms/${b.code}`)).status, 'waiting');
});

test('full membership does not advertise public join and joined users still return', () => {
  const members = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, { seat: i < 9 ? i : null }]));
  const db = { users: {}, rooms: { '123456': { code:'123456', name:'满员桌', hostId:'p0', access:'public', status:'waiting', members, settings:{maxPlayers:9,smallBlind:5,bigBlind:10},createdAt:new Date().toISOString() } } };
  assert.equal(lobbyDirectory(db, 'outsider').rooms[0].canJoin, false);
  assert.equal(lobbyDirectory(db, 'p29').rooms[0].canJoin, true);
  assert.equal(lobbyDirectory(db, 'p29').rooms[0].seatedCount, 9);
});

test('a failed table timer does not block another table from committing its due work', async t => {
  const { app, api, users } = await setup(t, 10);
  const a = (await api(users[0], '/api/rooms', {}, 201)).room;
  const b = (await api(users[1], '/api/rooms', {}, 201)).room;
  let seenFailure = false;
  app.service.needsTick = room => room.status !== 'closed';
  app.service.tick = room => {
    if (room.code === a.code) { seenFailure = true; room.name = 'must roll back'; throw new Error('isolated table test'); }
    room.status = 'closed'; return true;
  };
  const originalError = console.error; console.error = () => {};
  try {
    await new Promise((resolve, reject) => {
      const start = Date.now(); const poll = setInterval(() => {
        if (seenFailure && app.store.data.rooms[b.code].status === 'closed') { clearInterval(poll); resolve(); }
        else if (Date.now() - start > 2000) { clearInterval(poll); reject(new Error('second table timer was blocked')); }
      }, 10);
    });
  } finally { console.error = originalError; }
  assert.equal(app.store.data.rooms[a.code].name, a.name);
  assert.equal(app.store.data.rooms[b.code].status, 'closed');
});
