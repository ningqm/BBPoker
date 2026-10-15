import { createHand, applyAction, availableActions, advanceRunout } from './poker.js';
import { handContext } from './hand-context.js';
import { handBigBlind } from './records.js';

const ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin']);
const EVENTS = new Set([...ACTIONS, 'smallBlind', 'bigBlind', 'entryBlind', 'deadBlind', 'ante', 'refund', 'street', 'runoutCard', 'allInLock']);
// Wager legality does not depend on cards. Replaying with this public dummy deck
// avoids ever inspecting an archived deck or an opponent's private hole cards.
const DUMMY_DECK = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
const finite = n => typeof n === 'number' && Number.isFinite(n);
const rate = (count, opportunities) => ({ count, opportunities, percent: opportunities ? Math.round(count / opportunities * 1000) / 10 : null });
const round = n => Math.round(n * 100) / 100;
const responses = () => ({ fold: 0, call: 0, raise: 0 });
const pair = (ids, a, b) => Array.isArray(ids) && ids.length === 2 && new Set(ids).size === 2 && ids.includes(a) && ids.includes(b);
const dealt = (h, id) => h.players?.some(p => p.id === id && Array.isArray(p.cards) && p.cards.length === 2);

function publicEvent(e) {
  return { type: e.type, street: e.street, playerId: e.playerId, amount: e.amount, to: e.to,
    boardCount: e.board?.length, playerIds: e.type === 'allInLock' ? [...(e.playerIds ?? [])].sort() : undefined };
}

/** Validate the entire public wager sequence through the actual rules engine.
 * Missing/illegal archives are unknown, never partially counted as zero. Dummy
 * showdown payouts are ignored; archived public winners are handled separately.
 */
function replayWagers(hand, mine, opponent) {
  try {
    if (!Array.isArray(hand.log) || !hand.log.length || hand.log.some((e, i) => !e || typeof e !== 'object'
      || e.seq !== undefined && e.seq !== i + 1 || !EVENTS.has(e.type) && !['payout', 'timeout'].includes(e.type))) return null;
    const posts = new Map();
    for (const e of hand.log) if (['entryBlind', 'deadBlind'].includes(e.type)) {
      if (e.street !== 'preflop') return null;
      const post = posts.get(e.playerId) ?? { playerId: e.playerId, live: 0, dead: 0 };
      if (e.type === 'entryBlind') post.live = e.to;
      else post.dead += e.amount;
      posts.set(e.playerId, post);
    }
    const simulation = createHand({ id: 'public-wager-replay', players: hand.players.map(p => ({ id: p.id, seat: p.seat, stack: p.startingStack })),
      buttonSeat: hand.buttonSeat, smallBlind: hand.smallBlind, bigBlind: hand.bigBlind, ante: hand.ante ?? 0, bombPot: hand.bombPot ?? false,
      entryPosts: [...posts.values()], deck: DUMMY_DECK, deferredRunout: hand.log.some(e => e.type === 'runoutCard') || hand.deferredRunout === true });
    // An old valid archive may contain a covered raise that was refunded.
    // Replay its original policy without rewriting actions or chip amounts.
    simulation.bettingRulesVersion = hand.bettingRulesVersion ?? 1;
    const result = { mine: responses(), opponent: responses(), threeBet: { mine: { count: 0, opportunities: 0 }, opponent: { count: 0, opportunities: 0 } } };
    let street = simulation.street, lastAggressor = null, firstRaiser = null, raises = 0;
    for (const e of hand.log.filter(e => ACTIONS.has(e.type))) {
      if (simulation.street !== street) { street = simulation.street; lastAggressor = null; }
      if (e.street !== simulation.street || e.playerId !== simulation.actingId) return null;
      const a = availableActions(simulation, e.playerId), p = simulation.players.find(p => p.id === e.playerId);
      const target = e.type === 'allin' ? p.bet + p.stack : e.to;
      const isRaise = ['raise', 'allin'].includes(e.type) && target > simulation.currentBet;
      const side = e.playerId === mine ? 'mine' : e.playerId === opponent ? 'opponent' : null;
      const peerId = side === 'mine' ? opponent : mine;
      const peer = simulation.players.find(p => p.id === peerId);
      // Legality is enforced before collecting any counters. Short all-in calls
      // remain calls; an unavailable re-raise does not create a 3-bet opportunity.
      const canIncrease = a.canRaise || a.canAllIn && a.maxRaiseTo > simulation.currentBet;
      const onlyPair = pair(simulation.players.filter(p => !p.folded).map(p => p.id), mine, opponent);
      const response = side && onlyPair && peer && !peer.folded && lastAggressor === peerId && a.callAmount > 0;
      const opportunity = side && !hand.bombPot && street === 'preflop' && raises === 1 && firstRaiser === peerId && canIncrease;
      applyAction(simulation, e.playerId, e.type, e.type === 'raise' ? e.to : undefined);
      if (response) result[side][e.type === 'fold' ? 'fold' : isRaise ? 'raise' : 'call']++;
      if (opportunity) { result.threeBet[side].opportunities++; if (isRaise) result.threeBet[side].count++; }
      if (isRaise) { lastAggressor = e.playerId; if (street === 'preflop') { raises++; firstRaiser ??= e.playerId; } }
    }
    while (simulation.status === 'playing' && simulation.runout?.active) advanceRunout(simulation);
    if (simulation.status !== 'complete') return null;
    const original = hand.log.filter(e => EVENTS.has(e.type)).map(publicEvent);
    const expected = simulation.log.filter(e => EVENTS.has(e.type)).map(publicEvent);
    if (JSON.stringify(original) !== JSON.stringify(expected)) return null;
    if (hand.players.some(p => {
      const q = simulation.players.find(q => q.id === p.id);
      return p.folded !== q.folded || finite(p.contributed) && p.contributed !== q.contributed;
    })) return null;
    result.lock = simulation.allInLock ? { players: simulation.allInLock.players.map(p => ({ id: p.id })), boardCount: simulation.allInLock.board.length } : null;
    return result;
  } catch { return null; }
}

