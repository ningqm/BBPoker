// Use the frozen hand/round snapshot. A room can change modes between rounds.
export function handGameMode(hand) {
  const round = Object.hasOwn(hand, 'squidRound') ? hand.squidRound
    : hand.miniBefore?.squid?.active ? hand.miniBefore.squid.round : null;
  if (round == null) return { type: hand.bombPot ? 'bomb' : 'holdem', squid: 'none' };
  const snapshot = [hand.miniAfter?.squid, hand.miniBefore?.squid].find(q => q?.round === round);
  const mode = hand.squidMode ?? snapshot?.mode ?? 'normal';
  return { type: hand.bombPot ? 'bomb' : 'holdem', squid: mode === 'unlimited' ? 'unlimited' : 'normal' };
}
export function handGameMatches(hand, filter) {
  const mode = handGameMode(hand);
  return (!filter.type || filter.type === 'all' || filter.type === mode.type)
    && (!filter.squid || filter.squid === 'all' || filter.squid === mode.squid);
}
