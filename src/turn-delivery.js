// A bounded, durable receipt compensates a delayed turn notification. It does
// not replay bets, undo timeouts, depend on the client's clock, or let a second
// device/reconnect add time again. Legacy clients keep the normal deadline.
export const MAX_DELIVERY_GRACE_MS = 8000;
export const DELIVERY_JITTER_MS = 1000;
export const DELIVERY_BUDGET_MS = 20000;
export const DELIVERY_BUDGET_WINDOW_MS = 30 * 60 * 1000;

export const turnDeliveryKey = room => JSON.stringify([room.code, room.hand?.id, room.hand?.log?.length, room.hand?.actingId]);

export function turnDeliveryReceipt(room, userId, receipt, timestamp = Date.now(), { commit = true, allowGrace = true } = {}) {
  const hand = room.hand, presentation = room.presentation;
  if (room.status === 'closed' || hand?.status !== 'playing' || hand.actingId !== userId
    || hand.transition || hand.runout?.active || receipt?.handId !== hand.id
    || receipt?.actionSeq !== hand.log.length || presentation?.handId !== hand.id
    || !Number.isFinite(presentation.actionReadyAt) || timestamp < presentation.actionReadyAt
    || !Number.isFinite(room.deadline) || timestamp >= room.deadline) return { accepted: false, changed: false };
  const key = `${hand.id}:${hand.log.length}:${userId}`;
  if (presentation.deliveryReceipt?.key === key) return { accepted: true, changed: false };
  const elapsed = Math.max(0, timestamp - presentation.actionReadyAt);
  // Receipt delay alone cannot prove a slow network. Bound intentional delay:
  // one compensated action per hand and at most 20 seconds per 30-minute
  // window/player. Budgets are saved with real grace; reconnects do not reset.
  const previous = room.deliveryBudgets?.[userId];
  const anchor = Number.isFinite(room.startedAt) ? room.startedAt : 0;
  const window = Math.max(0, Math.floor((timestamp - anchor) / DELIVERY_BUDGET_WINDOW_MS));
  const budget = previous && window <= previous.window ? previous : { window, used: 0, handId: previous?.handId ?? null };
  const remaining = Math.max(0, DELIVERY_BUDGET_MS - budget.used);
  const grace = allowGrace && elapsed > DELIVERY_JITTER_MS && budget.handId !== hand.id
    ? Math.min(MAX_DELIVERY_GRACE_MS, elapsed, remaining) : 0;
  if (commit) {
    presentation.deliveryReceipt = { key, at: timestamp, grace };
    // Preserve any previously spent time cards; only this fixed grace is added.
    room.deadline += grace;
    if (grace > 0) {
      room.deliveryBudgets ??= {};
      room.deliveryBudgets[userId] = { window: budget.window, used: budget.used + grace, handId: hand.id };
    }
  }
  return { accepted: true, changed: true, grace };
}

export function publicTurnDelivery(room) {
  const hand = room.hand, receipt = room.presentation?.deliveryReceipt;
  if (!receipt || room.presentation?.handId !== hand?.id
    || receipt.key !== `${hand.id}:${hand.log.length}:${hand.actingId}`) return null;
  return { acknowledged: true, seconds: receipt.grace / 1000, at: receipt.at };
}
