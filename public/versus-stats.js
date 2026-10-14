const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 0) => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const signed = value => finite(value) ? `${value > 0 ? '+' : ''}${number(value, Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 6 : 2)}` : '—';
const tone = value => finite(value) && value > 0 ? 'positive' : finite(value) && value < 0 ? 'negative' : 'muted';
const rate = value => value?.opportunities > 0 && finite(value.percent) ? `${number(value.percent, 1)}%` : '—';
const sample = value => `${number(value?.count ?? 0)} / ${number(value?.opportunities ?? 0)} 次`;

function responses(title, values = {}) {
  return `<section class="versus-responses"><h5>${title}</h5><div class="versus-response-grid">${[['fold', '弃牌'], ['call', '跟注'], ['raise', '加注']].map(([key, label]) => `<div><span>${label}</span><strong>${rate(values[key])}</strong><small>${sample(values[key])}</small></div>`).join('')}</div></section>`;
}

function threeBet(title, value) {
  return `<div class="versus-threebet"><span>${title}</span><strong>${rate(value)}</strong><small>${sample(value)}</small></div>`;
}

function allInMetric(label, value, count) {
  const amount = count > 0 ? value : null;
  return `<div><span>${label}</span><strong class="${tone(amount)}">${signed(amount)} <small>BB</small></strong></div>`;
}

/** Aggregated results only: no hand IDs, opponent hole cards or private histories. */
export function renderVersusStats(data, { scope = 'table' } = {}) {
  // The service returns null for the viewer's own avatar.
  if (!data || typeof data !== 'object') return '';
  const headsUp = data.headsUp || {}, showdown = data.showdown || {}, allIn = data.allIn || {}, coverage = data.coverage || {};
  const hands = finite(headsUp.hands) ? headsUp.hands : 0;
  const profit = hands > 0 && headsUp.bbComplete !== false ? headsUp.netBB : null;
  const bbMissing = headsUp.bbComplete === false && hands > 0;
  const summary = `<div class="versus-summary"><div class="versus-summary-item"><span>翻后单挑</span><strong>${number(hands)} <small>手</small></strong><small>只有你们两人进入翻牌</small></div><div class="versus-summary-item"><span>我的单挑盈亏</span><strong class="${tone(profit)}">${signed(profit)} <small>BB</small></strong><small>${bbMissing ? '部分历史记录无法换算 BB' : hands ? `盈利手率 ${rate(headsUp.profitRate)}` : '还没有翻后单挑记录'}</small></div><div class="versus-summary-item versus-showdown"><span>单挑摊牌 · 我的胜 / 负 / 平</span><strong><b class="positive">${number(showdown.wins ?? 0)}</b><i>/</i><b class="negative">${number(showdown.losses ?? 0)}</b><i>/</i><b class="muted">${number(showdown.ties ?? 0)}</b></strong><small>只算最终两人亮牌比大小，多人摊牌不计</small></div></div>`;
  const sampleNote = hands < 30 ? '<p class="versus-note versus-sample-note">单挑样本较少，先作参考；没有机会的比率显示「—」。</p>' : '';
  const allInNote = allIn.hands > 0
    ? `${number(allIn.hands)} 手有期望记录${allIn.estimatedHands > 0 ? `，其中 ${number(allIn.estimatedHands)} 手期望为估算` : ''}。${allIn.hands < 30 ? '样本较少，不能据此判断运气或打法。' : ''}`
    : '还没有可计算的双人全下跑牌记录。';
  const allInCoverage = allIn.unavailableHands > 0 ? `<p class="versus-note">另有 ${number(allIn.unavailableHands)} 手缺少有效的全下期望记录，未计入以上比较。</p>` : '';
  const missingBB = allIn.bbComplete === false && allIn.hands > 0 ? '<p class="versus-note">部分全下记录缺少历史大盲或金额，BB 合计暂不展示。</p>' : '';
  const incomplete = [['flopUnknownHands', '翻后单挑'], ['actionUnknownHands', '下注应对 / 3-Bet'], ['showdownUnknownHands', '摊牌'], ['allInUnknownHands', '全下跑牌']].filter(([key]) => coverage[key] > 0).map(([key, label]) => `${label} ${number(coverage[key])} 手`).join('、');
  const allInCount = allIn.bbComplete === false ? 0 : allIn.hands;
  return `<section class="versus-stats" aria-label="与你对抗"><header class="versus-heading"><h3>与你对抗</h3><span>${scope === 'career' ? '累计相遇' : '本桌相遇'} ${number(data.sharedHands ?? 0)} 手</span></header><p class="versus-note">${scope === 'career' ? '统计所有对局中，你们共同参与的已结算手牌。' : '只统计这张桌上，你们共同参与的已结算手牌。'}</p>${summary}<p class="versus-note">盈亏是我的整手净盈亏，可能包含第三人此前投入的筹码。</p>${sampleNote}<details class="versus-more"><summary>更多对抗数据 · 应对 / 3-Bet / 全下</summary><section class="versus-section"><h4>面对彼此下注</h4>${responses('对方面对我的下注', data.responses?.opponent)}${responses('我面对对方的下注', data.responses?.mine)}<p class="versus-note">只计行动时恰好剩下你们两人未弃牌的决策，翻前、翻后都算。需要补跟对方主动下注才计入，盲注和过牌不计；同一手可以有多次应对。</p></section><section class="versus-section"><h4>针对彼此的 3-Bet</h4><div class="versus-threebet-grid">${threeBet('我首次加注 → 对方再加注', data.threeBet?.opponent)}${threeBet('对方首次加注 → 我再加注', data.threeBet?.mine)}</div><p class="versus-note">面对对方的翻前首轮加注，再加注次数 / 有权再加注的机会。不是除以共同手数；炸弹池不计。</p></section><section class="versus-section"><h4>双人 All-in · 我的跑牌结果</h4><div class="versus-allin-grid">${allInMetric('实际净盈利', allIn.actualNetBB, allInCount)}${allInMetric('期望净盈利', allIn.expectedNetBB, allInCount)}${allInMetric('实际 − 期望', allIn.differenceBB, allInCount)}</div><p class="versus-note">${allInNote}</p><p class="versus-note">三项使用同一批全下手牌；正差额表示跑赢期望，负差额表示跑输。</p>${allInCoverage}${missingBB}</section>${incomplete ? `<p class="versus-note versus-coverage">部分旧牌谱信息不完整，以下记录未计入对应指标：${incomplete}。</p>` : ''}<p class="versus-note versus-definition">单挑盈亏和全下净盈利，均为对应手牌中你的整手德州净额，按每手当时的大盲换算；可能包含其他人此前投入的筹码，不代表直接从对方赢取的积分。小游戏盈亏不计入。</p></details></section>`;
}
