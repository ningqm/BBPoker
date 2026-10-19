import { seedLegacyAccount } from './helpers/accounts.js';
import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { availableActions, createHand } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';
import { aggregateAnalytics } from '../src/analytics.js';
import { createApp } from '../server.js';

// Independent integration oracles: nine actual room members and normal command
// dispatch. Only time/presence and a fresh pre-decision deck are controlled.
// All expected pot and fish transfers below are hand-calculated constants.
function setup(t, settings = {}, buyins = Array(9).fill(100)) {
  let time = 1800000000000;
  t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: 10 }, (_, i) => ({ id: `combined-nine-${i}`, name: `Combined ${i}` }));
  const data = { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data });
  const room = service.create(users[0], { settings: { smallBlind: 5, bigBlind: 10, maxPlayers: 9, durationMinutes: 30,
    squid: true, squidMode: 'unlimited', squidExtraTokens: 3, squidUnitBB: 2, bombPot: true, bombIntervalMinutes: 1, bombAnteBB: 2, ...settings } });
  const f = { users, data, service, room, get time() { return time; }, advance(ms) { assert.ok(ms >= 0); time += ms; } };
  f.id = i => users[i].id; f.member = i => room.members[f.id(i)];
  f.cmd = (i, type, extra = {}) => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && room.hand?.actingId) readyRoomAction(service, room, value => { time = value; });
    const q = room.mini.squid, part = q.active && q.participants.includes(f.id(i));
    const result = service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length,
      ...(['stand', 'sitout'].includes(type) ? { expectedSquidRound: part ? q.round : 0,
        expectedSquidCost: part && !q.counts[f.id(i)] ? q.tokenBudget * q.unit : 0 } : {}), ...extra });
    if (action) while (room.hand?.transition) assert.ok(advanceRoomEvent(service, room, value => { time = value; }));
    return result;
  };  f.connect = (i, connected) => { service.connections.set(`${room.code}:${f.id(i)}`, connected ? 1 : 0); service.connectionChanged(room, time, { reconnected: connected }); };
  f.start = () => { service.start(room, time, { automatic: true }); return room.hand; };
  f.win = i => {
    for (let n = 0; room.hand.status === 'playing'; n++) {
      assert.ok(n < 100 && !room.hand.runout?.active);
      const actor = users.findIndex(u => u.id === room.hand.actingId), a = availableActions(room.hand, room.hand.actingId);
      f.cmd(actor, actor === i ? a.canCheck ? 'check' : 'call' : 'fold');
    }
    assert.deepEqual(room.hand.result.mainWinnerIds, [f.id(i)]);
    service.completeRabbit(room, time); conserve(f);
  };
  for (let i = 1; i < 10; i++) service.join(users[i], room.code, room.invite);
  for (let i = 0; i < 9; i++) { f.cmd(i, 'sit', { seat: i, amountBB: buyins[i] }); f.connect(i, true); }
  f.start(); f.cmd(0, 'autoDeal', { paused: true });
  assert.deepEqual(Object.values(room.mini.squid.reserves), []);
  return f;
}
function conserve(f) {
  const ms = Object.values(f.room.members), h = f.room.hand;
  const held = ms.reduce((n, m) => n + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0)
    + Object.values(f.room.mini.squid.reserves).reduce((a, b) => a + b, 0)
    + (h?.status === 'playing' ? h.players.reduce((n, p) => n + p.contributed, 0) : 0);
  assert.equal(held, ms.reduce((n, m) => n + m.totalBuyIn, 0), 'buy-ins = stacks + escrow + cashouts + live pots');
}
function fishTransfers(f, expected) {
  const rows = f.data.ledger.filter(e => e.type === 'squidSettlement');
  assert.equal(rows.length, expected.length); assert.equal(new Set(rows.map(e => e.roundSettlementId)).size, 1);
  assert.deepEqual(Object.fromEntries(rows.map(e => [e.playerId, e.amount])), Object.fromEntries(expected.map((n, i) => [f.id(i), n])));
  assert.equal(rows.reduce((n, e) => n + e.amount, 0), 0);
  for (let i = 0; i < expected.length; i++) {
    const stats = aggregateAnalytics(f.data, f.id(i));
    assert.equal(stats.miniNet, expected[i]); assert.equal(stats.squidSettlementCount, 1);
  }
  if (expected.length < 10) assert.equal(aggregateAnalytics(f.data, f.id(9)).miniNet, 0, 'waiting newcomer has no old-round liability');
  conserve(f);
}
function installDeck(f, holes) {
  const old = f.room.hand;
  assert.equal(old.players.length, 9); assert.ok(!old.log.some(e => ['fold','call','check','raise','allin'].includes(e.type)));
  const order = [...old.players.filter(p => p.seat > old.buttonSeat), ...old.players.filter(p => p.seat <= old.buttonSeat)];
  const positions = new Map();
  for (let r = 0; r < 2; r++) order.forEach((p, i) => positions.set(r * 9 + i, holes[Number(p.id.split('-').at(-1))][r]));
  [19,20,21,23,25].forEach((pos, i) => positions.set(pos, ['Ac','Kd','Qc','2s','3d'][i]));
  assert.equal(new Set(positions.values()).size, positions.size);
  const pack = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
  const unused = pack.filter(c => ![...positions.values()].includes(c));
  const deck = pack.map((_, i) => positions.get(i) ?? unused.shift());
  const h = createHand({ id: old.id, players: old.players.map(p => ({ id: p.id, seat: p.seat, name: p.name, stack: p.startingStack })),
    buttonSeat: old.buttonSeat, smallBlind: 5, bigBlind: 10, bombPot: old.bombPot, ante: old.ante, deferredRunout: true, deck });
  Object.assign(old, h); delete old.allInEquity; delete old.equityFrames; old.shown = {}; old.audit = commitDeck(old);
  f.service.afterAction(f.room, f.time);
}
function finishRunout(f) {
  for (let i = 0; f.room.hand.status === 'playing'; i++) {
    assert.ok(i < 10 && f.room.hand.runout?.active);
    f.advance(f.room.hand.runout.nextAt - f.time); f.service.tick(f.room, f.time);
  }
  conserve(f);
}

