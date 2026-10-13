import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { EncryptedStore } from '../src/store.js';
import { aggregateAnalytics } from '../src/analytics.js';

function fixture(t, settings = {}) {
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const users = Array.from({ length: 5 }, (_, i) => ({ id: `pause-oracle-${i}`, name: `Synthetic pause ${i}`, avatar: 0 }));
  const f = { users, store: { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } },
    get time() { return time; }, advance(ms) { time += ms; } };
  f.service = new RoomService(f.store);
  f.room = f.service.create(users[0], { settings: { smallBlind: 1, bigBlind: 2, maxPlayers: 5, squid: true, squidUnitBB: 1, ...settings } });
  for (const user of users.slice(1)) f.service.join(user, f.room.code, f.room.invite);
  f.cmd = (i, type, extra = {}) => f.service.command(users[i], f.room.code, { type, commandId: randomUUID(), handId: f.room.hand?.id, actionSeq: f.room.hand?.log.length, ...extra });
  f.consent = i => ({ expectedSquidRound: f.room.mini.squid.round, expectedSquidCost: f.room.mini.squid.won.includes(users[i].id) ? 0 : 6 });
  f.connect = (i, online) => { f.service.connections.set(`${f.room.code}:${users[i].id}`, online ? 1 : 0); f.service.connectionChanged(f.room, time, { reconnected: online }); };
  f.win = winner => {
    for (let n = 0; f.room.hand.status === 'playing'; n++) {
      assert.ok(n < 50, 'synthetic fold-down must terminate');
      const index = users.findIndex(u => u.id === f.room.hand.actingId), a = availableActions(f.room.hand, f.room.hand.actingId);
      f.cmd(index, index === winner ? a.canCheck ? 'check' : 'call' : 'fold');
    }
    assert.deepEqual(f.room.hand.result.mainWinnerIds, [users[winner].id]);
    f.service.completeRabbit(f.room, time);
  };
  f.start = () => f.service.start(f.room, time, { automatic: true });
  for (let i = 0; i < 4; i++) { f.cmd(i, 'sit', { seat: i, amountBB: 100 }); f.connect(i, true); }
  f.start();
  return f;
}
const rows = f => f.store.data.ledger.filter(row => row.type === 'squidSettlement');
function conserved(f) {
  const r = f.room, members = Object.values(r.members);
  const pot = r.hand?.status === 'playing' ? r.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0;
  assert.equal(members.reduce((sum, m) => sum + m.stack + m.cashedOut, 0) + Object.values(r.mini.squid.reserves).reduce((sum, x) => sum + x, 0) + pot,
    members.reduce((sum, m) => sum + m.totalBuyIn, 0), 'stacks, reserves, cashouts and live pot conserve all bought-in points');
}
function roundSnapshot(f) {
  const q = f.room.mini.squid;
  return structuredClone({ active: q.active, round: q.round, roundSettlementId: q.roundSettlementId, participants: q.participants, won: q.won, reserves: q.reserves });
}

test('pause oracle: disconnecting during a squid hand does not retroactively remove its marker eligibility', t => {
  const f = fixture(t), round = f.room.mini.squid.round;
  // The big blind can win without acting after the other three players fold.
  f.connect(2, false); f.win(2);
  assert.equal(f.room.mini.squid.round, round);
  assert.deepEqual(f.room.mini.squid.won, [f.users[2].id]);
  assert.equal(rows(f).length, 0); conserved(f);
});

test('pause oracle: a pre-upgrade in-progress squid hand retains its original eligibility without the new explicit flag', t => {
  const f = fixture(t); delete f.room.hand.squidRound;
  f.connect(2, false); f.win(2);
  assert.deepEqual(f.room.mini.squid.won, [f.users[2].id]); assert.equal(rows(f).length, 0); conserved(f);
});

