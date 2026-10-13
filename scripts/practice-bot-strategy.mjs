import { evaluate } from '../src/poker.js';

// This is an ordinary player's practice opponent, not part of the dealer.
// Only our two hole cards and the visible board remove cards from this deck.
const CARDS = [...'cdhs'].flatMap(suit => [...'23456789TJQKA'].map(rank => rank + suit));
const SAMPLES = 200;
const compare = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
};

function estimateEquity(cards, board, opponents, random) {
  const known = [...cards, ...board];
  if (cards.length !== 2 || board.length > 5 || new Set(known).size !== known.length || known.some(card => !CARDS.includes(card))) return null;
  const unseen = CARDS.filter(card => !known.includes(card));
  const required = 5 - board.length + opponents * 2;
  if (required > unseen.length) return null;
  let score = 0;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const shuffled = [...unseen];
    // Partial Fisher-Yates: independently sample opponents and future board.
    // These hypothetical cards never enter a request to the real game server.
    for (let i = 0; i < required; i++) {
      const j = i + Math.floor(random() * (shuffled.length - i));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const futureBoard = [...board, ...shuffled.slice(0, 5 - board.length)];
    const own = evaluate([...cards, ...futureBoard]).tuple;
    let ties = 1, beaten = false, cursor = 5 - board.length;
    for (let opponent = 0; opponent < opponents; opponent++) {
      const other = evaluate([...shuffled.slice(cursor, cursor + 2), ...futureBoard]).tuple;
      cursor += 2;
      const comparison = compare(own, other);
      if (comparison < 0) { beaten = true; break; }
      if (!comparison) ties++;
    }
    if (!beaten) score += 1 / ties;
  }
  return score / SAMPLES;
}

/**
 * Input: RoomService.state(room, botUserId), exactly the normal HTTP/SSE view.
 * Output: null or { action: 'check'|'call'|'fold'|'raise'|'allin', amount? }.
 * The HTTP runner maps action to command.type and attaches handId/actionSeq.
 * This modest heuristic is for free practice, not a solver: rivals are sampled
 * uniformly and neither hidden opponent cards nor future real cards are read.
 * random must return a number in [0, 1), like Math.random.
 */
export function decideAction(room, { random = Math.random } = {}) {
  const hand = room?.hand, actions = room?.actions;
  if (!hand || room.status === 'closed' || hand.status !== 'playing' || hand.runout?.active || !actions?.canAct || hand.actingId !== room.meId) return null;
  const me = room.players?.find(player => player.id === room.meId);
  if (!me?.inHand || me.folded || me.allIn) return null;
  // Deliberately never access any other player's cards, even if supplied.
  const opponents = room.players.filter(player => player.id !== room.meId && player.inHand && !player.folded).length;
  if (!opponents) return null;
  const safeAction = () => actions.canCheck ? { action: 'check' } : actions.canFold ? { action: 'fold' } : null;
  const equity = estimateEquity(Array.isArray(me.cards) ? me.cards : [], Array.isArray(hand.board) ? hand.board : [], opponents, random);
  if (equity === null) return safeAction();

  const bigBlind = Math.max(1, room.settings?.bigBlind ?? 1);
  const call = Math.max(0, actions.callAmount ?? 0);
  const pot = Math.max(bigBlind, hand.pot ?? 0);
  const odds = call / (pot + call);
  const strong = equity > Math.max(0.57, 1 / (opponents + 1) + 0.16);
  const bluff = actions.canCheck && opponents === 1 && random() < 0.06;

  if ((strong && random() < 0.65 || bluff) && actions.canRaise &&
      Number.isSafeInteger(actions.minRaiseTo) && Number.isSafeInteger(actions.maxRaiseTo) && actions.maxRaiseTo >= actions.minRaiseTo) {
    const increment = hand.street === 'preflop' ? Math.max(bigBlind, 2.5 * bigBlind - hand.currentBet) : Math.max(bigBlind, pot * 0.6);
    const amount = Math.min(actions.maxRaiseTo, Math.max(actions.minRaiseTo, Math.round(hand.currentBet + increment)));
    return { action: 'raise', amount };
  }
  // A short stack may legally increase the wager without meeting minRaiseTo.
  // Use only the explicit all-in permission; never manufacture a normal raise.
  if (!actions.canRaise && actions.canAllIn && actions.maxRaiseTo > hand.currentBet && equity > 0.8 && random() < 0.65) return { action: 'allin' };
  if (actions.canCheck) return { action: 'check' };
  if (call > 0 && (equity >= odds + 0.07 || call <= bigBlind && equity >= 0.27)) return { action: 'call' };
  return safeAction();
}
