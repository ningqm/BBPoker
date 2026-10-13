// Shared by browser and server. Patterns describe two distinct cards in either
// order; a rank and suit in one slot always refer to the same physical card.
const RANKS = '23456789TJQKA';
const SUITS = ['s', 'h', 'd', 'c'];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const empty = value => value === undefined || value === null || value === '';
export const STARTING_HAND_PRESETS = Object.freeze([
  { id: 'all', label: '不限', description: '所有起手牌' },
  { id: 'pair', label: '口袋对子', description: '22–AA，任意口袋对子' },
  { id: 'bigPair', label: '大对子', description: '10、J、Q、K、A 的口袋对子' },
  { id: 'suitedConnector', label: '同花连张', description: '相邻点数且同花，例如 76、QJ、AK；不含 A2' },
  { id: 'suitedGapper', label: '同花隔张', description: '点数相隔 2 且同花，例如 75、QT、AQ；不含 A3' },
  { id: 'suitedAce', label: '同花 A', description: '一张 A 与另一张牌同花（A2 到 AK）' },
  { id: 'broadway', label: '两张大牌', description: 'T、J、Q、K、A 中的两个不同点数，花色不限，不含对子' },
  { id: 'premium', label: '顶端范围', description: 'AA、KK、QQ 或 AK（不限花色）' },
].map(value => Object.freeze(value)));

function option(value, choices, fallback, label) {
  if (empty(value)) return fallback;
  if (typeof value !== 'string' || !choices.includes(value)) fail(`${label}无效`);
  return value;
}
function rank(value, slot) {
  if (empty(value)) return '';
  if (typeof value !== 'string' || !/^[23456789TJQKA]$/i.test(value.trim())) fail(`第 ${slot} 张牌的点数无效`);
  return value.trim().toUpperCase();
}
/** Custom rank/suit/type selections take precedence over a preset. No implicit
 * intersection with stale preset values. The caller must adapt legacy fields.
 */
export function normalizeStartingHandFilter(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('起手牌筛选无效');
  let holePreset = option(input.holePreset, STARTING_HAND_PRESETS.map(p => p.id), 'all', '起手牌预设');
  const holeRank1 = rank(input.holeRank1, 1), holeRank2 = rank(input.holeRank2, 2);
  const holeSuit1 = option(input.holeSuit1, ['', ...SUITS, 'red', 'black'], '', '第 1 张牌的花色');
  const holeSuit2 = option(input.holeSuit2, ['', ...SUITS, 'red', 'black'], '', '第 2 张牌的花色');
  const holeType = option(input.holeType, ['all', 'pair', 'suited', 'offsuit'], 'all', '起手牌类型');
  if (holeRank1 || holeRank2 || holeSuit1 || holeSuit2 || holeType !== 'all') holePreset = 'all';
  if (holeRank1 && holeRank1 === holeRank2 && holeSuit1 === holeSuit2 && SUITS.includes(holeSuit1)) fail('两张起手牌不能是同一张牌');
  return { holePreset, holeRank1, holeSuit1, holeRank2, holeSuit2, holeType };
}

function slotMatches(card, rank, suit) {
  return (!rank || card[0] === rank) && (!suit || (suit === 'red' ? 'hd'.includes(card[1]) : suit === 'black' ? 'sc'.includes(card[1]) : card[1] === suit));
}
/** Only pass the viewer's own cards. Invalid/incomplete cards never match even
 * an unrestricted filter; observer retention is decided separately by callers.
 */
export function matchesStartingHand(cards, filter) {
  if (!Array.isArray(cards) || cards.length !== 2 || cards[0] === cards[1]
    || !cards.every(card => typeof card === 'string' && /^[23456789TJQKA][cdhs]$/.test(card))) return false;
  const [a, b] = cards, pair = a[0] === b[0], suited = a[1] === b[1];
  const x = RANKS.indexOf(a[0]), y = RANKS.indexOf(b[0]), gap = Math.abs(x - y);
  switch (filter.holePreset) {
    case 'pair': if (!pair) return false; break;
    case 'bigPair': if (!pair || x < 8) return false; break;
    case 'suitedConnector': if (!suited || gap !== 1) return false; break;
    case 'suitedGapper': if (!suited || gap !== 2) return false; break;
    case 'suitedAce': if (!suited || ![a[0], b[0]].includes('A')) return false; break;
    case 'broadway': if (pair || x < 8 || y < 8) return false; break;
    case 'premium': if (!(pair && x >= 10) && !([a[0], b[0]].includes('A') && [a[0], b[0]].includes('K'))) return false; break;
    case 'all': break;
    default: return false;
  }
  if (filter.holeType === 'pair' && !pair || filter.holeType === 'suited' && (pair || !suited) || filter.holeType === 'offsuit' && (pair || suited)) return false;
  return slotMatches(a, filter.holeRank1, filter.holeSuit1) && slotMatches(b, filter.holeRank2, filter.holeSuit2)
    || slotMatches(b, filter.holeRank1, filter.holeSuit1) && slotMatches(a, filter.holeRank2, filter.holeSuit2);
}

export function startingHandSummary(input = {}) {
  const filter = normalizeStartingHandFilter(input);
  if (filter.holePreset !== 'all') return STARTING_HAND_PRESETS.find(p => p.id === filter.holePreset).description;
  const suitNames = { s: '黑桃', h: '红桃', d: '方块', c: '梅花', red: '红色', black: '黑色' };
  const slot = (rank, suit) => [suitNames[suit], rank === 'T' ? '10' : rank || (suit ? '任意点数' : '')].filter(Boolean).join(' ') || '任意牌';
  const parts = [];
  if (filter.holeRank1 || filter.holeRank2 || filter.holeSuit1 || filter.holeSuit2) parts.push(`${slot(filter.holeRank1, filter.holeSuit1)} + ${slot(filter.holeRank2, filter.holeSuit2)}（顺序不限）`);
  const type = { pair: '口袋对子', suited: '同花且非对子', offsuit: '不同花且非对子' }[filter.holeType];
  if (type) parts.push(type);
  return parts.join(' · ') || '不限起手牌';
}
