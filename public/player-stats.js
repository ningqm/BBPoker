import { STATS_METRICS } from './stats.js';
import { avatarMarkup } from './avatar.js';
import { renderVersusStats } from './versus-stats.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—';
function metric(key, values = {}) {
  const definition = STATS_METRICS[key], m = values[key], samples = Number(m?.opportunities) || 0;
  const value = samples && Number.isFinite(m?.percent) ? `${number(m.percent)}%` : '—';
  return `<details class="player-stat"><summary><span>${esc(definition.label)}${definition.short ? ` <small>${esc(definition.short)}</small>` : ''}</span><strong>${value}</strong><small>${number(m?.count || 0)} / ${number(samples)} ${['vpip','pfr','winRate'].includes(key) ? '手' : '次机会'}</small></summary><p>${esc(definition.description)}</p></details>`;
}
export function renderPlayerStats(view) {
  const { data, loading, error, scope = 'table', player = {} } = view;
  const source = data?.player || player;
  const header = `<header class="player-stats-profile">${avatarMarkup(source)}<div><strong>${esc(source.name || '牌友')}</strong><small>${scope === 'career' ? '这位选手全部已结算手牌' : '这张牌桌的已结算手牌'}</small></div></header>`;
  const scopes = `<div class="player-stats-scopes" role="group" aria-label="选手数据统计范围">${[['table','本桌数据'],['career','累计数据']].map(([key,label]) => `<button type="button" class="${key === scope ? 'selected' : 'outline'}" data-action="player-stats-scope" data-scope="${key}" aria-pressed="${key === scope}">${label}</button>`).join('')}</div>`;
  let body;
  if (loading) body = '<p class="player-stats-empty" role="status">正在读取选手数据…</p>';
  else if (error) body = `<div class="player-stats-empty" role="alert"><p>${esc(error)}</p><button type="button" class="outline" data-action="player-stats-retry">重试</button></div>`;
  else {
    const hands = Number(data?.hands) || 0;
    body = `<div class="player-stats-sample"><strong>${number(hands)} <small>手</small></strong><span>${hands === 0 ? '这个范围还没有记录' : hands < 100 ? '样本较少，先作参考' : '已完成手牌'}</span></div><div class="player-stats-grid">${['winRate','vpip','pfr','threeBet'].map(key => metric(key,data?.metrics)).join('')}</div><details class="player-stats-more"><summary>更多指标 · 开池 / 4-bet / 5-bet / 摊牌</summary><div class="player-stats-grid">${['rfi','fourBet','fiveBet','wtsd','wsd'].map(key => metric(key,data?.metrics)).join('')}</div></details><p class="note">点指标查看含义。盈利手率按德州净盈利统计；翻前指标使用 ${number(data?.preflopHands || 0)} 手普通德州记录，炸弹池不计入。</p>`;
  }
  return `<section class="player-stats-card">${header}${scopes}${body}${!loading && !error ? renderVersusStats(data?.versus, { scope }) : ''}<p class="privacy-footnote">只展示汇总指标，不展示私人牌谱或未公开底牌。</p></section>`;
}