function showdownResult(hand, mine, opponent) {
  if (hand.result?.showdown === false) return 'none';
  if (hand.result?.showdown !== true || hand.players.some(p => typeof p.folded !== 'boolean')) return 'unknown';
  const live = hand.players.filter(p => !p.folded).map(p => p.id);
  if (!pair(live, mine, opponent)) return 'none';
  const pots = hand.result.pots;
  if (!Array.isArray(pots) || pots.some(p => !Array.isArray(p.eligibleIds) || !Array.isArray(p.winnerIds)
    || !finite(p.amount) || p.amount <= 0 || !p.winnerIds.length || p.winnerIds.some(id => !p.eligibleIds.includes(id)))) return 'unknown';
  const shared = pots.filter(p => pair(p.eligibleIds, mine, opponent));
  if (!shared.length) return 'unknown';
  const outcomes = shared.map(p => pair(p.winnerIds, mine, opponent) ? 'ties'
    : p.winnerIds.length === 1 && p.winnerIds[0] === mine ? 'wins' : p.winnerIds.length === 1 && p.winnerIds[0] === opponent ? 'losses' : 'unknown');
  return new Set(outcomes).size === 1 ? outcomes[0] : 'unknown';
}

/** Aggregate only the viewer's encounters with one peer. No raw records, cards,
 * unrelated target earnings or target-only all-in snapshots leave this function.
 */