test('combined nine: 3bet/4bet and three all-ins, pending leaver, newcomer barrier, one entry blind then a due bomb', t => {
  const f = setup(t), q = f.room.mini.squid, round = q.roundSettlementId;
  installDeck(f, [['Js','Jh'],['Ts','Th'],['9s','9h'],['As','Ah'],['Ks','Kh'],['Qs','Qh'],['8s','8h'],['7s','7h'],['6s','6h']]);
  f.cmd(3, 'raise', { amount: 30 }); f.cmd(4, 'raise', { amount: 90 }); f.cmd(5, 'raise', { amount: 250 });
  for (const i of [6,7,8,0,1,2]) f.cmd(i, 'fold');
  f.cmd(3, 'call'); f.cmd(4, 'call');
  assert.equal(f.room.hand.street, 'flop');
  f.cmd(4, 'stand');
  f.cmd(3, 'allin'); f.cmd(4, 'call'); f.cmd(5, 'call');
  finishRunout(f);
  // Three full stacks 1000 each + dead SB5 + BB10 = 3015. AA beats KK and QQ.
  assert.deepEqual(f.room.hand.result.pots.map(p => p.amount), [3015]);
  assert.deepEqual(f.room.hand.result.mainWinnerIds, [f.id(3)]);
  assert.deepEqual(f.room.hand.players.map(p => p.stack - p.startingStack), [0,-5,-10,2015,-1000,-1000,0,0,0]);
  assert.equal(q.counts[f.id(3)], 1); assert.equal(f.member(4).seat, null); assert.equal(f.member(4).cashedOut, 0);
  assert.equal(q.reserves[f.id(4)], undefined);
  for (let viewer = 0; viewer < 9; viewer++) {
    const state = f.service.state(f.room, f.id(viewer));
    for (const p of state.players.filter(p => p.inHand)) {
      const exposed = [3,4,5,viewer].includes(Number(p.id.split('-').at(-1)));
      assert.equal(p.cards.every(c => c !== null), exposed, 'only the viewer and three all-in contenders are exposed');
    }
  }
  f.cmd(9, 'sit', { seat: 4, amountBB: 100 }); f.connect(9, true);
  assert.equal(f.service.state(f.room, f.id(9)).players.find(p => p.id === f.id(9)).waitingFor, 'squid');
  f.cmd(8, 'stand');
  const sitId = randomUUID();
  f.cmd(4, 'sit', { seat: 8, amountBB: 100, entryMode: 'post', commandId: sitId });
  f.cmd(4, 'sit', { seat: 8, amountBB: 100, entryMode: 'post', commandId: sitId });
  assert.equal(f.member(4).totalBuyIn, 2000); assert.equal(q.reserves[f.id(4)], undefined);
  f.advance(60000); f.start();
  assert.equal(f.room.hand.bombPot, false, 'a pending returning player defers the due bomb');
  assert.ok(!f.room.hand.players.some(p => p.id === f.id(9)), 'default wait-BB entrant still respects position');
  assert.deepEqual(f.room.hand.log.filter(e => e.playerId === f.id(4) && ['entryBlind','bigBlind','smallBlind','deadBlind'].includes(e.type)).map(e => [e.type,e.amount]), [['entryBlind',10]]);
  assert.equal(q.roundSettlementId, round); assert.equal(q.tokenBudget, 12); assert.equal(q.participants.length, 9);
  f.win(3); f.start();
  assert.equal(f.room.hand.bombPot, false, 'newcomer now reaches a natural big blind before the deferred bomb');
  assert.ok(f.room.hand.players.some(p => p.id === f.id(9)));
  assert.equal(q.tokenBudget, 13); assert.equal(q.participants.length, 10);
  assert.deepEqual(f.room.hand.log.filter(e => e.playerId === f.id(9) && ['entryBlind','bigBlind','deadBlind'].includes(e.type)).map(e => [e.type,e.amount]), [['bigBlind',10]]);
  f.win(3); f.start();
  assert.equal(f.room.hand.bombPot, true); assert.equal(f.room.hand.players.length, 8);
  assert.equal(f.room.hand.log.filter(e => e.type === 'ante').length, 8);
  assert.ok(f.room.hand.log.every(e => !['smallBlind','bigBlind','entryBlind','deadBlind'].includes(e.type)));
  f.win(3); assert.equal(f.room.hand.result.pots.reduce((sum, p) => sum + p.amount, 0), 160);
  assert.equal(q.counts[f.id(3)], 4); assert.deepEqual(Object.values(q.reserves), []);
  f.cmd(0, 'close');
  fishTransfers(f, [-80,-80,-80,720,-80,-80,-80,-80,-80,-80]);
  assert.equal(q.lastResult.tokensAwarded, 4); assert.equal(q.lastResult.tokensExhausted, false);
  assert.equal(aggregateAnalytics(f.data, f.id(9)).hands, 2);
});

