/**
 * Independent PHH writer for already permission-filtered RoomService histories.
 * Specification: https://github.com/uoftcprg/phh-std (MIT).
 * Bulk tables: https://github.com/uoftcprg/pokerkit/blob/main/pokerkit/notation.py
 * No PokerKit source is copied and no Python dependency is used at runtime.
 */

const CARD = /^[2-9TJQKA][cdhs]$/;
const PLAY_ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin']);
const PASSIVE_EVENTS = new Set(['ante', 'smallBlind', 'bigBlind', 'refund', 'payout', 'timeout', 'reconnect']);

// JSON string escapes are valid TOML basic-string escapes. Normalize lone
// surrogates and escape DEL, which TOML does not allow literally in a string.
const quote = value => JSON.stringify(String(value).toWellFormed()).replace(/\u007f/g, '\\u007f');
const array = values => `[${values.join(', ')}]`;
const strings = values => array(values.map(quote));

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`PHH：${label}不是有效整数`);
  return value;
}

function card(value) {
  if (value === null || value === undefined || value === '??') return '??';
  if (!CARD.test(value)) throw new Error('PHH：存在无效的可见牌');
  return value;
}

function orderPlayers(hand) {
  if (!Array.isArray(hand.players) || hand.players.length < 2 || hand.players.length > 9) throw new Error('PHH：需要 2 至 9 位玩家');
  const players = [...hand.players].sort((a, b) => a.seat - b.seat);
  for (const p of players) {
    integer(p.seat, '座位');
    if (typeof p.id !== 'string' || !p.id || !Array.isArray(p.cards) || p.cards.length !== 2) throw new Error('PHH：玩家或过滤后的底牌无效');
  }
  if (new Set(players.map(p => p.id)).size !== players.length || new Set(players.map(p => p.seat)).size !== players.length) throw new Error('PHH：玩家或座位重复');
  integer(hand.buttonSeat, '庄位');
  const button = players.findIndex(p => p.seat === hand.buttonSeat);
  if (button < 0) throw new Error('PHH：庄位不属于本手玩家');
  // PHH p1 is the first player dealt, clockwise after the button. In heads-up
  // this is the BB; PHH reverses [SB, BB] internally for the two-player case.
  const ordered = [...players.slice(button + 1), ...players.slice(0, button + 1)];
  const sb = ordered[ordered.length === 2 ? 1 : 0];
  const bb = ordered[ordered.length === 2 ? 0 : 1];
  if (hand.bombPot ? hand.smallBlindSeat !== null || hand.bigBlindSeat !== null : hand.smallBlindSeat !== sb.seat || hand.bigBlindSeat !== bb.seat) throw new Error('PHH：盲注位置与庄位不一致');
  return ordered;
}

