// Read only a completed handFor response. Never evaluate cards or unpack a
// stored hand: visibility remains the server's decision for this viewer.
import { formatChips, unitLabel } from './money.js';
import { historyBoard } from './replay.js';
const streets = ['preflop', 'flop', 'turn', 'river'];
const streetNames = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' };
const suits = { c: ['♣', '梅花'], d: ['♦', '方块'], h: ['♥', '红桃'], s: ['♠', '黑桃'] };
const paid = new Set(['ante', 'smallBlind', 'bigBlind', 'entryBlind', 'deadBlind', 'call', 'raise', 'allin']);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const own = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
const points = value => Number.isSafeInteger(value) ? value.toLocaleString('zh-CN') : '—';
const tone = value => value > 0 ? 'ho-positive' : value < 0 ? 'ho-negative' : 'ho-neutral';
const validCard = card => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card);

/** Display only; filtering uses server-side exact comparison. */
export function formatHandBB(amount, bigBlind, { signed = false } = {}) {
  if (!Number.isSafeInteger(amount)) return '—';
  return formatChips(amount, Number.isSafeInteger(bigBlind) && bigBlind > 0 ? bigBlind : null, { signed, unit: 'bb', digits: 4 });
}

function validate(hand) {
  if (!hand || typeof hand !== 'object' || 'deck' in hand || 'audit' in hand || 'allInLock' in hand
    || hand.status === 'playing' || !Array.isArray(hand.players) || !Array.isArray(hand.log)
    || !Array.isArray(hand.board) || hand.board.length > 5 || hand.board.some(card => !validCard(card))) {
    throw new Error('只支持已过滤的已结算牌谱');
  }
  const ids = new Set();
  for (const player of hand.players) {
    if (!player || typeof player.id !== 'string' || ids.has(player.id) || 'cardIndices' in player
      || !Array.isArray(player.cards) || player.cards.length !== 2 || player.cards.some(card => card !== null && !validCard(card))) {
      throw new Error('牌谱玩家或底牌记录无效');
    }
    ids.add(player.id);
  }
  for (const event of hand.log) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('牌谱行动记录无效');
    if ((paid.has(event.type) || ['refund', 'payout'].includes(event.type))
      && (!ids.has(event.playerId) || !Number.isSafeInteger(event.amount) || event.amount < 0)) throw new Error('牌谱积分记录无效');
  }
}

function cardMarkup(card, emptyLabel = '未公开底牌') {
  if (!validCard(card)) return `<span class="ho-card ho-card-empty" aria-label="${esc(emptyLabel)}">—</span>`;
  const [glyph, label] = suits[card[1]], rank = card[0] === 'T' ? '10' : card[0];
  return `<span class="ho-card ${['d', 'h'].includes(card[1]) ? 'ho-card-red' : ''}" aria-label="${label} ${rank}"><b>${rank}</b><span aria-hidden="true">${glyph}</span></span>`;
}
const cardRow = (cards, count, emptyLabel) => `<span class="ho-cards">${Array.from({ length: count }, (_, i) => cardMarkup(cards?.[i], emptyLabel)).join('')}</span>`;
function chipText(value, bb, signed = false) {
  return formatChips(Number.isSafeInteger(value) ? value : null, Number.isSafeInteger(bb) && bb > 0 ? bb : null, { signed, digits: 4 });
}
function miniNet(hand, playerId, player) {
  if (Number.isSafeInteger(player?.miniNet)) return player.miniNet;
  return own(hand.mini?.changes, playerId) && Number.isSafeInteger(hand.mini.changes[playerId]) ? hand.mini.changes[playerId] : 0;
}
function position(hand, player) {
  const tags = [];
  const knownSeat = Number.isSafeInteger(player.seat) && player.seat >= 0;
  if (knownSeat && player.seat === hand.buttonSeat) tags.push('<span title="庄家">BTN</span>');
  if (knownSeat && !hand.bombPot && player.seat === hand.smallBlindSeat) tags.push('<span title="小盲">SB</span>');
  if (knownSeat && !hand.bombPot && player.seat === hand.bigBlindSeat) tags.push('<span title="大盲">BB</span>');
  return `<span class="ho-positions">${tags.join('')}<small>${Number.isSafeInteger(player.seat) && player.seat >= 0 ? `${player.seat + 1} 号座` : '座位未记录'}</small></span>`;
}

