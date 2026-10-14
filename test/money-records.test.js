import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';
import { aggregateAnalytics } from '../src/analytics.js';
import { ledgerBlindLookup } from '../src/records.js';
import { setDisplayUnit } from '../public/money.js';
import { recordTotals, opponentRecords, opponentResultList, opponentFilters, recordFilterKey, sessionDetail, sessionRow } from '../public/records.js';
import { avatarMarkup } from '../public/avatar.js';
import { renderStatsPage, renderProfitChart, renderAllInChart } from '../public/stats.js';
import { renderHandOverview } from '../public/hand-overview.js';

test.afterEach(() => setDisplayUnit('points'));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function fixture() {
  const db = { users: { me: { id: 'me', name: '我' }, friend: { id: 'friend', name: '朋友' } }, rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data: db }), room = service.create(db.users.me, { name: '单位测试' });
  service.join(db.users.friend, room.code, room.invite);
  function add(id, bb, net, mini = 0, expected = null) {
    const h = { id, number: db.hands.length + 1, status: 'complete', at: `2026-10-14T10:00:0${db.hands.length}.000Z`, roomCode: room.code, roomName: room.name,
      settings: { bigBlind: bb }, bigBlind: bb, board: [], miniChanges: { me: mini }, log: [],
      players: [{ id: 'me', name: '我', seat: 0, cards: ['As', 'Kh'], startingStack: 1000, stack: 1000 + net },
        { id: 'friend', name: '朋友', seat: 1, cards: [null, null], startingStack: 1000, stack: 1000 - net }],
      result: { payouts: {}, mainWinnerIds: [], pots: [], showdown: false } };
    if (bb === null) { delete h.settings; delete h.bigBlind; }
    if (expected !== null) { h.allInLock = { board: [], street: 'preflop', players: [{ id: 'me' }, { id: 'friend' }] };
      h.allInEquity = { method: 'exact', players: [{ id: 'me', expectedNet: expected, equity: 55 }] }; }
    db.hands.push(h); return h;
  }
  return { db, service, room, add };
}

test('hand/session totals and analytics use per-hand historical 10/20/3 BB with raw fractions', () => {
  const f = fixture(); f.add('ten', 10, 100, 10); f.add('twenty', 20, -100, 20); f.add('third', 3, 1);
  f.room.settings.bigBlind = 999;
  const before = structuredClone(f.db), hands = f.service.handLibrary('me'), sessions = f.service.sessions('me'), detail = f.service.sessionFor('me', f.room.code).session,
    stats = aggregateAnalytics(f.db, 'me');
  assert.deepEqual(f.db, before, 'derived BB data must not migrate or rewrite archives');
  for (const total of [hands.totals, sessions.totals]) { assert.equal(total.net, 31); close(total.bb.holdemNet, 5 + 1 / 3); close(total.bb.miniNet, 2); close(total.bb.net, 7 + 1 / 3); assert.equal(total.bb.complete, true); }
  close(detail.meNetBB, 7 + 1 / 3); close(detail.players.find(p => p.id === 'me').holdemNetBB, 5 + 1 / 3);
  close(stats.holdemNetBB, 5 + 1 / 3); close(stats.netBB, 7 + 1 / 3); assert.equal(stats.bbHands, 3); assert.equal(stats.bbComplete, true);
  assert.deepEqual(stats.curve.slice(0, 2).map(p => p.netBB), [11, 7]); close(stats.curve.at(-1).netBB, stats.netBB);
});

test('all-in expected decimals and curves normalize every historical blind before accumulating', () => {
  const f = fixture(); f.add('ten', 10, 100, 0, 70.1234); f.add('twenty', 20, -100, 0, -40.2345); f.add('third', 3, 1, 0, 0.3333);
  const allIn = aggregateAnalytics(f.db, 'me').allIn, expected = 70.1234 / 10 - 40.2345 / 20 + 0.3333 / 3;
  close(allIn.actualNetBB, 5 + 1 / 3); close(allIn.expectedNetBB, expected); close(allIn.differenceBB, allIn.actualNetBB - expected);
  assert.equal(allIn.bbHands, 3); assert.equal(allIn.bbComplete, true);
  close(allIn.curve.at(-1).actualBB, allIn.actualNetBB); close(allIn.curve.at(-1).expectedBB, expected);
  close(allIn.hands.find(h => h.id === 'ten').expectedNetBB, 7.01234);
  setDisplayUnit('bb'); const chart = renderAllInChart(allIn.curve); assert.match(chart, /累计BB/); assert.doesNotMatch(chart, /累计积分/);
  setDisplayUnit('points'); assert.match(renderAllInChart(allIn.curve), /累计积分/);
});

