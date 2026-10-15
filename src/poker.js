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

/** Hypothetical remaining community cards, using the committed deck and burns.
 * This read-only helper never advances the real hand or changes its settlement.
 * Its complete result is private: callers reveal only the scheduled prefix.
 */
export function rabbitRunout(hand) {
  if (hand.status !== 'complete' || !hand.result || hand.result.showdown || ![0, 3, 4].includes(hand.board.length)) return null;
  const cards = [], indices = [];
  let cursor = hand.deckCursor, boardCount = hand.board.length;
  while (boardCount < 5) {
    if ([0, 3, 4].includes(boardCount)) cursor++; // burn before each new street
    if (cursor >= 52 || !CARDS.includes(hand.deck[cursor])) throw new Error('补看公共牌位置无效');
    cards.push(hand.deck[cursor]); indices.push(cursor++); boardCount++;
  }
  return { cards, indices };
}

function settlementPots(hand) {
  const contenders = hand.players.filter(p => !p.folded);
  const pots = [];
  // A missed small blind is dead money, not a live tier a player can reclaim
  // as uncalled. Keep it out of side-pot caps and award it with the main pot.
  const matched = p => p.contributed - (p.deadContribution ?? 0);
  const dead = hand.players.reduce((sum, p) => sum + (p.deadContribution ?? 0), 0);
  const levels = [...new Set(hand.players.map(matched).filter(n => n > 0))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of levels) {
    const contributors = hand.players.filter(p => matched(p) >= level);
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
    pots.push({ amount, eligibleIds: eligible.map(p => p.id) });
  }
  if (dead) {
    if (pots.length) pots[0].amount += dead;
    else pots.push({ amount: dead, eligibleIds: contenders.map(p => p.id) });
  }
  return pots;
}

