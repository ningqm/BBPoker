import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RoomService, settingsFor } from '../src/room.js';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { exportPhh } from '../src/phh.js';
import { verifyProof } from '../src/fairness.js';

function fixture(settings = {}, count = 3) {
  const users = Array.from({ length: 4 }, (_, i) => ({ id: `friend-${i}`, name: `朋友${i}`, avatar: i }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store), room = service.create(users[0], { settings });
  for (const u of users.slice(1)) service.join(u, room.code, room.invite);
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) cmd(i, 'sit', { seat: i, amountBB: 100 });
  return { users, store, service, room, cmd };
}
function finish(f, type = 'fold') {
  for (let n = 0; f.room.hand.status === 'playing'; n++) {
    assert.ok(n < 100);
    const i = f.users.findIndex(u => u.id === f.room.hand.actingId);
    f.cmd(i, type === 'call' && availableActions(f.room.hand, f.room.hand.actingId).canCheck ? 'check' : type);
  }
}
function conserved(r) {
  const all = Object.values(r.members);
  const actual = all.reduce((sum, p) => sum + p.stack + p.cashedOut, 0)
    + Object.values(r.mini.squid.reserves).reduce((a, b) => a + b, 0) + r.mini.mushroom.pool
    + (r.hand?.status === 'playing' ? r.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0);
  assert.equal(actual, all.reduce((sum, p) => sum + p.totalBuyIn, 0));
}

test('BB configuration follows blind changes, requires valid bounded numbers, and disables new mushroom/approval', () => {
  const s = settingsFor({ smallBlind: 10, bigBlind: 20, minBuyInBB: 50, maxBuyInBB: null, squidUnitBB: 3, approvalRequired: true });
  assert.equal(s.minBuyIn, 1000); assert.equal(s.maxBuyIn, null); assert.equal(s.squidUnit, 60);
  assert.equal(s.actionSeconds, 15); assert.equal(s.durationMinutes, 60); assert.equal(s.approvalRequired, false);
  assert.equal(s.timeBankCards, 3); assert.equal(s.timeBankSeconds, 30);
  for (const input of [{ minBuyInBB: NaN }, { maxBuyInBB: Infinity }, { minBuyInBB: -1 }, { maxBuyInBB: 10 }, { squidUnitBB: .5 },
    { bombAnteBB: Infinity }, { bombEveryHands: 0 }, { timeBankCards: -1 }, { timeBankSeconds: 0 }, { durationMinutes: NaN }, { mushroom: true }]) assert.throws(() => settingsFor(input));
  assert.equal(settingsFor({ minBuyIn: 1000, maxBuyIn: 2000, squidUnit: 30 }).minBuyInBB, 100);
});

test('legacy fractional BB equivalents remain playable without changing stored point amounts', () => {
  const f = fixture({}, 2);
  f.room.rulesVersion = 1;
  f.room.settings = { maxPlayers: 9, smallBlind: 5, bigBlind: 10, minBuyIn: 105, maxBuyIn: 1001, actionSeconds: 30,
    approvalRequired: true, squid: false, squidUnit: 5, mushroom: false, mushroomUnit: 1 };
  f.cmd(1, 'buyin', { amount: 1 }); assert.equal(f.room.pending.length, 0);
  for (let n = 0; n < 2; n++) { f.service.start(f.room); finish(f); }
  assert.equal(f.room.settings.squidUnit, 5); assert.equal(f.room.settings.squidUnitBB, .5);
  assert.equal(f.room.settings.minBuyIn, 105); assert.equal(f.room.settings.maxBuyIn, 1001);
});

test('instant BB buy-in and unlimited maximum keep integer and lifetime accounting limits', () => {
  const f = fixture({ maxBuyInBB: null }, 0);
  f.cmd(1, 'sit', { seat: 1, amountBB: 100000000 });
  assert.equal(f.room.members[f.users[1].id].stack, 1000000000); assert.equal(f.room.pending.length, 0);
  assert.throws(() => f.cmd(1, 'buyin', { amountBB: 1 }), /累计带入/);
  f.cmd(1, 'stand');
  assert.throws(() => f.cmd(1, 'sit', { seat: 1, amountBB: 20 }), /累计带入/);
  for (const extra of [{ amount: 201 }, { amountBB: 20.5 }, { amountBB: Infinity }, { amountBB: -20 }, { amount: NaN }]) assert.throws(() => f.cmd(2, 'sit', { seat: 2, ...extra }));
  assert.equal(f.room.name, '朋友0必赢的局'); conserved(f.room);
});

