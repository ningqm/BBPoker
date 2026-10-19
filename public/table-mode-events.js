// A presentation-only observer of already committed public room state. It never
// starts a hand, changes a deadline, calculates a settlement or submits a command.
export const TABLE_MODE_OPENING_MS = 1100;
export const TABLE_MODE_RESULT_MS = 2600;
export const SQUID_RESULT_DELAY_MS = 1800;
const MAX_TRANSPORT_DELAY_MS = 5000;
const ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin']);

const time = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && value ? Date.parse(value) : NaN;
const number = value => Number.isFinite(value) ? value : 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const identity = value => typeof value === 'string' && value.length > 0 ? value : null;

function snapshot(room) {
  if (!identity(room?.code) || !identity(room.meId)) return null;
  const hand = room.hand, q = room.mini?.squid, result = q?.lastResult;
  const settledAt = time(result?.settledAt), settledRound = count(result?.round);
  const settlementId = identity(result?.roundSettlementId) ??
    (settledRound && Number.isFinite(settledAt) ? `${settledRound}:${settledAt}` : null);
  // Retain only public identifiers and scalar presentation values. No cards,
  // user supplied names, chat, invite tokens or account data enter this tracker.
  return {
    code: room.code, meId: room.meId, revision: room.revision, status: room.status,
    serverTime: time(room.serverTime), bigBlind: number(room.settings?.bigBlind),
    hand: hand && identity(hand.id) ? {
      id: hand.id, number: count(hand.number), status: hand.status, at: time(hand.at),
      actionReadyAt: time(hand.actionReadyAt), seq: count(hand.actionSeq),
      bombPot: hand.bombPot === true, ante: number(hand.ante),
      hasAction: Array.isArray(hand.log) && hand.log.some(event => ACTIONS.has(event?.type)),
      logKnown: Array.isArray(hand.log),
    } : null,
    squid: {
      active: q?.active === true, round: count(q?.round),
      settlementId: identity(q?.roundSettlementId),
      mode: q?.mode === 'unlimited' ? 'unlimited' : 'normal',
      tokenBudget: count(q?.tokenBudget), participantCount: Array.isArray(q?.participants) ? q.participants.length : 0,
      unit: number(q?.unit),
      result: settlementId && settledRound && Number.isFinite(settledAt) ? {
        id: settlementId, round: settledRound, at: settledAt,
        handId: identity(result.handId), mode: result.mode === 'unlimited' ? 'unlimited' : 'normal',
        unit: number(result.unit), tokenBudget: count(result.tokenBudget),
        tokensAwarded: count(result.tokensAwarded), amount: number(result.amount),
        ownDelta: Object.hasOwn(result.changes ?? {}, room.meId) && Number.isFinite(result.changes[room.meId])
          ? result.changes[room.meId] : null,
        participantCount: Array.isArray(result.winnerIds) && Array.isArray(result.loserIds)
          ? result.winnerIds.length + result.loserIds.length : 0,
      } : null,
    },
  };
}

function older(current, previous) {
  if (!previous || current.code !== previous.code || current.meId !== previous.meId) return false;
  if (Number.isFinite(current.revision) && Number.isFinite(previous.revision) && current.revision < previous.revision) return true;
  if (current.squid.round < previous.squid.round) return true;
  if (!previous.hand) return false;
  if (!current.hand) return true;
  return current.hand.number < previous.hand.number ||
    (current.hand.id === previous.hand.id && current.hand.seq < previous.hand.seq);
}

function eventsSince(previous, current, now) {
  const events = [], prefix = `${current.code}:${current.meId}`;
  const before = previous.squid, squid = current.squid, result = squid.result;
  if (result && result.id !== before.result?.id && result.round === before.round &&
      result.round <= squid.round && result.at <= now && now < result.at + SQUID_RESULT_DELAY_MS + TABLE_MODE_RESULT_MS) {
    events.push({ id: `${prefix}:squid-end:${result.id}`, type: 'squid-end',
      at: result.at + SQUID_RESULT_DELAY_MS, until: result.at + SQUID_RESULT_DELAY_MS + TABLE_MODE_RESULT_MS,
      handId: result.handId, mode: result.mode, round: result.round,
      unit: result.unit, bigBlind: current.bigBlind, tokenBudget: result.tokenBudget,
      participantCount: result.participantCount, tokensAwarded: result.tokensAwarded,
      ownDelta: result.ownDelta, amount: result.amount });
  }
  const hand = current.hand;
  const newDeal = current.status !== 'closed' && hand?.status === 'playing' &&
    hand.id !== previous.hand?.id && hand.number === (previous.hand?.number ?? 0) + 1 &&
    hand.logKnown && !hand.hasAction && Number.isFinite(hand.at);
  if (!newDeal) return events;
  // The existing deal guard already reserves this interval. Never create a new
  // client-side wait, and do not show an opening after someone may act.
  const until = Math.min(hand.at + TABLE_MODE_OPENING_MS,
    Number.isFinite(hand.actionReadyAt) ? hand.actionReadyAt : Infinity);
  if (hand.at > now || now >= until) return events;
  if (hand.bombPot) events.push({ id: `${prefix}:bomb-start:${hand.id}`, type: 'bomb-start',
    at: hand.at, until, handId: hand.id, ante: hand.ante, bigBlind: current.bigBlind });
  if (squid.active && squid.round === before.round + 1) {
    events.push({ id: `${prefix}:squid-start:${squid.settlementId ?? squid.round}`, type: 'squid-start',
      at: hand.at, until, handId: hand.id, mode: squid.mode, round: squid.round,
      unit: squid.unit, bigBlind: current.bigBlind, tokenBudget: squid.tokenBudget,
      participantCount: squid.participantCount });
  }
  return events;
}

/**
 * Feed every accepted snapshot, including hidden/disconnected states. `now` is
 * the server-adjusted room clock. Returned at/until are server epoch millis.
 * First load, account/table changes and reconnects are silent baselines; there
 * is deliberately no catch-up queue or browser storage of animation events.
 */
export function createTableModeTracker() {
  let previous = null, mutedBaseline = false;
  const seen = new Set();
  return {
    reset() { previous = null; mutedBaseline = false; seen.clear(); },
    update(room, { live = true, visible = true, connected = true, reconnected = false,
      enabled = true, now = Date.now() } = {}) {
      const current = snapshot(room);
      if (!current) { previous = null; mutedBaseline = false; seen.clear(); return []; }
      if (older(current, previous)) return [];
      const sameRoom = previous?.code === current.code && previous?.meId === current.meId;
      if (!sameRoom) seen.clear();
      const delayed = Number.isFinite(current.serverTime) && now - current.serverTime > MAX_TRANSPORT_DELAY_MS;
      const suppressed = !live || !visible || !connected || !enabled || reconnected || delayed || !Number.isFinite(now);
      const events = sameRoom && !suppressed && !mutedBaseline ? eventsSince(previous, current, now) : [];
      previous = current;
      mutedBaseline = !live || !visible || !connected || !enabled;
      return events.filter(event => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        // A bounded guard against duplicate/rolled-back snapshots, not an event
        // log. One active table needs only the most recent presentation keys.
        if (seen.size > 128) seen.delete(seen.values().next().value);
        return true;
      });
    },
  };
}
