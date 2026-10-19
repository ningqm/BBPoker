// Pre-actions are local, cancellable intent. They never send a command before
// the server grants this player a turn, and they never authorize a higher bet.
const chipAmount = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0;
const bettingStreets = new Set(['preflop', 'flop', 'turn', 'river']);
const allowedKinds = new Set(['check-fold', 'call-current']);
const playerActionKinds = new Set(['fold', 'check', 'call', 'bet', 'raise', 'allin']);

export function preActionOptions(room) {
  const hand = room?.hand, players = Array.isArray(room?.players) ? room.players : [];
  const me = players.find(player => player?.id === room.meId);
  const ownTurn = Boolean(hand?.actingId && hand.actingId === room?.meId);
  const inHand = Boolean(me?.inHand && !me.folded && !me.allIn);
  const scopeKey = identifier(room?.code) && identifier(room?.meId) && identifier(hand?.id)
    && bettingStreets.has(hand?.street) ? JSON.stringify([room.code, room.meId, hand.id, hand.street]) : null;
  const validPlayers = Array.isArray(room?.players) && players.every(player => player && (!player.inHand
    || chipAmount(player.bet) && chipAmount(player.stack)));
  const participating = Boolean(scopeKey && room.status !== 'closed' && hand.status === 'playing'
    && !hand.transition && !hand.runout?.active && inHand && !me.sittingOut && !me.leftRoom && !me.pendingDeparture
    && Number.isSafeInteger(me.seat) && me.seat >= 0 && chipAmount(me.stack) && me.stack > 0
    && chipAmount(me.bet) && chipAmount(hand.currentBet) && me.bet <= hand.currentBet
    && Number.isSafeInteger(me.bet + me.stack) && validPlayers);
  if (!participating) return { eligible: false, waiting: false, participating: false, inHand, ownTurn,
    key: null, scopeKey, callAmount: 0, currentBet: null, amountToMatch: 0, shortCall: false, callAllIn: false };
  const opponents = room.players.filter(player => player.id !== room.meId && player.inHand && !player.folded);
  // Match the engine's uncalled-bet cap if all surviving opponents are all-in.
  const amountToMatch = opponents.some(player => !player.allIn) ? hand.currentBet
    : Math.max(0, ...opponents.map(player => player.bet));
  const required = Math.max(0, amountToMatch - me.bet), callAmount = Math.min(me.stack, required);
  const waiting = Boolean(identifier(hand.actingId) && !ownTurn && !room.actions?.canAct && !room.actions?.turnAvailable);
  const key = JSON.stringify([scopeKey, hand.currentBet, amountToMatch, callAmount]);
  return { eligible: waiting, waiting, participating, inHand, ownTurn, key, scopeKey,
    callAmount, currentBet: hand.currentBet, amountToMatch, shortCall: callAmount < required,
    callAllIn: callAmount > 0 && callAmount === me.stack };
}

const freshContext = context => Boolean(context?.identity && context.page === 'room'
  && context.connected === true && context.visible === true && !context.resync
  && !context.staleSnapshot && context.online !== false && !context.foregroundPending);
const safeContext = context => freshContext(context) && !context.busy;
const ownActions = room => Array.isArray(room?.hand?.log) ? JSON.stringify(room.hand.log.flatMap((entry, index) =>
  entry?.playerId === room.meId && playerActionKinds.has(entry.type) ? [[entry.seq ?? index, entry.type]] : [])) : null;

export function createPreActions() {
  let selection = null, binding = null;
  function reset() { selection = binding = null; }
  function update(room, context) {
    if (!selection) return null;
    // A short network interruption or background visit suspends intent; it
    // does not erase it. Identity/navigation changes remain immediate, while
    // stale snapshots cannot invalidate a choice based on obsolete hand data.
    if (context?.identity !== binding.identity || context?.page !== 'room'
      || room?.code && room.code !== binding.roomCode || room?.meId && room.meId !== binding.playerId) {
      reset(); return null;
    }
    if (!freshContext(context)) return selection;
    const options = preActionOptions(room), me = Array.isArray(room?.players) ? room.players.find(player => player?.id === room.meId) : null;
    // Auto-check can advance a player's action without changing bet or stack.
    // The full public action log prevents reusing old intent on a later turn
    // of the same street after a background timeout and an intervening raise.
    const changedOwnActions = binding.ownActions !== null && ownActions(room) !== binding.ownActions;
    if (!options.participating || options.scopeKey !== selection.scopeKey
      || me.bet !== binding.ownBet || me.stack !== binding.ownStack || changedOwnActions
      || selection.kind === 'call-current' && options.key !== selection.key) reset();
    return selection;
  }
  function toggle(kind, room, context) {
    update(room, context);
    const options = preActionOptions(room);
    if (!allowedKinds.has(kind) || !safeContext(context) || !options.eligible) return null;
    if (selection?.kind === kind) { reset(); return null; }
    const me = room.players.find(player => player.id === room.meId);
    binding = { identity: context.identity, roomCode: room.code, playerId: room.meId,
      ownBet: me.bet, ownStack: me.stack, ownActions: ownActions(room) };
    selection = Object.freeze({ kind, key: options.key, scopeKey: options.scopeKey,
      currentBet: options.currentBet, amountToMatch: options.amountToMatch, callAmount: options.callAmount,
      shortCall: options.shortCall, callAllIn: options.callAllIn });
    return selection;
  }
  function consume(room, context) {
    if (!update(room, context) || !safeContext(context)) return null;
    const options = preActionOptions(room), actions = room.actions || {}, hand = room.hand;
    if (!options.ownTurn || actions.canAct !== true) return null;
    // canAct is authoritative; the display countdown may deliberately remain
    // ahead after server clock calibration. Only compare the snapshot's times.
    if (Number.isFinite(hand.actionReadyAt) && Number.isFinite(room.serverTime)
      && room.serverTime < hand.actionReadyAt) return null;
    const selected = selection;
    // Consume before returning so duplicate renders/frames cannot send twice.
    reset();
    if (!chipAmount(actions.callAmount) || actions.callAmount !== options.callAmount) return null;
    if (selected.kind === 'check-fold') {
      if (actions.canCheck === true && actions.callAmount === 0) return { type: 'check' };
      return actions.canCheck === false && actions.canFold === true && actions.callAmount > 0 ? { type: 'fold' } : null;
    }
    if (selected.callAmount === 0) return actions.canCheck === true ? { type: 'check' } : null;
    return actions.canCheck === false && actions.callAmount === selected.callAmount ? { type: 'call' } : null;
  }
  return { toggle, update, consume, reset, get selection() { return selection; } };
}
