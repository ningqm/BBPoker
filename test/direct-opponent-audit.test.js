import test from 'node:test';
import { readyRoomAction } from './helpers/room-clock.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHand, availableActions, applyAction } from '../src/poker.js';
import { RoomService } from '../src/room.js';
import { directHandTransfers, directSquidTransfers, directOpponentRecords } from '../src/opponent-transfers.js';
import { directRecordLibrary } from '../src/direct-records.js';

// Independent audit: all expected pots and pair amounts below are hand-derived.
// Fixed decks belong exclusively to isolated engine tests, never live games.
const cards = [...'cdhs'].flatMap(suit => [...'23456789TJQKA'].map(rank => rank + suit));
function fixedDeck(holes, board) {
  const reserved = [...holes.flat(), ...board];
  assert.equal(new Set(reserved).size, reserved.length);
  const spare = cards.filter(card => !reserved.includes(card));
  const order = holes.map((_, i) => i).slice(1).concat(0);
  const prefix = [...order.map(i => holes[i][0]), ...order.map(i => holes[i][1]),
    spare.shift(), ...board.slice(0, 3), spare.shift(), board[3], spare.shift(), board[4]];
  return [...prefix, ...spare];
}
function engine(stacks, holes, board, extra = {}) {
  return createHand({ id: randomUUID(), buttonSeat: 0, smallBlind: 5, bigBlind: 10,
    players: stacks.map((stack, seat) => ({ id: String.fromCharCode(65 + seat), seat, stack })),
    deck: fixedDeck(holes, board), ...extra });
}
const act = (hand, type, amount) => applyAction(hand, hand.actingId, type, amount);
function checkDown(hand) {
  for (let i = 0; hand.status === 'playing'; i++) {
    assert.ok(i < 80); act(hand, availableActions(hand, hand.actingId).canCheck ? 'check' : 'call');
  }
  return hand;
}
function allIn(hand) {
  for (let i = 0; hand.status === 'playing'; i++) {
    assert.ok(i < 30);
    const a = availableActions(hand, hand.actingId);
    act(hand, a.canAllIn ? 'allin' : a.canCheck ? 'check' : 'call');
  }
  return hand;
}
function amounts(result) {
  assert.equal(result.covered, true, result.reason);
  return Object.fromEntries(result.transfers.map(t => [`${t.fromId}>${t.toId}`, t.amount]));
}
function exactAmounts(result) {
  assert.equal(result.covered, true, result.reason);
  return Object.fromEntries(result.transfers.map(t => [`${t.fromId}>${t.toId}`, `${t.exact.numerator}/${t.exact.denominator}`]));
}
const akTie = [['Ah', 'Kd'], ['As', 'Kc'], ['2h', '3h'], ['2c', '3c']];
const straightBoard = ['Qd', 'Jc', 'Ts', '4s', '5d'];

test('independent audit: an uncalled raise is refunded, not attributed to a losing opponent', t => {
  const hand = engine([100, 100], [['Ah', 'Kd'], ['2h', '3h']], straightBoard);
  act(hand, 'raise', 50); act(hand, 'fold');
  assert.deepEqual(hand.players.map(p => p.contributed), [10, 10]);
  assert.deepEqual(hand.result.payouts, { A: 20, B: 0 });
  assert.equal(hand.log.find(e => e.type === 'refund').amount, 40);
  assert.deepEqual(amounts(directHandTransfers(hand)), { 'B>A': 10 });
});

