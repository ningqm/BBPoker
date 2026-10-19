// Server-owned, single-use intent. Never projected to another player.
const playerActions = new Set(['fold', 'check', 'call', 'bet', 'raise', 'allin']);
const countActions = (h, id) => h.log.filter(e => e.playerId === id && playerActions.has(e.type)).length;
export function preActionQuote(r, m) {
  const h = r.hand, p = h?.players.find(p => p.id === m?.id);
  if (!m || m.seat === null || m.leftRoom || m.sittingOut || m.pendingDeparture || r.status === 'closed'
    || h?.status !== 'playing' || h.transition || h.runout?.active || !h.actingId
    || !p || p.folded || p.allIn || p.stack <= 0) return null;
  const others = h.players.filter(x => x.id !== m.id && !x.folded);
  const amountToMatch = others.some(x => !x.allIn) ? h.currentBet : Math.max(0, ...others.map(x => x.bet));
  return { currentBet: h.currentBet, ownBet: p.bet, ownStack: p.stack, amountToMatch,
    callAmount: Math.min(p.stack, Math.max(0, amountToMatch - p.bet)), ownActionCount: countActions(h, m.id) };
}
export function preActionValid(r, m, epoch) {
  const i = m?.preAction, q = preActionQuote(r, m);
  return Boolean(i && q && i.epoch === epoch && i.handId === r.hand.id && i.street === r.hand.street
    && i.ownBet === q.ownBet && i.ownStack === q.ownStack && i.ownActionCount === q.ownActionCount
    && (i.kind === 'check-fold' || i.kind === 'call-current' && i.currentBet === q.currentBet
      && i.amountToMatch === q.amountToMatch && i.callAmount === q.callAmount));
}
export function clearPreAction(m, reason) {
  if (!m.preAction) return;
  m.preActionResult = { id: m.preAction.id, reason };
  m.preAction = null; m.preActionVersion = (m.preActionVersion ?? 0) + 1;
}
