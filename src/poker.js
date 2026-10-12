import { randomInt } from 'node:crypto';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const CARDS = [...SUITS].flatMap(s => [...RANKS].map(r => r + s));
const NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const compare = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** Unbiased Fisher–Yates driven by the operating system's cryptographic RNG. */
export function shuffleDeck() {
  const deck = [...CARDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function five(cards) {
  const ranks = cards.map(c => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const unique = [...new Set(ranks)];
  let straight = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straight = unique[0];
    else if (unique.join(',') === '14,5,4,3,2') straight = 5;
  }
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (straight && flush) return [8, straight];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, ...groups.map(g => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...groups.map(g => g[0])];
  if (groups[0][1] === 2) return [1, ...groups.map(g => g[0])];
  return [0, ...ranks];
}

/** 5–7 cards => { tuple, name }; compare tuple lexicographically, larger wins. */
export function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7 ||
      new Set(cards).size !== cards.length || cards.some(c => !CARDS.includes(c))) {
    throw new Error('评估手牌需要 5 至 7 张不重复的有效扑克牌');
  }
  let best = null;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const tuple = five([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compare(tuple, best) > 0) best = tuple;
          }
  return { tuple: best, name: NAMES[best[0]] };
}

function log(hand, event) {
  hand.log.push({ seq: hand.log.length + 1, street: hand.street, ...event });
}

function clockwise(hand, seat) {
  return [...hand.players.filter(p => p.seat > seat), ...hand.players.filter(p => p.seat <= seat)];
}

function contribute(hand, p, requested, type, streetBet = true) {
  const amount = Math.min(p.stack, requested);
  p.stack -= amount;
  p.contributed += amount;
  if (streetBet) p.bet += amount;
  p.allIn = p.stack === 0;
  if (type) log(hand, { playerId: p.id, type, amount, ...(streetBet ? { to: p.bet } : {}) });
  return amount;
}

function refund(hand, p, amount) {
  if (!amount) return;
  p.stack += amount;
  p.contributed -= amount;
  p.bet -= Math.min(p.bet, amount);
  p.allIn = p.stack === 0;
  log(hand, { playerId: p.id, type: 'refund', amount });
}

// Return only an unmatched current-street wager. Antes never count as a bet.
function refundUncalled(hand) {
  const bets = [...hand.players].sort((a, b) => b.bet - a.bet);
  if (bets[0].bet > bets[1].bet) refund(hand, bets[0], bets[0].bet - bets[1].bet);
}

function draw(hand) {
  if (hand.deckCursor >= 52) throw new Error('牌堆不足');
  const index = hand.deckCursor++;
  return { card: hand.deck[index], index };
}

function nextStreet(hand) {
  hand.street = STREETS[STREETS.indexOf(hand.street) + 1];
  hand.burnIndices.push(draw(hand).index);
  const count = hand.street === 'flop' ? 3 : 1;
  for (let i = 0; i < count; i++) {
    const { card, index } = draw(hand);
    hand.board.push(card);
    hand.boardIndices.push(index);
  }
  hand.currentBet = 0;
  hand.minRaise = hand.bigBlind;
  for (const p of hand.players) {
    p.bet = 0;
    p._acted = false;
    p.lastActedBet = null;
    p.reopenAt = null;
  }
  log(hand, { type: 'street', board: [...hand.board] });
}