function actionText(event, bb, allInAfter) {
  const amount = chipText(event.amount, bb), to = Number.isSafeInteger(event.to) ? chipText(event.to, bb) : null;
  switch (event.type) {
    case 'ante': return `前注 ${amount}`;
    case 'smallBlind': return `小盲 ${amount}`;
    case 'bigBlind': return `大盲 ${amount}`;
    case 'entryBlind': return `补大盲 ${amount}`;
    case 'deadBlind': return `补小盲 ${amount}（不抵跟注）`;
    case 'fold': return '弃牌';
    case 'check': return '过牌';
    case 'call': return `${allInAfter ? '全下跟注' : '跟注'} ${amount}`;
    case 'raise': return to ? `${allInAfter ? '全下加注至' : '加注至'} ${to}` : `加注 · 本次投入 ${amount}`;
    case 'allin': return event.isRaise === false ? `全下跟注 ${amount}${to ? `（本轮共 ${to}）` : ''}`
      : to ? `全下至 ${to}（本次投入 ${amount}）` : `全下 · 本次投入 ${amount}`;
    case 'refund': return `退回未跟注 ${amount}`;
    case 'payout': return `获得底池 ${amount}`;
    case 'timeout': return '超时自动处理';
    case 'reconnect': return '重新连接';
    case 'timebank': return Number.isSafeInteger(event.seconds) ? `使用时间牌 · 延长 ${event.seconds} 秒` : '使用时间牌';
    case 'allInLock': return '下注结束，开始全下跑牌';
    case 'street': return `发出${streetNames[event.street] || '公共牌'}`;
    case 'runoutCard': return '跑牌 · 发出一张公共牌';
    case 'show': return '主动亮牌';
    case 'showdown': return '摊牌';
    case 'complete': return '本手结算';
    case 'start': case 'deal': return '开始发牌';
    default: return '牌局记录';
  }
}
function actions(hand, bb) {
  const stack = new Map(hand.players.map(p => [p.id, Number.isSafeInteger(p.startingStack) ? p.startingStack : null]));
  const lines = [], recentActions = new Map();
  hand.log.forEach((event, index) => {
    // timeout is appended after applyAction, which may already have dealt the
    // next street or paid the winners. Annotate its actual check/fold rather
    // than treating the timeout's later street as a second player action.
    if (event.type === 'timeout') {
      const actual = recentActions.get(event.playerId);
      recentActions.delete(event.playerId);
      if (actual && ['check', 'fold'].includes(actual.event.type)) {
        actual.label += '（超时）';
        actual.timedOut = true;
        return;
      }
    }
    const before = stack.get(event.playerId);
    if (paid.has(event.type) && Number.isSafeInteger(before)) stack.set(event.playerId, before - event.amount);
    else if (['refund', 'payout'].includes(event.type) && Number.isSafeInteger(before)) stack.set(event.playerId, before + event.amount);
    const allInAfter = paid.has(event.type) && stack.get(event.playerId) === 0;
    const line = { event, number: index + 1, allInAfter, label: actionText(event, bb, allInAfter) };
    lines.push(line);
    if (['check', 'fold', 'call', 'raise', 'allin'].includes(event.type)) recentActions.set(event.playerId, line);
  });
  return lines;
}
function actionKind(action) {
  const type = action.event.type;
  if (type === 'allin' || type === 'allInLock' || action.allInAfter && ['call', 'raise'].includes(type)) return 'allin';
  return ['check', 'call', 'raise', 'fold', 'refund', 'payout', 'timebank'].includes(type) ? type : 'normal';
}
function actionLabel(action) {
  return action.timedOut ? `${esc(action.label.slice(0, -4))}<small class="ho-timeout">（超时）</small>` : esc(action.label);
}
function actionChip(action) {
  return `<span class="ho-action ho-action-${actionKind(action)}"><span class="ho-seq" aria-label="全桌第 ${action.number} 条记录">${action.number}</span><span>${actionLabel(action)}</span></span>`;
}
function visibleEventBoard(hand, event) {
  if (!['street', 'runoutCard', 'allInLock'].includes(event.type) || !Array.isArray(event.board)
    || event.board.length > hand.board.length || event.board.some((card, index) => card !== hand.board[index])) return '';
  return event.board.length ? cardRow(event.board, event.board.length) : '';
}
function boardMarkup(view) {
  return `<span class="ho-cards ho-board-cards">${Array.from({ length: 5 }, (_, index) => {
    const supplementary = index >= view.actualCount && index < view.board.length;
    const face = cardMarkup(view.board[index], view.pending ? '等待补看余牌' : '本手未发出');
    return supplementary ? `<span class="ho-supplemental" aria-label="结算后补看，不计输赢">${face}</span>` : face;
  }).join('')}</span>`;
}
function potBreakdown(hand, bb, names) {
  const pots = Array.isArray(hand.result?.pots) ? hand.result.pots : [];
  if (!pots.length) return '<p class="ho-empty-note">底池明细未记录</p>';
  return `<div class="ho-pots">${pots.map((pot, index) => {
    const winners = Array.isArray(pot.winnerIds) ? pot.winnerIds : [];
    const amount = Number.isSafeInteger(pot.amount) && pot.amount >= 0 ? pot.amount : null;
    return `<div class="ho-pot"><strong>${index === 0 ? '主池' : `边池 ${index}`} · ${esc(chipText(amount, bb))}</strong><span>${winners.length && amount !== null ? winners.map((id, i) => {
      // The engine stores winnerIds in odd-chip order; mirror the exact integer
      // split, never allocate rounded BB amounts or copy the combined payout.
      const share = Math.floor(amount / winners.length) + (i < amount % winners.length ? 1 : 0);
      return `${esc(names.get(id) || '牌友')} 获得 ${esc(chipText(share, bb))}`;
    }).join(' · ') : '获分记录未提供'}</span></div>`;
  }).join('')}</div>`;
}
function chronology(hand, lines, bb, names) {
  const groups = [];
  for (const line of lines) {
    const key = line.event.type === 'payout' ? 'settlement' : streets.includes(line.event.street) ? line.event.street : 'other';
    if (groups.at(-1)?.key !== key) groups.push({ key, lines: [] });
    groups.at(-1).lines.push(line);
  }
  return `<details class="ho-chronology"><summary>按顺序查看完整过程 · ${lines.length} 条记录</summary>${groups.map(group =>
    `<section class="ho-round"><h4>${group.key === 'settlement' ? '结算' : group.key === 'preflop' && hand.bombPot ? '前注（跳过翻前下注）' : streetNames[group.key] || '其他记录'}</h4><ol>${group.lines.map(line => {
      const name = names.get(line.event.playerId);
      return `<li value="${line.number}"><span class="ho-seq">${line.number}</span><div><span class="ho-event ho-action-${actionKind(line)}">${name ? `<strong>${esc(name)}</strong> · ` : ''}${actionLabel(line)}</span>${visibleEventBoard(hand, line.event)}</div></li>`;
    }).join('')}</ol></section>`).join('')}${potBreakdown(hand, bb, names)}</details>`;
}