test('independent audit: main and side pots retain separate opponents even when one player nets zero overall', t => {
  const hand = allIn(engine([50, 100, 200], [['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ['2c', '3d', '7s', '8c', '9h']));
  assert.deepEqual(hand.players.map(p => p.contributed), [50, 100, 100]);
  assert.deepEqual(hand.result.pots, [
    { amount: 150, eligibleIds: ['A', 'B', 'C'], winnerIds: ['A'] },
    { amount: 100, eligibleIds: ['B', 'C'], winnerIds: ['B'] }
  ]);
  assert.deepEqual(hand.result.payouts, { A: 150, B: 100, C: 0 });
  assert.deepEqual(amounts(directHandTransfers(hand)), { 'B>A': 50, 'C>A': 50, 'C>B': 50 });
});

test('independent audit: equal split winners do not invent transfers between each other', t => {
  const hand = allIn(engine([100, 100, 100, 100], akTie, straightBoard));
  assert.deepEqual(hand.result.payouts, { A: 200, B: 200, C: 0, D: 0 });
  const result = directHandTransfers(hand);
  assert.equal(result.allocated, true);
  assert.deepEqual(amounts(result), { 'C>A': 50, 'C>B': 50, 'D>A': 50, 'D>B': 50 });
});

test('independent audit: odd chip follows the actual clockwise winner and remains with the sole loser', t => {
  const hand = engine([100, 100, 100], [['2h', '3h'], ['2c', '3c'], ['4h', '5h']], ['As', 'Ks', 'Qs', 'Js', 'Ts'], { ante: 1 });
  act(hand, 'call'); act(hand, 'call'); assert.equal(hand.actingId, 'C'); act(hand, 'fold'); checkDown(hand);
  assert.deepEqual(hand.players.map(p => p.contributed), [11, 11, 11]);
  assert.deepEqual(hand.result.pots[0].winnerIds, ['B', 'A']);
  assert.deepEqual(hand.result.payouts, { A: 16, B: 17, C: 0 });
  assert.deepEqual(amounts(directHandTransfers(hand)), { 'C>A': 5, 'C>B': 6 });
});

test('independent audit: dead blind enters the main pot; fractional allocation remains exact', t => {
  const hand = checkDown(engine([100, 100, 100, 100], akTie, straightBoard,
    { entryPosts: [{ playerId: 'D', live: 10, dead: 5 }] }));
  assert.deepEqual(hand.players.map(p => p.contributed), [10, 10, 10, 15]);
  assert.deepEqual(hand.players.map(p => p.deadContribution), [0, 0, 0, 5]);
  assert.equal(hand.result.pots.length, 1); assert.equal(hand.result.pots[0].amount, 45);
  assert.deepEqual(hand.result.payouts, { A: 22, B: 23, C: 0, D: 0 });
  // Net gains A=12/B=13; C loses 10, D loses 15. Allocate in ratio 12:13.
  assert.deepEqual(exactAmounts(directHandTransfers(hand)), {
    'C>A': '24/5', 'C>B': '26/5', 'D>A': '36/5', 'D>B': '39/5'
  });
  const legacy = structuredClone(hand); legacy.players.forEach(p => delete p.deadContribution);
  assert.deepEqual(exactAmounts(directHandTransfers(legacy)), exactAmounts(directHandTransfers(hand)));
  delete legacy.log;
  assert.equal(directHandTransfers(legacy).covered, false, 'missing historical dead-blind evidence must not guess zero');
});

test('independent audit: a pure split with no net loser has no opponent transfers', t => {
  const hand = allIn(engine([100, 100], akTie.slice(0, 2), straightBoard));
  assert.deepEqual(hand.result.payouts, { A: 100, B: 100 });
  assert.deepEqual(amounts(directHandTransfers(hand)), {});
});

test('independent audit: a bomb pot has only antes and its tied gains can be smaller than one chip per opponent', t => {
  const hand = checkDown(engine([100, 100, 100, 100], akTie, straightBoard, { bombPot: true, ante: 1 }));
  assert.equal(hand.log.some(row => ['smallBlind', 'bigBlind', 'entryBlind'].includes(row.type)), false);
  assert.deepEqual(hand.players.map(p => p.contributed), [1, 1, 1, 1]);
  assert.deepEqual(hand.result.payouts, { A: 2, B: 2, C: 0, D: 0 });
  assert.deepEqual(exactAmounts(directHandTransfers(hand)), { 'C>A': '1/2', 'C>B': '1/2', 'D>A': '1/2', 'D>B': '1/2' });
});

test('independent audit: cards, deck and hidden hand names are unnecessary and never inspected', t => {
  const hand = allIn(engine([50, 100, 200], [['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ['2c', '3d', '7s', '8c', '9h']));
  const forbid = (object, key) => Object.defineProperty(object, key, { get() { throw new Error(`private field accessed: ${key}`); } });
  for (const key of ['deck', 'board', 'audit']) forbid(hand, key);
  forbid(hand.result, 'handNames'); for (const p of hand.players) forbid(p, 'cards');
  assert.deepEqual(amounts(directHandTransfers(hand)), { 'B>A': 50, 'C>A': 50, 'C>B': 50 });
});

test('independent audit: inconsistent archives are wholly uncovered and reads do not mutate evidence', t => {
  const hand = allIn(engine([50, 100, 200], [['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ['2c', '3d', '7s', '8c', '9h']));
  const before = structuredClone(hand); directHandTransfers(hand); assert.deepEqual(hand, before);
  const changes = [
    h => { delete h.players[0].contributed; }, h => { h.result.pots[0].amount++; },
    h => { h.result.pots[0].eligibleIds.push('A'); }, h => { h.result.pots[0].winnerIds = ['C', 'C']; },
    h => { h.result.payouts.A++; }, h => { h.players[0].stack++; },
    h => { h.players[2].contributed = 200; }, h => { h.result.pots[1].eligibleIds.push('A'); }
  ];
  for (const change of changes) {
    const corrupt = structuredClone(hand); change(corrupt);
    assert.equal(directHandTransfers(corrupt).covered, false);
    assert.deepEqual(directHandTransfers(corrupt).transfers, []);
  }
});

function squidFixture(t) {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const users = ['A', 'B', 'C', 'D'].map(id => ({ id, name: `Audit ${id}` }));
  const db = { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data: db });
  const room = service.create(users[0], { settings: { smallBlind: 1, bigBlind: 2, maxPlayers: 4, squid: true, squidUnitBB: 2 } });
  users.slice(1).forEach(u => service.join(u, room.code, room.invite));
  const cmd = (id, type, extra = {}) => service.command(db.users[id], room.code,
    { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
  users.forEach((u, seat) => { cmd(u.id, 'sit', { seat, amountBB: 100 }); service.connections.set(`${room.code}:${u.id}`, 1); });
  const start = () => service.start(room, Date.now(), { automatic: true });
  const win = id => {
    for (let step = 0; room.hand.status === 'playing'; step++) {
      assert.ok(step < 30); if (!readyRoomAction(service, room, value => { clock = value; })) break; const actor = room.hand.actingId, a = availableActions(room.hand, actor);
      cmd(actor, actor === id ? a.canCheck ? 'check' : 'call' : 'fold');
    }
    assert.deepEqual(room.hand.result.mainWinnerIds, [id]); service.completeRabbit(room);
  };
  start(); return { db, service, room, cmd, start, win };
}

test('independent audit: a departed fish holder receives a late natural settlement without a fictitious final hand', t => {
  const f = squidFixture(t); f.win('A'); f.cmd('A', 'stand');
  const cashBefore = f.room.members.A.cashedOut;
  f.start(); f.win('B'); f.start(); f.win('C');
  assert.deepEqual(f.db.hands.at(-1).players.map(p => p.id), ['B', 'C', 'D']);
  const rows = f.db.ledger.filter(row => row.type === 'squidSettlement');
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.playerId, r.amount])), { A: 4, B: 4, C: 4, D: -12 });
  assert.equal(f.room.members.A.cashedOut - cashBefore, 16, '12 reserved points returned plus 4 net profit');
  assert.deepEqual(amounts(directSquidTransfers(rows, f.db.hands.at(-1).miniAfter.squid)), { 'D>A': 4, 'D>B': 4, 'D>C': 4 });
  const report = directRecordLibrary(f.db, 'A').opponents;
  assert.equal(report.summary.hands, 1); assert.equal(report.summary.squid.net, 4);
  assert.equal(report.rows.find(row => row.id === 'D').squid.won, 4);
  assert.equal(report.rows.find(row => row.id === 'B').squid.net, 0, 'holders do not pay one another');
});

test('independent audit: closing between hands uses complete ledger counts for an absent holder', t => {
  const f = squidFixture(t); f.win('A'); f.cmd('A', 'stand'); f.service.close(f.room);
  assert.equal(f.db.hands[0].miniAfter.squid.active, true, 'archive predates the separate partial settlement');
  const rows = f.db.ledger.filter(row => row.type === 'squidSettlement');
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.playerId, r.amount])), { A: 12, B: -4, C: -4, D: -4 });
  const report = directRecordLibrary(f.db, 'A').opponents;
  assert.equal(report.summary.hands, 1); assert.equal(report.summary.squid.coveredEvents, 1);
  assert.equal(report.summary.squid.net, 12); assert.equal(report.summary.squid.netBB, 6);
  assert.deepEqual(Object.fromEntries(report.rows.map(row => [row.id, row.squid.net])), { B: 4, C: 4, D: 4 });
});

test('independent audit: unlimited squid attributes repeated fish and all absent losers using the frozen nine-player round', t => {
  const ids = [...'ABCDEFGHI'], counts = { A: 5, B: 4, C: 3, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0 };
  const evidence = { participants: ids, roundSettlementId: 'audit-round', mode: 'unlimited', counts,
    unit: 20, tokenBudget: 12, tokensAwarded: 12 };
  const totals = { A: 600, B: 480, C: 360, D: -240, E: -240, F: -240, G: -240, H: -240, I: -240 };
  const rows = ids.map(playerId => ({ type: 'squidSettlement', playerId, roomCode: 'audit', roundSettlementId: 'audit-round', amount: totals[playerId] }));
  const expected = Object.fromEntries([...'DEFGHI'].flatMap(id => [[`${id}>A`, 100], [`${id}>B`, 80], [`${id}>C`, 60]]));
  assert.deepEqual(amounts(directSquidTransfers(rows, evidence)), expected);
  assert.equal(directSquidTransfers(rows.slice(0, -1), evidence).covered, false);
  const bad = structuredClone(rows); bad[8].amount = -220;
  assert.equal(directSquidTransfers(bad, evidence).covered, false);
  const report = directOpponentRecords([], 'I', {}, new Map(), { squidGroups: [{ rows, evidence, bigBlind: 10 }] });
  assert.equal(report.summary.hands, 0); assert.equal(report.summary.holdem.net, 0);
  assert.equal(report.summary.squid.net, -240); assert.equal(report.summary.squid.netBB, -24);
  assert.deepEqual(Object.fromEntries(report.rows.filter(row => row.squid.lost).map(row => [row.id, row.squid.lost])), { A: 100, B: 80, C: 60 });
});

test('independent audit: a malformed first squid ledger row is unavailable without throwing', t => {
  for (const rows of [[null], [undefined], [false], [0], ['invalid']]) {
    const result = directSquidTransfers(rows, {});
    assert.equal(result.covered, false); assert.deepEqual(result.transfers, []);
  }
});

test('independent audit: duplicate archives and settlement rows cannot double debit an opponent', t => {
  const hand = allIn(engine([50, 100, 200], [['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ['2c', '3d', '7s', '8c', '9h']));
  hand.roomCode = 'audit'; hand.at = '2026-10-14T12:00:00.000Z';
  const report = directOpponentRecords([{ hand }, { hand: structuredClone(hand) }], 'C');
  assert.equal(report.summary.hands, 1); assert.equal(report.summary.holdem.lost, 100);
  assert.deepEqual(Object.fromEntries(report.rows.map(r => [r.id, r.holdem.lost])), { A: 50, B: 50 });
  const f = squidFixture(t); f.win('A'); f.service.close(f.room);
  const rows = f.db.ledger.filter(row => row.type === 'squidSettlement'), evidence = f.room.mini.squid;
  const original = amounts(directSquidTransfers(rows, evidence));
  assert.deepEqual(amounts(directSquidTransfers([...rows, structuredClone(rows[0])], evidence)), original);
});

test('independent audit: selected-opponent amounts differ from same-table total and unknown evidence stays explicit', t => {
  const hand = allIn(engine([50, 100, 200], [['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ['2c', '3d', '7s', '8c', '9h']));
  hand.roomCode = 'audit'; hand.at = '2026-10-14T12:00:00.000Z';
  const againstA = directOpponentRecords([{ hand }], 'B', { opponent: 'A' });
  const againstC = directOpponentRecords([{ hand }], 'B', { opponent: 'C' });
  assert.equal(againstA.summary.holdem.net, -50); assert.equal(againstA.summary.holdem.netBB, -5);
  assert.equal(againstC.summary.holdem.net, 50); assert.equal(againstC.summary.holdem.netBB, 5);
  const total = directOpponentRecords([{ hand }], 'B');
  assert.equal(total.summary.holdem.net, 0); assert.equal(total.summary.holdem.won, 50); assert.equal(total.summary.holdem.lost, 50);
  const incomplete = structuredClone(hand); incomplete.id = 'missing-evidence'; delete incomplete.players[0].contributed;
  const mixed = directOpponentRecords([{ hand }, { hand: incomplete }], 'B', { opponent: 'C' });
  assert.equal(mixed.summary.hands, 2); assert.equal(mixed.summary.coveredHands, 1); assert.equal(mixed.summary.unknownHands, 1);
  assert.equal(mixed.summary.holdem.net, null); assert.equal(mixed.summary.holdem.covered.net, 50);
});

test('independent audit: mixed blind levels are normalized per event rather than after summing chips', t => {
  const small = engine([100, 100], [['Ah', 'Kd'], ['2h', '3h']], straightBoard);
  act(small, 'raise', 50); act(small, 'fold');
  const large = engine([100, 100], [['Ah', 'Kd'], ['2h', '3h']], straightBoard, { smallBlind: 10, bigBlind: 20 });
  act(large, 'raise', 60); act(large, 'fold');
  for (const h of [small, large]) { h.roomCode = 'audit'; h.at = '2026-10-14T12:00:00.000Z'; }
  const report = directOpponentRecords([{ hand: small }, { hand: large }], 'A');
  assert.equal(report.summary.holdem.won, 30); assert.equal(report.summary.holdem.wonBB, 2);
  delete large.bigBlind;
  const unavailableBB = directOpponentRecords([{ hand: small }, { hand: large }], 'A');
  assert.equal(unavailableBB.summary.holdem.net, 30); assert.equal(unavailableBB.summary.holdem.netBB, null);
});
