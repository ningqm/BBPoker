import { advanceRoomEvent, readyRoomAction } from './helpers/room-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore } from '../src/store.js';
import { RoomService, settingsFor } from '../src/room.js';
import { availableActions, createHand } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';
import { aggregateAnalytics } from '../src/analytics.js';

// Nine real RoomService members, commands and engine actions. Only the bomb
// showdown fixtures replace a newly created deck locally, before any decision.
// Expected transfers / pot layers are arithmetic constants, not engine oracles.
function fixture(t, settings = {}, buyins = Array(9).fill(100)) {
  let time = 1800000000000; t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: 10 }, (_, i) => ({ id: `nine-oracle-${i}`, name: `Synthetic nine ${i}` }));
  const data = { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const f = { users, data, service: new RoomService({ data }), get time() { return time; }, advance(ms) { time += ms; } };
  f.room = f.service.create(users[0], { settings: { smallBlind: 5, bigBlind: 10, maxPlayers: 9, squid: true, squidUnitBB: 2, ...settings } });
  for (const user of users.slice(1)) f.service.join(user, f.room.code, f.room.invite);
  f.id = i => users[i].id;
  f.member = i => f.room.members[f.id(i)];
  f.cmd = (i, type, extra = {}) => {
    const action = ['fold', 'check', 'call', 'raise', 'allin'].includes(type);
    if (action && f.room.hand?.actingId) readyRoomAction(f.service, f.room, value => { time = value; });
    const q = f.room.mini.squid, part = q.active && q.participants.includes(f.id(i));
    const result = f.service.command(users[i], f.room.code, { type, commandId: randomUUID(), handId: f.room.hand?.id, actionSeq: f.room.hand?.log.length,
      ...(['stand', 'sitout'].includes(type) ? { expectedSquidRound: part ? q.round : 0, expectedSquidCost: part && !q.won.includes(f.id(i)) ? (q.mode === 'unlimited' ? q.tokenBudget * q.unit : 160) : 0 } : {}), ...extra });
    if (action) while (f.room.hand?.transition) assert.ok(advanceRoomEvent(f.service, f.room, value => { time = value; }));
    return result;
  };  f.connect = (i, value) => { f.service.connections.set(`${f.room.code}:${f.id(i)}`, value ? 1 : 0); f.service.connectionChanged(f.room, time, { reconnected: value }); };
  f.start = () => { f.service.start(f.room, time, { automatic: true }); return f.room.hand; };
  f.win = i => {
    for (let n = 0; f.room.hand.status === 'playing'; n++) {
      assert.ok(n < 100, 'fold-down terminates'); const h = f.room.hand;
      assert.ok(!h.runout?.active, 'fold-down is not a forced showdown');
      const actor = users.findIndex(u => u.id === h.actingId), a = availableActions(h, h.actingId);
      f.cmd(actor, actor === i ? a.canCheck ? 'check' : 'call' : 'fold');
    }
    assert.deepEqual(f.room.hand.result.mainWinnerIds, [f.id(i)]);
    const q = f.room.mini.squid;
    if (q.mode === 'unlimited') assert.deepEqual(q.won.slice().sort(), q.participants.filter(id => q.counts[id] > 0).sort(), 'legacy won projection stays exactly equal to positive count holders');
    f.service.completeRabbit(f.room, time); conserved(f);
  };
  for (let i = 0; i < 9; i++) { f.cmd(i, 'sit', { seat: i, amountBB: buyins[i] }); f.connect(i, true); }
  f.start(); return f;
}
function conserved(f) {
  const r = f.room, ms = Object.values(r.members);
  const held = ms.reduce((s, m) => s + m.stack + m.cashedOut - (m.squidDebt ?? 0), 0)
    + Object.values(r.mini.squid.reserves).reduce((s, x) => s + x, 0)
    + (r.hand?.status === 'playing' ? r.hand.players.reduce((s, p) => s + p.contributed, 0) : 0);
  assert.equal(held, ms.reduce((s, m) => s + m.totalBuyIn, 0), 'all buy-ins remain in stacks, live pots, reserves or cashouts');
}
const settlements = f => f.data.ledger.filter(x => x.type === 'squidSettlement');
function amounts(f, expected) {
  const rows = settlements(f); assert.equal(rows.length, 9);
  assert.equal(new Set(rows.map(x => x.roundSettlementId)).size, 1);
  assert.deepEqual(Object.fromEntries(rows.map(x => [x.playerId, x.amount])), Object.fromEntries(expected.map((v, i) => [f.id(i), v])));
  for (let i = 0; i < 9; i++) {
    const id = f.id(i), stats = aggregateAnalytics(f.data, id), exported = f.service.exports(id, f.room.code);
    assert.equal(stats.miniNet, expected[i]); assert.equal(stats.squidSettlementCount, 1);
    assert.equal(f.service.sessionFor(id, f.room.code).session.meMiniNet, expected[i]);
    assert.equal(f.service.stats(id).miniNet, expected[i]);
    const adjustments = f.service.exportAdjustments(id, f.room.code);
    assert.equal(adjustments.length, 1); assert.equal(adjustments[0].amount, expected[i]);
    assert.equal(exported.reduce((sum, h) => sum + h.players.find(p => p.id === id).miniNet, 0), 0,
      'exports keep the authoritative fish adjustment separate from its per-hand mirror');
    if (f.room.hand.squidSettlementId) {
      const h = f.service.handFor(id, f.room.code, f.room.hand.id);
      const dealt = h.players.find(p => p.id === id);
      if (dealt) assert.equal(dealt.miniNet, expected[i], 'visible final hand may show its single settlement mirror');
      assert.equal(h.mini.changes[id], expected[i], 'absent round participants retain their mirrored adjustment without becoming dealt players');
      assert.equal(h.squidSettlementChanges[id], expected[i]);
    }
  }
  assert.equal(rows.reduce((s, x) => s + x.amount, 0), 0); conserved(f);
}
function playWin(f, i) { f.start(); f.win(i); }

