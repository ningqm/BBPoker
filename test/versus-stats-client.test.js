import test from 'node:test';
import assert from 'node:assert/strict';
import { renderVersusStats } from '../public/versus-stats.js';

const rate = (count, opportunities) => ({ count, opportunities, percent: opportunities ? Math.round(count / opportunities * 1000) / 10 : null });
const fixture = () => ({
  sharedHands: 40,
  headsUp: { hands: 12, netBB: 7.5, bbHands: 12, bbComplete: true, profitRate: rate(7, 12) },
  showdown: { hands: 6, wins: 3, losses: 2, ties: 1 },
  responses: { mine: { fold: rate(2, 10), call: rate(5, 10), raise: rate(3, 10) }, opponent: { fold: rate(4, 10), call: rate(6, 10), raise: rate(0, 10) } },
  threeBet: { mine: rate(1, 3), opponent: rate(2, 8) },
  allIn: { eligibleHands: 4, hands: 3, unavailableHands: 1, estimatedHands: 2, actualNetBB: -12, expectedNetBB: -4, differenceBB: -8, bbHands: 3, bbComplete: true },
  coverage: { flopUnknownHands: 0, actionUnknownHands: 0, showdownUnknownHands: 0, allInUnknownHands: 0 },
});

test('opponent comparison defaults to three readable summaries and keeps extended rates collapsed', () => {
  const html = renderVersusStats(fixture());
  assert.match(html, /本桌相遇 40 手/);
  assert.match(html, /翻后单挑/);
  assert.match(html, /12 <small>手/);
  assert.match(html, /class="positive">\+7.5 <small>BB/);
  assert.match(html, /盈利手率 58.3%/);
  assert.match(html, /单挑摊牌 · 我的胜 \/ 负 \/ 平/);
  assert.match(html, /<details class="versus-more"><summary>/);
  assert.doesNotMatch(html, /<details[^>]+open/);
  assert.match(html, /可能包含第三人此前投入/);
  assert.match(html, /单挑样本较少/);
});

test('the same data follows the current table or career scope explicitly', () => {
  const table = renderVersusStats(fixture(), { scope: 'table' });
  const career = renderVersusStats(fixture(), { scope: 'career' });
  assert.match(table, /只统计这张桌上/);
  assert.match(career, /累计相遇 40 手/);
  assert.match(career, /所有对局中，你们共同参与/);
  assert.doesNotMatch(career, /只统计这张桌上/);
});

test('opponent and viewer action rates have directional labels and opportunity denominators', () => {
  const html = renderVersusStats(fixture());
  assert.match(html, /对方面对我的下注/);
  assert.match(html, /我面对对方的下注/);
  assert.match(html, /40%<\/strong><small>4 \/ 10 次/);
  assert.match(html, /0%<\/strong><small>0 \/ 10 次/);
  assert.match(html, /我首次加注 → 对方再加注/);
  assert.match(html, /25%<\/strong><small>2 \/ 8 次/);
  assert.match(html, /对方首次加注 → 我再加注/);
  assert.match(html, /33.3%<\/strong><small>1 \/ 3 次/);
  assert.match(html, /恰好剩下你们两人未弃牌的决策，翻前、翻后都算/);
  assert.doesNotMatch(html, /翻前、翻后及多人阶段/);
  assert.match(html, /盲注和过牌不计/);
});

test('no opportunities remain unknown while observed zeros remain real zero values', () => {
  const data = fixture();
  data.headsUp.netBB = 0;
  data.responses.mine.fold = rate(0, 0);
  data.threeBet.mine = rate(0, 0);
  const html = renderVersusStats(data);
  assert.match(html, /class="muted">0 <small>BB/);
  assert.match(html, /—<\/strong><small>0 \/ 0 次/);
  assert.match(html, /0%<\/strong><small>0 \/ 10 次/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('empty and self comparisons never imply a measured zero profit or expose unknown data', () => {
  assert.equal(renderVersusStats(null), '');
  assert.equal(renderVersusStats(undefined), '');
  const empty = renderVersusStats({ sharedHands: 0, headsUp: { hands: 0, netBB: 0 }, allIn: { hands: 0, actualNetBB: 0, expectedNetBB: 0, differenceBB: 0 } });
  assert.match(empty, /本桌相遇 0 手/);
  assert.match(empty, /class="muted">— <small>BB/);
  assert.match(empty, /还没有翻后单挑记录/);
  assert.match(empty, /还没有可计算的双人全下跑牌记录/);
});

test('all-in values retain signs and communicate estimates, missing snapshots and small samples', () => {
  const html = renderVersusStats(fixture());
  assert.match(html, /class="negative">-12 <small>BB/);
  assert.match(html, /class="negative">-4 <small>BB/);
  assert.match(html, /class="negative">-8 <small>BB/);
  assert.match(html, /3 手有期望记录，其中 2 手期望为估算/);
  assert.match(html, /另有 1 手缺少有效的全下期望记录/);
  assert.match(html, /三项使用同一批全下手牌/);
  assert.match(html, /不代表直接从对方赢取的积分/);
  assert.match(html, /小游戏盈亏不计入/);
});

test('incomplete archives hide BB sums and identify affected metric coverage', () => {
  const data = fixture();
  data.headsUp.bbComplete = false;
  data.allIn.bbComplete = false;
  data.coverage = { flopUnknownHands: 2, actionUnknownHands: 4, showdownUnknownHands: 1, allInUnknownHands: 3 };
  const html = renderVersusStats(data);
  assert.doesNotMatch(html, /\+7.5|>-12 <small>BB/);
  assert.match(html, /部分历史记录无法换算 BB/);
  assert.match(html, /BB 合计暂不展示/);
  assert.match(html, /翻后单挑 2 手、下注应对 \/ 3-Bet 4 手、摊牌 1 手、全下跑牌 3 手/);
});

test('tiny nonzero BB values retain direction and raw/private payload fields are never rendered', () => {
  const data = fixture();
  data.headsUp.netBB = -0.0002;
  data.cards = ['As', 'Ks'];
  data.name = '<script>private</script>';
  data.hands = [{ id: 'private-hand-id', cards: ['Qh', 'Jh'] }];
  const html = renderVersusStats(data, { scope: '<script>evil</script>' });
  assert.match(html, /class="negative">-0.0002 <small>BB/);
  assert.doesNotMatch(html, /<script>|private-hand-id|As|Ks|Qh|Jh/);
});
