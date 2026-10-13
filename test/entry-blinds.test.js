import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { planEntry, commitEntry, markEntrySeat, setEntryMode, needsEntry, projectEntry } from '../src/entry-blinds.js';
import { replaySnapshot } from '../public/replay.js';
import { handTendencies } from '../src/analytics.js';
import { exportPhh } from '../src/phh.js';
import { spawnSync } from 'node:child_process';

const deck = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
const member = (seat, played = true) => ({ id: `p${seat}`, seat, stack: 1000, totalBuyIn: played ? 1000 : 0,
  blindEntry: { played, mode: 'wait', lastSeat: seat, missedSmall: false, missedBig: false } });
function room(seats = [0, 2, 4, 6]) {
  return { handNumber: 3, buttonSeat: 0, settings: { smallBlind: 5, bigBlind: 10 },
    blindOrbit: { bigBlindSeat: 4, smallBlindSeat: 2 }, members: Object.fromEntries(seats.map(seat => [member(seat).id, member(seat)])) };
}
const eligible = r => Object.values(r.members).filter(m => m.seat != null && !m.sittingOut && m.stack > 0);
const deal = (r, plan, id = `h${r.handNumber + 1}`) => createHand({ id, players: plan.players, buttonSeat: plan.buttonSeat,
  ...r.settings, entryPosts: plan.posts, deck });
function next(r, members = eligible(r)) {
  const p = planEntry(r, members), h = deal(r, p); commitEntry(r, p, h); r.hand = h; r.handNumber++; r.buttonSeat = h.buttonSeat; return { p, h };
}
function finish(h, allin = false) {
  for (let n = 0; h.status === 'playing'; n++) {
    assert.ok(n < 100);
    const a = availableActions(h, h.actingId);
    applyAction(h, h.actingId, allin && a.canAllIn ? 'allin' : a.canCheck ? 'check' : 'call');
  }
  assert.equal(h.players.reduce((n, p) => n + p.stack, 0), h.players.reduce((n, p) => n + p.startingStack, 0));
  return h;
}
function filtered(h) {
  return { id: h.id, at: '2026-10-13T00:00:00.000Z', roomCode: '123456', roomName: 'entry',
    settings: { smallBlind: h.smallBlind, bigBlind: h.bigBlind }, bigBlind: h.bigBlind,
    ante: h.ante, buttonSeat: h.buttonSeat, smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat,
    board: [...h.board], log: structuredClone(h.log), result: structuredClone(h.result),
    players: h.players.map(p => ({ id: p.id, name: p.id, seat: p.seat, cards: [...p.cards], folded: p.folded,
      startingStack: p.startingStack, endingStack: p.stack, net: p.stack - p.startingStack })) };
}