test('combined nine: forced bomb busts eight, late rebuy cancels absent settlement, returning liability survives expiry', t => {
  const f = setup(t, { bombAnteBB: 500 }), q = f.room.mini.squid;
  f.win(0); f.advance(60000); f.start();
  installDeck(f, [['As','Ah'],['Ks','Kh'],['Qs','Qh'],['Js','Jh'],['Ts','Th'],['9s','9h'],['8s','8h'],['7s','7h'],['6s','6h']]);
  finishRunout(f);
  assert.deepEqual(f.room.hand.players.map(p => p.startingStack), [1015,995,990,1000,1000,1000,1000,1000,1000]);
  // 990*9 + 5*8 + 5*7 = 8985 contestable; AA also receives its uncalled15.
  assert.deepEqual(f.room.hand.result.pots.map(p => p.amount), [8910,40,35]);
  assert.deepEqual(f.room.hand.log.filter(e => e.type === 'refund').map(e => e.amount), [15]);
  assert.deepEqual(f.users.slice(0,9).map((_, i) => f.member(i).stack), [9000,0,0,0,0,0,0,0,0]);
  assert.equal(q.counts[f.id(0)], 2); assert.equal(q.absentSettlementAt, f.time + 10000);
  assert.deepEqual(f.room.rebuyGrace.eligibleIds.sort(), f.users.slice(1,9).map(u => u.id).sort());
  for (let i = 1; i < 9; i++) f.connect(i, false);
  f.advance(9999); f.service.tick(f.room, f.time);
  assert.equal(q.active, true); f.connect(1, true);
  const buy = randomUUID(); f.cmd(1, 'buyin', { amountBB: 100, commandId: buy }); f.cmd(1, 'buyin', { amountBB: 100, commandId: buy });
  assert.equal(f.member(1).stack, 1000); assert.equal(f.member(1).totalBuyIn, 2000); assert.equal(q.reserves[f.id(1)], undefined);
  assert.equal(q.absentSettlementAt, null);
  f.cmd(2, 'stand'); f.cmd(9, 'sit', { seat: 2, amountBB: 100 }); f.connect(9, true);
  f.cmd(0, 'stand'); assert.equal(f.member(0).cashedOut, 9000);
  assert.equal(f.service.squidReady(f.room).length, 1, 'the waiting newcomer cannot pretend to be a second round opponent');
  f.advance(f.room.endsAt - f.time); f.service.tick(f.room, f.time);
  const deadline = f.service.state(f.room, f.id(1)).mini.squid.expiryGraceEndsAt;
  assert.equal(deadline, f.time + 90000);
  f.advance(89999); f.service.tick(f.room, f.time); assert.equal(q.active, true);
  f.advance(1); f.service.tick(f.room, f.time); assert.equal(f.room.status, 'closed');
  fishTransfers(f, [320,-40,-40,-40,-40,-40,-40,-40,-40]);
  assert.equal(f.member(0).cashedOut, 9320); assert.equal(f.member(1).cashedOut, 960); assert.equal(f.member(2).cashedOut, 0);
  assert.equal(f.member(9).cashedOut, 1000);
  f.connect(2, true); f.service.tick(f.room, f.time); fishTransfers(f, [320,-40,-40,-40,-40,-40,-40,-40,-40]);
});