test('small nonzero BB chart labels are not rounded into a zero result', () => {
  setDisplayUnit('bb');
  assert.match(renderProfitChart([{ net: 1, netBB: 0.0005 }]), /\+0\.0005/);
  assert.match(renderAllInChart([{ actual: 1, actualBB: 0.0005, expected: 0.5, expectedBB: 0.00025 }]), /实际 \+0\.0005，期望 \+0\.00025/);
});

test('ledger minis are counted once and use their own or linked historical snapshot, never mutable room settings', () => {
  const f = fixture(); const a = f.add('ten', 10, 0), b = f.add('twenty', 20, 0, 40);
  b.squidSettlementId = 'round'; b.squidSettlementChanges = { me: 40 };
  f.db.ledger.push({ type: 'squidSettlement', roomCode: f.room.code, roundSettlementId: 'round', handId: b.id, playerId: 'me', amount: 40, at: '2026-10-14T10:00:03.000Z' },
    { type: 'mushroomRefund', roomCode: f.room.code, handId: a.id, playerId: 'me', amount: 10, at: '2026-10-14T10:00:04.000Z' },
    { type: 'squidSettlement', roomCode: f.room.code, roundSettlementId: 'standalone', bigBlind: 5, playerId: 'me', amount: 15, at: '2026-10-14T10:00:05.000Z' });
  f.room.settings.bigBlind = 999;
  const stats = aggregateAnalytics(f.db, 'me'), detail = f.service.sessionFor('me', f.room.code).session;
  assert.equal(stats.miniNet, 65); assert.equal(stats.miniNetBB, 6); assert.equal(detail.meMiniNet, 65); assert.equal(detail.meMiniNetBB, 6);
  assert.equal(stats.squidSettlementCount, 2); assert.equal(stats.standaloneSquidSettlementCount, 1);
  const one = aggregateAnalytics(f.db, 'me', { maxHands: 1 }); assert.equal(one.miniNet, 40); assert.equal(one.miniNetBB, 2);
});

test('missing legacy blinds invalidate full BB aggregates and curves while all point amounts remain available', () => {
  const f = fixture(); f.add('known', 10, 100, 0, 60.5); f.add('unknown', null, 20, 5, 10.5); f.add('later', 20, -10);
  f.room.settings.bigBlind = 200;
  const hands = f.service.handLibrary('me'), detail = f.service.sessionFor('me', f.room.code).session, stats = aggregateAnalytics(f.db, 'me');
  assert.equal(hands.totals.bb.net, null); assert.equal(hands.totals.bb.knownRecords, 2); assert.equal(hands.totals.bb.records, 3);
  assert.equal(detail.meNetBB, null); assert.equal(stats.netBB, null); assert.equal(stats.net, 115); assert.equal(stats.bbHands, 2);
  assert.equal(stats.curve[1].netBB, null); assert.equal(stats.curve[2].netBB, null);
  assert.equal(stats.allIn.actualNetBB, null); assert.equal(stats.allIn.expectedNetBB, null); assert.equal(stats.allIn.bbHands, 1);
  setDisplayUnit('bb'); assert.match(recordTotals(hands.totals, 'hands'), /— BB/); assert.doesNotMatch(renderProfitChart(stats.curve), /<svg/); assert.doesNotMatch(renderAllInChart(stats.allIn.curve), /<svg/);
  assert.match(renderStatsPage(stats), /缺少历史大盲/);
  setDisplayUnit('points'); assert.match(recordTotals(hands.totals, 'hands'), /\+115 积分/); assert.match(renderProfitChart(stats.curve), /<svg/);
});