/** Public live-pot display without refunding or mutating the actual hand. */
export function potPreview(hand) {
  if (hand.result) return { pots: hand.result.pots.map(({ amount, eligibleIds }) => ({ amount, eligibleIds: [...eligibleIds] })), uncalledBets: [] };
  // The rules helper removes uncalled overbets. Run it only on a disposable
  // copy, and report that unmatched portion separately as still awaiting calls.
  const preview = structuredClone(hand);
  const pots = settlementPots(preview);
  const uncalledBets = hand.players.flatMap((player, index) => {
    const amount = player.contributed - preview.players[index].contributed;
    return amount > 0 ? [{ playerId: player.id, amount }] : [];
  });
  return { pots, uncalledBets };
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
  for (const { amount, eligibleIds } of settlementPots(hand)) {
    const eligible = contenders.filter(p => eligibleIds.includes(p.id));
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
  if (hand.runout) hand.runout.active = false;
}

function lockAllIn(hand) {
  if (hand.allInLock) return;
  // Match settlement's unmatched-tier refunds before freezing the EV cost basis.
  const pots = settlementPots(hand);
  const players = hand.players.filter(p => !p.folded).map(p => ({ id: p.id, seat: p.seat, cards: [...p.cards], contributed: p.contributed }));
  hand.allInLock = {
    version: 1, street: hand.street, board: [...hand.board], players, pots,
    buttonSeat: hand.buttonSeat, logSeq: hand.log.length + 1,
  };
  log(hand, { type: 'allInLock', board: [...hand.board], playerIds: players.map(p => p.id) });
}

function advance(hand, afterSeat) {
  while (hand.status === 'playing') {
    const live = hand.players.filter(p => !p.folded);
    if (live.length === 1) {
      if (hand.deferredTransitions) { hand.actingId = null; hand.transition = { kind: 'award' }; return; }
      settle(hand); return;
    }
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
    // Live rooms publish the final action before drawing or exposing a
    // showdown. No future community card is drawn into this pending state.
    if (hand.deferredTransitions && hand.street === 'river') {
      hand.actingId = null; hand.transition = { kind: 'showdown' }; return;
    }
    refundUncalled(hand);
    if (mobile.length <= 1) lockAllIn(hand);
    if (hand.street === 'river') { settle(hand); return; }
    if (mobile.length <= 1) {
      if (hand.deferredRunout) {
        hand.actingId = null;
        hand.runout = { active: true, fromBoardCount: hand.board.length };
        return;
      }
    }
    if (hand.deferredTransitions) {
      hand.actingId = null; hand.transition = { kind: 'street' }; return;
    }
    nextStreet(hand);
    afterSeat = hand.buttonSeat;
  }
}

export function createHand({ id, players, buttonSeat, smallBlind, bigBlind, ante = 0, bombPot = false, entryPosts = [], deck, deferredRunout = false, deferredTransitions = false } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 9) throw new Error('需要 2 至 9 位玩家');
  if (typeof bombPot !== 'boolean' || (bombPot && !integer(ante, 1))) throw new Error('炸弹池前注无效');
  if (typeof deferredRunout !== 'boolean') throw new Error('跑牌设置无效');
  if (typeof deferredTransitions !== 'boolean') throw new Error('换轮设置无效');
  if (!integer(smallBlind, 1) || !integer(bigBlind, smallBlind) || !integer(ante)) throw new Error('盲注或前注无效');
  if (players.some(p => !p || typeof p.id !== 'string' || !p.id || !integer(p.seat) || !integer(p.stack, 1)) ||
      new Set(players.map(p => p.id)).size !== players.length || new Set(players.map(p => p.seat)).size !== players.length ||
      !Number.isSafeInteger(players.reduce((sum, p) => sum + p.stack, 0))) throw new Error('玩家、座位或带入积分无效');
  if (!integer(buttonSeat) || !players.some(p => p.seat === buttonSeat)) throw new Error('庄位必须是本手玩家');
  if (!Array.isArray(entryPosts) || new Set(entryPosts.map(p => p?.playerId)).size !== entryPosts.length ||
      entryPosts.some(post => !post || !players.some(p => p.id === post.playerId) || !integer(post.live) || !integer(post.dead) ||
        ![0, bigBlind].includes(post.live) || post.dead > smallBlind || (!post.live && !post.dead)) || (bombPot && entryPosts.length)) throw new Error('入桌补盲配置无效');
  const shuffled = deck === undefined ? shuffleDeck() : [...deck];
  if (shuffled.length !== 52 || new Set(shuffled).size !== 52 || shuffled.some(c => !CARDS.includes(c))) throw new Error('牌堆必须含 52 张不同扑克牌');
  const hand = {
    id, status: 'playing', street: 'preflop', buttonSeat, smallBlind, bigBlind, ante, bombPot, deferredRunout, deferredTransitions,
    // Server-owned policy, never a room/client option. Existing saved hands
    // without this marker finish under v1; every newly dealt hand uses v2.
    bettingRulesVersion: 2,
    smallBlindSeat: null, bigBlindSeat: null, board: [], boardIndices: [],
    deck: Object.freeze(shuffled), deckCursor: 0, burnIndices: [],
    players: players.map(p => ({ id: p.id, name: p.name ?? '', seat: p.seat,
      startingStack: p.stack, stack: p.stack, cards: [], cardIndices: [], folded: false,
      allIn: false, bet: 0, contributed: 0, deadContribution: 0, _acted: false, lastActedBet: null, reopenAt: null,
    })).sort((a, b) => a.seat - b.seat),
    actingId: null, currentBet: bigBlind, minRaise: bigBlind, log: [], result: null, allInLock: null, runout: null, transition: null,
  };
  const order = clockwise(hand, buttonSeat);
  const sb = players.length === 2 ? hand.players.find(p => p.seat === buttonSeat) : order[0];
  const bb = players.length === 2 ? order[0] : order[1];
  hand.smallBlindSeat = bombPot ? null : sb.seat;
  hand.bigBlindSeat = bombPot ? null : bb.seat;
  // Validate before any deduction. A posted live BB is a total live target,
  // never an extra blind on top of a naturally assigned BB.
  for (const post of entryPosts) {
    const p = hand.players.find(p => p.id === post.playerId);
    const natural = p === bb ? bigBlind : p === sb ? smallBlind : 0;
    if (p.stack < ante + Math.max(natural, post.live) + post.dead) throw new Error('补盲积分不足，请补码或等大盲');
  }
  if (ante) for (const p of order) contribute(hand, p, ante, 'ante', false);
  if (!bombPot) {
    contribute(hand, sb, smallBlind, 'smallBlind');
    contribute(hand, bb, bigBlind, 'bigBlind');
    for (const post of entryPosts) {
      const p = hand.players.find(p => p.id === post.playerId);
      if (post.live > p.bet) contribute(hand, p, post.live - p.bet, 'entryBlind');
      if (post.dead) p.deadContribution += contribute(hand, p, post.dead, 'deadBlind', false);
    }
  }
  for (let round = 0; round < 2; round++) for (const p of order) {
    const { card, index } = draw(hand);
    p.cards.push(card);
    p.cardIndices.push(index);
  }
  if (bombPot) nextStreet(hand);
  advance(hand, bombPot ? buttonSeat : bb.seat);
  return hand;
}

