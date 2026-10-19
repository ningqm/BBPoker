import { formatChips } from './money.js';

const TYPES = new Set(['bomb-start', 'squid-start', 'squid-end']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const squidName = mode => mode === 'unlimited' ? '无限鱿鱼' : '鱿鱼';

// Decoration is selected from already-public events. There are no commands,
// timers, sounds, or private-card reads in this renderer.
export function tableModeNotice(events = [], { now = Date.now(), room } = {}) {
  if (!Array.isArray(events) || !finite(now)) return null;
  const active = events.filter(event => event && TYPES.has(event.type) && typeof event.id === 'string' &&
    event.id.length > 0 && event.id.length <= 240 && finite(event.at) && finite(event.until) &&
    event.until > event.at && event.until - event.at <= 5000 && event.at <= now && now < event.until &&
    (!room || room.status !== 'closed' || event.type === 'squid-end')).sort((a, b) => b.at - a.at);
  const latest = active.find(e=>e.type!=='squid-end'||!room?.hand||room.hand.status!=='playing');
  if (!latest) return null;
  const starts = latest.type !== 'squid-end' ? active.filter(event => event.type !== 'squid-end' &&
    event.handId && event.handId === latest.handId && Math.abs(event.at - latest.at) < 1100) : [];
  const bomb = starts.find(event => event.type === 'bomb-start') || (latest.type === 'bomb-start' ? latest : null);
  const squid = starts.find(event => event.type === 'squid-start') || (latest.type === 'squid-start' ? latest : null);
  const merged = Boolean(bomb && squid), source = merged ? [bomb, squid] : [latest];
  const bb = latest.bigBlind ?? room?.settings?.bigBlind;
  const points = (value, signed = false) => formatChips(value, bb, { signed });
  const round = integer(latest.round) && latest.round ? `第 ${latest.round} 轮` : '';
  let title, detail, tone = latest.type === 'bomb-start' ? 'bomb' : 'squid';
  if (merged) {
    title = `炸弹池 × ${squidName(squid.mode)}`;
    detail = finite(bomb.ante) ? `每人 ${points(bomb.ante)}` : '同时开场';
    tone = 'combined';
  } else if (latest.type === 'bomb-start') {
    title = '炸弹池开场';
    detail = finite(latest.ante) ? `每人 ${points(latest.ante)} · 直接翻牌` : '直接进入翻牌';
  } else if (latest.type === 'squid-start') {
    title = `新一轮 ${squidName(latest.mode)}`;
    detail = [round, integer(latest.tokenBudget) ? `${latest.tokenBudget} 条鱼` : '新一轮开始'].filter(Boolean).join(' · ');
  } else {
    title = `${round ? round + ' ' : ''}${squidName(latest.mode)}结算`;
    detail = finite(latest.ownDelta) ? `本轮 ${points(latest.ownDelta, true)}` : '结算完成';
  }
  return {
    key: source.map(event => event.id).sort().join('|'), type: merged ? 'combined-start' : latest.type,
    title, detail, tone, positive: latest.type === 'squid-end' && finite(latest.ownDelta) && latest.ownDelta > 0,
    negative: latest.type === 'squid-end' && finite(latest.ownDelta) && latest.ownDelta < 0,
    at: Math.min(...source.map(event => event.at)), until: Math.min(...source.map(event => event.until)),
    glyph: merged ? '💣🐙' : latest.type === 'bomb-start' ? '💣' : latest.type === 'squid-end' ? '✓' : '🐙',
  };
}

function cleanHost(host) {
  if (!host) return;
  host.querySelector('.table-mode-notice')?.remove();
  host.classList.remove('has-mode-notice', 'mode-notice-results');
}

/** Pass #app or .room-shell. The existing summary row temporarily carries the
 * notice, so it never covers cards, changes table height, or blocks clicks.
 * Call during ordinary render/tick. Expiration is also enforced in reduced
 * motion mode; remounting resumes at event age rather than replaying entrance.
 */
export function mountTableModeEffects(root, events = [], { enabled = true, animated = true, now = Date.now(), room } = {}) {
  if (!root?.ownerDocument || !root.querySelectorAll) return;
  const hosts = [...root.querySelectorAll('.has-mode-notice')];
  const doc = root.ownerDocument;
  const notice = enabled && doc.visibilityState !== 'hidden' ? tableModeNotice(events, { now, room }) : null;
  const host = root.querySelector('.room-status-bar') || root.querySelector('.results-heading p');
  for (const old of hosts) if (old !== host || !notice) cleanHost(old);
  const oldCard = root.querySelector('.squid-settlement-live');
  const result = room?.mini?.squid?.lastResult;
  const showResult = notice?.type === 'squid-end' && room?.hand?.status === 'complete' && result?.round;
  if (!showResult) oldCard?.remove();
  else {
    const dock = root.querySelector('.table-bottom');
    if (dock) { const card = oldCard || doc.createElement('div'); card.className='squid-settlement-live'; card.setAttribute('role','status'); const html=renderSquidResult(result,room,{compact:true}); if(card.innerHTML!==html)card.innerHTML=html; if(!oldCard)dock.append(card); }
  }
  if (!notice || !host) return;
  const results = host.matches('.results-heading p');
  let node = host.querySelector('.table-mode-notice');
  if (node?.dataset.modeEvent !== notice.key) { node?.remove(); node = null; }
  host.classList.add('has-mode-notice');
  host.classList.toggle('mode-notice-results', results);
  if (!node) {
    node = doc.createElement('span'); node.className = 'table-mode-notice'; node.dataset.modeEvent = notice.key;
    node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); node.setAttribute('aria-atomic', 'true');
    const icon = doc.createElement('span'); icon.className = 'table-mode-icon'; icon.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('strong'); title.className = 'table-mode-title';
    const detail = doc.createElement('span'); detail.className = 'table-mode-detail';
    node.append(icon, title, detail); host.append(node);
    node.style.setProperty('--mode-duration', `${notice.until - notice.at}ms`);
    node.style.setProperty('--mode-age', `${Math.max(0, now - notice.at)}ms`);
    node.addEventListener('animationend', event => {
      // Tick performs removal with the shared server clock. A CSS animation
      // finishing does not re-arm the event on the next tick or full rerender.
      if (event.target === node && event.animationName === 'table-mode-lifetime') node.dataset.modeFinished = 'true';
    });
  }
  node.dataset.modeType = notice.type;
  node.className = `table-mode-notice mode-${notice.tone}${animated ? ' is-animated' : ''}${notice.positive ? ' is-positive' : ''}${notice.negative ? ' is-negative' : ''}`;
  node.dataset.modeUntil = String(notice.until);
  const update = (selector, value) => { const element = node.querySelector(selector); if (element.textContent !== value) element.textContent = value; };
  update('.table-mode-icon', notice.glyph); update('.table-mode-title', results ? '鱿鱼结算' : notice.title); update('.table-mode-detail', notice.detail);
}

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderSquidResult(result, room, {compact=false}={}) {
  if (!result || !result.changes || !Number.isSafeInteger(result.round)) return '';
  const names = new Map((room?.players || []).map(p => [p.id,p.name]));
  const rows = Object.entries(result.changes).filter(([,delta])=>Number.isFinite(delta)).sort((a,b)=>a[1]-b[1]);
  const bb = room?.settings?.bigBlind;
  return `<section class="squid-result-card${compact?' compact':''}" aria-label="鱿鱼独立结算"><h3>🐟 第 ${result.round} 轮 · 鱿鱼结算</h3>${compact?'':'<p class="note">以下仅为鱿鱼输赢，不含德州收池；已计入本场盈亏。</p>'}<div class="squid-result-rows">${rows.map(([id,delta])=>`<div class="squid-result-row${id===room?.meId?' is-me':''}"><span>${escapeText(names.get(id)||'已离桌玩家')}${id===room?.meId?'（我）':''}</span><strong class="${delta<0?'negative':delta>0?'positive':''}">${delta<0?'罚鱼 ':delta>0?'收鱼 ':'持平 '}${escapeText(formatChips(delta,bb,{signed:true}))}</strong>${compact?'':`<small>${Number.isSafeInteger(result.counts?.[id])?result.counts[id]:0} 条鱼</small>`}</div>`).join('')}</div></section>`;
}
export function renderSquidHistory(room) {
  const q=room?.mini?.squid;
  const rows=Array.isArray(q?.history)&&q.history.length?q.history:q?.lastResult?[q.lastResult]:[];
  if(!rows.length)return '';
  return `<div class="table-info-section squid-result-history" data-table-info="squid-history"><h3>鱿鱼结算记录</h3><p class="note">最近 ${rows.length} 轮 · 每轮单独记账</p>${rows.slice().reverse().map((r,i)=>`<details${i===0?' open':''}><summary>第 ${Number(r.round)||0} 轮 · ${r.mode==='unlimited'?'无限鱿鱼':'普通鱿鱼'} · 查看罚鱼与收鱼</summary>${renderSquidResult(r,room)}</details>`).join('')}</div>`;
}