test('continuity oracle: newcomers wait outside the fixed round while original players continue and reconnect', t => {
  const f = fixture(t); f.win(0); f.connect(3, false);
  f.cmd(4, 'sit', { seat: 4, amountBB: 100 }); f.connect(4, true);
  const before = roundSnapshot(f), due = f.room.nextHandAt;
  assert.ok(Number.isFinite(due), 'remaining original players receive a squid next-hand countdown');
  f.advance(due - f.time); f.service.tick(f.room, f.time);
  assert.equal(f.room.hand.status, 'playing'); assert.equal(f.room.hand.settings.squid, true);
  assert.equal(f.room.hand.squidRound, before.round);
  assert.deepEqual(f.room.hand.players.map(p => p.id), [0, 1, 2].map(i => f.users[i].id));
  const hand = structuredClone(f.room.hand); f.connect(3, true);
  assert.deepEqual(f.room.hand, hand, 'reconnecting cannot join or change the current hand contract');
  f.win(1); assert.deepEqual(f.room.mini.squid.won, [f.users[0].id, f.users[1].id]);
  assert.deepEqual(f.room.mini.squid.reserves, before.reserves); assert.equal(rows(f).length, 0); conserved(f);
  assert.equal(aggregateAnalytics(f.store.data, f.users[4].id).miniNet, 0);
  assert.equal(aggregateAnalytics(f.store.data, f.users[4].id).hands, 0, 'waiting is not a played hand');
  f.cmd(3, 'entryBlind', { mode: 'post' });
  let returned = false;
  for (let i = 0; i < 6; i++) {
    f.start(); assert.equal(f.room.hand.squidRound, before.round);
    assert.ok(f.room.hand.players.every(p => before.participants.includes(p.id)));
    if (f.room.hand.players.some(p => p.id === f.users[3].id)) { returned = true; f.win(3); break; }
    f.win(0);
  }
  assert.equal(returned, true); assert.equal(f.room.mini.squid.active, false); conserved(f);
});

test('continuity oracle: an original outside the hand may stand immediately without injecting fish transfers into live stacks', t => {
  const f = fixture(t); f.win(0); f.connect(3, false); f.start();
  assert.equal(f.room.hand.settings.squid, true);
  f.connect(3, true); const before = roundSnapshot(f), hand = structuredClone(f.room.hand), commandId = randomUUID();
  f.cmd(3, 'stand', { ...f.consent(3), commandId });
  assert.equal(f.room.members[f.users[3].id].pendingDeparture, null);
  assert.equal(f.room.members[f.users[3].id].seat, null); assert.deepEqual(f.room.hand, hand);
  assert.deepEqual(roundSnapshot(f), before); assert.equal(rows(f).length, 0); conserved(f);
  f.cmd(3, 'stand', { ...f.consent(3), commandId }); f.win(1);
  assert.equal(f.room.members[f.users[3].id].seat, null); assert.equal(f.room.mini.squid.active, true);
  assert.equal(rows(f).length, 0); assert.equal(f.room.mini.squid.reserves[f.users[3].id], 6);
  assert.deepEqual(f.room.mini.squid.won, [f.users[0].id, f.users[1].id]); conserved(f);
  f.connect(2, false); f.advance(5000); f.service.tick(f.room, f.time);
  assert.equal(rows(f).length, 4); assert.ok(rows(f).every(r => r.reason === 'absent'));
  assert.deepEqual(Object.fromEntries(rows(f).map(r => [r.playerId, r.amount])), Object.fromEntries([4, 4, -4, -4].map((amount, i) => [f.users[i].id, amount])));
  const oldCount = rows(f).length; f.cmd(3, 'stand'); f.service.finish(f.room, f.time); assert.equal(rows(f).length, oldCount);
  for (const row of rows(f)) assert.equal(aggregateAnalytics(f.store.data, row.playerId).miniNet, row.amount);
  assert.equal(aggregateAnalytics(f.store.data, f.users[3].id).hands, 1, 'settlement outside a hand creates no phantom played hand'); conserved(f);
});

test('continuity oracle: committing every chip is not a new broke-player blocker and a squid hand still awards its winner a mark', t => {
  const f = fixture(t); f.win(0); f.connect(3, false); f.start();
  const actor = f.users.findIndex(u => u.id === f.room.hand.actingId);
  f.cmd(actor, 'allin'); assert.equal(f.room.members[f.users[actor].id].stack, 0);
  assert.equal(f.service.squidBlock(f.room), null);
  f.connect(3, true); assert.equal(f.service.squidBlock(f.room), null);
  assert.equal(f.room.hand.squidRound, 1); f.win(actor);
  assert.deepEqual(f.room.mini.squid.won.slice().sort(), [...new Set([f.users[0].id, f.users[actor].id])].sort());
  assert.equal(rows(f).length, 0); conserved(f);
});

