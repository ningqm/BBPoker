import test from 'node:test';
import assert from 'node:assert/strict';
import { setDisplayUnit } from '../public/money.js';
test.beforeEach(() => setDisplayUnit('bb'));
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { formatHandBB, renderHandOverview } from '../public/hand-overview.js';

function basic() {
  return { id: 'overview', number: 1, settings: { bigBlind: 10 }, board: ['2c', '3d', '4h'],
    buttonSeat: 0, smallBlindSeat: 0, bigBlindSeat: 1,
    players: [{ id: 'a', name: '甲', seat: 0, startingStack: 100, net: 10, miniNet: -5, cards: ['As', 'Kh'] },
      { id: 'b', name: '乙', seat: 1, startingStack: 100, net: -10, miniNet: 5, cards: [null, null] }],
    log: [{ playerId: 'a', type: 'smallBlind', amount: 5, to: 5, street: 'preflop' },
      { playerId: 'b', type: 'bigBlind', amount: 10, to: 10, street: 'preflop' },
      { playerId: 'a', type: 'call', amount: 5, to: 10, street: 'preflop' },
      { playerId: 'b', type: 'check', street: 'preflop' },
      { type: 'street', board: ['2c', '3d', '4h'], street: 'flop' },
      { playerId: 'b', type: 'fold', street: 'flop' },
      { playerId: 'a', type: 'payout', amount: 20, street: 'flop' }],
    result: { showdown: false, pots: [{ amount: 20, winnerIds: ['a'] }] }, mini: { changes: { a: -5, b: 5 } } };
}
function engine(stacks, extras = {}) {
  return createHand({ id: 'engine-overview', players: stacks.map((stack, seat) => ({ id: 'abc'[seat], name: '甲乙丙'[seat], seat, stack })),
    buttonSeat: 0, smallBlind: 5, bigBlind: 10, ...extras });
}
function finish(h, choose = a => a.canCheck ? 'check' : 'call') {
  for (let i = 0; h.status === 'playing'; i++) { assert.ok(i < 100); applyAction(h, h.actingId, choose(availableActions(h, h.actingId))); }
}
function filtered(h, viewer = 'a') {
  return { id: h.id, settings: { bigBlind: h.bigBlind }, board: [...h.board], bombPot: h.bombPot,
    buttonSeat: h.buttonSeat, smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat,
    players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, startingStack: p.startingStack,
      cards: p.id === viewer || h.result.showdown && !p.folded ? [...p.cards] : [null, null], net: p.stack - p.startingStack, miniNet: 0 })),
    log: structuredClone(h.log), result: structuredClone(h.result) };
}