/** Resolve one server-scheduled round boundary, without skipping its next turn. */
export function advanceTransition(hand) {
  if (hand.status !== 'playing' || !hand.transition) return hand;
  if (hand.actingId !== null || hand.runout?.active) throw new Error('换轮状态无效');
  const { kind } = hand.transition;
  if (!['street', 'showdown', 'award'].includes(kind)
    || (kind === 'street' && hand.street === 'river') || (kind === 'showdown' && hand.street !== 'river')
    || (kind === 'award' && hand.players.filter(p => !p.folded).length !== 1)) throw new Error('换轮阶段无效');
  if (kind === 'showdown' && !hand.transition.afterRunout && !hand.transition.revealed) {
    hand.transition = { kind: 'showdown', revealed: true };
    return hand;
  }
  hand.transition = null;
  if (kind !== 'street') {
    if (kind === 'showdown' && hand.players.filter(p => !p.folded && !p.allIn).length <= 1) lockAllIn(hand);
    settle(hand);
  } else {
    nextStreet(hand);
    advance(hand, hand.buttonSeat);
  }
  return hand;
}

/** Reveal one complete street after betting locks; no equity code sees the deck. */
export function advanceRunout(hand) {
  if (hand.status !== 'playing' || !hand.runout?.active) return hand;
  if (hand.actingId !== null || !hand.allInLock || hand.board.length >= 5) throw new Error('跑牌状态无效');
  const count = hand.board.length;
  if (count === 0 || count === 3 || count === 4) {
    hand.street = count === 0 ? 'flop' : count === 3 ? 'turn' : 'river';
    hand.burnIndices.push(draw(hand).index);
    hand.currentBet = 0;
    hand.minRaise = hand.bigBlind;
    for (const p of hand.players) { p.bet = 0; p._acted = false; p.lastActedBet = null; p.reopenAt = null; }
  }
  // Legacy saved hands may already have one or two flop cards. Complete that
  // same flop without another burn, then continue with one turn and one river.
  const targetCount = count < 3 ? 3 : count + 1;
  while (hand.board.length < targetCount) {
    const { card, index } = draw(hand);
    hand.board.push(card);
    hand.boardIndices.push(index);
  }
  log(hand, { type: 'street', board: [...hand.board] });
  if (hand.board.length === 5) {
    if (hand.deferredTransitions) {
      hand.runout.active = false;
      hand.transition = { kind: 'showdown', afterRunout: true };
    } else settle(hand);
  }
  return hand;
}

export function availableActions(hand, playerId) {
  const p = hand.players.find(p => p.id === playerId);
  const canAct = hand.status === 'playing' && !hand.transition && hand.actingId === playerId && !!p && !p.folded && !p.allIn;
  if (!canAct) return { canAct: false, canCheck: false, canFold: false, callAmount: 0, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, canAllIn: false };
  const responder = hand.players.some(q => q.id !== p.id && !q.folded && !q.allIn);
  const amountToMatch = responder ? hand.currentBet : Math.max(0, ...hand.players.filter(q => q.id !== p.id && !q.folded).map(q => q.bet));
  const callAmount = Math.min(p.stack, Math.max(0, amountToMatch - p.bet));
  const maxRaiseTo = p.bet + p.stack;
  const minRaiseTo = hand.currentBet + hand.minRaise;
  const reopened = !p._acted || hand.currentBet >= p.reopenAt;
  // A player who has not yet called may still hold chips while being covered
  // by the existing wager. Such a short caller cannot contest any raise;
  // avoid offering a phantom side pot that would immediately be refunded.
  const raiseResponder = hand.players.some(q => q.id !== p.id && !q.folded && !q.allIn
    && q.bet + q.stack > hand.currentBet);
  const legacyCoveredRaises = (hand.bettingRulesVersion ?? 1) === 1;
  const mayIncrease = reopened && (legacyCoveredRaises ? responder : raiseResponder);
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