test('unlinked ambiguous ledger stakes stay unknown; new entries and pre-start buy-ins snapshot their own blind', () => {
  const f = fixture(); f.add('a', 10, 0); f.add('b', 20, 0); f.room.members.me.totalBuyIn = 1000;
  f.room.settings.bigBlind = 10; const first = f.service.log(f.room, 'me', 'buyin', 500, 'test');
  f.room.settings.bigBlind = 20; const second = f.service.log(f.room, 'me', 'buyin', 500, 'test');
  assert.equal(first.bigBlind, 10); assert.equal(second.bigBlind, 20);
  const player = f.service.sessionFor('me', f.room.code).session.players.find(p => p.id === 'me'); assert.equal(player.totalBuyInBB, 75);
  const lookup = ledgerBlindLookup(f.db); assert.equal(lookup({ roomCode: f.room.code, type: 'squidSettlement' }), null);
  assert.equal(lookup({ roomCode: f.room.code, type: 'buyin' }), null);
  assert.equal(lookup({ roomCode: f.room.code, bigBlind: 0, handId: 'a' }), null);
});

test('all history modules follow the selected unit and preserve counts, thresholds, hidden cards and original amounts', () => {
  const f = fixture(); const h = f.add('known', 10, 100, 20, 70.5), result = f.service.handLibrary('me'), detail = f.service.sessionFor('me', f.room.code).session, stats = aggregateAnalytics(f.db, 'me');
  const visible = { ...h, players: h.players.map(p => ({ ...p, net: p.stack - p.startingStack, miniNet: h.miniChanges[p.id] ?? 0 })) };
  delete visible.allInLock; const before = structuredClone(visible);
  for (const unit of ['bb', 'points']) {
    setDisplayUnit(unit);
    const text = [recordTotals(result.totals, 'hands'), opponentRecords(result.opponents), sessionRow(detail), sessionDetail(detail, 'me'), renderStatsPage(stats), renderHandOverview(visible, 'me')].join('');
    assert.match(text, unit === 'bb' ? /\+12 BB/ : /\+120 积分/); assert.match(text, /未公开底牌/);
    assert.doesNotMatch(text, /NaN|Infinity/); assert.deepEqual(visible, before);
  }
});

test('legacy replay projection preserves a top-level historical BB without revealing hidden cards or current stakes', () => {
  const f = fixture();
  for (const [seat, user] of Object.values(f.db.users).entries()) {
    f.service.command(user, f.room.code, { type: 'sit', seat, amount: 1000, commandId: randomUUID() });
    f.service.connections.set(`${f.room.code}:${user.id}`, 1);
  }
  f.service.start(f.room);
  f.service.command(f.db.users[f.room.hand.actingId], f.room.code, { type: 'fold', commandId: randomUUID(), handId: f.room.hand.id, actionSeq: f.room.hand.log.length });
  const stored = f.db.hands.at(-1), archivedBB = stored.bigBlind;
  delete stored.settings; f.room.settings.bigBlind = 999;
  setDisplayUnit('bb');
  const before = structuredClone(stored), projected = f.service.handFor('me', f.room.code, stored.id);
  assert.deepEqual(stored, before); assert.equal(projected.bigBlind, archivedBB); assert.equal(projected.settings, undefined);
  assert.equal(f.service.handLibrary('me').hands[0].bigBlind, projected.bigBlind);
  assert.deepEqual(projected.players.find(p => p.id === 'friend').cards, [null, null]);
  assert.deepEqual(projected.players.find(p => p.id === 'me').cards, stored.players.find(p => p.id === 'me').cards);
  for (const field of ['deck', 'audit', 'allInLock', 'deckCursor', 'burnIndices']) assert.equal(projected[field], undefined);
  assert.deepEqual(projected.proofs.map(proof => proof.position).sort(), [...stored.players.find(p => p.id === 'me').cardIndices].sort());
  assert.doesNotMatch(renderHandOverview(projected, 'me'), /— BB/);
  delete stored.bigBlind;
  const unknown = f.service.handFor('me', f.room.code, stored.id);
  assert.equal(unknown.bigBlind, null); assert.match(renderHandOverview(unknown, 'me'), /— BB/);
  assert.deepEqual(unknown.players.find(p => p.id === 'friend').cards, [null, null]);
});