test('BB formatting preserves small amounts and explicitly marks missing historical blinds', () => {
  assert.equal(formatHandBB(25, 10, { signed: true }), '+2.5 BB');
  assert.equal(formatHandBB(-25, 10, { signed: true }), '-2.5 BB');
  assert.equal(formatHandBB(0, 10, { signed: true }), '0 BB');
  assert.equal(formatHandBB(1, 2000), '0.0005 BB');
  for (const bb of [undefined, null, 0, -1, '10', Infinity]) assert.equal(formatHandBB(1050, bb, { signed: true }), '— BB');
  for (const amount of [undefined, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatHandBB(amount, 10), '—');
});

test('overview has actual five board slots, combined net, positions, no playback controls and does not mutate input', () => {
  const hand = basic(), before = structuredClone(hand), html = renderHandOverview(hand, 'a');
  assert.deepEqual(hand, before);
  const board = html.split('<div class="ho-mine">')[0];
  assert.equal((board.match(/aria-label="本手未发出"/g) || []).length, 2);
  assert.match(html, /我的净盈亏.*\+0\.5 BB/s);
  assert.match(html, /德州 \+1 BB/); assert.match(html, /小游戏 -0.5 BB/);
  assert.match(html, /title="庄家">BTN/); assert.match(html, /title="小盲">SB/); assert.match(html, /title="大盲">BB/);
  assert.doesNotMatch(html, /<button|onclick=|<script/);
});

test('raw stored hands and unfiltered card positions are rejected, including apparently completed ones', () => {
  for (const key of ['deck', 'audit', 'allInLock']) assert.throws(() => renderHandOverview({ ...basic(), [key]: null }, 'a'), /过滤/);
  assert.throws(() => renderHandOverview({ ...basic(), status: 'playing' }, 'a'), /过滤/);
  const hand = basic(); hand.players[0].cardIndices = [0, 2];
  assert.throws(() => renderHandOverview(hand, 'a'), /底牌/);
});

test('each raise and call retains its distinct amount, while numbering follows the complete table order', () => {
  const hand = basic(); hand.players.forEach(p => p.startingStack = 500);
  hand.log = [
    { seq: 999, street: 'preflop', playerId: 'a', type: 'raise', amount: 30, to: 30 },
    { seq: 999, street: 'preflop', playerId: 'b', type: 'raise', amount: 80, to: 80 },
    { seq: 1, street: 'preflop', playerId: 'a', type: 'raise', amount: 130, to: 160 },
    { seq: 1, street: 'preflop', playerId: 'b', type: 'call', amount: 80, to: 160 },
  ];
  const html = renderHandOverview(hand, 'a'), route = html.split('<details')[0], log = html.split('<details')[1];
  assert.match(route, /加注至 3 BB/); assert.match(route, /加注至 8 BB/); assert.match(route, /加注至 16 BB/);
  assert.match(route, /跟注 8 BB/); assert.doesNotMatch(route, /跟注 16 BB/);
  assert.deepEqual([...log.matchAll(/<li value="(\d+)"/g)].map(m => Number(m[1])), [1, 2, 3, 4]);
  assert.match(route, /全桌第 3 条记录/); assert.doesNotMatch(html, /999/);
});

test('real engine all-in logs distinguish the street target from this action contribution', () => {
  const hand = engine([100, 100]); applyAction(hand, hand.actingId, 'allin');
  assert.equal(hand.log.at(-1).amount, 95); assert.equal(hand.log.at(-1).to, 100);
  applyAction(hand, hand.actingId, 'call');
  const html = renderHandOverview(filtered(hand), 'a');
  assert.match(html, /全下至 10 BB（本次投入 9.5 BB）/);
  assert.match(html, /全下跟注 9 BB/);
  assert.match(html, /class="ho-action ho-action-allin"><span class="ho-seq"[^>]*>\d+<\/span><span>全下至 10 BB/);
  assert.match(html, /class="ho-action ho-action-allin"><span class="ho-seq"[^>]*>\d+<\/span><span>全下跟注 9 BB/);
  const raised = engine([100, 100]);
  applyAction(raised, raised.actingId, 'raise', 100);
  assert.equal(raised.log.at(-1).type, 'raise');
  applyAction(raised, raised.actingId, 'call');
  assert.match(renderHandOverview(filtered(raised), 'a'), /class="ho-action ho-action-allin"><span class="ho-seq"[^>]*>\d+<\/span><span>全下加注至 10 BB/);
  const short = basic(); short.log = [{ street: 'preflop', playerId: 'b', type: 'allin', amount: 20, to: 30, isRaise: false }];
  assert.match(renderHandOverview(short, 'a'), /全下跟注 2 BB（本轮共 3 BB）/);
});

test('real engine uncalled raise refund stays in chronological order and does not inflate the pot', () => {
  const hand = engine([100, 100]); applyAction(hand, hand.actingId, 'raise', 80); applyAction(hand, hand.actingId, 'fold');
  const html = renderHandOverview(filtered(hand), 'a'), log = html.split('<details')[1];
  assert.match(html, /加注至 8 BB/); assert.match(html, /退回未跟注 7 BB/);
  assert.match(html, /实际公共牌 · 底池 <strong[^>]*>2 BB/);
  assert.ok(log.indexOf('弃牌') < log.indexOf('退回未跟注'));
  assert.ok(log.indexOf('退回未跟注') < log.indexOf('获得底池'));
  assert.match(html, /主池 · 2 BB/);
});

test('side pots allocate each pot separately with the stored odd-point winner order', () => {
  const hand = basic(); hand.result = { showdown: true, payouts: { a: 90, b: 51 }, pots: [
    { amount: 101, winnerIds: ['b', 'a'] }, { amount: 40, winnerIds: ['a'] } ] };
  const html = renderHandOverview(hand, 'a'), pots = html.split('<div class="ho-pots">')[1];
  assert.match(pots, /主池 · 10.1 BB.*乙 获得 5.1 BB · 甲 获得 5 BB/s);
  assert.match(pots, /边池 1 · 4 BB.*甲 获得 4 BB/s);
  assert.doesNotMatch(pots, /甲 获得 9 BB/);
});

test('real multiway all-in side pots and short bomb antes render without creating fictitious blind posts', () => {
  const hand = engine([15, 100, 500], { ante: 20, bombPot: true });
  finish(hand, a => a.canAllIn ? 'allin' : a.canCheck ? 'check' : 'call');
  assert.ok(hand.result.pots.length > 1);
  const html = renderHandOverview(filtered(hand), 'a');
  assert.match(html, /炸弹池 · 直接从翻牌开始/); assert.match(html, /前注 1.5 BB/); assert.match(html, /前注 2 BB/);
  assert.match(html, /边池 1/); assert.doesNotMatch(html, /title="小盲"|title="大盲"|小盲 0.5 BB|大盲 1 BB/);
});

test('entry blinds, dead small blind and antes remain distinguishable and dead blinds never become a call', () => {
  const hand = engine([100, 100, 100], { ante: 2, entryPosts: [{ playerId: 'a', live: 10, dead: 5 }] });
  finish(hand);
  const html = renderHandOverview(filtered(hand), 'a');
  assert.match(html, /前注 0.2 BB/); assert.match(html, /补大盲 1 BB/); assert.match(html, /补小盲 0.5 BB（不抵跟注）/);
});

test('partial shown cards remain partial and never derive hidden ranks or private card payloads', () => {
  const hand = basic(); hand.players[1].cards = ['Qd', null];
  hand.players[1].hiddenCards = ['Ks', 'Kd'];
  hand.result.handNames = { b: '隐藏牌型SECRET' };
  hand.log.push({ type: 'show', playerId: 'b', street: 'flop', cards: ['Ks', 'Kd'] });
  hand.log.push({ type: 'street', street: 'river', board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] });
  const html = renderHandOverview(hand, 'a');
  assert.match(html, /aria-label="方块 Q"/); assert.match(html, /aria-label="未公开底牌"/);
  assert.doesNotMatch(html, /隐藏牌型SECRET|黑桃 K|方块 K|黑桃 Q|黑桃 J|黑桃 10/);
});