test('nine-player oracle: eight distinct fish, repeated winners and repeated finish never duplicate reserves or transfers', t => {
  const f = fixture(t), first = f.room.mini.squid.roundSettlementId;
  assert.deepEqual(Object.values(f.room.mini.squid.reserves), []); conserved(f);
  f.win(0); playWin(f, 0);
  assert.deepEqual(f.room.mini.squid.won, [f.id(0)]); assert.equal(settlements(f).length, 0);
  for (let i = 1; i < 8; i++) playWin(f, i);
  amounts(f, [20, 20, 20, 20, 20, 20, 20, 20, -160]);
  assert.equal(f.room.mini.squid.active, false); assert.deepEqual(f.room.mini.squid.reserves, {});
  f.service.finish(f.room, f.time); f.service.settleSquid(f.room, { reason: 'partial', timestamp: f.time });
  assert.equal(settlements(f).length, 9);
  const before = f.users.slice(0, 9).map((_, i) => f.member(i).stack);
  f.start(); assert.equal(f.room.mini.squid.round, 2); assert.notEqual(f.room.mini.squid.roundSettlementId, first);
  assert.deepEqual(Object.values(f.room.mini.squid.reserves), []);
  for (const p of f.room.hand.players) assert.equal(p.startingStack, before[Number(p.id.split('-').at(-1))]);
  assert.equal(settlements(f).length, 9); conserved(f);
});