test('opponent report has an independent compact date room and opponent form, without hand-only fields', () => {
  const state={room:'room2',filters:{period:'7',position:'CO',type:'bomb',tableSize:'full',result:'win',holePreset:'premium',handNumber:'12',opponent:'friend',maxHands:'100',potType:'headsUp'},favorites:true};
  const html=opponentFilters(state,[{code:'room2',name:'<script>同名局</script>',createdAt:'2026-10-14T12:00:00Z'}]);
  assert.match(html,/id="opponent-records-filter-form"/);assert.match(html,/data-record-kind="opponents"/);assert.ok(html.includes(recordFilterKey(state).replaceAll('"','&quot;')));
  for(const name of ['room','opponent'])assert.match(html,new RegExp(`name="${name}"`));
  assert.doesNotMatch(html,/name="(?:result|minBB|hole\w*|handNumber|position|type|squid|tableSize|maxHands|potType|favorites)"|起手牌|找第几手|我的盈亏/);
  assert.match(html,/选择对局/);assert.match(html,/全部对局/);assert.match(html,/筛选条件/);assert.match(html,/&lt;script&gt;同名局&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.match(html,/data-record-disclosure="filters">/);assert.match(html,/value="friend" selected/);
  const plain=opponentFilters({filters:{}});assert.match(plain,/data-record-disclosure="filters">/);assert.doesNotMatch(plain,/name="(?:from|to)"/);
  const custom=opponentFilters({filters:{period:'custom',from:'2026-10-01',to:'2026-10-14'}});assert.match(custom,/name="from" value="2026-10-01"/);assert.match(custom,/name="to" value="2026-10-14"/);assert.match(custom,/应用日期/);
});

const opponentFixture=()=>({uniqueHands:12,net:9999,netBB:777,bbHands:12,rows:[
  {id:'mixed',name:'小红',avatar:3,hands:5,net:-50,netBB:2.5,bbHands:5,lastAt:'2026-10-14T12:00:00Z',headsUpHands:1,headsUpNet:800,headsUpNetBB:400,headsUpBBHands:1,wins:3,losses:2,even:0},
  {id:'known',name:'ALICE',avatar:1,hands:10,net:100,netBB:1,bbHands:10,lastAt:'2026-10-13T12:00:00Z',headsUpHands:0,headsUpNet:0,headsUpNetBB:0,headsUpBBHands:0},
  {id:'unknown',name:'旧记录',hands:8,net:1000,netBB:900,bbHands:0,lastAt:'2026-10-12T12:00:00Z'},
]});

test('opponent list shows one amount per friend with public avatars and no misleading pairwise win count or giant total', () => {
  const data=opponentFixture();setDisplayUnit('bb');
  const html=opponentRecords(data,'hands',{mode:'all',avatar:avatarMarkup});
  assert.match(html,/3 位朋友/);assert.match(html,/12 手已去重/);assert.match(html,/这些手牌里我的盈亏/);assert.match(html,/并非直接从对方赢得/);
  assert.match(html,/data-action="library-opponent-mode" data-mode="all" aria-pressed="true"/);assert.match(html,/data-mode="headsUp" aria-pressed="false"/);assert.match(html,/data-opponent-results/);
  assert.match(html,/\/avatars\/ai-04\.png/);assert.match(html,/共同 5 手/);assert.match(html,/朋友 · 共同手数/);assert.match(html,/class="positive">\+2\.5 BB/);assert.match(html,/class="muted">— BB/);assert.match(html,/缺少历史大盲/);
  assert.doesNotMatch(html,/777 BB|9,999|3 赢|2 输|opponent-totals|opponent-details|400 BB/);assert.equal((html.match(/<details/g)||[]).length,1);
  assert.match(html,/同一手可能出现在多位朋友名下，各行不可相加/);assert.match(html,/可能包含其他玩家翻前留下的积分/);assert.match(html,/不含鱿鱼等小游戏/);
});

test('opponent profit/loss sorting and colors follow the selected unit, and incomplete BB never acts like zero', () => {
  const data=opponentFixture();setDisplayUnit('bb');
  const profit=opponentResultList(data,'profit'),loss=opponentResultList(data,'loss');
  assert.ok(profit.indexOf('data-opponent="mixed"')<profit.indexOf('data-opponent="known"'));assert.ok(loss.indexOf('data-opponent="known"')<loss.indexOf('data-opponent="mixed"'));
  for(const html of [profit,loss])assert.ok(html.indexOf('data-opponent="unknown"')>html.indexOf('data-opponent="mixed"'));
  setDisplayUnit('points');const points=opponentResultList(data,'profit');assert.ok(points.indexOf('data-opponent="known"')<points.indexOf('data-opponent="mixed"'));assert.ok(points.indexOf('data-opponent="unknown"')<points.indexOf('data-opponent="known"'));assert.match(points,/class="negative">-50 积分/);assert.doesNotMatch(points,/缺少历史大盲/);
  const partial={...data,rows:[{...data.rows[0],bbHands:2}]};setDisplayUnit('bb');const html=opponentResultList(partial);assert.match(html,/— BB/);assert.match(html,/2 \/ 5 手可折算/);assert.doesNotMatch(html,/\+2\.5 BB/);
});

test('nickname search is literal, case-insensitive and keeps search controls outside replaceable results', () => {
  const data=opponentFixture(),before=structuredClone(data),html=opponentRecords(data,'recent',{search:'alice',mode:'all'});
  assert.match(html,/data-opponent-search[^>]*value="alice"/);assert.match(html,/data-opponent-sort/);assert.ok(html.indexOf('data-opponent-search')<html.indexOf('data-opponent-results'));assert.match(html,/找到 1 位朋友/);assert.doesNotMatch(html,/data-opponent="mixed"/);assert.match(html,/data-opponent="known"/);
  const results=opponentResultList(data,'hands',{search:'ＡＬＩＣＥ'});assert.match(results,/data-opponent="known"/);assert.doesNotMatch(results,/data-opponent-search|data-opponent-sort/);
  const empty=opponentResultList(data,'hands',{search:'<img src=x>'});assert.match(empty,/没有找到这位朋友/);assert.match(empty,/data-action="library-opponent-clear-search"/);assert.match(empty,/&lt;img src=x&gt;/);assert.doesNotMatch(empty,/<img/);
  const recent=opponentResultList(data,'recent');assert.ok(recent.indexOf('data-opponent="mixed"')<recent.indexOf('data-opponent="known"'));assert.deepEqual(data,before);
});

test('heads-up mode uses server-filtered whole-hand rows, never substitutes independent heads-up subtotals', () => {
  const data=opponentFixture();data.rows=[data.rows[0]];data.uniqueHands=5;setDisplayUnit('bb');
  const html=opponentRecords(data,'recent',{mode:'headsUp'});assert.match(html,/data-mode="headsUp" aria-pressed="true"/);assert.match(html,/单挑 5 手/);assert.match(html,/朋友 · 单挑手数/);assert.match(html,/\+2\.5 BB/);assert.doesNotMatch(html,/400 BB|翻后单挑 1 手|共同 5 手|朋友 · 共同手数/);
  const empty=opponentRecords({rows:[],uniqueHands:0},'hands',{mode:'headsUp'});assert.match(empty,/暂无翻后单挑记录/);assert.match(empty,/data-action="record-reset" data-kind="hands"/);assert.doesNotMatch(empty,/0 BB/);
  const noRows=opponentResultList({rows:[],uniqueHands:0},'hands',{search:'小明'});assert.match(noRows,/暂无共同手牌记录/);assert.doesNotMatch(noRows,/library-opponent-clear-search/);
});

test('opponent names, ids and search values are escaped without exposing archived cards', () => {
  const name='<img src=x onerror="alert(1)">',data={rows:[{id:'bad" onclick="attack',name,hands:1,net:0,netBB:0,bbHands:1,cards:['As','Ah']}],uniqueHands:1};
  const html=opponentRecords(data,'hands',{search:'"'});assert.match(html,/&lt;img/);assert.match(html,/data-opponent="bad&quot; onclick=&quot;attack"/);assert.match(html,/title="&lt;img/);assert.doesNotMatch(html,/<img|onclick="attack|onerror="|As|Ah/);assert.match(html,/0 积分/);
});