function handTable(hand, index, viewerId) {
  if (!hand || typeof hand !== 'object' || 'deck' in hand || 'audit' in hand) throw new Error('PHH：只接受按玩家权限过滤后的牌谱');
  const players = orderPlayers(hand);
  const position = new Map(players.map((p, i) => [p.id, `p${i + 1}`]));
  const smallBlind = integer(hand.settings?.smallBlind, '小盲', 1);
  const bigBlind = integer(hand.settings?.bigBlind, '大盲', smallBlind);
  const ante = integer(hand.ante ?? 0, '前注');
  const starting = players.map(p => integer(p.startingStack, '起始德州积分', 1));
  const finishing = players.map((p, i) => {
    if (!Number.isSafeInteger(p.net)) throw new Error('PHH：德州净输赢无效');
    return integer(starting[i] + p.net, '结束德州积分');
  });
  const visible = players.map(p => p.cards.map(card).join(''));
  const known = players.flatMap(p => p.cards.filter(c => c != null && c !== '??'));
  if (!Array.isArray(hand.board) || hand.board.some(c => !CARD.test(c))) throw new Error('PHH：公共牌无效');
  if (![0, 3, 4, 5].includes(hand.board.length)) throw new Error('PHH：公共牌数量无效');
  if (new Set([...known, ...hand.board]).size !== known.length + hand.board.length) throw new Error('PHH：可见牌重复');
  if (!Array.isArray(hand.log)) throw new Error('PHH：缺少行动记录');
  const actions = players.map((p, i) => `d dh p${i + 1} ${visible[i]}`);
  // PHH NT has no skip-preflop flag. Zero-cost checks reproduce the omitted
  // betting round without changing any stack; annotate these export-only steps
  // so analysis tools do not mistake them for real player decisions.
  const syntheticChecks = [];
  if (hand.bombPot) {
    const mobile = players.filter(p => p.startingStack > ante);
    if (mobile.length > 1) for (const p of mobile) syntheticChecks.push(`${position.get(p.id)} cc # BBPoker bomb pot: preflop skipped`);
    actions.push(...syntheticChecks);
  }
  const finalAction = hand.log.findLastIndex(a => PLAY_ACTIONS.has(a.type));
  const show = () => {
    if (!hand.result?.showdown) return;
    for (let i = 0; i < players.length; i++) if (!players[i].folded) actions.push(`p${i + 1} sm ${visible[i]}`);
  };
  if (finalAction === -1) show();
  let board = [];
  for (let i = 0; i < hand.log.length; i++) {
    const event = hand.log[i];
    const actor = position.get(event.playerId);
    if (PLAY_ACTIONS.has(event.type) && !actor) throw new Error('PHH：行动玩家不属于本手');
    if (event.type === 'fold') actions.push(`${actor} f`);
    else if (event.type === 'check' || event.type === 'call') actions.push(`${actor} cc`);
    else if (event.type === 'raise' || event.type === 'allin') {
      if (event.type === 'allin' && typeof event.isRaise !== 'boolean') throw new Error('PHH：全下记录缺少跟注或加注标记');
      actions.push(event.type === 'allin' && !event.isRaise ? `${actor} cc` : `${actor} cbr ${integer(event.to, '加注到', 1)}`);
    } else if (event.type === 'street') {
      if (!Array.isArray(event.board) || event.board.slice(0, board.length).join('') !== board.join('') ||
          event.board.length !== (board.length === 0 ? 3 : board.length + 1) || event.board.length > 5 || event.board.some(c => !CARD.test(c))) throw new Error('PHH：公共牌行动顺序无效');
      actions.push(`d db ${event.board.slice(board.length).join('')}`);
      board = [...event.board];
    } else if (!PASSIVE_EVENTS.has(event.type)) throw new Error(`PHH：不支持的行动类型 ${event.type}`);
    // PHH needs all-in show actions before automatic runouts, not after the
    // river. Regular river showdown likewise follows the last betting action.
    if (i === finalAction) show();
  }
  if (board.join('') !== hand.board.join('')) throw new Error('PHH：公共牌与行动记录不一致');
  const stamp = new Date(hand.at);
  if (!Number.isFinite(stamp.getTime())) throw new Error('PHH：牌局时间无效');
  const mini = players.map(p => {
    if (!Number.isSafeInteger(p.miniNet ?? 0)) throw new Error('PHH：小游戏净输赢无效');
    return p.miniNet ?? 0;
  });
  const lines = [
    `[${index + 1}]`,
    'variant = "NT"',
    `antes = ${array(players.map(() => ante))}`,
    'ante_trimming_status = true',
    `blinds_or_straddles = ${array(hand.bombPot ? players.map(() => 0) : [smallBlind, bigBlind, ...players.slice(2).map(() => 0)])}`,
    `min_bet = ${bigBlind}`,
    `starting_stacks = ${array(starting)}`,
    'actions = [', ...actions.map(a => `  ${quote(a)},`), ']',
    `hand = ${quote(hand.id)}`,
    `table = ${quote(hand.roomCode)}`,
    `event = ${quote(hand.roomName ?? 'BBPoker')}`,
    `players = ${strings(players.map(p => p.name ?? '朋友'))}`,
    `seats = ${array(players.map(p => p.seat + 1))}`,
    `finishing_stacks = ${array(finishing)}`,
    `winnings = ${array(players.map(p => integer(hand.result?.payouts?.[p.id], '德州获分')))}`,
    `year = ${stamp.getUTCFullYear()}`, `month = ${stamp.getUTCMonth() + 1}`, `day = ${stamp.getUTCDate()}`,
    `time = ${stamp.toISOString().slice(11, 23)}`, 'time_zone = "Etc/UTC"',
    '_tongzhuo_format = "1"',
    '_tongzhuo_unit = "non-redeemable points"',
    '_tongzhuo_visibility = "Own cards and publicly revealed cards only; unknown cards stay ??."',
    '_tongzhuo_reveal_timing = "Cards reflect export-time visibility; no reveal timestamps are inferred."',
    `_tongzhuo_player_ids = ${strings(players.map(p => p.id))}`,
    `_tongzhuo_mini_net = ${array(mini)}`,
    // Ending room balances may include mini pools/reserves and are deliberately
    // separate from the standard PHH finishing_stacks used for hold'em replay.
    `_tongzhuo_room_ending_stacks = ${array(players.map(p => integer(p.endingStack, '结束房间积分')))}`,
  ];
  if (hand.bombPot) { lines.push('_bbpoker_bomb_pot = true', `_bbpoker_synthetic_preflop_checks = ${syntheticChecks.length}`); }
  if (viewerId !== undefined) lines.push(`_tongzhuo_viewer_id = ${quote(viewerId)}`);
  if (typeof hand.commitment === 'string') lines.push(`_tongzhuo_commitment = ${quote(hand.commitment)}`);
  return lines.join('\n');
}

/** Return an official bulk-PHH (.phhs) TOML document from filtered histories. */
export function exportPhh(hands, adjustments = [], viewerId) {
  if (!Array.isArray(hands) || !Array.isArray(adjustments)) throw new Error('PHH：牌谱和调整记录必须为数组');
  const header = [
    '# BBPoker bulk PHH (Tongzhuo format). Standard hands use [1], [2], ... TOML tables.',
    '# Only visible cards are exported. Unknown cards are not reconstructed.',
    '# Mini-game accounting is custom metadata, never hold\'em wagers.',
    '# Standalone adjustments below are comments, not PHH hands; generic parsers ignore them.',
  ];
  for (const a of adjustments) {
    if (!Number.isSafeInteger(a.amount)) throw new Error('PHH：独立调整金额无效');
    // A safelist prevents unrelated fields (including hidden cards) from ever
    // being included when the caller provides a larger object.
    const item = { id: a.id, at: a.at, roomCode: a.roomCode, roomName: a.roomName, playerId: a.playerId, type: a.type, amount: a.amount, note: a.note };
    header.push(`# Tongzhuo adjustment JSON: ${JSON.stringify(item).replace(/[\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}`);
  }
  return `${header.join('\n')}\n\n${hands.map((h, i) => handTable(h, i, viewerId)).join('\n\n')}\n`;
}
