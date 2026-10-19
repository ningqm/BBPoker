// A revision alone cannot deduplicate a projection: readiness, connectivity
// and delivery grace can change without a new betting action. Compare every
// JSON-visible field except the root server clock, which is accepted separately.
export function sameRoomSnapshot(previous, next) {
  if (!previous || !next || previous.code !== next.code || previous.meId !== next.meId) return false;
  return equal(previous, next, true);
}

function equal(a, b, root = false) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).filter(key => !root || key !== 'serverTime');
  const other = Object.keys(b).filter(key => !root || key !== 'serverTime');
  if (keys.length !== other.length) return false;
  return keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