test('continuity oracle: insufficient-player grace observes the running hand but permits partial settlement only after it ends', t => {
  const f = fixture(t, { actionSeconds: 90 }); f.win(0); f.start();
  for (const i of [0, 2, 3]) f.connect(i, false);
  const before = roundSnapshot(f), since = f.room.mini.squid.blockerSince;
  f.advance(89000);
  assert.equal(f.room.mini.squid.blockerSince, since);
  assert.equal(f.service.canSettleSquid(f.room, f.users[1].id, f.time), false);
  assert.throws(() => f.cmd(1, 'settleSquid'));
  assert.equal(rows(f).length, 0); assert.deepEqual(roundSnapshot(f), before); conserved(f);
  f.win(0); f.advance(1000); assert.equal(f.service.canSettleSquid(f.room, f.users[1].id, f.time), true);
  f.cmd(1, 'settleSquid'); assert.equal(rows(f).length, 4);
  assert.deepEqual(Object.fromEntries(rows(f).map(r => [r.playerId, r.amount])), Object.fromEntries([6, -2, -2, -2].map((amount, i) => [f.users[i].id, amount])));
  assert.ok(rows(f).every(r => r.reason === 'partial')); conserved(f);
});

test('continuity oracle: queued sit-out is cancellable; confirmed sit-out preserves liability and later settles exactly once', t => {
  const f = fixture(t); f.win(0); f.connect(3, false); f.start(); f.connect(3, true);
  assert.ok(!f.room.hand.players.some(p => p.id === f.users[3].id));
  f.cmd(2, 'sitout', { value: true, ...f.consent(2) });
  assert.equal(f.room.members[f.users[2].id].pendingDeparture, 'sitout');
  assert.equal(f.room.members[f.users[2].id].sittingOut, false); assert.equal(rows(f).length, 0);
  f.cmd(2, 'sitout', { value: false }); assert.equal(f.room.members[f.users[2].id].pendingDeparture, null);
  f.cmd(2, 'sitout', { value: true, ...f.consent(2) }); f.win(1);
  assert.equal(f.room.members[f.users[2].id].sittingOut, true); assert.equal(f.room.members[f.users[2].id].seat, 2);
  assert.equal(rows(f).length, 0); assert.equal(f.room.mini.squid.reserves[f.users[2].id], 6); conserved(f);
  f.cmd(3, 'sitout', { value: true, ...f.consent(3) }); f.advance(5000); f.service.tick(f.room, f.time);
  assert.equal(rows(f).length, 4); assert.equal(rows(f).find(r => r.playerId === f.users[3].id).amount, -4); conserved(f);
});

test('continuity oracle: marked departure preserves reserves and later partial earnings without another buy-in', t => {
  const f = fixture(t); f.win(0); f.connect(3, false); f.start();
  f.cmd(0, 'stand', f.consent(0)); f.win(1);
  const returned = f.room.members[f.users[0].id].cashedOut;
  assert.equal(f.room.mini.squid.reserves[f.users[0].id], 6); assert.equal(rows(f).length, 0); conserved(f);
  f.cmd(0, 'close');
  assert.equal(f.room.members[f.users[0].id].cashedOut, returned + 10);
  assert.equal(aggregateAnalytics(f.store.data, f.users[0].id).miniNet, 4);
  assert.equal(rows(f).length, 4); conserved(f);
});

test('continuity oracle: encrypted restart preserves hand and roster; reconnect changes only future participation', t => {
  const f = fixture(t); f.win(0); f.connect(3, false); f.start();
  const before = roundSnapshot(f), hand = structuredClone(f.room.hand);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-squid-pause-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const disk = new EncryptedStore(directory); disk.data = f.store.data; disk.save();
  f.store = new EncryptedStore(directory); f.service = new RoomService(f.store); f.room = f.store.data.rooms[f.room.code];
  assert.deepEqual(roundSnapshot(f), before); assert.deepEqual(f.room.hand, hand);
  for (let i = 0; i < 4; i++) f.connect(i, true);
  assert.deepEqual(f.room.hand, hand); assert.equal(f.room.hand.settings.squid, true); f.win(1);
  assert.deepEqual(f.room.mini.squid.reserves, before.reserves); assert.equal(rows(f).length, 0); conserved(f);
  f.start(); assert.equal(f.room.hand.settings.squid, true);
  assert.equal(f.room.mini.squid.roundSettlementId, before.roundSettlementId);
  assert.deepEqual(f.room.mini.squid.reserves, before.reserves); f.win(1);
  assert.deepEqual(f.room.mini.squid.won, [f.users[0].id, f.users[1].id]); conserved(f);
});

