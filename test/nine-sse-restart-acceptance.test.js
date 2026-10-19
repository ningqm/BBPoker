import { seedLegacyAccount } from './helpers/accounts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { createHand, availableActions } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';
import { readyRoomAction, advanceRoomEvent } from './helpers/room-clock.js';

// Real HTTP requests and SSE sockets exercise the transport lifecycle. Only
// the clock and one pre-decision deck are controlled; no production data is read.
async function fixture(t, buyins = Array(9).fill(200)) {
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-nine-sse-'));
  let app, base;
  const sockets = new Map();
  async function boot() {
    app = createApp({ dataDir: dir, actionTickMs: 1000000 });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  await boot();
  async function api(user, path, body, status = 200) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  const users = [];
  for (let i = 0; i < 10; i++) users.push(seedLegacyAccount(app, { name: `SSE验收${i}` }));
  const created = (await api(users[0], '/api/rooms', { name: '九人连接与重启验收', settings: {
    maxPlayers: 9, smallBlind: 5, bigBlind: 10, durationMinutes: 60,
    squid: true, squidMode: 'unlimited', squidExtraTokens: 3, squidUnitBB: 2,
    bombPot: true, bombIntervalMinutes: 1, bombAnteBB: 2,
  } }, 201)).room;
  const code = created.code, path = `/api/rooms/${code}`, id = i => users[i].user.id;
  const room = () => app.store.data.rooms[code];
  const setTime = value => { time = value; };
  const waitFor = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.ok(predicate(), 'real SSE state should reach the expected condition');
  };
  async function connect(i, suffix = '') {
    const key = `${i}:${suffix}`, controller = new AbortController();
    const response = await fetch(`${base}/api/events?room=${code}`, { headers: { Authorization: `Bearer ${users[i].token}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), stream = { controller, reader, latest: null, frames: 0, error: null };
    stream.done = (async () => {
      const decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const json = event.split('\n').find(line => line.startsWith('data: '));
            if (!json) continue;
            stream.latest = JSON.parse(json.slice(6)); stream.frames++;
          }
        }
      } catch (error) { if (!controller.signal.aborted && error.message !== 'terminated') stream.error = error; }
    })();
    sockets.set(key, stream); await waitFor(() => stream.latest !== null);
    assert.equal(stream.latest.meId, id(i)); return stream;
  }
  async function disconnect(i, suffix = '') {
    const key = `${i}:${suffix}`, socket = sockets.get(key); if (!socket) return;
    socket.controller.abort(); await socket.reader.cancel().catch(() => {}); await socket.done;
    assert.equal(socket.error, null); sockets.delete(key);
    const expected = [...sockets.keys()].filter(k => k.startsWith(`${i}:`)).length;
    await waitFor(() => (app.service.connections.get(`${code}:${id(i)}`) ?? 0) === expected);
  }
  const cmd = async (i, type, extra = {}, status = 200) => {
    if (['fold', 'check', 'call', 'raise', 'allin'].includes(type)) {
      readyRoomAction(app.service, room(), setTime); app.store.save(); app.broadcast(code);
    }
    return api(users[i], path + '/action', { type, commandId: randomUUID(),
      handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra }, status);
  };
  const event = () => {
    assert.ok(advanceRoomEvent(app.service, room(), setTime)); app.store.save(); app.broadcast(code);
  };
  const conserve = () => {
    const r = room(), ms = Object.values(r.members);
    const actual = ms.reduce((sum, m) => sum + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0)
      + Object.values(r.mini.squid.reserves).reduce((sum, n) => sum + n, 0)
      + (r.hand?.status === 'playing' ? r.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0);
    assert.equal(actual, ms.reduce((sum, m) => sum + m.totalBuyIn, 0));
  };
  async function start() {
    await cmd(0, 'start');
    if (room().hand?.status !== 'playing') {
      assert.ok(Number.isFinite(room().nextHandAt)); time = Math.max(time, room().nextHandAt);
      app.service.tick(room(), time); app.store.save(); app.broadcast(code);
    }
    assert.equal(room().hand.status, 'playing'); await cmd(0, 'autoDeal', { paused: true }); conserve();
  }
  async function win(target) {
    for (let steps = 0; room().hand.status === 'playing'; steps++) {
      assert.ok(steps < 100);
      if (room().hand.transition || room().hand.runout?.active) { event(); continue; }
      const actor = users.findIndex(u => u.user.id === room().hand.actingId);
      const legal = availableActions(room().hand, id(actor));
      await cmd(actor, actor === target ? legal.canCheck ? 'check' : 'call' : 'fold'); conserve();
    }
    assert.deepEqual(room().hand.result.mainWinnerIds, [id(target)]);
    app.service.completeRabbit(room(), time); app.store.save(); app.broadcast(code); conserve();
  }
  async function restart() {
    const identities = [...sockets.keys()].map(k => k.split(':'));
    for (const [i, suffix] of identities) await disconnect(Number(i), suffix);
    await app.close(); await boot();
    for (const [i, suffix] of identities) await connect(Number(i), suffix);
  }
  t.after(async () => {
    for (const key of [...sockets.keys()]) { const [i, suffix] = key.split(':'); await disconnect(Number(i), suffix); }
    await app.close(); rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 1; i < 10; i++) await api(users[i], path + '/join', { invite: created.invite });
  for (let i = 0; i < 9; i++) { await cmd(i, 'sit', { seat: i, amountBB: buyins[i] }); await connect(i); }
  await start();
  return { get app() { return app; }, users, id, room, cmd, connect, disconnect, restart, sockets, event, conserve, start, win, waitFor,
    api: (i, route, body, status) => api(users[i], route, body, status), path,
    advance(ms) { assert.ok(ms >= 0); time += ms; }, get time() { return time; } };
}

const squidFinancial = q => Object.fromEntries(['active','round','roundSettlementId','participants','tokenBudget','counts','reserves','admissions'].map(key => [key, structuredClone(q[key])]));

function predeterminedThreeWay(f) {
  const h = f.room().hand, holes = [['Js','Jh'],['Ts','Th'],['9s','9h'],['As','Ah'],['Ks','Kh'],['Qs','Qh'],['8s','8h'],['7s','7h'],['6s','6h']];
  assert.equal(h.log.filter(e => ['fold','check','call','raise','allin'].includes(e.type)).length, 0);
  const order = [...h.players.filter(p => p.seat > h.buttonSeat), ...h.players.filter(p => p.seat <= h.buttonSeat)];
  const chosen = new Map();
  for (let r = 0; r < 2; r++) order.forEach((p, index) => chosen.set(r * 9 + index, holes[f.users.findIndex(u => u.user.id === p.id)][r]));
  [19,20,21,23,25].forEach((position, i) => chosen.set(position, ['Ac','Kd','Qc','2s','3d'][i]));
  const pack = [...'cdhs'].flatMap(suit => [...'23456789TJQKA'].map(rank => rank + suit));
  const unused = pack.filter(card => ![...chosen.values()].includes(card));
  const deck = pack.map((_, position) => chosen.get(position) ?? unused.shift());
  Object.assign(h, createHand({ id: h.id, players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, stack: p.startingStack })),
    buttonSeat: h.buttonSeat, smallBlind: 5, bigBlind: 10, deferredTransitions: true, deferredRunout: true, deck }));
  h.shown = {}; h.audit = commitDeck(h); f.app.service.afterAction(f.room(), f.time); f.app.store.save(); f.app.broadcast(f.room().code);
}

test('nine actual SSE players: concurrent chats/top-up, disconnect, three-way all-in, restart and duplicate deliveries keep payouts and histories exact', async t => {
  const f = await fixture(t, [250,250,250,100,150,200,250,250,250]);
  predeterminedThreeWay(f);
  const handId = f.room().hand.id, queuedId = randomUUID();
  await f.cmd(3, 'raise', { amount: 30 }); await f.cmd(4, 'raise', { amount: 90 }); await f.cmd(5, 'raise', { amount: 250 });
  const beforeTopup = structuredClone(f.room().hand);
  await Promise.all([
    f.cmd(3, 'buyin', { amountBB: 100, commandId: queuedId }), f.cmd(3, 'buyin', { amountBB: 100, commandId: queuedId }),
    ...Array.from({ length: 9 }, (_, i) => f.api(i, f.path + '/chat', { messageId: randomUUID(), kind: 'text', text: `第${i}位同时聊天` })),
    ...Array.from({ length: 9 }, (_, i) => f.api(i, f.path)),
  ]);
  await f.waitFor(() => [...f.sockets.values()].every(socket => socket.latest.chat.length === 9));
  assert.deepEqual(f.room().hand, beforeTopup, 'chat and pending chips cannot alter the live hand');
  assert.equal(f.app.service.pendingBuyIn(f.room().members[f.id(3)]), 1000);
  assert.equal(f.room().members[f.id(3)].totalBuyIn, 1000);
  await f.connect(4, 'second-tab'); await f.disconnect(4);
  assert.equal((await f.api(0, f.path)).players.find(p => p.id === f.id(4)).connected, true, 'closing one browser tab cannot mark another open tab offline');
  await f.disconnect(4, 'second-tab');
  assert.equal((await f.api(0, f.path)).players.find(p => p.id === f.id(4)).connected, false);
  await f.connect(4);
  for (const i of [6,7,8,0,1,2]) await f.cmd(i, 'fold');
  await f.cmd(3, 'allin'); await f.cmd(4, 'allin');
  const lastAllin = { commandId: randomUUID(), handId, actionSeq: f.room().hand.log.length };
  await f.cmd(5, 'call', lastAllin);
  while (f.room().hand.transition) f.event();
  assert.equal(f.room().hand.runout.active, true);
  const frozen = structuredClone(f.room().hand), squid = squidFinancial(f.room().mini.squid);
  await f.restart();
  assert.deepEqual(f.room().hand, frozen, 'restart preserves exact deck, visible board, commitments, wagers and next reveal');
  assert.deepEqual(squidFinancial(f.room().mini.squid), squid);
  await Promise.all([f.cmd(3, 'buyin', { amountBB: 100, commandId: queuedId }), f.api(5, f.path + '/action', { type: 'call', ...lastAllin })]);
  assert.deepEqual(f.room().hand, frozen); assert.equal(f.app.service.pendingBuyIn(f.room().members[f.id(3)]), 1000);
  for (const i of [0,1,2,6,7,8]) {
    const view = await f.api(i, f.path);
    assert.equal(view.hand.deck, undefined); assert.equal(view.hand.audit, undefined);
    for (const p of view.players.filter(p => p.inHand)) assert.equal(p.cards.filter(Boolean).length, [i,3,4,5].includes(f.users.findIndex(u => u.user.id === p.id)) ? 2 : 0);
  }
  for (let steps = 0; f.room().hand.status === 'playing'; steps++) { assert.ok(steps < 10); f.event(); f.conserve(); }
  await f.waitFor(() => [...f.sockets.values()].every(socket => socket.latest.hand.status === 'complete'));
  for (const [key, socket] of f.sockets) {
    const viewer = Number(key.split(':')[0]);
    assert.equal(socket.latest.hand.board.length, 5);
    assert.equal(socket.latest.hand.id, handId);
    for (const p of socket.latest.players.filter(p => p.inHand)) assert.equal(p.cards.filter(Boolean).length, [viewer,3,4,5].includes(f.users.findIndex(u => u.user.id === p.id)) ? 2 : 0);
  }
  const h = f.room().hand;
  assert.deepEqual(h.board, ['Ac','Kd','Qc','2s','3d']);
  assert.deepEqual(h.result.pots.map(p => p.amount), [3015,1000]);
  assert.deepEqual(h.result.pots.map(p => p.winnerIds), [[f.id(3)],[f.id(4)]]);
  assert.deepEqual(h.log.filter(e => e.type === 'refund').map(e => e.amount), []);
  assert.equal(h.players.find(p => p.id === f.id(5)).stack, 500, 'covering caller retains chips above the largest opposing all-in');
  const expected = [0,-5,-10,2015,-500,-1500,0,0,0];
  assert.deepEqual(h.players.map(p => p.stack - p.startingStack), expected);
  assert.equal(f.room().members[f.id(3)].stack, 4015, 'one queued 100 BB top-up arrives after the award');
  assert.equal(f.room().members[f.id(3)].totalBuyIn, 2000);
  assert.equal(f.app.service.pendingBuyIn(f.room().members[f.id(3)]), 0);
  assert.equal(f.room().mini.squid.counts[f.id(3)], 1); assert.equal(f.room().mini.squid.counts[f.id(4)], 0, 'side-pot winner gets no fish');
  const views = await Promise.all(Array.from({ length: 9 }, (_, i) => f.api(i, f.path + '/hands/' + handId)));
  views.forEach((view, i) => {
    assert.equal(view.board.length, 5); assert.deepEqual(view.players.map(p => p.net), expected);
    for (const p of view.players) assert.equal(p.cards.filter(Boolean).length, [i,3,4,5].includes(f.users.findIndex(u => u.user.id === p.id)) ? 2 : 0);
  });
  const direct = (await f.api(3, `/api/opponents?room=${f.room().code}`)).opponents;
  assert.equal(direct.summary.holdem.net, 2015);
  assert.equal(direct.rows.find(row => row.id === f.id(4)).holdem.net, 1000);
  assert.equal(direct.rows.find(row => row.id === f.id(5)).holdem.net, 1000);
  const inverse = (await f.api(4, `/api/opponents?room=${f.room().code}&opponent=${f.id(3)}`)).opponents;
  assert.equal(inverse.summary.holdem.net, -1000);
  for (const scope of ['table','career']) {
    const stats = await f.api(0, f.path + `/players/${f.id(4)}/stats?scope=${scope}`);
    assert.equal(stats.hands, 1); assert.equal(stats.metrics.vpip.count, 1); assert.equal(stats.metrics.threeBet.count, 1);
    assert.equal(stats.versus.headsUp.hands, 0, 'a three-way all-in must not become heads-up statistics');
  }
  const closeId = randomUUID(); await f.cmd(0, 'close', { commandId: closeId });
  const settled = structuredClone(f.app.store.data); await f.restart(); await f.cmd(0, 'close', { commandId: closeId });
  assert.deepEqual(f.app.store.data.ledger, settled.ledger, 'restart and close retry never duplicate payouts or fish settlement');
  const fish = f.app.store.data.ledger.filter(row => row.type === 'squidSettlement');
  assert.equal(fish.length, 9); assert.equal(new Set(fish.map(row => row.roundSettlementId)).size, 1);
  assert.deepEqual(fish.map(row => row.amount), [-20,-20,-20,160,-20,-20,-20,-20,-20]);
  for (let i = 0; i < 9; i++) {
    const stats = await f.api(i, '/api/stats');
    assert.equal(stats.hands, 1); assert.equal(stats.holdemNet, expected[i]); assert.equal(stats.miniNet, i === 3 ? 160 : -20);
    assert.equal(stats.totalBuyIn, [2500,2500,2500,2000,1500,2000,2500,2500,2500][i]);
    assert.equal(stats.squidSettlementCount, 1);
  }
  f.conserve();
});

test('nine real SSE players: absent zero-fish player, new identity and old winner return preserve fish, one entry post, bomb ante and ledger across restart', async t => {
  const f = await fixture(t);
  await f.win(0);
  const originalRound = f.room().mini.squid.roundSettlementId;
  await f.disconnect(4);
  await f.cmd(0, 'stand', { expectedSquidRound: f.room().mini.squid.round, expectedSquidCost: 0 });
  await f.connect(9);
  const sitId = randomUUID();
  await Promise.all([f.cmd(9, 'sit', { seat: 0, amountBB: 200, entryMode: 'post', commandId: sitId }), f.cmd(9, 'sit', { seat: 0, amountBB: 200, entryMode: 'post', commandId: sitId })]);
  const zeroFishStack = f.room().members[f.id(4)].stack;
  assert.equal(f.room().mini.squid.tokenBudget, 12, 'sitting down alone is not fish admission');
  const beforeRestart = squidFinancial(f.room().mini.squid); await f.restart();
  assert.deepEqual(squidFinancial(f.room().mini.squid), beforeRestart);
  await f.start();
  assert.equal(f.room().hand.bombPot, false); assert.equal(f.room().hand.players.length, 8);
  assert.equal(f.room().mini.squid.tokenBudget, 13); assert.equal(f.room().mini.squid.participants.length, 10);
  assert.equal(f.room().mini.squid.counts[f.id(9)], 0); assert.equal(f.room().mini.squid.counts[f.id(0)], 1);
  assert.equal(f.room().mini.squid.reserves[f.id(9)], undefined);
  assert.equal(f.room().members[f.id(4)].stack, zeroFishStack, 'new admission charges neither reserve nor blind to an offline player');
  assert.equal(f.room().hand.players.some(p => p.id === f.id(4)), false);
  assert.deepEqual(f.room().hand.log.filter(e => e.playerId === f.id(9) && ['entryBlind','smallBlind','bigBlind','deadBlind'].includes(e.type)).map(e => [e.type,e.amount]), [['entryBlind',10]]);
  await f.cmd(9, 'sit', { seat: 0, amountBB: 200, entryMode: 'post', commandId: sitId });
  assert.equal(f.room().mini.squid.tokenBudget, 13); assert.equal(f.room().members[f.id(9)].totalBuyIn, 2000);
  await f.win(1);
  await f.cmd(1, 'stand', { expectedSquidRound: f.room().mini.squid.round, expectedSquidCost: 0 });
  const returnId = randomUUID();
  await Promise.all([f.cmd(0, 'sit', { seat: 1, amountBB: 100, entryMode: 'post', commandId: returnId }), f.cmd(0, 'sit', { seat: 1, amountBB: 100, entryMode: 'post', commandId: returnId })]);
  await f.connect(4); await f.cmd(4, 'entryBlind', { mode: 'post' });
  f.advance(60000);
  let oldEntryPosts = 0;
  for (let attempts = 0; attempts < 5; attempts++) {
    await f.start();
    assert.equal(f.room().mini.squid.tokenBudget, 13); assert.equal(f.room().mini.squid.roundSettlementId, originalRound);
    assert.equal(f.room().mini.squid.participants.filter(id => id === f.id(0)).length, 1);
    oldEntryPosts += f.room().hand.log.filter(e => e.playerId === f.id(0) && e.type === 'entryBlind').length;
    if (f.room().hand.bombPot) {
      assert.equal(f.room().hand.players.length, 9);
      assert.equal(f.room().hand.log.filter(e => e.type === 'ante').length, 9);
      assert.ok(f.room().hand.log.every(e => !['entryBlind','smallBlind','bigBlind','deadBlind'].includes(e.type)));
      const saved = structuredClone(f.room().hand), reserve = structuredClone(f.room().mini.squid.reserves);
      await f.restart(); assert.deepEqual(f.room().hand, saved); assert.deepEqual(f.room().mini.squid.reserves, reserve);
      await f.win(0); break;
    }
    await f.win(f.room().hand.players.some(p => p.id === f.id(0)) ? 0 : 2);
  }
  assert.equal(f.room().hand.bombPot, true, 'due bomb follows completion of required entry blind');
  assert.equal(oldEntryPosts, 1, 'returning winner posts exactly one entry BB, never one on every retry or bomb');
  assert.equal(f.room().mini.squid.participants.length, 10);
  const counts = structuredClone(f.room().mini.squid.counts), totalFish = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const zeroCount = Object.values(counts).filter(n => n === 0).length;
  await f.cmd(0, 'close');
  const settlements = f.app.store.data.ledger.filter(row => row.type === 'squidSettlement');
  assert.equal(settlements.length, 10);
  for (const row of settlements) assert.equal(row.amount, counts[row.playerId] ? counts[row.playerId] * 20 * zeroCount : -totalFish * 20);
  assert.equal(settlements.reduce((sum, row) => sum + row.amount, 0), 0);
  for (let i = 0; i < 10; i++) {
    const stats = await f.api(i, '/api/stats');
    const expected = settlements.find(row => row.playerId === f.id(i)).amount;
    assert.equal(stats.miniNet, expected); assert.equal(stats.squidSettlementCount, 1);
    const direct = (await f.api(i, `/api/opponents?room=${f.room().code}`)).opponents;
    assert.equal(direct.summary.total.net, stats.net);
    assert.equal(direct.rows.reduce((sum, row) => sum + row.total.net, 0), stats.net);
  }
  f.conserve();
});