test('nine-player oracle: marked leaver still receives while two absent unmarked players pay only seven winners', t => {
  const f = fixture(t); f.win(0); f.cmd(0, 'stand'); const cash = f.member(0).cashedOut;
  f.connect(7, false); f.connect(8, false);
  const absentBalances = [f.member(7).stack, f.member(8).stack];
  // Keep the tenth identity observing: this case audits the original nine
  // participants' absent settlement, not the old assumption that a seated
  // newcomer can never enter an ongoing round. Mid-round admission is covered
  // independently in squid-midround-oracle.test.js.
  f.connect(9, true);
  assert.equal(f.member(9).seat, null);
  assert.equal(f.member(9).totalBuyIn, 0);
  for (let i = 1; i < 7; i++) {
    f.start(); assert.ok(f.room.hand.players.every(p => ![f.id(0), f.id(7), f.id(8), f.id(9)].includes(p.id)));
    f.win(i);
  }
  assert.deepEqual([f.member(7).stack, f.member(8).stack], absentBalances, 'absent players do not burn blinds');
  assert.equal(f.room.mini.squid.absentSettlementAt, f.time + 5000);
  f.advance(4999); f.service.tick(f.room, f.time); assert.equal(settlements(f).length, 0);
  f.advance(1); f.service.tick(f.room, f.time);
  amounts(f, [40, 40, 40, 40, 40, 40, 40, -140, -140]);
  assert.equal(f.member(0).cashedOut, cash + 40, 'marked leaver receives only the settled net 40 into cashout');
  assert.deepEqual([f.member(7).stack, f.member(8).stack], absentBalances.map(x => x - 140));
  assert.equal(aggregateAnalytics(f.data, f.id(9)).hands, 0); assert.equal(aggregateAnalytics(f.data, f.id(9)).miniNet, 0);
  f.connect(7, true); f.connect(8, true); f.service.tick(f.room, f.time);
  assert.equal(settlements(f).length, 9); conserved(f);
});

test('nine-player oracle: one of two unmarked absentees returns before grace, earns fish and cancels a multi-loser settlement', t => {
  const f = fixture(t); f.win(0); f.connect(7, false); f.connect(8, false);
  for (let i = 1; i < 7; i++) playWin(f, i);
  const reserve = structuredClone(f.room.mini.squid.reserves), round = f.room.mini.squid.roundSettlementId;
  const absent = f.member(7).stack;
  f.advance(4999); f.connect(8, true); f.cmd(8, 'entryBlind', { mode: 'post' });
  assert.equal(f.room.mini.squid.absentSettlementAt, null); assert.equal(settlements(f).length, 0);
  let returned = false;
  for (let n = 0; n < 10; n++) {
    f.start(); assert.deepEqual(f.room.mini.squid.reserves, reserve); assert.equal(f.room.mini.squid.roundSettlementId, round);
    if (f.room.hand.players.some(p => p.id === f.id(8))) {
      returned = true;
      const charges = f.room.hand.log.filter(x => x.playerId === f.id(8) && ['bigBlind', 'entryBlind', 'deadBlind', 'smallBlind'].includes(x.type));
      assert.ok(charges.reduce((s, x) => s + x.amount, 0) <= 15, 'at most one live BB and one missed SB');
      assert.ok(charges.filter(x => ['bigBlind', 'entryBlind'].includes(x.type)).length <= 1, 'natural BB never duplicates entry BB');
      f.win(8); break;
    }
    f.win(0);
  }
  assert.equal(returned, true);
  amounts(f, [20, 20, 20, 20, 20, 20, 20, -160, 20]);
  assert.equal(f.member(7).stack, absent - 160, 'loser pays eight actual fish at settlement, never extra absent blinds');
  assert.ok(settlements(f).every(x => x.reason === 'normal'));
});

test('nine-player oracle: pending departure cancellation, same-round reseating and retried buy-in keep one liability', t => {
  const f = fixture(t), firstId = randomUUID();
  f.cmd(8, 'stand', { commandId: firstId }); f.cmd(8, 'stand', { commandId: firstId });
  assert.equal(f.member(8).pendingDeparture, 'stand');
  f.cmd(8, 'cancelDeparture'); assert.equal(f.member(8).pendingDeparture, null);
  f.cmd(8, 'stand'); f.win(0);
  assert.equal(f.member(8).seat, null); assert.equal(f.room.mini.squid.reserves[f.id(8)], undefined);
  const buy = randomUUID(), cash = f.member(8).cashedOut;
  f.cmd(8, 'sit', { seat: 8, amountBB: 100, entryMode: 'post', commandId: buy });
  f.cmd(8, 'sit', { seat: 8, amountBB: 100, entryMode: 'post', commandId: buy });
  assert.equal(f.member(8).totalBuyIn, 2000); assert.equal(f.member(8).stack, 1000); assert.equal(f.member(8).cashedOut, cash);
  assert.equal(f.room.mini.squid.reserves[f.id(8)], undefined); assert.equal(f.room.mini.squid.round, 1);
  f.cmd(0, 'close'); amounts(f, [160, -20, -20, -20, -20, -20, -20, -20, -20]);
  assert.equal(f.member(8).cashedOut, cash + 980);
});

