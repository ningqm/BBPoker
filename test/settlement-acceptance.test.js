import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { availableActions, createHand, applyAction } from '../src/poker.js';
import { commitDeck } from '../src/fairness.js';
import { exportPhh } from '../src/phh.js';
import { publicPlayerStats } from '../src/player-stats.js';
import { directHandTransfers } from '../src/opponent-transfers.js';
import { handTendencies } from '../src/analytics.js';
import { versusStats } from '../src/versus-stats.js';
import { readyRoomAction } from './helpers/room-clock.js';
import { replayIndependently } from './helpers/pokerkit-oracle.mjs';

// An independent engine replays actual service-command transcripts, including
// hidden folded cards. Expected stacks are computed by PokerKit, not BBPoker.
// Deck replacement is test-only, before any decision, for reproducible failures.
const PACK = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
function rng(seed) {
  return max => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
}
function deterministicDeck(hand, random, board = null) {
  const deck = [...PACK];
  for (let i = 51; i; i--) { const j = random(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  if (board) {
    const n = hand.players.length, positions = [2*n+1, 2*n+2, 2*n+3, 2*n+5, 2*n+7];
    positions.forEach((p, i) => { const j = deck.indexOf(board[i]); [deck[p], deck[j]] = [deck[j], deck[p]]; });
  }
  hand.deck = Object.freeze(deck);
  for (const player of hand.players) player.cards = player.cardIndices.map(index => deck[index]);
  hand.audit = commitDeck(hand);
}
function assertConserved(data, room) {
  const members = Object.values(room.members);
  const held = members.reduce((sum, m) => sum + m.stack + m.cashedOut, 0)
    + (room.hand?.status === 'playing' ? room.hand.players.reduce((sum, p) => sum + p.contributed, 0) : 0);
  assert.equal(held, members.reduce((sum, m) => sum + m.totalBuyIn, 0));
  for (const m of members) assert.ok(Number.isSafeInteger(m.stack) && m.stack >= 0);
  assert.equal(data.ledger.filter(row => row.type === 'holdem').reduce((sum, row) => sum + row.amount, 0), 0);
}
function setup(t, count) {
  let clock = 1800000000000;
  t.mock.method(Date, 'now', () => clock);
  const users = Array.from({ length: count }, (_, i) => ({ id: `acceptance-${count}-${i}`, name: `Synthetic ${i}` }));
  const data = { users: Object.fromEntries(users.map(u => [u.id,u])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data });
  const room = service.create(users[0], { settings: { maxPlayers: count, smallBlind: 5, bigBlind: 10, durationMinutes: 480 } });
  const command = (user, type, extra = {}) => service.command(user, room.code, {
    type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra,
  });
  for (const [i,user] of users.entries()) {
    if (i) service.join(user, room.code, room.invite);
    command(user, 'sit', { seat: i, amountBB: 100 + 50*i });
    service.connections.set(`${room.code}:${user.id}`, 1);
  }
  return { data, room, users, service, command, setClock: time => { clock = time; } };
}
function verifyProjection(f, expectedHands) {
  const { data, room, service, users } = f;
  for (const user of users) {
    const own = data.hands.map(h => h.players.find(p => p.id === user.id)).filter(Boolean);
    const net = own.reduce((sum, p) => sum + p.stack - p.startingStack, 0);
    assert.equal(own.length, expectedHands);
    const m = room.members[user.id];
    assert.equal(m.stack + m.cashedOut - m.totalBuyIn, net, 'buy-ins are not poker profit');
    assert.equal(data.ledger.filter(l => l.playerId === user.id && l.type === 'holdem').reduce((sum,l) => sum+l.amount,0), net);
    assert.equal(service.stats(user.id).holdemNet, net);
    assert.equal(service.stats(user.id, { room: room.code }).hands, expectedHands);
    assert.equal(service.sessionFor(user.id, room.code).session.meHoldemNet, net);
    for (const scope of ['table','career']) {
      const profile = publicPlayerStats(data, users[0].id, room.code, user, { scope });
      assert.equal(profile.hands, expectedHands);
      assert.equal(profile.metrics.winRate.count, own.filter(p => p.stack > p.startingStack).length);
      // These independent counters inspect money-moving actions only, without
      // using either analytics implementation as the other one's oracle.
      const vpip = data.hands.filter(h => h.log.some(e => e.playerId === user.id && e.street === 'preflop'
        && ['call','raise','allin'].includes(e.type) && e.amount > 0)).length;
      const pfr = data.hands.filter(h => h.log.some(e => e.playerId === user.id && e.street === 'preflop'
        && ['raise','allin'].includes(e.type) && e.isRaise === true)).length;
      assert.equal(profile.metrics.vpip.count, vpip);
      assert.equal(profile.metrics.pfr.count, pfr);
    }
  }
  for (const h of data.hands) {
    const attribution = directHandTransfers(h);
    assert.equal(attribution.covered, true, `${h.number}: ${attribution.reason}`);
    for (const p of h.players) {
      const attributed = attribution.transfers.reduce((sum, row) => sum + (row.toId === p.id ? row.amount : 0) - (row.fromId === p.id ? row.amount : 0), 0);
      assert.ok(Math.abs(attributed - (p.stack - p.startingStack)) < 1e-7, 'all opponent rows reconcile to this exact hand');
    }
  }
}

function coveredRaiseHand(shortStack) {
  return createHand({ id:'covered-raise', players:[100,200,shortStack].map((stack,seat)=>({id:String(seat),seat,stack})),
    buttonSeat:0, smallBlind:5, bigBlind:10, deck:PACK });
}
for (const shortStack of [50,100]) test(`a ${shortStack}-point pending caller cannot contest an increase above the current 100-point all-in`, () => {
  const h=coveredRaiseHand(shortStack); applyAction(h,'0','allin');
  const a=availableActions(h,'1');
  assert.equal(h.bettingRulesVersion,2); assert.equal(a.canRaise,false); assert.equal(a.canAllIn,false);
  assert.equal(a.callAmount,95);
  for (const [type,amount] of [['raise',190],['allin',undefined]]) {
    const before=structuredClone(h); assert.throws(()=>applyAction(h,'1',type,amount)); assert.deepEqual(h,before);
  }
  applyAction(h,'1','call'); applyAction(h,'2','call');
  assert.equal(h.status,'complete');
  assert.deepEqual(h.result.pots.map(p=>p.amount),shortStack===50?[150,100]:[300]);
  assert.equal(h.log.some(e=>e.type==='refund'),false);
  assert.equal(handTendencies(h,'1').threeBetOpportunity,false);
});
test('even one available chip above the current wager preserves a genuine side-pot raising opportunity', () => {
  const h=coveredRaiseHand(101); applyAction(h,'0','allin');
  assert.equal(availableActions(h,'1').canRaise,true); assert.equal(availableActions(h,'1').canAllIn,true);
  applyAction(h,'1','raise',190); applyAction(h,'2','call');
  assert.deepEqual(h.result.pots.map(p=>p.amount),[300,2]);
  assert.equal(h.log.find(e=>e.type==='refund').amount,89);
  assert.equal(handTendencies(h,'1').threeBetOpportunity,true);
});
test('an unversioned in-progress hand and its refunded legacy raise remain readable without changing the archive', () => {
  let h=coveredRaiseHand(50); delete h.bettingRulesVersion;
  applyAction(h,'0','allin'); h=JSON.parse(JSON.stringify(h)); // old saved active hand, restored after upgrade
  assert.equal(availableActions(h,'1').canAllIn,true);
  applyAction(h,'1','allin'); applyAction(h,'2','call');
  assert.equal(h.log.find(e=>e.type==='refund').amount,100);
  assert.deepEqual(h.result.pots.map(p=>p.amount),[150,100]);
  const before=structuredClone(h), stats=versusStats([h],'1','0');
  assert.equal(stats.coverage.actionUnknownHands,0); assert.equal(handTendencies(h,'1').threeBetOpportunity,true);
  assert.deepEqual(h,before,'historical analytics must not rewrite refunded wagers or payout amounts');
  assert.equal(coveredRaiseHand(50).bettingRulesVersion,2,'next newly dealt hand always uses current rules');
});

for (const count of [2,5,9]) test(`${count}-player service acceptance: 30 mixed hands reconcile with PokerKit and every public accounting view`, {
  skip: !process.env.POKERKIT_PYTHON && 'Set POKERKIT_PYTHON to independently replay service-generated hands.',
}, t => {
  const f = setup(t,count), { service,room,users,command,data } = f;
  const random = rng(0x36ca91 + count), types = new Set();
  let decisionCount = 0, retries = 0, queued = 0, sidePots = 0, oddTies = 0, refunds = 0;
  for (let number = 0; number < 30; number++) {
    for (const u of users) if (room.members[u.id].stack < 1000) command(u,'buyin',{amountBB:100});
    service.completeRabbit(room);
    service.start(room, Date.now(), { automatic: true });
    command(users[0], 'autoDeal', { paused: true });
    const h = room.hand;
    deterministicDeck(h,random,number === 0 ? ['As','Ks','Qs','Js','Ts'] : null);
    for (let step = 0; h.status === 'playing'; step++) {
      assert.ok(step < 250, 'every hand terminates');
      readyRoomAction(service,room,f.setClock);
      if (h.status === 'complete') break;
      const actor = users.find(u => u.id === h.actingId), a = availableActions(h,actor.id);
      assert.equal(service.state(room,actor.id).actions.canAct,true);
      if (number === 4 && step === 0) {
        const target = users.at(-1), before = room.members[target.id].stack, id = randomUUID();
        command(target,'buyin',{amountBB:100,commandId:id});
        command(target,'buyin',{amountBB:100,commandId:id});
        assert.equal(room.members[target.id].stack,before,'mid-hand top-up cannot change the current pot limit');
        assert.equal(service.pendingBuyIn(room.members[target.id]),1000);
        queued++;
      }
      const choice = random(100), raises = h.log.filter(e => e.street === h.street && e.isRaise).length;
      let type = a.canCheck ? 'check' : 'call', amount;
      if (number === 0) {
        if (count > 2 && h.street === 'preflop' && actor.id === h.players.find(p=>p.seat===h.smallBlindSeat).id) type='fold';
      } else if (number === 1 && a.canAllIn) type='allin';
      else if (number === 2) {
        if (h.street === 'preflop' && raises < 4 && a.canRaise) { type='raise'; amount=Math.ceil(a.minRaiseTo/10)*10; }
      } else if (number === 3) {
        if (step === 0 && a.canRaise) { type='raise'; amount=Math.ceil(a.minRaiseTo/10)*10; }
        else type='fold';
      } else if (choice < 15) type='fold';
      else if (choice < 28 && a.canAllIn) type='allin';
      else if (choice < 53 && a.canRaise) {
        const min = Math.ceil(a.minRaiseTo/10)*10, max=Math.floor(a.maxRaiseTo/10)*10;
        if (min <= max) { type='raise'; amount=min+10*random(Math.min(12,(max-min)/10+1)); }
      }
      const id = randomUUID(), seq = h.log.length;
      command(actor,type,{amount,commandId:id});
      if (decisionCount % 7 === 0) {
        const accepted=structuredClone(data);
        command(actor,type,{amount,commandId:id,actionSeq:seq});
        assert.deepEqual(data,accepted,'retry cannot repeat a wager, payout or archive'); retries++;
      }
      types.add(type); decisionCount++; assertConserved(data,room);
    }
    assert.equal(data.hands.length, number+1, 'one archive per completed hand');
    assertConserved(data,room);
    sidePots += h.result.pots.length > 1;
    oddTies += h.result.pots.some(p=>p.winnerIds.length>1 && p.amount%p.winnerIds.length);
    refunds += h.log.some(e=>e.type==='refund');
    for (const viewer of users) {
      const visible = service.handFor(viewer.id,room.code,h.id);
      for (const p of visible.players) if (p.id !== viewer.id && p.folded) assert.deepEqual(p.cards,[null,null]);
    }
    f.setClock(Date.now()+6000);
  }
  verifyProjection(f,30);
  const independent = replayIndependently(exportPhh(service.exports(users[0].id,room.code)),30);
  assert.ok(['check','call','fold','raise','allin'].every(type=>types.has(type)));
  assert.ok(retries>10); assert.equal(queued,1); assert.ok(refunds>0);
  if (count>2) { assert.ok(sidePots>0); assert.ok(oddTies>0); }
  t.diagnostic(JSON.stringify({players:count,...independent,decisionCount,retries,queued,sidePots,oddTies,refunds}));
});