export function versusStats(hands, mine, opponent) {
  if (mine === opponent) return null;
  const shared = hands.filter(h => h.status === 'complete' && dealt(h, mine) && dealt(h, opponent));
  const headsUp = { hands: 0, profitRate: null, netBB: 0, bbHands: 0, bbComplete: true };
  const showdown = { hands: 0, wins: 0, losses: 0, ties: 0 };
  const actions = { mine: responses(), opponent: responses() };
  const threeBet = { mine: { count: 0, opportunities: 0 }, opponent: { count: 0, opportunities: 0 } };
  const allIn = { eligibleHands: 0, hands: 0, unavailableHands: 0, estimatedHands: 0,
    actualNetBB: null, expectedNetBB: null, differenceBB: null, bbHands: 0, bbComplete: true };
  const coverage = { flopUnknownHands: 0, actionUnknownHands: 0, showdownUnknownHands: 0, allInUnknownHands: 0 };
  let profitHands = 0, netHands = 0, allInActual = 0, allInExpected = 0;
  for (const hand of shared) {
    const player = hand.players.find(p => p.id === mine), bb = handBigBlind(hand);
    const net = finite(player.stack) && finite(player.startingStack) ? player.stack - player.startingStack : null;
    const context = handContext(hand, mine);
    if (context.potType === 'unknown') coverage.flopUnknownHands++;
    if (context.potType === 'headsUp' && context.flopPlayerIds.includes(opponent)) {
      headsUp.hands++;
      if (net !== null) { netHands++; if (net > 0) profitHands++; }
      if (bb !== null && net !== null) { headsUp.netBB += net / bb; headsUp.bbHands++; }
    }
    const outcome = showdownResult(hand, mine, opponent);
    if (outcome === 'unknown') coverage.showdownUnknownHands++;
    else if (outcome !== 'none') { showdown.hands++; showdown[outcome]++; }
    const replay = replayWagers(hand, mine, opponent);
    if (!replay) coverage.actionUnknownHands++;
    else for (const side of ['mine', 'opponent']) {
      for (const type of ['fold', 'call', 'raise']) actions[side][type] += replay[side][type];
      for (const key of ['count', 'opportunities']) threeBet[side][key] += replay.threeBet[side][key];
    }
    // Missing old snapshots can establish eligibility through reliable public
    // wagers, but never supply invented equity from the completed board.
    const lock = hand.allInLock;
    const lockIds = lock?.players?.map(p => p.id);
    const reliableLock = lock && Array.isArray(lock.board) && [0, 3, 4, 5].includes(lock.board.length) && Array.isArray(lockIds) && lockIds.length >= 2;
    if (lock && !reliableLock || !lock && !replay) { coverage.allInUnknownHands++; continue; }
    const ids = reliableLock ? lockIds : replay?.lock?.players.map(p => p.id);
    const boardCount = reliableLock ? lock.board.length : replay?.lock?.boardCount;
    if (!pair(ids, mine, opponent) || !(boardCount < 5)) continue;
    allIn.eligibleHands++;
    const equity = hand.allInEquity, expected = equity?.players?.find(p => p.id === mine);
    const aligned = reliableLock && Array.isArray(equity?.board) && JSON.stringify(equity.board) === JSON.stringify(lock.board)
      && pair(equity.players?.map(p => p.id), mine, opponent);
    if (!aligned || !finite(expected?.expectedNet) || net === null || !['exact', 'monte-carlo'].includes(equity.method)) continue;
    allIn.hands++;
    if (equity.method !== 'exact') allIn.estimatedHands++;
    if (bb !== null) { allInActual += net / bb; allInExpected += expected.expectedNet / bb; allIn.bbHands++; }
  }
  headsUp.profitRate = rate(profitHands, netHands);
  headsUp.bbComplete = headsUp.bbHands === headsUp.hands;
  headsUp.netBB = headsUp.bbComplete ? round(headsUp.netBB) : null;
  const resultResponses = {};
  for (const side of ['mine', 'opponent']) {
    const total = Object.values(actions[side]).reduce((a, b) => a + b, 0);
    resultResponses[side] = Object.fromEntries(Object.entries(actions[side]).map(([type, count]) => [type, rate(count, total)]));
    threeBet[side] = rate(threeBet[side].count, threeBet[side].opportunities);
  }
  allIn.unavailableHands = allIn.eligibleHands - allIn.hands;
  allIn.bbComplete = allIn.bbHands === allIn.hands;
  if (allIn.hands && allIn.bbComplete) { allIn.actualNetBB = round(allInActual); allIn.expectedNetBB = round(allInExpected); allIn.differenceBB = round(allInActual - allInExpected); }
  return { sharedHands: shared.length, headsUp, showdown, responses: resultResponses, threeBet, allIn, coverage };
}
