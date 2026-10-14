import assert from 'node:assert/strict';

// Advance a test-owned Date.now clock through one real room timer. This does
// not alter production flags, clear delays or expose unrevealed deck cards.
export function advanceRoomEvent(service, room, setTime) {
  if (room.hand?.status !== 'playing') return false;
  const due = room.hand.transition?.nextAt ?? (room.hand.runout?.active ? room.hand.runout.nextAt : null)
    ?? (room.presentation?.handId === room.hand.id && !room.presentation.readyPublished ? room.presentation.actionReadyAt : null);
  if (!Number.isFinite(due)) return false;
  const timestamp = Math.max(Date.now(), due);
  setTime(timestamp);
  assert.ok(Date.now() >= due, 'test clock setter must update Date.now before a room command');
  return service.tick(room, timestamp);
}

// For accounting/rules fixtures which do not assert intermediate presentation:
// finish scheduled boundaries/runouts and return at the next legal action, or
// at hand completion. Dedicated timing tests should use advanceRoomEvent once.
export function readyRoomAction(service, room, setTime) {
  for (let steps = 0; steps < 16; steps++) {
    if (room.hand?.status !== 'playing') return false;
    const readyAt = room.presentation?.handId === room.hand.id ? room.presentation.actionReadyAt : null;
    if (room.hand.actingId && (!Number.isFinite(readyAt) || Date.now() >= readyAt)) return true;
    if (!advanceRoomEvent(service, room, setTime)) return false;
  }
  throw new Error('room fixture exceeded bounded presentation steps');
}