test('valid instant seating replaces only the caller legacy pending request', () => {
  const f = fixture({}, 0), other = { id: 'old-other', playerId: f.users[2].id, seat: 2, amount: 1000 };
  f.room.pending = [{ id: 'old-mine', playerId: f.users[1].id, seat: 1, amount: 1000 }, other];
  assert.throws(() => f.cmd(1, 'sit', { seat: 2, amountBB: 100 }), /占用/);
  assert.throws(() => f.cmd(1, 'sit', { seat: 1, amountBB: -1 }));
  assert.equal(f.room.pending.length, 2);
  f.cmd(1, 'sit', { seat: 1, amountBB: 50 });
  assert.equal(f.room.members[f.users[1].id].stack, 500);
  assert.deepEqual(f.room.pending, [other]);
  assert.equal(f.store.data.ledger.filter(l => l.type === 'buyin').length, 1);
});

test('table clock starts on first hand and settings cannot reset it after play', () => {
  const f = fixture({ durationMinutes: 30 });
  assert.equal(f.room.startedAt, null); assert.equal(f.service.needsTick(f.room, Date.now() + 1e9), false);
  const start = Date.now(); f.service.start(f.room, start);
  assert.equal(f.room.startedAt, start); assert.equal(f.room.endsAt, start + 1800000);
  assert.equal(f.room.deadline, start + 15000); finish(f);
  assert.throws(() => f.cmd(0, 'settings', { settings: { durationMinutes: 60 } }), /配置已锁定/);
  f.service.start(f.room, start + 60000); assert.equal(f.room.startedAt, start); assert.equal(f.room.endsAt, start + 1800000);
});

test('time cards extend only a live actor turn and retry is idempotent without altering poker actions', t => {
  let timestamp = Date.now(); t.mock.method(Date, 'now', () => timestamp);
  const f = fixture(); f.cmd(0, 'start');
  const i = f.users.findIndex(u => u.id === f.room.hand.actingId), commandId = randomUUID(), h = f.room.hand;
  const log = structuredClone(h.log), deadline = f.room.deadline;
  f.cmd(i, 'timebank', { commandId });
  assert.equal(f.room.deadline, deadline + 30000); assert.equal(f.room.members[f.users[i].id].timeBank.remaining, 2);
  f.cmd(i, 'timebank', { commandId });
  assert.equal(f.room.deadline, deadline + 30000); assert.equal(h.timeBankUses.length, 1); assert.deepEqual(h.log, log);
  assert.throws(() => f.cmd((i + 1) % 3, 'timebank'), /当前行动/);
  assert.throws(() => f.cmd(i, 'timebank', { actionSeq: h.log.length - 1 }), /轮次已更新/);
  timestamp = f.room.deadline;
  assert.throws(() => f.cmd(i, 'timebank'), /超时/); assert.throws(() => f.cmd(i, 'call'), /超时/);
  assert.equal(f.service.tick(f.room, timestamp), true);
  assert.notEqual(h.actingId, f.users[i].id);
});

test('time card reset uses fixed room windows, replaces rather than accumulates, and cannot be farmed by reseating', t => {
  let timestamp = Date.now(); t.mock.method(Date, 'now', () => timestamp);
  const f = fixture({ durationMinutes: 120, timeBankCards: 5, timeBankSeconds: 45 }); f.cmd(0, 'start');
  const i = f.users.findIndex(u => u.id === f.room.hand.actingId);
  for (let n = 0; n < 5; n++) f.cmd(i, 'timebank');
  assert.throws(() => f.cmd(i, 'timebank'), /用完/); finish(f);
  f.cmd(i, 'stand'); f.cmd(i, 'sit', { seat: i, amountBB: 100 });
  assert.equal(f.room.members[f.users[i].id].timeBank.remaining, 0);
  assert.equal(f.service.needsTick(f.room, timestamp + 1799999), false);
  timestamp += 1800000; assert.equal(f.service.tick(f.room, timestamp), true);
  assert.equal(f.room.members[f.users[i].id].timeBank.remaining, 5);
  assert.equal(f.service.tick(f.room, timestamp), false);
  timestamp += 3600000; assert.equal(f.service.tick(f.room, timestamp), true);
  assert.equal(f.room.members[f.users[i].id].timeBank.remaining, 5);
});

