import { createHash } from 'node:crypto';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const CARDS = [...SUITS].flatMap(s => [...RANKS].map(r => r + s));
const CARD_IDS = new Map(CARDS.map((c, i) => [c, i]));
const BASE = 15 ** 5;

function straightHigh(mask) {
  for (let high = 12; high >= 4; high--) if ((mask & (31 << (high - 4))) === (31 << (high - 4))) return high + 2;
  return (mask & 4111) === 4111 ? 5 : 0;
}

function score(category, ranks) {
  let result = category * BASE;
  for (let i = 0, place = 15 ** 4; i < ranks.length; i++, place /= 15) result += ranks[i] * place;
  return result;
}

/** Equivalent ordering to poker.evaluate(), without enumerating 21 five-card hands. */
function evaluateIds(ids) {
  const counts = new Uint8Array(15);
  const suits = new Uint8Array(4);
  const masks = new Uint16Array(4);
  let mask = 0;
  for (const id of ids) {
    const rank = id % 13 + 2, suit = Math.floor(id / 13), bit = 1 << (rank - 2);
    counts[rank]++; suits[suit]++; masks[suit] |= bit; mask |= bit;
  }
  const flushSuit = suits.findIndex(n => n >= 5);
  if (flushSuit >= 0) {
    const high = straightHigh(masks[flushSuit]);
    if (high) return score(8, [high]);
  }
  const quads = [], trips = [], pairs = [], all = [];
  for (let rank = 14; rank >= 2; rank--) {
    if (counts[rank]) all.push(rank);
    if (counts[rank] === 4) quads.push(rank);
    else if (counts[rank] === 3) trips.push(rank);
    else if (counts[rank] === 2) pairs.push(rank);
  }
  if (quads.length) return score(7, [quads[0], all.find(r => r !== quads[0])]);
  if (trips.length && (trips.length > 1 || pairs.length)) return score(6, [trips[0], Math.max(trips[1] ?? 0, pairs[0] ?? 0)]);
  if (flushSuit >= 0) {
    const ranks = [];
    for (let r = 14; r >= 2 && ranks.length < 5; r--) if (masks[flushSuit] & (1 << (r - 2))) ranks.push(r);
    return score(5, ranks);
  }
  const high = straightHigh(mask);
  if (high) return score(4, [high]);
  if (trips.length) return score(3, [trips[0], ...all.filter(r => r !== trips[0]).slice(0, 2)]);
  if (pairs.length > 1) return score(2, [pairs[0], pairs[1], all.find(r => r !== pairs[0] && r !== pairs[1])]);
  if (pairs.length) return score(1, [pairs[0], ...all.filter(r => r !== pairs[0]).slice(0, 3)]);
  return score(0, all.slice(0, 5));
}

/** Exported for equivalence tests, never used to choose cards or alter the deck. */
export function equityScore(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length || cards.some(c => !CARD_IDS.has(c))) throw new Error('胜率评估需要 5 至 7 张有效且不重复的牌');
  return evaluateIds(cards.map(c => CARD_IDS.get(c)));
}

function combinations(n, k) {
  let value = 1;
  for (let i = 1; i <= k; i++) value = value * (n - k + i) / i;
  return Math.round(value);
}

// A deterministic simulation generator, deliberately unrelated to the live deck RNG.
function sampler(seed) {
  const bytes = createHash('sha256').update(seed).digest();
  let a = bytes.readUInt32LE(0), b = bytes.readUInt32LE(4), c = bytes.readUInt32LE(8), d = bytes.readUInt32LE(12);
  const next = () => {
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) >>> 0; c = ((c << 21) | (c >>> 11)); c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 20; i++) next();
  return bound => {
    const limit = 0x100000000 - 0x100000000 % bound;
    let value;
    do value = next(); while (value >= limit);
    return value % bound;
  };
}

/**
 * Conditional equity from PUBLIC exposed contenders and the currently visible board.
 * Folded cards, burn cards and the actual shuffled deck must never be passed here.
 * Percentages split ties. Expected payouts account for each side pot and odd chips.
 */
