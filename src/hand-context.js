// Read-only historical context: never inspect a deck, a player's cards or the
// current room's membership/settings. All positions refer to this dealt hand.
const EARLY_POSITIONS = {
  3: [], 4: ['CO'], 5: ['HJ', 'CO'], 6: ['UTG', 'HJ', 'CO'],
  7: ['UTG', 'LJ', 'HJ', 'CO'], 8: ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO'],
  9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
};
const seat = value => Number.isInteger(value) && value >= 0 && value < 9;
const unknownFlop = () => ({ known: false, ids: [] });

function positionFor(hand, players, userId) {
  if (!players.every(p => seat(p.seat)) || new Set(players.map(p => p.seat)).size !== players.length
    || !seat(hand.buttonSeat) || !players.some(p => p.seat === hand.buttonSeat)) return 'unknown';
  const ordered = [...players].sort((a, b) => a.seat - b.seat);
  const buttonIndex = ordered.findIndex(p => p.seat === hand.buttonSeat);
  const clockwise = [...ordered.slice(buttonIndex + 1), ...ordered.slice(0, buttonIndex + 1)];
  const button = clockwise.at(-1);
  // Bomb pots have no natural blinds. Only their archived button is meaningful.
  if (hand.bombPot) return button.id === userId ? 'BTN' : 'unknown';
  const sb = players.length === 2 ? button : clockwise[0], bb = players.length === 2 ? clockwise[0] : clockwise[1];
  if (hand.smallBlindSeat !== sb.seat || hand.bigBlindSeat !== bb.seat) return 'unknown';
  if (button.id === userId) return players.length === 2 ? 'BTN/SB' : 'BTN';
  if (sb.id === userId) return 'SB';
  if (bb.id === userId) return 'BB';
  const index = clockwise.slice(2, -1).findIndex(p => p.id === userId);
  return EARLY_POSITIONS[players.length]?.[index] ?? 'unknown';
}

/** Reconstruct the initial real flop from the chronological action log.
 * Later folds never change its size. Preflop all-in runouts count once three
 * real cards are dealt; rabbit cards do not. A missing/incomplete log yields
 * unknown, never a guess based on the final folded flags or rabbit board.
 */
function initialFlop(hand, players) {
  const log = hand.log;
  if (!Array.isArray(log) || !log.length) return unknownFlop();
  const ids = new Set(players.map(p => p.id)), live = new Set(ids), posts = new Set();
  let smallBlind = false, bigBlind = false, payout = false;
  for (let i = 0; i < log.length; i++) {
    const event = log[i];
    if (!event || typeof event !== 'object' || (event.seq !== undefined && event.seq !== i + 1)) return unknownFlop();
    if (event.type === 'smallBlind') smallBlind = ids.has(event.playerId);
    if (event.type === 'bigBlind') bigBlind = ids.has(event.playerId);
    if (event.type === 'ante' && ids.has(event.playerId)) posts.add(event.playerId);
    if (event.type === 'fold') {
      if (event.street !== 'preflop' || !live.has(event.playerId)) return unknownFlop();
      live.delete(event.playerId);
    }
    if (event.type === 'street') {
      const posted = hand.bombPot ? posts.size === players.length : smallBlind && bigBlind;
      if (!posted || event.street !== 'flop' || !Array.isArray(event.board) || event.board.length < 3 || live.size < 2) return unknownFlop();
      return { known: true, ids: [...live] };
    }
    if (event.type === 'payout') payout = true;
    if (event.street && event.street !== 'preflop' && !(event.type === 'runoutCard' && event.street === 'flop')) return unknownFlop();
  }
  const posted = hand.bombPot ? posts.size === players.length : smallBlind && bigBlind;
  return posted && payout && hand.status === 'complete' && Array.isArray(hand.board) && hand.board.length === 0 && live.size === 1
    ? { known: true, ids: [] } : unknownFlop();
}

export function handContext(hand, userId) {
  const players = Array.isArray(hand.players) ? hand.players : [];
  const valid = players.length >= 2 && players.length <= 9 && players.every(p => p && typeof p.id === 'string' && p.id)
    && new Set(players.map(p => p.id)).size === players.length;
  if (!valid) return { position: 'unknown', tableSize: null, potType: 'unknown', flopPlayers: null, dealtIds: [], flopPlayerIds: [] };
  const flop = initialFlop(hand, players), participated = players.some(p => p.id === userId);
  const sawFlop = flop.ids.includes(userId);
  return { position: participated ? positionFor(hand, players, userId) : 'unknown', tableSize: players.length,
    potType: !participated || !flop.known ? 'unknown' : !sawFlop ? 'noFlop' : flop.ids.length === 2 ? 'headsUp' : 'multiway',
    flopPlayers: flop.known ? flop.ids.length : null, dealtIds: players.map(p => p.id), flopPlayerIds: flop.ids };
}

export function handContextMatches(context, userId, filter) {
  if (filter.opponent && (filter.opponent === userId || !context.dealtIds.includes(filter.opponent))) return false;
  if (filter.position !== 'all' && context.position !== filter.position
    && !(context.position === 'BTN/SB' && ['BTN', 'SB'].includes(filter.position))) return false;
  if (filter.potType !== 'all' && context.potType !== filter.potType) return false;
  if (filter.opponent && ['headsUp', 'multiway'].includes(filter.potType)
    && !context.flopPlayerIds.includes(filter.opponent)) return false;
  const size = context.tableSize;
  return filter.tableSize === 'all' || filter.tableSize === 'headsUp' && size === 2
    || filter.tableSize === 'short' && size >= 3 && size <= 6 || filter.tableSize === 'full' && size >= 7 && size <= 9;
}