function controlledBomb(f, holes, board) {
  const old = f.room.hand; assert.equal(old.bombPot, true); assert.equal(old.board.length, 3);
  assert.ok(!old.log.some(e => ['fold', 'call', 'check', 'raise', 'allin'].includes(e.type)));
  const assigned = new Map(), players = old.players, order = [...players.filter(p => p.seat > old.buttonSeat), ...players.filter(p => p.seat <= old.buttonSeat)];
  for (let r = 0; r < 2; r++) order.forEach((p, i) => assigned.set(r * 9 + i, holes[Number(p.id.split('-').at(-1))][r]));
  [19, 20, 21, 23, 25].forEach((pos, i) => assigned.set(pos, board[i]));
  assert.equal(new Set(assigned.values()).size, assigned.size);
  const pack = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s)), unused = pack.filter(c => ![...assigned.values()].includes(c));
  const deck = pack.map((_, i) => assigned.get(i) ?? unused.shift());
  const h = createHand({ id: old.id, players: players.map(p => ({ id: p.id, seat: p.seat, stack: p.startingStack })), buttonSeat: old.buttonSeat,
    smallBlind: 5, bigBlind: 10, bombPot: true, ante: old.ante, deferredRunout: true, deck });
  Object.assign(old, h); delete old.allInEquity; delete old.equityFrames; old.shown = {}; old.audit = commitDeck(old);
  f.service.afterAction(f.room, f.time);
  for (let n = 0; old.status === 'playing'; n++) {
    assert.ok(n < 100);
    if (old.runout?.active) { f.advance(old.runout.nextAt - f.time); f.service.tick(f.room, f.time); }
    else f.cmd(f.users.findIndex(u => u.id === old.actingId), availableActions(old, old.actingId).canCheck ? 'check' : 'call');
  }
  conserved(f); return old;
}

test('nine-player oracle: timed bomb with four all-in pot tiers awards only the main-pot fish and preserves rebuy/leave reserves', t => {
  const f = fixture(t, { bombPot: true, bombIntervalMinutes: 1, bombAnteBB: 500 }, [100, 150, 200, 250, 250, 250, 250, 250, 250]);
  f.win(0); assert.equal(f.room.hand.bombPot, false);
  f.advance(60000); f.start();
  assert.equal(f.room.hand.players.length, 9); assert.equal(f.room.nextBombAt, f.time + 60000);
  const h = controlledBomb(f, [['As','Ah'], ['Ks','Kh'], ['Qs','Qh'], ['Js','Jh'], ['Ts','Th'], ['9s','9h'], ['8s','8h'], ['7s','7h'], ['6s','6h']], ['Ac','Kd','Qc','2s','3d']);
  assert.deepEqual(h.players.map(p => p.startingStack), [1015, 1495, 1990, 2500, 2500, 2500, 2500, 2500, 2500]);
  assert.deepEqual(h.result.pots.map(p => p.amount), [9135, 3840, 3465, 3060]);
  assert.deepEqual(h.result.pots.map(p => p.winnerIds), [0, 1, 2, 3].map(i => [f.id(i)]));
  assert.deepEqual(h.players.map(p => p.stack - p.startingStack), [8120, 2345, 1475, 560, -2500, -2500, -2500, -2500, -2500]);
  assert.ok(h.log.filter(e => e.type === 'ante').length === 9); assert.ok(h.log.every(e => !['smallBlind','bigBlind','entryBlind'].includes(e.type)));
  assert.deepEqual(f.room.mini.squid.won, [f.id(0)], 'side-pot winners and repeated main win award no extra normal fish');
  assert.deepEqual(f.room.rebuyGrace.eligibleIds.sort(), [4,5,6,7,8].map(i => f.id(i)));
  f.cmd(4, 'buyin', { amountBB: 100 }); assert.equal(f.member(4).stack, 1000); assert.equal(f.room.mini.squid.reserves[f.id(4)], undefined);
  f.cmd(5, 'stand'); assert.equal(f.member(5).cashedOut, 0); assert.equal(f.room.mini.squid.reserves[f.id(5)], undefined);
  f.cmd(0, 'close'); amounts(f, [160, -20, -20, -20, -20, -20, -20, -20, -20]);
  assert.equal(f.member(5).cashedOut - (f.member(5).squidDebt ?? 0), -20); assert.equal(f.member(4).cashedOut, 980);
  for (let i = 0; i < 9; i++) assert.equal(aggregateAnalytics(f.data, f.id(i)).metrics.vpip.opportunities, 1, 'bomb adds no preflop opportunity');
});