export function renderHandOverview(hand, viewerId) {
  validate(hand);
  const bb = hand.settings?.bigBlind ?? hand.bigBlind, mine = hand.players.find(p => p.id === viewerId);
  const myPoker = mine && Number.isSafeInteger(mine.net) ? mine.net : 0, myMini = miniNet(hand, viewerId, mine), myNet = myPoker + myMini;
  const names = new Map(hand.players.map(p => [p.id, p.name || '牌友'])), lines = actions(hand, bb);
  const pot = (Array.isArray(hand.result?.pots) ? hand.result.pots : []).reduce((sum, p) => sum + (Number.isSafeInteger(p?.amount) && p.amount >= 0 ? p.amount : 0), 0);
  const board = historyBoard(hand);
  const players = [...hand.players].sort((a, b) => a.seat - b.seat);
  const heading = hand.bombPot ? '<span class="ho-mode ho-mode-bomb">炸弹池 · 直接从翻牌开始</span>' : '<span>德州扑克</span>';
  return `<section class="hand-overview" aria-label="静态牌谱概览"><div class="ho-summary"><div class="ho-board"><p class="ho-kicker">${heading}${hand.squidRound ? `<span class="ho-mode ho-mode-squid">第 ${points(hand.squidRound)} 轮鱿鱼</span>` : ''}</p>${boardMarkup(board)}<p class="ho-board-caption">${board.rabbitCount ? '公共牌与补看余牌' : '实际公共牌'} · 底池 <strong title="${esc(chipText(pot, bb))}">${esc(chipText(pot, bb))}</strong></p></div><div class="ho-mine"><small>${mine ? '我的净盈亏' : myMini !== 0 ? '未参与发牌 · 鱿鱼结算' : '本手未参与'}</small><strong class="${tone(myNet)}" title="${esc(chipText(myNet, bb, true))}">${mine || myMini !== 0 ? esc(chipText(myNet, bb, true)) : '—'}</strong>${mine || myMini !== 0 ? `<span>德州 ${esc(chipText(myPoker, bb, true))}<br>小游戏 ${esc(chipText(myMini, bb, true))}</span>` : ''}</div></div>${board.rabbitCount || board.pending ? `<p class="ho-rabbit-note">${board.rabbitCount ? '虚线牌为补看余牌；手牌已结束，不计输赢。' : ''}${board.pending ? ' 余牌稍后自动更新。' : ''}</p>` : ''}<div class="ho-route-title"><h3>全桌操作路线</h3><small>数字表示全桌先后顺序 · 单位 ${unitLabel()}</small></div><div class="ho-route"><div class="ho-route-header" aria-hidden="true"><span>玩家 / 净盈亏</span>${streets.map(street => `<span>${street === 'preflop' && hand.bombPot ? '前注' : streetNames[street]}</span>`).join('')}</div>${players.map(player => {
    const poker = Number.isSafeInteger(player.net) ? player.net : 0, mini = miniNet(hand, player.id, player), net = poker + mini;
    return `<article class="ho-player ${player.id === viewerId ? 'ho-player-me' : ''}" aria-label="${esc(player.name || '牌友')}的操作路线"><div class="ho-player-heading"><div class="ho-player-name"><strong>${esc(player.name || '牌友')}</strong>${player.id === viewerId ? '<span class="ho-you">我</span>' : ''}</div>${position(hand, player)}<div class="ho-player-result">${cardRow(player.cards, 2)}<strong class="${tone(net)}" title="${esc(chipText(net, bb, true))}">${esc(chipText(net, bb, true))}</strong></div>${mini ? `<small class="ho-mini-breakdown">含小游戏 ${esc(chipText(mini, bb, true))}</small>` : ''}</div><div class="ho-player-streets">${streets.map(street => {
      const route = lines.filter(line => line.event.playerId === player.id && line.event.street === street && !['payout', 'timeout'].includes(line.event.type));
      return `<div class="ho-street"><h4>${street === 'preflop' && hand.bombPot ? '前注' : streetNames[street]}</h4><div class="ho-actions">${route.length ? route.map(actionChip).join('') : '<span class="ho-no-action">—</span>'}</div></div>`;
    }).join('')}</div></article>`;
  }).join('')}</div>${chronology(hand, lines, bb, names)}<p class="ho-privacy">这里只展示本人底牌与已公开底牌；未公开底牌保留牌背。净盈亏含本手关联的小游戏结算。</p></section>`;
}