export function calculateEquity({ players, board = [], pots, buttonSeat = 0, seed = '', samples = 20000, exactLimit = 10000 } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 9 || players.some(p => !p || typeof p.id !== 'string' || !p.id || !Number.isSafeInteger(p.seat) || p.seat < 0 || !Number.isSafeInteger(p.contributed) || p.contributed < 0 || !Array.isArray(p.cards) || p.cards.length !== 2) || new Set(players.map(p => p.id)).size !== players.length || new Set(players.map(p => p.seat)).size !== players.length) throw new Error('胜率玩家数据无效');
  if (!Array.isArray(board) || board.length > 5) throw new Error('公共牌数据无效');
  const known = [...board, ...players.flatMap(p => p.cards)];
  if (known.some(c => !CARD_IDS.has(c)) || new Set(known).size !== known.length) throw new Error('胜率计算中存在重复或无效扑克牌');
  const playerIndex = new Map(players.map((p, i) => [p.id, i]));
  if (!Array.isArray(pots) || !pots.length || pots.some(p => !p || !Number.isSafeInteger(p.amount) || p.amount <= 0 || !Array.isArray(p.eligibleIds) || !p.eligibleIds.length || new Set(p.eligibleIds).size !== p.eligibleIds.length || p.eligibleIds.some(id => !playerIndex.has(id))) || !Number.isSafeInteger(pots.reduce((sum, p) => sum + p.amount, 0))) throw new Error('胜率底池数据无效');
  if (!Number.isSafeInteger(buttonSeat) || buttonSeat < 0 || !Number.isSafeInteger(samples) || samples < 1 || samples > 100000 || !Number.isSafeInteger(exactLimit) || exactLimit < 0 || exactLimit > 100000 || typeof seed !== 'string' || seed.length > 1024) throw new Error('胜率计算参数无效');
  const unknown = CARDS.map((_, i) => i).filter(id => !known.includes(CARDS[id]));
  const missing = 5 - board.length, possibleBoards = combinations(unknown.length, missing);
  const exact = possibleBoards <= exactLimit || missing === 0;
  const count = exact ? possibleBoards : samples;
  const cards = players.map(p => [...p.cards.map(c => CARD_IDS.get(c)), ...board.map(c => CARD_IDS.get(c)), ...Array(missing).fill(0)]);
  const totals = players.map(() => ({ share: 0, win: 0, tie: 0, payout: 0 }));
  const potTotals = pots.map(() => players.map(() => ({ share: 0, payout: 0 })));
  const order = players.map((p, i) => ({ seat: p.seat, i })).sort((a, b) => ((a.seat > buttonSeat ? 0 : 1) - (b.seat > buttonSeat ? 0 : 1)) || a.seat - b.seat).map(p => p.i);
  const eligibility = pots.map(p => order.filter(i => p.eligibleIds.includes(players[i].id)));
  const scores = Array(players.length).fill(0);
  const chosen = Array(missing).fill(0);
  function observe() {
    for (let i = 0; i < cards.length; i++) {
      for (let j = 0; j < missing; j++) cards[i][2 + board.length + j] = chosen[j];
      scores[i] = evaluateIds(cards[i]);
    }
    for (let j = 0; j < pots.length; j++) {
      const eligible = eligibility[j];
      let best = -1;
      for (const i of eligible) if (scores[i] > best) best = scores[i];
      const winners = eligible.filter(i => scores[i] === best);
      const base = Math.floor(pots[j].amount / winners.length), odd = pots[j].amount % winners.length;
      for (let k = 0; k < winners.length; k++) {
        const i = winners[k], payout = base + (k < odd ? 1 : 0);
        potTotals[j][i].share += 1 / winners.length; potTotals[j][i].payout += payout; totals[i].payout += payout;
        if (j === 0) {
          totals[i].share += 1 / winners.length;
          if (winners.length === 1) totals[i].win++; else totals[i].tie++;
        }
      }
    }
  }
  if (exact) {
    const visit = (depth, start) => {
      if (depth === missing) { observe(); return; }
      for (let i = start; i <= unknown.length - (missing - depth); i++) { chosen[depth] = unknown[i]; visit(depth + 1, i + 1); }
    };
    visit(0, 0);
  } else {
    const random = sampler(JSON.stringify({ players: players.map(p => [p.id, p.cards, p.seat, p.contributed]), board, pots, buttonSeat, seed }));
    // Partial Fisher–Yates samples each possible continuation uniformly; restore swaps after each trial.
    const swapped = Array(missing).fill(0);
    for (let trial = 0; trial < count; trial++) {
      for (let j = 0; j < missing; j++) {
        const k = j + random(unknown.length - j); swapped[j] = k;
        [unknown[j], unknown[k]] = [unknown[k], unknown[j]]; chosen[j] = unknown[j];
      }
      observe();
      for (let j = missing - 1; j >= 0; j--) { const k = swapped[j]; [unknown[j], unknown[k]] = [unknown[k], unknown[j]]; }
    }
  }
  return {
    method: exact ? 'exact' : 'monte-carlo', samples: count, possibleBoards,
    // Conservative normal 95% sampling error bound for a single equity percentage, not a fairness guarantee.
    error95Pct: exact ? 0 : 100 * 1.96 * 0.5 / Math.sqrt(count),
    board: [...board],
    players: players.map((p, i) => ({ id: p.id, equity: totals[i].share * 100 / count, winPct: totals[i].win * 100 / count, tiePct: totals[i].tie * 100 / count, expectedPayout: totals[i].payout / count, expectedNet: totals[i].payout / count - p.contributed })),
    pots: pots.map((p, j) => ({ amount: p.amount, eligibleIds: [...p.eligibleIds], players: p.eligibleIds.map(id => {
      const i = playerIndex.get(id);
      return { id, equity: potTotals[j][i].share * 100 / count, expectedPayout: potTotals[j][i].payout / count };
    }) })),
  };
}