test('nine-player oracle: cutoff and overtime finish the original fish round with scheduled bombs and no new reserve', t => {
  const f = fixture(t, { bombPot: true, bombIntervalMinutes: 1, durationMinutes: 30 }); f.win(0);
  const round = f.room.mini.squid.roundSettlementId;
  f.advance(f.room.endsAt - 300000 - f.time); f.start(); assert.equal(f.room.hand.bombPot, true); f.win(1);
  f.advance(f.room.endsAt - f.time);
  for (let i = 2; i < 8; i++) {
    f.start(); assert.equal(f.room.hand.bombPot, i === 2); assert.equal(f.room.mini.squid.roundSettlementId, round); f.win(i);
  }
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.mini.squid.round, 1);
  assert.equal(f.data.hands.length, 8); amounts(f, [20,20,20,20,20,20,20,20,-160]);
  assert.equal(f.data.hands.flatMap(h => h.log).filter(e => e.type === 'ante').length, 18);
});


test('nine-player unlimited oracle: N+3 fish, repeated holders and budget exhaustion settle weighted counts with four losers', t => {
  const f = fixture(t, { squidMode: 'unlimited' }), q = f.room.mini.squid;
  assert.equal(q.mode, 'unlimited'); assert.equal(q.tokenBudget, 12); assert.equal(q.extraTokens, 3);
  assert.deepEqual(Object.values(q.reserves), []);
  const before = structuredClone(q), initial = f.service.state(f.room, f.id(0));
  assert.deepEqual(q, before, 'read projection cannot migrate or charge reserves');
  assert.equal(initial.players.find(p => p.id === f.id(8)).squidMaxLoss, 240);
  assert.equal(initial.mini.squid.tokensRemaining, 12);
  const sequence = [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 4];
  sequence.forEach((id, n) => {
    if (n) f.start(); f.win(id);
    assert.equal(f.room.hand.squidAwardedId, f.id(id));
    assert.equal(Object.values(f.room.hand.squidCounts).reduce((a, b) => a + b, 0), n + 1);
    if (n < 11) { assert.equal(q.active, true); assert.equal(settlements(f).length, 0); }
  });
  amounts(f, [400, 240, 160, 80, 80, -240, -240, -240, -240]);
  assert.equal(q.active, false); assert.equal(q.lastResult.tokensExhausted, true);
  assert.equal(q.lastResult.tokensAwarded, 12); assert.equal(q.lastResult.amount, 960);
  assert.deepEqual(q.lastResult.counts, Object.fromEntries([5,3,2,1,1,0,0,0,0].map((n, i) => [f.id(i), n])));
  assert.equal(q.lastResult.loserId, null); assert.equal(q.lastResult.loserIds.length, 4);
  const settled = structuredClone(f.data);
  f.service.finish(f.room, f.time); f.service.settleSquid(f.room, { reason: 'partial', timestamp: f.time });
  assert.deepEqual(f.data, settled, 'repeated finalization cannot emit another weighted adjustment or mutate snapshots');
  const hand = f.room.hand, historical = f.service.handFor(f.id(9), f.room.code, hand.id);
  assert.equal(historical.squidMode, 'unlimited'); assert.equal(historical.squidTokenBudget, 12);
  assert.deepEqual(historical.squidCounts, q.lastResult.counts);
  assert.ok(historical.players.every(p => p.cards.every(c => c === null)), 'new counts cannot expose any hidden hole cards');
  assert.equal(f.service.history(f.id(0), f.room.code).hands[0].squidMode, 'unlimited');
  assert.equal(f.service.handLibrary(f.id(0), { room: f.room.code, limit: '20' }).hands[0].squidTokenBudget, 12);
  f.start(); assert.equal(q.round, 2); assert.deepEqual(Object.values(q.counts), Array(9).fill(0));
  assert.deepEqual(f.service.handFor(f.id(0), f.room.code, hand.id).squidCounts, historical.squidCounts, 'starting next round cannot rewrite historical counts');
  assert.equal(settlements(f).length, 9); conserved(f);
});