test('combined nine: multiple bomb hands preserve an absent blind debt and return posts exactly once before the next bomb', t => {
  const f = setup(t), q = f.room.mini.squid;
  f.win(0); f.connect(4, false);
  f.start(); f.win(0); f.start(); f.win(0);
  assert.deepEqual([f.room.blindOrbit.smallBlindSeat, f.room.blindOrbit.bigBlindSeat], [3,5]);
  assert.equal(f.member(4).blindEntry.missedBig, true); assert.equal(f.member(4).blindEntry.missedSmall, false);
  const absentStack = f.member(4).stack;
  for (let n = 0; n < 2; n++) {
    f.advance(60000); f.start(); assert.equal(f.room.hand.bombPot, true);
    assert.equal(f.room.hand.players.length, 8); assert.ok(!f.room.hand.players.some(p => p.id === f.id(4)));
    assert.deepEqual([f.room.blindOrbit.smallBlindSeat, f.room.blindOrbit.bigBlindSeat], [3,5]);
    if (n === 1) { f.connect(4, true); assert.equal(f.member(4).sittingOut, true); f.cmd(4, 'sitout', { value: false, entryMode: 'post' }); }
    f.win(0); assert.equal(f.member(4).stack, absentStack);
  }
  f.advance(60000); f.start(); assert.equal(f.room.hand.bombPot, false);
  assert.ok(!f.room.hand.players.some(p => p.id === f.id(4)), 'seat4 is still in the protected button-to-BB arc');
  assert.equal(f.member(4).stack, absentStack, 'a protected waiting seat is not charged');
  assert.equal(f.member(4).blindEntry.missedSmall, true, 'the first ordinary hand crosses the missing SB, unlike the earlier bombs');
  f.win(0); f.start(); assert.equal(f.room.hand.bombPot, false);
  assert.deepEqual(f.room.hand.log.filter(e => e.playerId === f.id(4) && ['entryBlind','bigBlind','smallBlind','deadBlind'].includes(e.type)).map(e => [e.type,e.amount]), [['entryBlind',10],['deadBlind',5]]);
  assert.equal(f.member(4).blindEntry.missedBig, false); f.win(0);
  f.start(); assert.equal(f.room.hand.bombPot, true); assert.equal(f.room.hand.players.length, 9);
  assert.deepEqual(f.room.hand.log.filter(e => e.playerId === f.id(4)).map(e => [e.type,e.amount]), [['ante',20]]);
  f.win(0); assert.equal(q.counts[f.id(0)], 8); assert.equal(q.tokenBudget, 12);
  assert.deepEqual(Object.values(q.reserves), []);
  f.cmd(0, 'close'); fishTransfers(f, [1280,-160,-160,-160,-160,-160,-160,-160,-160]);
});