test('rabbit cards fill the final board slots while keeping distinct non-result markings and rejecting invalid additions', () => {
  const hand = basic(); hand.rabbit = { originalCount: 3, board: [...hand.board, '5c', '6s'] };
  const before = structuredClone(hand), html = renderHandOverview(hand, 'a');
  const board = html.split('<div class="ho-mine">')[0];
  assert.match(html, /补看余牌/); assert.match(html, /手牌已结束，不计输赢/); assert.match(html, /aria-label="黑桃 6"/);
  assert.match(board, /aria-label="黑桃 6"/); assert.match(board, /aria-label="梅花 5"/);
  assert.equal((board.match(/class="ho-supplemental"/g) || []).length, 2);
  assert.equal((board.match(/aria-label="本手未发出"/g) || []).length, 0);
  assert.deepEqual(hand, before);
  for (const board of [['Ac', '3d', '4h', '5c', '6s'], [...hand.board, '2c', '6s']]) {
    assert.doesNotMatch(renderHandOverview({ ...hand, rabbit: { originalCount: 3, board } }, 'a'), /ho-rabbit/);
  }
  hand.result.showdown = true; assert.doesNotMatch(renderHandOverview(hand, 'a'), /ho-rabbit/);
});

test('a just-settled history marks pending public cards and never invents the missing turn or river', () => {
  const hand = basic(); hand.rabbit = { originalCount: 3, board: [...hand.board], active: true };
  const html = renderHandOverview(hand, 'a'), board = html.split('<div class="ho-mine">')[0];
  assert.equal((board.match(/aria-label="等待补看余牌"/g) || []).length, 2);
  assert.match(html, /余牌稍后自动更新/); assert.doesNotMatch(html, /class="ho-supplemental"/);
  hand.rabbit.board.push('5c');
  const partial = renderHandOverview(hand, 'a').split('<div class="ho-mine">')[0];
  assert.equal((partial.match(/aria-label="等待补看余牌"/g) || []).length, 1);
  assert.equal((partial.match(/class="ho-supplemental"/g) || []).length, 1);
});