function settle(hand) {
  refundUncalled(hand);
  const contenders = hand.players.filter(p => !p.folded);
  const showdown = contenders.length > 1;
  const evaluations = new Map(showdown ? contenders.map(p => [p.id, evaluate([...p.cards, ...hand.board])]) : []);
  const result = {
    pots: [], payouts: Object.fromEntries(hand.players.map(p => [p.id, 0])),
    mainWinnerIds: [], handNames: {}, showdown,
  };
  for (const [id, value] of evaluations) result.handNames[id] = value.name;
  const levels = [...new Set(hand.players.map(p => p.contributed).filter(n => n > 0))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of levels) {
    const contributors = hand.players.filter(p => p.contributed >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    // No unmatched tier is ever reported as a won side pot.
    if (contributors.length === 1) {
      refund(hand, contributors[0], amount);
      continue;
    }
    let eligible = contributors.filter(p => !p.folded);
    // Folded dead money above a surviving short stack still belongs to the
    // last live hand if nobody remains eligible for that contribution tier.
    if (!eligible.length && contenders.length === 1) eligible = contenders;
    if (!eligible.length) throw new Error('底池没有可领奖玩家');
    let winners = eligible;
    if (showdown && eligible.length > 1) {
      let best = evaluations.get(eligible[0].id).tuple;
      for (const p of eligible.slice(1)) {
        const score = evaluations.get(p.id).tuple;
        if (compare(score, best) > 0) best = score;
      }
      winners = eligible.filter(p => compare(evaluations.get(p.id).tuple, best) === 0);
    }
    const winnerIds = clockwise(hand, hand.buttonSeat).filter(p => winners.includes(p)).map(p => p.id);
    const pot = { amount, eligibleIds: eligible.map(p => p.id), winnerIds };
    result.pots.push(pot);
    if (!result.mainWinnerIds.length) result.mainWinnerIds = [...winnerIds];
    const share = Math.floor(amount / winnerIds.length);
    const odd = amount % winnerIds.length;
    winnerIds.forEach((id, i) => { result.payouts[id] += share + (i < odd ? 1 : 0); });
  }
  for (const p of hand.players) {
    p.stack += result.payouts[p.id];
    if (result.payouts[p.id]) log(hand, { playerId: p.id, type: 'payout', amount: result.payouts[p.id] });
  }
  hand.result = result;
  hand.status = 'complete';
  hand.actingId = null;
}

function advance(hand, afterSeat) {
  while (hand.status === 'playing') {
    const live = hand.players.filter(p => !p.folded);
    if (live.length === 1) { settle(hand); return; }
    const mobile = live.filter(p => !p.allIn);
    // When nobody else can respond, no pointless check/raise is requested.
    const pending = mobile.filter(p => {
      const toMatch = mobile.length > 1 ? hand.currentBet : Math.max(0, ...live.filter(q => q !== p).map(q => q.bet));
      return p.bet < toMatch || (!p._acted && mobile.length > 1);
    });
    if (pending.length) {
      hand.actingId = clockwise(hand, afterSeat).find(p => pending.includes(p)).id;
      return;
    }
    refundUncalled(hand);
    if (hand.street === 'river') { settle(hand); return; }
    nextStreet(hand);
    afterSeat = hand.buttonSeat;
  }
}

export function createHand({ id, players, buttonSeat, smallBlind, bigBlind, ante = 0, deck } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 9) throw new Error('需要 2 至 9 位玩家');
  if (!integer(smallBlind, 1) || !integer(bigBlind, smallBlind) || !integer(ante)) throw new Error('盲注或前注无效');
  if (players.some(p => !p || typeof p.id !== 'string' || !p.id || !integer(p.seat) || !integer(p.stack, 1)) ||
      new Set(players.map(p => p.id)).size !== players.length || new Set(players.map(p => p.seat)).size !== players.length ||
      !Number.isSafeInteger(players.reduce((sum, p) => sum + p.stack, 0))) throw new Error('玩家、座位或带入积分无效');
  if (!integer(buttonSeat) || !players.some(p => p.seat === buttonSeat)) throw new Error('庄位必须是本手玩家');
  const shuffled = deck === undefined ? shuffleDeck() : [...deck];
  if (shuffled.length !== 52 || new Set(shuffled).size !== 52 || shuffled.some(c => !CARDS.includes(c))) throw new Error('牌堆必须含 52 张不同扑克牌');
  const hand = {
    id, status: 'playing', street: 'preflop', buttonSeat, smallBlind, bigBlind, ante,
    smallBlindSeat: null, bigBlindSeat: null, board: [], boardIndices: [],
    deck: Object.freeze(shuffled), deckCursor: 0, burnIndices: [],
    players: players.map(p => ({ id: p.id, name: p.name ?? '', seat: p.seat,
      startingStack: p.stack, stack: p.stack, cards: [], cardIndices: [], folded: false,
      allIn: false, bet: 0, contributed: 0, _acted: false, lastActedBet: null, reopenAt: null,
    })).sort((a, b) => a.seat - b.seat),
    actingId: null, currentBet: bigBlind, minRaise: bigBlind, log: [], result: null,
  };
  const order = clockwise(hand, buttonSeat);
  const sb = players.length === 2 ? hand.players.find(p => p.seat === buttonSeat) : order[0];
  const bb = players.length === 2 ? order[0] : order[1];
  hand.smallBlindSeat = sb.seat;
  hand.bigBlindSeat = bb.seat;
  if (ante) for (const p of order) contribute(hand, p, ante, 'ante', false);
  contribute(hand, sb, smallBlind, 'smallBlind');
  contribute(hand, bb, bigBlind, 'bigBlind');
  for (let round = 0; round < 2; round++) for (const p of order) {
    const { card, index } = draw(hand);
    p.cards.push(card);
    p.cardIndices.push(index);
  }
  advance(hand, bb.seat);
  return hand;
}