test('combined nine: four different bomb-pot winners, side-pot leaver and rebuy do not create additional fish', t => {
  const f = setup(t, { bombAnteBB: 500 }, [100,150,200,250,250,250,250,250,250]), q = f.room.mini.squid;
  f.win(0); f.advance(60000); f.start();
  installDeck(f, [['As','Ah'],['Ks','Kh'],['Qs','Qh'],['Js','Jh'],['Ts','Th'],['9s','9h'],['8s','8h'],['7s','7h'],['6s','6h']]);
  f.cmd(1, 'stand'); finishRunout(f);
  // Four independent tiers: 1015*9, (1495-1015)*8, (1990-1495)*7,
  // (2500-1990)*6. AA/KK/QQ/JJ win successively as shorter stacks drop out.
  assert.deepEqual(f.room.hand.result.pots.map(p => p.amount), [9135,3840,3465,3060]);
  assert.deepEqual(f.room.hand.result.pots.map(p => p.winnerIds), [0,1,2,3].map(i => [f.id(i)]));
  assert.deepEqual(f.room.hand.players.map(p => p.stack-p.startingStack), [8120,2345,1475,560,-2500,-2500,-2500,-2500,-2500]);
  assert.equal(q.counts[f.id(0)], 2); assert.deepEqual(Object.values(q.counts).slice(1), Array(8).fill(0));
  assert.equal(f.room.hand.squidAwardedId, f.id(0)); assert.equal(f.member(1).cashedOut, 3840);
  assert.equal(q.reserves[f.id(1)], undefined); assert.equal(q.absentSettlementAt, null, 'two other unmarked side-pot winners can continue');
  f.cmd(9, 'sit', { seat: 1, amountBB: 100 }); f.connect(9, true);
  const buy = randomUUID(); f.cmd(4, 'buyin', { amountBB: 100, commandId: buy }); f.cmd(4, 'buyin', { amountBB: 100, commandId: buy });
  assert.equal(f.member(4).stack, 1000); assert.equal(f.member(4).totalBuyIn, 3500); assert.equal(q.reserves[f.id(4)], undefined);
  assert.equal(q.tokenBudget, 12); assert.equal(q.participants.includes(f.id(9)), false);
  f.cmd(0, 'close'); fishTransfers(f, [320,-40,-40,-40,-40,-40,-40,-40,-40]);
  assert.equal(f.member(1).cashedOut, 3840, 'the earlier side-pot cashout stays historical; the later two-fish liability is separate');
  assert.equal(f.member(4).cashedOut, 960);
});