test('new waiters enter when their natural BB reaches them, even with multiple simultaneous joins', () => {
  const r = room(); r.members.p1 = member(1, false); r.members.p3 = member(3, false); r.members.p5 = member(5, false);
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const before = structuredClone(r), plan = planEntry(r, eligible(r)); assert.deepEqual(r, before, 'planning never mutates');
    const h = deal(r, plan); commitEntry(r, plan, h); r.hand = h; r.handNumber++; r.buttonSeat = h.buttonSeat;
    for (const id of ['p1', 'p3', 'p5']) if (h.players.some(p => p.id === id)) seen.add(id);
    assert.equal(h.log.filter(e => e.type === 'entryBlind').length, 0);
  }
  assert.deepEqual([...seen].sort(), ['p1', 'p3', 'p5']);
});
test('post BB stays outside button/SB arc, is live, and does not move first action or minimum raise', () => {
  const r = room(); r.members.p1 = member(1, false); setEntryMode(r, r.members.p1, 'post');
  const { p, h } = next(r);
  assert.ok(p.players.some(x => x.id === 'p1')); assert.equal(h.bigBlindSeat, 6);
  assert.deepEqual(p.posts, [{ playerId: 'p1', live: 10, dead: 0 }]);
  assert.equal(h.players.find(x => x.id === 'p1').bet, 10); assert.equal(h.currentBet, 10); assert.equal(h.minRaise, 10);
  assert.equal(h.actingId, 'p0');
  applyAction(h, 'p0', 'raise', 30);
  assert.equal(h.actingId, 'p1'); assert.equal(availableActions(h, 'p1').callAmount, 20);
  finish(h);
});
test('natural BB never receives a second entry BB; protected button/SB newcomer waits past the button', () => {
  const r = room(); r.members.p5 = member(5, false); setEntryMode(r, r.members.p5, 'post');
  const { h } = next(r); assert.equal(h.bigBlindSeat, 5);
  assert.equal(h.players.find(p => p.id === 'p5').bet, 10); assert.equal(h.log.filter(e => e.playerId === 'p5' && e.type === 'entryBlind').length, 0);
  const q = room(); q.members.p3 = member(3, false); setEntryMode(q, q.members.p3, 'post');
  const first = next(q); assert.ok(!first.h.players.some(p => p.id === 'p3')); assert.match(first.p.waiting[0].reason, /过庄/);
  let entered = false; for (let i = 0; i < 5; i++) if (next(q).h.players.some(p => p.id === 'p3')) entered = true;
  assert.ok(entered);
});
test('planning retries and commit replay do not charge or rewrite the same hand twice', () => {
  const r = room(); r.members.p1 = member(1, false); setEntryMode(r, r.members.p1, 'post');
  const a = planEntry(r, eligible(r)), b = planEntry(r, eligible(r)); assert.deepEqual(a, b);
  const h = deal(r, a); assert.equal(commitEntry(r, a, h), true); const snap = structuredClone(r);
  assert.equal(commitEntry(r, a, h), false); assert.deepEqual(r, snap);
});
test('an absent existing player records missed positions without deductions and debts survive changing seats', () => {
  const r = room(); const absent = r.members.p6, balance = absent.stack;
  absent.sittingOut = true; next(r); assert.equal(absent.stack, balance); assert.equal(absent.blindEntry.missedBig, true);
  next(r); assert.equal(absent.blindEntry.missedSmall, true);
  markEntrySeat(r, absent, null); absent.seat = null; markEntrySeat(r, absent, 7); absent.seat = 7;
  assert.equal(needsEntry(r, absent), true); assert.equal(absent.blindEntry.missedBig, true); assert.equal(absent.blindEntry.missedSmall, true);
});
test('returning post pays one live BB and one dead SB while wait clears debt at natural BB', () => {
  const r = room(); const m = r.members.p0;
  Object.assign(m.blindEntry, { missedBig: true, missedSmall: true, mode: 'post' });
  const h = next(r).h; assert.equal(h.log.filter(e => e.playerId === m.id && e.type === 'entryBlind').length, 1);
  assert.equal(h.log.find(e => e.playerId === m.id && e.type === 'deadBlind').amount, 5);
  assert.equal(h.players.find(p => p.id === m.id).bet, 10); assert.equal(h.players.find(p => p.id === m.id).contributed, 15);
  const q = room(); Object.assign(q.members.p6.blindEntry, { missedBig: true, missedSmall: true, mode: 'wait' });
  const h2 = next(q).h; assert.equal(h2.bigBlindSeat, 6); assert.equal(h2.log.filter(e => e.playerId === 'p6' && ['deadBlind', 'entryBlind'].includes(e.type)).length, 0);
});
test('same-hand reconnect or stand and immediate same-seat return creates no new blind debt', () => {
  const r = room(); const m = r.members.p2; const before = projectEntry(r, m);
  markEntrySeat(r, m, null); m.seat = null; markEntrySeat(r, m, 2); m.seat = 2;
  assert.deepEqual(projectEntry(r, m), before); assert.equal(needsEntry(r, m), false);
});
test('all-wait restarts pause until one player explicitly posts; waiting player never pays an unexpected SB', () => {
  const r = room([0, 4]); for (const m of eligible(r)) Object.assign(m.blindEntry, { missedBig: true, missedSmall: true });
  const paused = planEntry(r, eligible(r)); assert.equal(paused.players.length, 0); assert.match(paused.waiting[0].reason, /需一人选择补盲/);
  setEntryMode(r, r.members.p0, 'post');
  const h = next(r).h; assert.equal(h.players.length, 2); assert.equal(h.bigBlindSeat, 4);
  assert.equal(h.log.filter(e => e.playerId === 'p4').length, 1); assert.equal(h.log.find(e => e.playerId === 'p4').type, 'bigBlind');
  const paid = h.log.filter(e => e.playerId === 'p0').reduce((sum, e) => sum + e.amount, 0); assert.equal(paid, 15);
  assert.equal(h.players.find(p => p.id === 'p0').bet, 10);
});
test('one established player and one waiting newcomer restart with newcomer at BB regardless of the old cursor', () => {
  const r = room([0, 4]); r.members.p4 = member(4, false); r.blindOrbit.bigBlindSeat = 4;
  const h = next(r).h; assert.equal(h.bigBlindSeat, 4); assert.equal(h.smallBlindSeat, 0);
  assert.deepEqual(h.log.filter(e => e.playerId === 'p4').map(e => e.type), ['bigBlind']);
});
test('bomb pot does not advance ordinary blind orbit or erase newcomer obligations', () => {
  const r = room(); r.members.p1 = member(1, false);
  const plan = planEntry(r, eligible(r), { bombPot: true }); assert.deepEqual(plan.orbit, r.blindOrbit); assert.ok(!plan.players.some(p => p.id === 'p1'));
  const h = createHand({ id: 'bomb', players: plan.players, buttonSeat: plan.buttonSeat, ...r.settings, bombPot: true, ante: 20, deck });
  commitEntry(r, plan, h); assert.equal(needsEntry(r, r.members.p1), true); assert.equal(r.blindOrbit.bigBlindSeat, 4);
});
test('short posted player waits instead of partially paying live/dead costs, failed deal never commits debt', () => {
  const r = room(); const m = r.members.p0; Object.assign(m.blindEntry, { missedBig: true, missedSmall: true, mode: 'post' }); m.stack = 14;
  const p = planEntry(r, eligible(r)); assert.ok(!p.players.some(x => x.id === m.id)); assert.match(p.waiting.find(x => x.playerId === m.id).reason, /积分不足/);
  assert.equal(m.blindEntry.missedBig, true);
});
test('dead SB is in main pot, never an unmatched refund, including unequal all-ins and odd chips', () => {
  const h = createHand({ id: 'dead', players: [100, 50, 100].map((stack, seat) => ({ id: `p${seat}`, seat, stack })), buttonSeat: 0, smallBlind: 5, bigBlind: 10,
    entryPosts: [{ playerId: 'p0', live: 10, dead: 5 }], deck });
  finish(h, true);
  assert.deepEqual(h.result.pots.map(p => p.amount), [155, 90]);
  assert.equal(h.log.filter(e => e.type === 'refund').reduce((n, e) => n + e.amount, 0), 0);
  assert.equal(h.players.find(p => p.id === 'p2').contributed, 95);
  assert.equal(h.players.find(p => p.id === 'p0').contributed, 100);
  assert.equal(h.result.pots[0].eligibleIds.length, 3);
  const replay = filtered(h);
  for (let i = 0; i <= h.log.length; i++) {
    const snap = replaySnapshot(replay, i, 'p0'); assert.equal(snap.players.reduce((n, p) => n + p.stack, 0) + snap.pot, 250);
  }
});
test('entry BB and dead SB are forced payments, not VPIP or a phantom raise', () => {
  const h = createHand({ id: 'vpip', players: [0, 1, 2, 3].map(seat => ({ id: `p${seat}`, seat, stack: 100 })), buttonSeat: 0, smallBlind: 5, bigBlind: 10,
    entryPosts: [{ playerId: 'p3', live: 10, dead: 5 }], deck });
  finish(h); const stats = handTendencies(h, 'p3'); assert.equal(stats.vpip, false); assert.equal(stats.pfr, false);
});
test('engine rejects malformed entry fees and safely deduplicates a natural BB live target', () => {
  const config = { id: 'validation', players: [0, 1, 2].map(seat => ({ id: `p${seat}`, seat, stack: 100 })), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck };
  const h = createHand({ ...config, entryPosts: [{ playerId: 'p2', live: 10, dead: 0 }] });
  assert.equal(h.players.find(p => p.id === 'p2').stack, 90); assert.equal(h.log.some(e => e.type === 'entryBlind'), false);
  for (const entryPosts of [[{ playerId: 'other', live: 10, dead: 0 }], [{ playerId: 'p0', live: 20, dead: 0 }], [{ playerId: 'p0', live: 10, dead: 6 }], [{ playerId: 'p0', live: 10, dead: 0 }, { playerId: 'p0', live: 10, dead: 0 }]]) assert.throws(() => createHand({ ...config, entryPosts }), /补盲/);
});