test('last five minutes skip new squid and bomb rounds while an existing squid round may continue', t => {
  let timestamp = Date.now(); t.mock.method(Date, 'now', () => timestamp);
  const f = fixture({ squid: true, bombPot: true, bombEveryHands: 1 }); f.cmd(0, 'start');
  const round = f.room.mini.squid.round; assert.equal(f.room.hand.bombPot, true); finish(f);
  timestamp = f.room.endsAt - 300000; f.service.start(f.room);
  assert.equal(f.room.hand.bombPot, false); assert.equal(f.room.mini.squid.round, round);
  const winner = f.room.mini.squid.participants.find(id => !f.room.mini.squid.won.includes(id));
  while (f.room.hand.status === 'playing') {
    const actor = f.room.hand.actingId, a = availableActions(f.room.hand, actor);
    f.cmd(f.users.findIndex(u => u.id === actor), actor === winner ? a.canCheck ? 'check' : 'call' : 'fold');
  }
  // Distinct winners complete the current round, but the cutoff bars a new one.
  assert.equal(f.room.mini.squid.active, false);
  f.service.start(f.room); assert.equal(f.room.mini.squid.active, false); assert.equal(f.room.mini.squid.round, round);
});

test('expiry finishes current hand, returns unfinished reserves, closes once, and permits a final voluntary reveal', t => {
  let timestamp = Date.now(); t.mock.method(Date, 'now', () => timestamp);
  const f = fixture({ squid: true }); f.cmd(0, 'start');
  const initialHands = f.store.data.hands.length;
  timestamp = f.room.endsAt; f.room.deadline = timestamp + 15000;
  assert.equal(f.service.tick(f.room, timestamp), false); assert.equal(f.room.status, 'playing');
  finish(f);
  assert.equal(f.room.status, 'closed'); assert.equal(f.store.data.hands.length, initialHands + 1);
  assert.deepEqual(f.room.mini.squid.reserves, {}); conserved(f.room);
  const cashouts = f.store.data.ledger.filter(l => l.type === 'cashout').length;
  assert.equal(f.service.tick(f.room, timestamp + 1), false);
  assert.equal(f.store.data.ledger.filter(l => l.type === 'cashout').length, cashouts);
  f.cmd(0, 'show', { indices: [0] });
  assert.equal(f.service.handFor(f.users[3].id, f.room.code, f.room.hand.id).players[0].cards.filter(Boolean).length, 1);
  assert.throws(() => f.cmd(0, 'start'), /本场已结束/);
});

test('expiry between hands prevents a start even before the periodic tick', t => {
  let timestamp = Date.now(); t.mock.method(Date, 'now', () => timestamp);
  const f = fixture(); f.cmd(0, 'start'); finish(f); const number = f.room.handNumber;
  timestamp = f.room.endsAt; f.cmd(0, 'start');
  assert.equal(f.room.status, 'closed'); assert.equal(f.room.handNumber, number); conserved(f.room);
});

test('bomb pot starts at flop with only equal antes and every hidden hand stays private', () => {
  const f = fixture({ bombPot: true, bombEveryHands: 1, bombAnteBB: 2 }); f.cmd(0, 'start');
  const h = f.room.hand; assert.equal(h.street, 'flop'); assert.equal(h.ante, 20);
  assert.equal(h.smallBlindSeat, null); assert.equal(h.bigBlindSeat, null);
  assert.equal(h.log.filter(a => a.type === 'ante').length, 3);
  assert.ok(!h.log.some(a => ['smallBlind', 'bigBlind'].includes(a.type)));
  assert.ok(h.players.every(p => p.contributed === 20 && p.bet === 0));
  assert.equal(h.actingId, f.users[1].id);
  const observer = f.service.state(f.room, f.users[3].id);
  assert.ok(observer.players.every(p => p.cards.every(c => c === null))); assert.equal(observer.hand.proofs.length, 3);
  assert.ok(observer.hand.proofs.every(p => verifyProof(h.id, h.audit.root, p)));
  finish(f); const exported = f.service.exports(f.users[0].id, f.room.code)[0];
  assert.equal(exported.bombPot, true); assert.ok(exported.players.filter(p => p.id !== f.users[0].id).every(p => p.cards.every(c => c === null)));
  assert.ok(!Object.hasOwn(exported, 'deck')); conserved(f.room);
});

test('bomb frequency and preflop statistics count the intended opportunities only', () => {
  const f = fixture({ bombPot: true, bombEveryHands: 2 }); f.cmd(0, 'start');
  assert.equal(f.room.hand.bombPot, false); finish(f, 'call');
  const before = f.service.stats(f.users[0].id); assert.equal(before.vpip, 100); assert.equal(before.preflopHands, 1);
  f.service.start(f.room); assert.equal(f.room.hand.bombPot, true); finish(f);
  const after = f.service.stats(f.users[0].id); assert.equal(after.hands, 2); assert.equal(after.preflopHands, 1); assert.equal(after.vpip, 100);
});