test('combined nine HTTP: concurrent retries, stale actions and nine personalized reads never duplicate chips or reveal folded hands', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-combined-nine-'));
  const app = createApp({ dataDir: dir, actionTickMs: 1000000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (u, path, body, statuses = [200]) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: `Bearer ${u.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.ok(statuses.includes(response.status), `unexpected HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
  };
  const users = [];
  for (let i = 0; i < 10; i++) users.push(seedLegacyAccount(app, { name: `Combined HTTP ${i}` }));
  const initial = (await request(users[0], '/api/rooms', { settings: { maxPlayers: 9, smallBlind: 5, bigBlind: 10,
    squid: true, squidMode: 'unlimited', squidExtraTokens: 3, squidUnitBB: 2, bombPot: true, bombIntervalMinutes: 1 } }, [201])).room;
  const path = `/api/rooms/${initial.code}`, room = () => app.store.data.rooms[initial.code], id = i => users[i].user.id;
  const cmd = async (i, type, extra = {}, statuses = [200])  => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && room().hand?.actingId) readyRoomAction(app.service, room(), value => { clock = value; });
    const result = await request(users[i], path + '/action', {
    type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra,
  }, statuses);
    if (action) while (room().hand?.transition) { assert.ok(advanceRoomEvent(app.service, room(), value => { clock = value; })); app.store.save(); }
    return result;
  };
  const consent = i => ({ expectedSquidRound: room().mini.squid.round, expectedSquidCost: room().mini.squid.counts[id(i)] ? 0 : 240 });
  const privacy = (view, viewer) => {
    const h = room().hand;
    for (const p of view.players.filter(p => p.inHand)) assert.deepEqual(p.cards,
      p.id === id(viewer) ? h.players.find(x => x.id === p.id).cards : [null,null]);
    assert.deepEqual(view.hand.proofs.map(p => p.position).sort((a,b) => a-b), h.players.find(p => p.id === id(viewer)).cardIndices.slice().sort((a,b) => a-b));
    assert.equal(Object.hasOwn(view.hand, 'deck'), false); assert.equal(Object.hasOwn(view.hand, 'audit'), false);
    assert.equal(JSON.stringify(view).includes('passwordHash'), false);
  };
  const nineReads = async () => {
    const views = await Promise.all(users.slice(0,9).map(u => request(u, path)));
    views.forEach(privacy); return views;
  };
  for (let i = 1; i < 9; i++) await request(users[i], path + '/join', { invite: initial.invite });
  for (let i = 0; i < 9; i++) {
    await cmd(i, 'sit', { seat: i, amountBB: 100 });
    // API concurrency is real HTTP; only online transport presence is synthetic.
    app.service.connections.set(`${initial.code}:${id(i)}`, 1);
  }
  await cmd(0, 'start'); await cmd(0, 'autoDeal', { paused: true }); await nineReads();
  await request(users[9], path, undefined, [403]); await request(users[9], path + '/history', undefined, [403]);
  const lobby = await request(users[9], '/api/lobby');
  const allowed = ['code','name','hostName','status','access','joined','seatedCount','maxPlayers','smallBlind','bigBlind','squid','squidMode','squidExtraTokens','bombPot','bombIntervalMinutes','handNumber','endsAt','canJoin'].sort();
  assert.deepEqual(Object.keys(lobby.rooms[0]).sort(), allowed);
  assert.ok(!JSON.stringify(lobby).includes(initial.invite));
  const seq = room().hand.log.length, handId = room().hand.id, raiseId = randomUUID();
  const retry = { commandId: raiseId, handId, actionSeq: seq, amount: 30 };
  await Promise.all([
    cmd(3, 'raise', retry), cmd(3, 'raise', retry),
    cmd(4, 'raise', { handId, actionSeq: seq, amount: 90 }, [400,409]), nineReads(),
  ]);
  assert.equal(room().hand.log.filter(e => e.playerId === id(3) && e.type === 'raise').length, 1);
  assert.equal(room().hand.players.find(p => p.id === id(3)).contributed, 30);
  await cmd(4, 'raise', { amount: 90 }); await cmd(5, 'raise', { amount: 250 });
  const standId = randomUUID();
  const departureRace = await Promise.all([
    cmd(5, 'stand', { commandId: standId, ...consent(5) }),
    cmd(5, 'stand', { commandId: standId, ...consent(5) }),
    // Either serialization is valid: a top-up arriving first waits and is
    // cancelled on departure; one arriving after stand is rejected explicitly.
    cmd(5, 'buyin', { amountBB: 100 }, [200,409]), nineReads(),
  ]);
  assert.equal(room().members[id(5)].pendingDeparture, 'stand');
  assert.equal(app.service.pendingBuyIn(room().members[id(5)]), departureRace[2].room ? 1000 : 0);
  assert.equal(room().members[id(5)].totalBuyIn, 1000);
  for (const i of [6,7,8,0,1,2,3,4]) await cmd(i, 'fold');
  // After the 4bet everyone folds: 250-90=160 returned, actual pot=90+90+30+5+10=225.
  assert.deepEqual(room().hand.log.filter(e => e.type === 'refund').map(e => e.amount), [160]);
  assert.equal(room().hand.result.payouts[id(5)], 225);
  assert.deepEqual(room().hand.players.map(p => p.stack - p.startingStack), [0,-5,-10,-30,-90,135,0,0,0]);
  assert.equal(room().members[id(5)].cashedOut, 1135); assert.equal(room().members[id(5)].seat, null);
  assert.equal(app.service.pendingBuyIn(room().members[id(5)]), 0);
  assert.equal(room().members[id(5)].totalBuyIn, 1000);
  assert.equal(app.store.data.ledger.filter(e => e.playerId === id(5) && e.type === 'buyin').length, 1);
  assert.equal(app.store.data.ledger.filter(e => e.playerId === id(5) && e.type === 'buyinCancelled').length, departureRace[2].room ? 1 : 0);
  assert.equal(room().mini.squid.counts[id(5)], 1); assert.equal(room().mini.squid.reserves[id(5)], undefined);
  await nineReads();
  const historyViews = await Promise.all(users.slice(0,9).map(u => request(u, path + '/hands/' + handId)));
  historyViews.forEach((view, i) => {
    for (const p of view.players) assert.deepEqual(p.cards, p.id === id(i) ? room().hand.players.find(x => x.id === p.id).cards : [null,null]);
    assert.equal(view.proofs.length, 2); assert.deepEqual(view.result.handNames, {});
  });
  await request(users[9], path + '/hands/' + handId, undefined, [403]);
  await request(users[9], path + '/join', { invite: initial.invite });
  const sitId = randomUUID();
  await Promise.all([
    cmd(9, 'sit', { commandId: sitId, seat: 5, amountBB: 100 }),
    cmd(9, 'sit', { commandId: sitId, seat: 5, amountBB: 100 }), nineReads(),
  ]);
  assert.equal(room().members[id(9)].totalBuyIn, 1000); assert.equal(room().members[id(9)].stack, 1000);
  assert.equal(app.store.data.ledger.filter(e => e.playerId === id(9) && e.type === 'buyin').length, 1);
  assert.equal(room().mini.squid.participants.includes(id(9)), false);
  const freshView = await request(users[9], path);
  assert.equal(freshView.players.find(p => p.id === id(9)).waitingFor, 'squid');
  assert.ok(freshView.players.filter(p => p.inHand).every(p => p.cards.every(c => c === null)));
  await cmd(5, 'sit', { seat: 5, amountBB: 100 }, [400]);
  assert.equal(room().members[id(5)].totalBuyIn, 1000); assert.equal(room().mini.squid.reserves[id(5)], undefined);
  assert.deepEqual(Object.values(room().mini.squid.reserves), []);
  await cmd(8, 'stand', consent(8));
  const beforeRaceBuyins = Object.values(room().members).reduce((sum,m) => sum+m.totalBuyIn,0);
  const seatRace = await Promise.all([
    cmd(5, 'sit', { seat: 8, amountBB: 100, entryMode: 'post' }, [200,400]),
    cmd(8, 'sit', { seat: 8, amountBB: 100, entryMode: 'post' }, [200,400]), nineReads(),
  ]);
  assert.equal(seatRace.slice(0,2).filter(result => result.room).length, 1, 'exactly one competing identity receives the free seat');
  assert.equal(Object.values(room().members).filter(m => m.seat === 8).length, 1);
  assert.equal(Object.values(room().members).reduce((sum,m) => sum+m.totalBuyIn,0) - beforeRaceBuyins, 1000, 'the losing request cannot also credit a buy-in');
  assert.deepEqual(Object.values(room().mini.squid.reserves), []);
  assert.equal(room().mini.squid.tokenBudget, 12);
  conserve({ room: room() });
  await cmd(0, 'close');
  const adjustments = app.store.data.ledger.filter(e => e.type === 'squidSettlement');
  assert.equal(adjustments.length, 9);
  assert.deepEqual(Object.fromEntries(adjustments.map(e => [e.playerId,e.amount])), Object.fromEntries(users.slice(0,9).map((u,i) => [u.user.id,i === 5 ? 160 : -20])));
  conserve({ room: room() });
});
