import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '../src/room.js';
import { EncryptedStore } from '../src/store.js';
import { availableActions, createHand, applyAction } from '../src/poker.js';
import { directHandTransfers } from '../src/opponent-transfers.js';
import { revokeAccountSessions } from '../src/account-admin.js';
import { roomResults } from '../public/room-results.js';
import { exportPhh } from '../src/phh.js';
import { replayIndependently } from './helpers/pokerkit-oracle.mjs';
import { readyRoomAction } from './helpers/room-clock.js';

// Cross-feature acceptance: hand settlement, host departure, fish liability,
// supplemental labels, account identity and encrypted persistence in one game.
for (const mode of ['normal', 'unlimited']) for (const leaveDuringHand of [false, true]) {
  test(`release cross audit: ${mode}, host leaves ${leaveDuringHand ? 'during' : 'between'} hands`, t => {
    let clock = 1800000000000;
    t.mock.method(Date, 'now', () => clock);
    const dir = mkdtempSync(join(tmpdir(), 'release-settlement-cross-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let store = new EncryptedStore(dir), service = new RoomService(store);
    const users = ['A', 'B', 'C'].map(id => ({ id, name: id, credentialVersion: 0 }));
    store.data.users = Object.fromEntries(users.map(u => [u.id, u]));
    const code = service.create(users[0], { settings: { squid: true, squidMode: mode, squidUnitBB: 200, durationMinutes: 30 } }).code;
    const room = () => store.data.rooms[code];
    const cmd = (id, type, extra = {}) => service.command(store.data.users[id], code, { type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra });
    const restart = () => {
      store.save(); const before = structuredClone(store.data);
      store = new EncryptedStore(dir); assert.deepEqual(store.data, before);
      service = new RoomService(store);
      for (const id of ['A', 'B', 'C']) service.connections.set(`${code}:${id}`, 1);
    };
    const financial = () => structuredClone({ members: room().members, ledger: store.data.ledger, hands: store.data.hands.map(h => ({ ...h, rabbit: null })), hand: room().hand ? { ...room().hand, rabbit: null } : null });
    const reconcile = () => {
      const r = room(), committed = r.hand?.status === 'playing' ? r.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0;
      const members = Object.values(r.members);
      assert.ok(members.every(m => Number.isSafeInteger(m.stack) && m.stack >= 0 && Number.isSafeInteger(m.squidDebt ?? 0) && (m.squidDebt ?? 0) >= 0));
      assert.equal(members.reduce((sum, m) => sum + m.stack + m.cashedOut - (m.squidDebt ?? 0) - m.totalBuyIn, 0) + committed, 0);
      if (r.hand?.status === 'playing') return;
      for (const id of ['A', 'B', 'C']) {
        const p = service.state(r, id).players.find(p => p.id === id);
        const session = service.sessionFor(id, code).session;
        const opponents = service.opponents(id, { room: code }).opponents, direct = opponents.summary;
        assert.equal(session.meNet, p.sessionProfit, `${id}: session vs financial balance`);
        assert.equal(service.stats(id).net, p.sessionProfit, `${id}: stats vs financial balance`);
        assert.equal(direct.unknownHands, 0);
        assert.ok(Number.isFinite(direct.total.net));
        assert.ok(opponents.rows.every(row => Number.isFinite(row.total.net)));
        assert.ok(Math.abs(direct.total.net - p.sessionProfit) < 1e-8, `${id}: direct opponents vs financial balance`);
        assert.ok(Math.abs(opponents.rows.reduce((sum, row) => sum + row.total.net, 0) - p.sessionProfit) < 1e-8);
      }
    };
    const win = id => {
      for (let n = 0; room().hand.status === 'playing'; n++) {
        assert.ok(n < 100);
        if (!readyRoomAction(service, room(), value => { clock = value; })) break;
        const actor = room().hand.actingId, actions = availableActions(room().hand, actor);
        cmd(actor, actor === id ? actions.canCheck ? 'check' : 'call' : 'fold');
      }
      const before = financial();
      const phh = exportPhh([service.handFor('A', code, room().hand.id)]);
      service.completeRabbit(room(), clock);
      for (const viewer of ['A', 'B', 'C']) {
        const view = service.state(room(), viewer);
        const mine = view.players.find(p => p.id === viewer);
        if (mine.inHand) assert.ok(mine.displayHandCategory);
        else assert.equal(mine.displayHandCategory, null);
      }
      assert.deepEqual(financial(), before, 'supplemental category projection must not alter settlement');
      assert.equal(exportPhh([service.handFor('A', code, room().hand.id)]), phh);
      reconcile();
    };
    for (const [seat, user] of users.entries()) {
      if (seat) service.join(user, code, room().invite);
      cmd(user.id, 'sit', { seat, amountBB: 100 });
      service.connections.set(`${code}:${user.id}`, 1);
    }
    cmd('A', 'start');
    let leave;
    const depart = () => {
      const view = service.state(room(), 'A').players.find(p => p.id === 'A');
      leave = { commandId: randomUUID(), expectedSquidRound: room().mini.squid.round, expectedSquidCost: view.squidMaxLoss };
      cmd('A', 'leave', leave);
      assert.notEqual(room().hostId, 'A');
      assert.equal(room().members.A.leftRoom, true);
    };
    if (leaveDuringHand) {
      cmd('A', 'buyin', { amountBB: 500 });
      depart(); restart();
      assert.equal(room().members.A.pendingDeparture, 'leave');
    }
    win('B');
    if (!leaveDuringHand) depart();
    const cashout = room().members.A.cashedOut;
    assert.ok(cashout > 0); assert.equal(room().members.A.totalBuyIn, 1000);
    restart(); const once = financial(); cmd('A', 'leave', leave); assert.deepEqual(financial(), once);
    service.start(room(), clock); win('C');
    assert.equal(room().mini.squid.active, false);
    assert.deepEqual(room().mini.squid.lastResult.changes, { A: -4000, B: 2000, C: 2000 });
    assert.equal(room().members.A.cashedOut, cashout); assert.equal(room().members.A.squidDebt, 4000);
    const ledger = structuredClone(store.data.ledger), archives = structuredClone(store.data.hands);
    restart(); reconcile();
    const balance = financial();
    store.data.users['legacy-token-A'] = store.data.users.A;
    store.data.sessions = { a: { userId: 'A' }, b: { userId: 'B' } };
    revokeAccountSessions(store.data, store.data.users.A);
    assert.equal(store.data.users['legacy-token-A'], undefined);
    assert.equal(store.data.sessions.a, undefined); assert.ok(store.data.sessions.b);
    assert.deepEqual(financial(), balance, 'credential revocation must not change monetary identity');
    restart(); reconcile();
    const sitId = randomUUID();
    cmd('A', 'sit', { seat: 0, amountBB: 500, entryMode: 'post', commandId: sitId });
    assert.equal(room().members.A.squidDebt, 0); assert.equal(room().members.A.stack, 1000);
    restart(); cmd('A', 'sit', { seat: 0, amountBB: 500, entryMode: 'post', commandId: sitId });
    assert.equal(room().members.A.totalBuyIn, 6000); assert.equal(room().members.A.stack, 1000);
    assert.deepEqual(store.data.hands, archives);
    assert.deepEqual(store.data.ledger.filter(row => row.type === 'squidSettlement'), ledger.filter(row => row.type === 'squidSettlement'));
    reconcile(); cmd(room().hostId, 'close'); restart(); reconcile();
    const results = roomResults(service.state(room(), 'A'));
    assert.equal(results.players.length, 3); assert.equal(results.players.reduce((sum, p) => sum + p.net, 0), 0);
    for (const p of results.players) assert.equal(p.net, p.cashOut - p.buyIn - p.debt);
    if (process.env.POKERKIT_PYTHON) {
      const exported = store.data.hands.map(h => service.handFor('A', code, h.id));
      replayIndependently(exportPhh(exported), 2);
    }
  });
}


test('release cross audit: 132 independently replayed small-stack games cover every button with posts, dead blinds and bomb pots', {
  skip: !process.env.POKERKIT_PYTHON,
}, t => {
  const pack = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
  let seed = 184791;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const views = [];
  let oddPots = 0, sidePots = 0, refunded = 0, folds = 0;
  for (let count = 2; count <= 9; count++) for (let button = 0; button < count; button++) for (const mode of ['ordinary', 'posted', 'bomb']) {
    const deck = [...pack];
    for (let i = 51; i > 0; i--) { const j = random(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    // Alternating forced board ties and random showdowns catches winner-order
    // and pot-boundary errors independently of a particular button position.
    if (button % 2 === 0) [2*count+1, 2*count+2, 2*count+3, 2*count+5, 2*count+7].forEach((position, i) => {
      const other = deck.indexOf(['As', 'Ks', 'Qs', 'Js', 'Ts'][i]);
      [deck[position], deck[other]] = [deck[other], deck[position]];
    });
    const players = Array.from({ length: count }, (_, seat) => ({ id: String(seat), name: String(seat), seat: seat*2, stack: 17 + random(143) }));
    const h = createHand({ id: `rotation-${count}-${button}-${mode}`, players, buttonSeat: button*2, smallBlind: 5, bigBlind: 10,
      deck, ante: mode === 'bomb' ? 7 : 0, bombPot: mode === 'bomb',
      entryPosts: mode === 'posted' ? players.filter((_, i) => i % 3 === 0).map(p => ({ playerId: p.id, live: 10, dead: 5 })) : [] });
    for (let n = 0; h.status === 'playing'; n++) {
      assert.ok(n < 100);
      const actor = h.actingId, actions = availableActions(h, actor);
      const fold = count >= 4 && actor === String((button + 1) % count) && h.players.filter(p => !p.folded).length > 2;
      applyAction(h, actor, fold ? 'fold' : actions.canAllIn ? 'allin' : actions.canCheck ? 'check' : 'call');
      folds += Number(fold);
    }
    assert.equal(h.players.reduce((sum, p) => sum + p.stack - p.startingStack, 0), 0);
    const direct = directHandTransfers(h); assert.equal(direct.covered, true, `${h.id}: ${direct.reason}`);
    for (const p of h.players) {
      const net = direct.transfers.reduce((sum, row) => sum + (row.toId === p.id ? row.amount : 0) - (row.fromId === p.id ? row.amount : 0), 0);
      assert.ok(Math.abs(net - (p.stack - p.startingStack)) < 1e-8, h.id);
    }
    sidePots += Number(h.result.pots.length > 1); oddPots += h.result.pots.filter(p => p.amount % p.winnerIds.length).length;
    refunded += Number(h.log.some(row => row.type === 'refund'));
    views.push({ id: h.id, number: views.length+1, at: '2026-10-17T00:00:00.000Z', roomCode: 'synthetic-rotation', roomName: 'independent rotation audit',
      buttonSeat: h.buttonSeat, smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat, ante: h.ante, bombPot: h.bombPot,
      settings: { smallBlind: 5, bigBlind: 10 }, board: h.board, log: h.log, result: h.result,
      players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, startingStack: p.startingStack,
        endingStack: p.stack, net: p.stack - p.startingStack, miniNet: 0, cards: p.folded ? [null,null] : p.cards, folded: p.folded })) });
  }
  const summary = replayIndependently(exportPhh(views), 132);
  assert.ok(oddPots > 10 && sidePots > 50 && refunded > 20 && folds > 30);
  t.diagnostic(JSON.stringify({ ...summary, oddPots, sidePots, refunded, folds }));
});