test('pause oracle: expiry completes a playable original squid round without starting another round or bomb pot', t => {
  const f = fixture(t, { bombPot: true, bombIntervalMinutes: 1 }); f.win(0);
  const before = roundSnapshot(f); f.room.nextBombAt = f.time; f.room.endsAt = f.time + 1; f.advance(1);
  f.start(); assert.equal(f.room.hand.squidRound, before.round); assert.equal(f.room.hand.bombPot, false);
  f.win(1); assert.equal(f.room.mini.squid.active, true); assert.notEqual(f.room.status, 'closed'); conserved(f);
  f.start(); assert.equal(f.room.hand.squidRound, before.round); assert.equal(f.room.hand.bombPot, false);
  f.win(2); assert.equal(f.room.status, 'closed'); assert.equal(f.room.handNumber, 3);
  assert.equal(f.room.mini.squid.round, before.round); assert.equal(rows(f).length, 4);
  assert.ok(rows(f).every(row => row.reason === 'normal')); conserved(f);
});

test('pause oracle: expiry without an active squid round finishes only the current ordinary hand', t => {
  const f = fixture(t, { squid: false }); f.room.endsAt = f.time + 1; f.advance(1);
  assert.equal(f.room.hand.status, 'playing'); f.win(1);
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.handNumber, 1); assert.equal(rows(f).length, 0); conserved(f);
});

test('continuity oracle: expiry with too few original players uses one fixed recovery window across still-insufficient roster changes', t => {
  const f = fixture(t); f.win(0); f.start();
  for (const i of [0, 2, 3]) f.connect(i, false);
  f.room.endsAt = f.time + 1; f.advance(1); f.win(0);
  const since = f.room.squidOvertimeWaitSince;
  assert.equal(since, f.time); assert.equal(f.room.nextHandAt, null); assert.equal(f.room.handNumber, 2);
  assert.throws(() => f.start());
  f.advance(20000); f.connect(1, false); f.connect(2, true);
  assert.equal(f.room.squidOvertimeWaitSince, since, 'replacing the sole available player cannot extend the window');
  f.advance(20000); f.connect(2, false); f.connect(3, true);
  assert.equal(f.room.squidOvertimeWaitSince, since);
  f.advance(49999); f.service.tick(f.room, f.time); assert.notEqual(f.room.status, 'closed');
  f.advance(1); f.service.tick(f.room, f.time);
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.handNumber, 2);
  assert.deepEqual(Object.fromEntries(rows(f).map(r => [r.playerId, r.amount])), Object.fromEntries([6, -2, -2, -2].map((amount, i) => [f.users[i].id, amount])));
  assert.ok(rows(f).every(row => row.reason === 'partial')); conserved(f);
});

test('continuity oracle: an actual overtime hand clears the recovery window and later insufficient players start a new window', t => {
  const f = fixture(t); f.win(0); f.start();
  for (const i of [0, 2, 3]) f.connect(i, false);
  f.room.endsAt = f.time + 1; f.advance(1); f.win(0); const firstSince = f.room.squidOvertimeWaitSince;
  f.advance(40000); f.connect(2, true); f.start();
  assert.equal(f.room.hand.squidRound, 1); assert.equal(f.room.squidOvertimeWaitSince, null);
  f.connect(1, false); f.win(1);
  assert.ok(f.room.squidOvertimeWaitSince > firstSince); assert.equal(f.room.squidOvertimeWaitSince, f.time);
  assert.deepEqual(f.room.mini.squid.won, [f.users[0].id, f.users[1].id]); assert.equal(rows(f).length, 0); conserved(f);
});

test('continuity oracle: restart grants fresh observed overtime without changing held reserves or historical net', t => {
  const f = fixture(t); f.win(0); f.start();
  for (const i of [0, 2, 3]) f.connect(i, false);
  f.room.endsAt = f.time + 1; f.advance(1); f.win(0); const before = roundSnapshot(f), oldSince = f.room.squidOvertimeWaitSince;
  f.advance(50000); f.store = { data: structuredClone(f.store.data) }; f.service = new RoomService(f.store); f.room = f.store.data.rooms[f.room.code];
  f.connect(1, true);
  assert.equal(f.room.squidOvertimeWaitSince, f.time); assert.ok(f.room.squidOvertimeWaitSince > oldSince);
  assert.deepEqual(roundSnapshot(f), before); assert.equal(rows(f).length, 0);
  f.advance(89999); f.service.tick(f.room, f.time); assert.notEqual(f.room.status, 'closed');
  f.advance(1); f.service.tick(f.room, f.time); assert.equal(f.room.status, 'closed'); assert.equal(rows(f).length, 4); conserved(f);
});