test('an ordinary river showdown shows all five actual cards without supplemental labels', () => {
  const h = engine([1000, 1000]); finish(h);
  const record = filtered(h), html = renderHandOverview(record, 'a').split('<div class="ho-mine">')[0];
  assert.equal(record.board.length, 5);
  assert.equal((html.match(/class="ho-card /g) || []).length, 5);
  assert.doesNotMatch(html, /ho-supplemental|本手未发出|等待补看/);
});

test('a viewer absent from the dealt players still sees their actual fish payout without invented hole cards', () => {
  const hand = basic(); hand.mini.changes.c = 40;
  const html = renderHandOverview(hand, 'c');
  assert.match(html, /未参与发牌 · 鱿鱼结算/); assert.match(html, /小游戏 \+4 BB/);
  assert.match(html, /德州 0 BB/);
  assert.equal((html.match(/<article class="ho-player/g) || []).length, 2);
  assert.match(renderHandOverview(hand, 'd'), /本手未参与/);
});

test('all user text is escaped; unknown event fields are not printed or executed', () => {
  const hand = basic(); hand.players[0].name = '<img src=x onerror="alert(1)">';
  hand.log.push({ type: '<script>SECRET</script>', street: 'flop', playerId: 'a', text: '<svg onload=alert(1)>' });
  const html = renderHandOverview(hand, 'a');
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<script|<svg|SECRET|onload=/);
  hand.players[1].cards[0] = '<img src=x>';
  assert.throws(() => renderHandOverview(hand, 'a'), /底牌/);
});

test('historical missing position and blind values do not invent tags or hide real point amounts', () => {
  setDisplayUnit('points');
  const hand = basic(); delete hand.settings; delete hand.buttonSeat; delete hand.smallBlindSeat; delete hand.bigBlindSeat;
  hand.players.forEach(p => delete p.seat);
  const html = renderHandOverview(hand, 'a');
  assert.match(html, /\+5 积分/); assert.match(html, /底池 <strong[^>]*>20 积分/);
  assert.match(html, /座位未记录/); assert.doesNotMatch(html, />BTN<|>SB<|>BB</);
});

test('a timeout after the engine changes streets annotates its original preflop check only', () => {
  const hand = engine([100, 100]);
  applyAction(hand, hand.actingId, 'call');
  const actor = hand.actingId, number = hand.log.length + 1;
  applyAction(hand, actor, 'check');
  assert.equal(hand.street, 'flop');
  assert.equal(hand.log[number - 1].type, 'check');
  assert.equal(hand.log.at(-1).type, 'street');
  const timeoutNumber = hand.log.length + 1;
  hand.log.push({ seq: timeoutNumber, street: hand.street, playerId: actor, type: 'timeout', amount: 0 });
  finish(hand);
  const record = filtered(hand), before = structuredClone(record), rendered = renderHandOverview(record, 'a');
  assert.match(rendered, /过牌<small class="ho-timeout">（超时）<\/small>/);
  const html = rendered.replace(/<small class="ho-timeout">（超时）<\/small>/g, '（超时）');
  assert.deepEqual(record, before);
  const player = html.split(`aria-label="${actor === 'a' ? '甲' : '乙'}的操作路线">`)[1].split('</article>')[0];
  const preflop = player.split('<h4>翻前</h4>')[1].split('<h4>翻牌</h4>')[0];
  const flop = player.split('<h4>翻牌</h4>')[1].split('<h4>转牌</h4>')[0];
  assert.match(preflop, new RegExp(`全桌第 ${number} 条记录[^]*过牌（超时）`));
  assert.doesNotMatch(flop, /超时/);
  assert.equal((html.match(/过牌（超时）/g) || []).length, 2);
  assert.doesNotMatch(html, /超时自动处理|实际操作见前一条/);
  assert.doesNotMatch(html, new RegExp(`<li value="${timeoutNumber}"`));
  assert.match(html, new RegExp(`<li value="${timeoutNumber + 1}"`));
});

test('a timeout appended after fold and payout annotates the fold without adding a settlement action', () => {
  const hand = engine([100, 100]), actor = hand.actingId, number = hand.log.length + 1;
  applyAction(hand, actor, 'fold');
  assert.equal(hand.status, 'complete'); assert.equal(hand.log.at(-1).type, 'payout');
  const timeoutNumber = hand.log.length + 1;
  hand.log.push({ seq: timeoutNumber, street: hand.street, playerId: actor, type: 'timeout', amount: 0 });
  const rendered = renderHandOverview(filtered(hand), 'a');
  assert.match(rendered, /弃牌<small class="ho-timeout">（超时）<\/small>/);
  const html = rendered.replace(/<small class="ho-timeout">（超时）<\/small>/g, '（超时）'), log = html.split('<details')[1];
  assert.match(html, new RegExp(`全桌第 ${number} 条记录[^]*弃牌（超时）`));
  assert.equal((html.match(/弃牌（超时）/g) || []).length, 2);
  assert.ok(log.indexOf('弃牌（超时）') < log.indexOf('获得底池'));
  assert.doesNotMatch(log, new RegExp(`<li value="${timeoutNumber}"`));
  assert.doesNotMatch(html, /超时自动处理|实际操作见前一条/);
});

test('unmatched or repeated timeout stays informational, never invents a check/fold or enters a player route', () => {
  const hand = basic(); hand.log = [
    { playerId: 'a', type: 'timeout', street: 'preflop', amount: 0 },
    { playerId: 'b', type: 'check', street: 'preflop' },
    { playerId: 'a', type: 'timeout', street: 'flop', amount: 0 },
    { playerId: 'b', type: 'timeout', street: 'flop', amount: 0 },
    { playerId: 'b', type: 'timeout', street: 'flop', amount: 0 },
  ];
  const html = renderHandOverview(hand, 'a').replace(/<small class="ho-timeout">（超时）<\/small>/g, '（超时）'), [route, log] = html.split('<details');
  assert.equal((route.match(/过牌（超时）/g) || []).length, 1);
  assert.doesNotMatch(route, /超时自动处理/);
  assert.equal((log.match(/超时自动处理/g) || []).length, 3);
  assert.deepEqual([...log.matchAll(/<li value="(\d+)"/g)].map(m => Number(m[1])), [1, 2, 3, 5]);
  assert.doesNotMatch(html, /（超时）（超时）|实际操作见前一条/);
});

test('nine-player unlimited history shows its archived fish snapshot without mixing it into the poker pot',()=>{
  const hand=basic();for(let i=2;i<9;i++)hand.players.push({id:'p'+i,name:'玩家'+i,seat:i,startingStack:1000,net:0,miniNet:0,cards:[null,null]});
  hand.squidRound=2;hand.squidMode='unlimited';hand.squidTokenBudget=12;hand.squidAwardedId='a';hand.squidCounts=Object.fromEntries(hand.players.map((p,i)=>[p.id,i===0?3:i===1?1:0]));
  const before=structuredClone(hand),html=renderHandOverview(hand,'a');
  assert.match(html,/无限鱿鱼 · 第 2 轮/);assert.match(html,/本轮已拿 4 \/ 12 条鱼，7 人无鱼/);assert.match(html,/甲 本手拿到 1 条鱼/);assert.match(html,/>鱼×3 · 本手＋1</);
  assert.equal((html.match(/本手结束时的本轮鱼数/g)||[]).length,9);assert.match(html,/底池 <strong title="2 BB">2 BB/);assert.match(html,/德州 \+1 BB/);assert.match(html,/小游戏 -0.5 BB/);assert.match(html,/未公开底牌/);assert.deepEqual(hand,before);
});

test('old ordinary history stays readable and missing fish snapshots never invent counts',()=>{
  const hand=basic();hand.squidRound=1;let html=renderHandOverview(hand,'a');assert.match(html,/普通鱿鱼 · 第 1 轮/);assert.doesNotMatch(html,/ho-fish-count|ho-fish-summary/);
  hand.squidMode='unlimited';hand.squidTokenBudget=12;hand.squidCounts={a:NaN,b:-1};html=renderHandOverview(hand,'a');assert.doesNotMatch(html,/ho-fish-count|ho-fish-summary|NaN/);
});
