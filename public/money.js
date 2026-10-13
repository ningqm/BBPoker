// Display preferences never change the integer points used by the game/API.
let displayUnit = 'points';
export const normalizeUnit = value => value === 'bb' ? 'bb' : 'points';
export const getDisplayUnit = () => displayUnit;
export function setDisplayUnit(value) { displayUnit = normalizeUnit(value); return displayUnit; }
export const unitLabel = (unit = displayUnit) => normalizeUnit(unit) === 'bb' ? 'BB' : '积分';
const finite = value => value !== null && value !== undefined && !(typeof value === 'string' && !value.trim()) && Number.isFinite(Number(value));
const validBlind = value => finite(value) && Number(value) > 0;

function formatted(value, { unit = displayUnit, signed = false, digits = 2, unitLabel: label = true } = {}) {
  const suffix = label ? ` ${unitLabel(unit)}` : '';
  if (!finite(value)) return `—${suffix}`;
  const n = Number(value), precision = Math.max(0, Math.min(10, digits));
  // A small nonzero blind or split must never appear as zero.
  const fractionDigits = n && Math.abs(n) < 10 ** -precision
    ? Math.min(10, Math.ceil(-Math.log10(Math.abs(n))) + 1) : precision;
  const rounded = Number(n.toFixed(fractionDigits));
  return `${signed && rounded > 0 ? '+' : ''}${Object.is(rounded, -0) ? '0' : rounded.toLocaleString('zh-CN', { maximumFractionDigits: fractionDigits })}${suffix}`;
}

export function formatChips(points, bigBlind, options = {}) {
  const unit = normalizeUnit(options.unit ?? displayUnit);
  const value = unit === 'bb' ? finite(points) && validBlind(bigBlind) ? Number(points) / Number(bigBlind) : null : points;
  return formatted(value, { ...options, unit });
}

// bbValue must be a sum of each historical hand's own BB amount, not a
// point total divided by the currently open table's blind.
export function formatAggregate(points, bbValue, options = {}) {
  const unit = normalizeUnit(options.unit ?? displayUnit);
  return formatted(unit === 'bb' ? bbValue : points, { ...options, unit });
}

export function chipInputValue(points, bigBlind, unit = displayUnit) {
  if (!finite(points) || normalizeUnit(unit) === 'bb' && !validBlind(bigBlind)) return '';
  const value = normalizeUnit(unit) === 'bb' ? Number(points) / Number(bigBlind) : Number(points);
  // Enough precision to round-trip integer points even for blinds such as 3.
  return String(Number(value.toFixed(12)));
}

export function parseChipInput(value, bigBlind, unit = displayUnit) {
  if (!finite(value)) return null;
  if (normalizeUnit(unit) === 'points') return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const multiplier = normalizeUnit(unit) === 'bb' ? Number(bigBlind) : 1;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
  const points = Number(value) * multiplier, rounded = Math.round(points);
  // Accept floating point representation noise, never silently round a bet.
  const noise = Math.min(1e-4, Math.max(1e-7, Number.EPSILON * Math.abs(points) * 4));
  return Number.isSafeInteger(rounded) && rounded >= 0 && Math.abs(points - rounded) < noise ? rounded : null;
}