const canonical = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
const fixed = prefix => [...prefix, ...canonical.filter(c => !prefix.includes(c))];
function bomb(stacks, ante = 20) {
  const hand = createHand({ id: randomUUID(), players: stacks.map((stack, seat) => ({ id: String(seat), name: String(seat), seat, stack })),
    buttonSeat: 0, smallBlind: 5, bigBlind: 10, bombPot: true, ante,
    deck: fixed('Ks As Qs Kh Ah Qh Jc 2c 3d 4h Tc 8s Td 9c'.split(' ')) });
  return hand;
}
function filtered(h) {
  return { id: h.id, at: new Date().toISOString(), roomCode: 'EXAMPLE', roomName: '炸弹池测试', bombPot: true,
    buttonSeat: h.buttonSeat, smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat, ante: h.ante,
    settings: { smallBlind: h.smallBlind, bigBlind: h.bigBlind }, board: h.board, log: h.log, result: h.result,
    players: h.players.map(p => ({ ...p, cards: p.folded ? [null, null] : p.cards, net: p.stack - p.startingStack, miniNet: 0, endingStack: p.stack })) };
}

test('short bomb antes and postflop all-ins settle unequal side pots and return uncalled excess', () => {
  const allIn = bomb([30, 20, 10], 50);
  assert.equal(allIn.status, 'complete');
  assert.deepEqual(allIn.result.pots.map(p => p.amount), [30, 20]);
  assert.deepEqual(allIn.result.payouts, { 0: 0, 1: 20, 2: 30 });
  assert.deepEqual(allIn.players.map(p => p.stack), [10, 20, 30]);
  const h = bomb([200, 100, 50]);
  while (h.status === 'playing') applyAction(h, h.actingId, availableActions(h, h.actingId).canAllIn ? 'allin' : 'call');
  assert.deepEqual(h.result.pots.map(p => p.amount), [150, 100]);
  assert.deepEqual(h.result.payouts, { 0: 0, 1: 100, 2: 150 });
  assert.deepEqual(h.players.map(p => p.stack), [100, 100, 150]);
});

test('bomb PHH distinguishes skipped preflop from player decisions and ignores time card metadata', () => {
  const h = bomb([200, 100, 50]);
  while (h.status === 'playing') applyAction(h, h.actingId, availableActions(h, h.actingId).canCheck ? 'check' : 'call');
  const item = filtered(h), source = exportPhh([item]);
  assert.match(source, /blinds_or_straddles = \[0, 0, 0\]/);
  assert.match(source, /_bbpoker_bomb_pot = true/); assert.match(source, /_bbpoker_synthetic_preflop_checks = 3/);
  assert.ok(h.log.every(a => !(a.street === 'preflop' && a.type === 'check')));
  item.timeBankUses = [{ playerId: '0', seconds: 30 }]; assert.equal(exportPhh([item]), source);
});

test('independent PokerKit replays ante-only bomb pots, short stacks, two-player and postflop folds', {
  skip: !process.env.POKERKIT_PYTHON && 'Set POKERKIT_PYTHON for the independent bomb-pot replay check.',
}, () => {
  const examples = [bomb([30, 20, 10], 50), bomb([200, 100, 50]), bomb([100, 100]), bomb([100, 100, 100]), bomb([10, 10], 20), bomb([100, 10, 10], 20)];
  for (let i = 1; i < examples.length; i++) {
    const h = examples[i];
    while (h.status === 'playing') applyAction(h, h.actingId, i === 3 ? 'fold' : availableActions(h, h.actingId).canAllIn ? 'allin' : 'call');
  }
  const source = exportPhh(examples.map(filtered));
  const script = `import sys,json\nfrom pokerkit import HandHistory\nhands=list(HandHistory.loads_all(sys.stdin.read()))\nfor h in hands:\n s=list(h)[-1]\n assert not s.status,(h.hand,'unfinished')\n assert s.stacks==h.finishing_stacks,(h.hand,s.stacks,h.finishing_stacks)\nprint(json.dumps({'replayed':len(hands)}))\n`;
  const result = spawnSync(process.env.POKERKIT_PYTHON, ['-c', script], { input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { replayed: examples.length });
});