export function availableActions(hand, playerId) {
  const p = hand.players.find(p => p.id === playerId);
  const canAct = hand.status === 'playing' && hand.actingId === playerId && !!p && !p.folded && !p.allIn;
  if (!canAct) return { canAct: false, canCheck: false, canFold: false, callAmount: 0, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, canAllIn: false };
  const responder = hand.players.some(q => q.id !== p.id && !q.folded && !q.allIn);
  const amountToMatch = responder ? hand.currentBet : Math.max(0, ...hand.players.filter(q => q.id !== p.id && !q.folded).map(q => q.bet));
  const callAmount = Math.min(p.stack, Math.max(0, amountToMatch - p.bet));
  const maxRaiseTo = p.bet + p.stack;
  const minRaiseTo = hand.currentBet + hand.minRaise;
  const reopened = !p._acted || hand.currentBet >= p.reopenAt;
  const mayIncrease = reopened && responder;
  return { canAct, canCheck: callAmount === 0, canFold: true, callAmount,
    canRaise: mayIncrease && maxRaiseTo >= minRaiseTo, minRaiseTo, maxRaiseTo,
    canAllIn: p.stack > 0 && (maxRaiseTo <= hand.currentBet || mayIncrease),
  };
}

export function applyAction(hand, playerId, type, amount) {
  const a = availableActions(hand, playerId);
  if (!a.canAct) throw new Error('还没轮到你行动，或本手已经结束');
  const p = hand.players.find(p => p.id === playerId);
  if (!['fold', 'check', 'call', 'raise', 'allin'].includes(type)) throw new Error('不支持的行动');
  if (type === 'check' && !a.canCheck) throw new Error('当前需要跟注，不能过牌');
  if (type === 'call' && a.callAmount === 0) throw new Error('无需跟注，请选择过牌');
  if (type === 'allin' && !a.canAllIn) throw new Error('当前不允许全下加注');
  let target;
  if (type === 'raise') {
    if (!integer(amount, 1) || amount <= hand.currentBet || amount > a.maxRaiseTo) throw new Error('加注总额无效');
    const shortAllIn = amount === a.maxRaiseTo && a.canAllIn;
    if ((!a.canRaise || amount < a.minRaiseTo) && !shortAllIn) throw new Error('加注未达到最小额度，或加注权尚未重新开放');
    target = amount;
  } else if (type === 'allin') target = a.maxRaiseTo;
  if (type === 'fold') {
    p.folded = true;
    log(hand, { playerId, type });
  } else if (type === 'check') log(hand, { playerId, type });
  else if (type === 'call') contribute(hand, p, a.callAmount, type);
  else {
    const oldBet = hand.currentBet;
    contribute(hand, p, target - p.bet, type);
    hand.log.at(-1).isRaise = target > oldBet;
    if (target > oldBet) {
      const increment = target - oldBet;
      if (increment >= hand.minRaise) hand.minRaise = increment;
      hand.currentBet = target;
    }
  }
  p._acted = true;
  p.lastActedBet = hand.currentBet;
  p.reopenAt = hand.currentBet + hand.minRaise;
  advance(hand, p.seat);
  return hand;
}