test('nine-player unlimited oracle: one remaining unmarked ends before budget, never invents the two unused fish', t => {
  const f = fixture(t, { squidMode: 'unlimited' });
  const sequence = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7];
  sequence.forEach((id, n) => { if (n) f.start(); f.win(id); });
  amounts(f, [60,20,20,20,20,20,20,20,-200]);
  assert.equal(f.room.mini.squid.lastResult.tokensAwarded, 10);
  assert.equal(f.room.mini.squid.lastResult.tokensExhausted, false);
  assert.equal(f.room.mini.squid.lastResult.tokenBudget, 12);
  assert.equal(f.room.mini.squid.lastResult.loserId, f.id(8));
  assert.ok(settlements(f).every(r => r.tokensAwarded === 10 && r.squidMode === 'unlimited'));
});

test('nine-player unlimited oracle: marked departure and seven absent losers settle actual four issued fish, once', t => {
  const f = fixture(t, { squidMode: 'unlimited' }); f.win(0); playWin(f, 0); playWin(f, 0); playWin(f, 1);
  f.cmd(0, 'stand'); const cash = f.member(0).cashedOut;
  for (let i = 2; i < 9; i++) f.connect(i, false);
  assert.equal(f.room.mini.squid.absentSettlementAt, f.time + 5000);
  f.advance(5000); f.service.tick(f.room, f.time);
  amounts(f, [420,140,-80,-80,-80,-80,-80,-80,-80]);
  assert.equal(f.member(0).cashedOut, cash + 420, 'seven losers times three actual fish times 20');
  assert.equal(f.room.mini.squid.lastResult.tokensAwarded, 4); assert.equal(f.room.mini.squid.lastResult.tokensExhausted, false);
  assert.ok(settlements(f).every(r => r.reason === 'absent'));
  for (let i = 2; i < 9; i++) f.connect(i, true);
  f.service.tick(f.room, f.time); f.service.settleSquid(f.room, { reason: 'partial', timestamp: f.time });
  assert.equal(settlements(f).length, 9); conserved(f);
});

test('nine-player unlimited oracle: late reconnect cancels absence settlement and same-account return does not reserve twice', t => {
  const f = fixture(t, { squidMode: 'unlimited' }); f.win(0); playWin(f, 0); playWin(f, 1);
  for (let i = 2; i < 9; i++) f.connect(i, false);
  const reserve = structuredClone(f.room.mini.squid.reserves), id = f.room.mini.squid.roundSettlementId;
  f.advance(4999); f.connect(8, true); f.cmd(8, 'entryBlind', { mode: 'post' });
  assert.equal(f.room.mini.squid.absentSettlementAt, null);
  f.cmd(8, 'stand'); const cash = f.member(8).cashedOut;
  f.cmd(8, 'sit', { seat: 8, amountBB: 100, entryMode: 'post' });
  assert.equal(f.member(8).stack, 1000); assert.equal(f.member(8).cashedOut, cash);
  assert.deepEqual(f.room.mini.squid.reserves, reserve); assert.equal(f.room.mini.squid.roundSettlementId, id);
  assert.equal(f.room.mini.squid.absentSettlementAt, null); f.advance(2); f.service.tick(f.room, f.time);
  assert.equal(settlements(f).length, 0);
  f.cmd(0, 'autoDeal', { paused: true });
  f.cmd(0, 'close'); amounts(f, [280,140,-60,-60,-60,-60,-60,-60,-60]);
});