test('PHH keeps entry posts live and dead SB in main pot without changing action order', () => {
  const h = createHand({ id: 'phh-entry', players: [0, 1, 2, 3].map(seat => ({ id: `p${seat}`, seat, stack: 100 })), buttonSeat: 0, smallBlind: 5, bigBlind: 10,
    entryPosts: [{ playerId: 'p3', live: 10, dead: 5 }], deck });
  finish(h);
  const source = exportPhh([filtered(h)]);
  assert.match(source, /blinds_or_straddles = \[5, 10, -10, 0\]/);
  assert.match(source, /antes = \[0, 0, 5, 0\]/);
  assert.match(source, /ante_trimming_status = false/);
});
test('independent PokerKit replays posted blinds, dead SB, multiway all-ins and fold pots to identical stacks', {
  skip: !process.env.POKERKIT_PYTHON && 'Set POKERKIT_PYTHON for independent entry-blind replay.',
}, () => {
  const hands = [];
  for (const stacks of [[100, 100, 100, 100], [100, 50, 100], [55, 55, 55], [15, 100, 50], [100, 10, 100]]) {
    const config = { id: `entry-${stacks.join('-')}`, players: stacks.map((stack, seat) => ({ id: `p${seat}`, seat, stack })),
      buttonSeat: 0, smallBlind: 5, bigBlind: 10, entryPosts: [{ playerId: 'p0', live: 10, dead: 5 }], deck };
    hands.push(filtered(finish(createHand(config), true)));
    const folded = createHand({ ...config, id: `${config.id}-fold` });
    while (folded.status === 'playing') applyAction(folded, folded.actingId, 'fold');
    hands.push(filtered(folded));
  }
  const h = createHand({ id: 'entry-order', players: [0, 1, 2, 3, 4].map(seat => ({ id: `p${seat}`, seat, stack: 200 })), buttonSeat: 0, smallBlind: 5, bigBlind: 10,
    entryPosts: [{ playerId: 'p3', live: 10, dead: 5 }, { playerId: 'p4', live: 10, dead: 0 }], deck });
  applyAction(h, h.actingId, 'raise', 30); hands.push(filtered(finish(h)));
  const reboot = room([0, 4]); for (const m of eligible(reboot)) Object.assign(m.blindEntry, { missedBig: true, missedSmall: true });
  setEntryMode(reboot, reboot.members.p0, 'post'); hands.push(filtered(finish(next(reboot).h)));
  const postBB = room(); Object.assign(postBB.members.p6.blindEntry, { missedBig: true, missedSmall: true, mode: 'post' }); hands.push(filtered(finish(next(postBB).h)));
  const script = `import sys,json\nfrom pokerkit import HandHistory\nhands=list(HandHistory.loads_all(sys.stdin.read()))\nfor h in hands:\n transitions=list(h.state_actions)\n state=transitions[-1][0]\n assert not state.status,(h.hand,'unfinished')\n assert state.stacks==h.finishing_stacks,(h.hand,state.stacks,h.finishing_stacks)\n actual=sum(type(op).__name__ in {'Folding','CheckingOrCalling','CompletionBettingOrRaisingTo'} for op in state.operations)\n expected=sum(len(a.split())>1 and a.split()[1] in {'f','cc','cbr'} for a in h.actions)\n # PokerKit may add a zero-cost check when the only player with chips\n # has matched an all-in forced post; BBPoker runs the board immediately.\n extras=actual-expected\n zeros=sum(type(op).__name__=='CheckingOrCalling' and op.amount==0 for op in state.operations)\n assert 0<=extras<=zeros,(h.hand,'unrecorded paid action',actual,expected)\nprint(json.dumps({'replayed':len(hands)}))\n`;
  const run = spawnSync(process.env.POKERKIT_PYTHON, ['-c', script], { input: exportPhh(hands), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.deepEqual(JSON.parse(run.stdout), { replayed: hands.length });
});

test('choosing post on a natural BB pays its missing dead SB once; choosing wait removes the old debt', () => {
  const r = room(); Object.assign(r.members.p6.blindEntry, { missedBig: true, missedSmall: true, mode: 'post' });
  const h = next(r).h;
  assert.equal(h.bigBlindSeat, 6);
  assert.deepEqual(h.log.filter(e => e.playerId === 'p6').map(e => [e.type, e.amount]), [['bigBlind', 10], ['deadBlind', 5]]);
  assert.equal(needsEntry(r, r.members.p6), false);
  const nextHand = next(r).h; assert.equal(nextHand.log.some(e => e.playerId === 'p6' && e.type === 'deadBlind'), false);
});
test('seeded 600 multiway histories with live/dead posts conserve all chips and replay every intermediate deduction', () => {
  let seed = 18397; const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 600; trial++) {
    const count = 3 + random(7), players = Array.from({ length: count }, (_, seat) => ({ id: `p${seat}`, seat, stack: 20 + random(200) }));
    const posts = players.filter(p => p.seat !== 1 && p.seat !== 2 && random(2)).map(p => ({ playerId: p.id, live: 10, dead: random(2) ? 5 : 0 }));
    const h = createHand({ id: `random-${trial}`, players, buttonSeat: 0, smallBlind: 5, bigBlind: 10, entryPosts: posts, deck });
    for (let n = 0; h.status === 'playing'; n++) {
      assert.ok(n < 150); const a = availableActions(h, h.actingId), choice = random(5);
      applyAction(h, h.actingId, choice === 0 ? 'fold' : choice === 1 && a.canAllIn ? 'allin' : a.canCheck ? 'check' : 'call');
    }
    const total = players.reduce((sum, p) => sum + p.stack, 0);
    assert.equal(h.players.reduce((sum, p) => sum + p.stack, 0), total);
    assert.ok(h.players.every(p => p.contributed >= p.deadContribution && p.stack >= 0));
    assert.equal(h.result.pots.reduce((sum, p) => sum + p.amount, 0), h.players.reduce((sum, p) => sum + p.contributed, 0));
    const f = filtered(h);
    for (let i = 0; i <= h.log.length; i++) { const frame = replaySnapshot(f, i); assert.equal(frame.pot + frame.players.reduce((sum, p) => sum + p.stack, 0), total); }
  }
});
test('seeded rotating seat populations never charge absent players or strand waiters after the table stabilizes', () => {
  let seed = 707; const random = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const r = room([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (let turn = 0; turn < 150; turn++) {
    for (const m of Object.values(r.members)) { m.sittingOut = random(4) === 0; if (random(3) === 0) setEntryMode(r, m, random(2) ? 'post' : 'wait'); }
    if (eligible(r).length < 2) continue;
    const ids = new Set(eligible(r).map(m => m.id)); if (!planEntry(r, eligible(r)).players.length) continue; const { h } = next(r);
    assert.ok(h.players.every(p => ids.has(p.id)));
    assert.equal(h.log.filter(e => e.type === 'bigBlind').length, 1);
    assert.equal(new Set(h.log.filter(e => e.type === 'entryBlind').map(e => e.playerId)).size, h.log.filter(e => e.type === 'entryBlind').length);
  }
  for (const m of Object.values(r.members)) { m.sittingOut = false; setEntryMode(r, m, 'wait'); }
  if (!planEntry(r, eligible(r)).players.length) setEntryMode(r, Object.values(r.members)[0], 'post');
  for (let i = 0; i < 10; i++) next(r);
  assert.ok(Object.values(r.members).every(m => !needsEntry(r, m)), 'all waiters enter within one stable orbit');
});

test('a returning natural BB with insufficient chips for optional dead SB pays only its natural blind', () => {
  for (const stack of [1, 5, 10, 14]) {
    const r = room(); r.members.p6.stack = stack;
    Object.assign(r.members.p6.blindEntry, { missedBig: true, missedSmall: true, mode: 'post' });
    const plan = planEntry(r, eligible(r)); assert.equal(plan.posts.some(p => p.playerId === 'p6'), false);
    const h = deal(r, plan); commitEntry(r, plan, h);
    const paid = h.log.filter(e => e.playerId === 'p6').reduce((sum, e) => sum + (e.amount ?? 0), 0);
    assert.equal(paid, Math.min(stack, 10)); assert.equal(needsEntry(r, r.members.p6), false);
    finish(h);
  }
});
