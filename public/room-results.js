import { formatChips } from './money.js';
import { avatarMarkup } from './avatar.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const amount = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const resultClass = value => value > 0 ? 'positive' : value < 0 ? 'negative' : 'even';

// Cash-out is final only after the room closes and all squid reserves settle.
// room.players includes departed members; seats and last-hand players do not.
export function roomResults(room) {
  if (room?.status !== 'closed') return null;
  const players = (room.players || []).filter(p => amount(p.totalBuyIn) > 0).map(p => {
    const buyIn = amount(p.totalBuyIn), net = amount(p.sessionProfit);
    return { id: p.id, name: p.name, avatar: p.avatar, avatarImage: p.avatarImage,
      buyIn, net, cashOut: net === null ? null : buyIn + net, mine: p.id === room.meId };
  }).sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity) || Number(b.mine) - Number(a.mine));
  return { players, mine: players.find(p => p.mine), hands: Math.max(0, Number(room.hand?.number) || 0) };
}

export function renderRoomResults(room, { unitToggle = '' } = {}) {
  const result = roomResults(room);
  if (!result) return '';
  const bb = room.settings?.bigBlind, chips = (n, signed = false) => esc(formatChips(n, bb, { signed }));
  const label = n => n === null ? '待同步' : n > 0 ? '水上' : n < 0 ? '水下' : '持平';
  const me = result.mine;
  return `<main class="room-shell room-results" data-room="${esc(room.code)}" data-room-view="results">
    <header class="results-heading"><div><span class="results-eyebrow">本场已结束</span><h1>本场战绩</h1><p>${esc(room.name)}</p></div>${unitToggle}</header>
    <div class="results-scroll" tabindex="0" aria-label="本场所有玩家战绩">
      ${me ? `<section class="results-mine ${resultClass(me.net)}" aria-label="我的本场战绩"><div><span>我的净盈亏 · ${label(me.net)}</span><strong>${chips(me.net, true)}</strong></div><dl><div><dt>累计带入</dt><dd>${chips(me.buyIn)}</dd></div><div><dt>累计收回</dt><dd>${chips(me.cashOut)}</dd></div></dl></section>` : ''}
      <div class="results-list-heading"><h2>全员战绩</h2><span>${result.players.length} 人 · ${result.hands} 手</span></div>
      <ol class="results-list">${result.players.map(p => `<li class="results-player ${p.mine ? 'is-mine' : ''}" data-result-player="${esc(p.id)}"><div class="results-player-top"><div class="results-player-name">${avatarMarkup(p, 'result-avatar')}<strong title="${esc(p.name)}">${esc(p.name)}</strong>${p.mine ? '<span class="results-you">我</span>' : ''}</div><div class="results-profit ${resultClass(p.net)}"><small>${label(p.net)}</small><strong>${chips(p.net, true)}</strong></div></div><dl><div><dt>累计带入</dt><dd>${chips(p.buyIn)}</dd></div><div><dt>累计收回</dt><dd>${chips(p.cashOut)}</dd></div></dl></li>`).join('')}</ol>
      ${!result.players.length ? '<p class="results-empty">本场没有玩家带入筹码。</p>' : ''}
      <p class="results-note">净盈亏＝累计收回－累计带入。包含德州和鱿鱼结算，中途离座、返桌和补码已合并。</p>
    </div>
    <footer class="results-footer"><button type="button" class="outline" data-action="history" ${result.hands ? '' : 'disabled'}>查看本场牌谱</button><button type="button" class="primary" data-action="lobby">返回大厅</button></footer>
  </main>`;
}