test('nine-player unlimited oracle: encrypted restart preserves frozen counts, budget, exact reserves and later weighted settlement', t => {
  const f = fixture(t, { squidMode: 'unlimited', squidExtraTokens: 0 }); f.win(0); playWin(f, 0); playWin(f, 1);
  const before = structuredClone(f.room.mini.squid), balance = f.users.slice(0,9).map((_,i) => f.member(i).stack);
  const dir = mkdtempSync(join(tmpdir(), 'bbpoker-nine-unlimited-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const disk = new EncryptedStore(dir); disk.data = f.data; disk.save();
  const restored = new EncryptedStore(dir); f.service = new RoomService(restored); f.data = restored.data; f.room = f.data.rooms[f.room.code];
  assert.deepEqual(f.room.mini.squid, before); assert.deepEqual(f.users.slice(0,9).map((_,i) => f.member(i).stack), balance);
  for (let i=0;i<9;i++) f.connect(i,true);
  for (let n=0;n<6;n++) playWin(f,0);
  amounts(f,[1120,140,-180,-180,-180,-180,-180,-180,-180]);
  assert.equal(f.room.mini.squid.lastResult.tokenBudget,9); assert.equal(f.room.mini.squid.lastResult.tokensAwarded,9);
  assert.deepEqual(f.room.mini.squid.lastResult.counts,Object.fromEntries([8,1,0,0,0,0,0,0,0].map((n,i)=>[f.id(i),n])));
});

test('nine-player legacy oracle: removing new round fields restores old single-fish meaning without changing held money', t => {
  const f = fixture(t); f.win(0);
  const q = f.room.mini.squid;
  for (const k of ['mode','extraTokens','counts','tokenBudget']) delete q[k];
  for (const k of ['squidMode','squidExtraTokens']) delete f.room.settings[k];
  for (const h of [f.room.hand,...f.data.hands]) {
    for (const k of ['squidMode','squidTokenBudget','squidCounts','squidAwardedId']) delete h[k];
    for (const mini of [h.miniBefore,h.miniAfter]) if (mini?.squid) for (const k of ['mode','extraTokens','counts','tokenBudget']) delete mini.squid[k];
  }
  const before=structuredClone(f.data), view=f.service.state(f.room,f.id(0));
  assert.deepEqual(f.data,before); assert.equal(view.mini.squid.mode,'normal'); assert.equal(view.mini.squid.tokenBudget,8);
  assert.equal(view.players.find(p=>p.id===f.id(0)).squidCount,1);
  assert.equal(f.service.handFor(f.id(0),f.room.code,f.room.hand.id).squidMode,'normal');
  playWin(f,0); assert.deepEqual(q.won,[f.id(0)]);
  for(let i=1;i<8;i++) playWin(f,i);
  amounts(f,[20,20,20,20,20,20,20,20,-160]);
});

test('nine-player unlimited oracle: royal-board nine-way bomb split awards no fish and no preflop opportunity', t => {
  const f=fixture(t,{squidMode:'unlimited',bombPot:true,bombIntervalMinutes:1,bombAnteBB:500});f.win(0);
  f.advance(60000);f.start();
  const h=controlledBomb(f,[['2s','2h'],['3s','3h'],['4s','4h'],['5s','5h'],['6s','6h'],['7s','7h'],['8s','8h'],['9s','9h'],['Ts','Th']],['Ac','Kc','Qc','Jc','Tc']);
  assert.equal(h.result.mainWinnerIds.length,9);assert.equal(h.squidAwardedId,null);
  assert.deepEqual(h.players.map(p=>p.stack-p.startingStack),Array(9).fill(0));
  assert.equal(f.room.mini.squid.counts[f.id(0)],1);assert.equal(Object.values(f.room.mini.squid.counts).reduce((a,b)=>a+b,0),1);
  assert.equal(settlements(f).length,0);f.cmd(0,'close');amounts(f,[160,-20,-20,-20,-20,-20,-20,-20,-20]);
});

test('unlimited configuration is explicit and validates extra fish boundaries without weakening normal or buy-in rules', () => {
  assert.equal(settingsFor().squidMode,'normal');assert.equal(settingsFor().squidExtraTokens,3);
  assert.equal(settingsFor({squidMode:'unlimited',squidExtraTokens:0}).squidExtraTokens,0);
  assert.equal(settingsFor({squidMode:'unlimited',squidExtraTokens:100}).squidExtraTokens,100);
  for (const squidExtraTokens of [-1,101,.5,'3',null,Infinity,NaN]) assert.throws(()=>settingsFor({squidExtraTokens}));
  for (const squidMode of ['infinite','normal-unlimited','',null,1]) assert.throws(()=>settingsFor({squidMode}));
});

test('nine-player unlimited oracle: all-offline observation does not settle, and expiry recovery stays fixed across absent-player changes', t => {
  const f = fixture(t, { squidMode: 'unlimited', durationMinutes: 30 });
  f.win(0); playWin(f,0); playWin(f,0);
  for(let i=0;i<9;i++) f.connect(i,false);
  const before=structuredClone(f.room.mini.squid);
  f.advance(5000);f.service.tick(f.room,f.time);
  assert.equal(settlements(f).length,0);assert.equal(f.room.mini.squid.active,true);
  assert.deepEqual(f.room.mini.squid.counts,before.counts);assert.deepEqual(f.room.mini.squid.reserves,before.reserves);
  f.advance(f.room.endsAt-f.time);f.connect(8,true);f.service.tick(f.room,f.time);
  const since=f.room.squidOvertimeWaitSince;assert.equal(since,f.time);
  f.advance(40000);f.connect(8,false);f.connect(7,true);assert.equal(f.room.squidOvertimeWaitSince,since);
  f.advance(49999);f.service.tick(f.room,f.time);assert.notEqual(f.room.status,'closed');
  f.advance(1);f.service.tick(f.room,f.time);assert.equal(f.room.status,'closed');
  amounts(f,[480,-60,-60,-60,-60,-60,-60,-60,-60]);
  assert.equal(f.room.mini.squid.lastResult.tokensAwarded,3);assert.equal(f.room.mini.squid.lastResult.tokensExhausted,false);
});

test('nine-player unlimited oracle: overtime keeps frozen N+X and only its original round despite an overdue bomb', t => {
  const f=fixture(t,{squidMode:'unlimited',squidExtraTokens:0,bombPot:true,bombIntervalMinutes:1,durationMinutes:30});f.win(0);
  const round=f.room.mini.squid.roundSettlementId;
  f.advance(f.room.endsAt-f.time);
  for(let n=0;n<8;n++) {
    f.start();assert.equal(f.room.hand.bombPot,n===0);assert.equal(f.room.hand.squidTokenBudget,9);assert.equal(f.room.mini.squid.roundSettlementId,round);f.win(0);
  }
  amounts(f,[1440,-180,-180,-180,-180,-180,-180,-180,-180]);
  assert.equal(f.room.status,'closed');assert.equal(f.room.mini.squid.round,1);assert.equal(f.data.hands.length,9);
});

test('nine-player unlimited oracle: maximum extra fish is a budget only; renewal no longer locks that potential loss', t => {
  const f=fixture(t,{squidMode:'unlimited',squidExtraTokens:100},Array(9).fill(250));
  assert.equal(f.room.mini.squid.tokenBudget,109);assert.deepEqual(Object.values(f.room.mini.squid.reserves),[]);
  for(let n=0;n<109;n++){if(n)f.start();f.win(0);}
  amounts(f,[17440,-2180,-2180,-2180,-2180,-2180,-2180,-2180,-2180]);
  const before=structuredClone(f.data.hands);f.start();
  assert.equal(f.room.mini.squid.round,2);assert.equal(f.room.hand.players.length,9);assert.deepEqual(f.room.mini.squid.reserves,{});
  assert.deepEqual(f.data.hands,before,'starting another round cannot change historical settlements');conserved(f);
});
