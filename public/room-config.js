// Only reusable gameplay options cross from an old room to a new form.
// Identity, invites, players and running-hand state are deliberately excluded.
export const ROOM_DURATION_CHOICES = Object.freeze([15, 30, 45, 60, ...Array.from({ length: 22 }, (_, i) => 90 + i * 30)]);

// Reusing an older room creates a new configuration. Round upward only here:
// existing rooms and their absolute expiry time must keep their original value.
export function normalizeRoomDuration(value) {
  if (!Number.isSafeInteger(value) || value < 15 || value > 720) throw new Error('牌桌时长需要在 15–720 分钟之间');
  return ROOM_DURATION_CHOICES.find(duration => duration >= value);
}

export function reusableRoomSettings(input, defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
  const result = { ...defaults };
  const own = key => Object.prototype.hasOwnProperty.call(input, key);
  for (const key of Object.keys(defaults)) {
    // Retired per-stack limits are not a cumulative cap. New tables always use
    // the same per-transaction increments, irrespective of a legacy room.
    if (['minBuyInBB', 'maxBuyInBB', 'actionSeconds', 'timeBankCards', 'timeBankSeconds'].includes(key) || !own(key)) continue;
    const value = input[key];
    if (key === 'squidMode') {
      if (!['normal', 'unlimited'].includes(value)) throw new Error('这个牌桌的鱿鱼玩法无法读取，请选择其他牌桌');
      result[key] = value;
    }
    else if (key === 'maxTotalBuyInBB' && value === null) result[key] = null;
    else if (typeof defaults[key] === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
  }
  // A hand-count interval cannot be translated into minutes. Legacy rooms get
  // the current 10-minute default; the original room is never changed here.
  result.minBuyInBB = 100;
  result.maxBuyInBB = 1000;
  result.actionSeconds = 20;
  result.timeBankSeconds = 30;
  result.durationMinutes = normalizeRoomDuration(result.durationMinutes);
  result.timeBankCards = 3 * Math.ceil(result.durationMinutes / 30);
  if (!own('squidUnitBB') && own('squidUnit')) {
    if (typeof input.squidUnit !== 'number' || !Number.isFinite(input.squidUnit)) throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
    result.squidUnitBB = input.squidUnit / result.bigBlind;
  }
  result.squidUnitBB = Math.round(result.squidUnitBB);
  const ranges = {
    maxPlayers: [2, 9], smallBlind: [1, 1000], bigBlind: [result.smallBlind * 2, 2000],
    maxTotalBuyInBB: [100, Math.floor(1e9 / result.bigBlind / 50) * 50],
    squidUnitBB: [1, Math.floor(1e6 / result.bigBlind)], squidExtraTokens: [0, 100], actionSeconds: [20, 20],
    bombIntervalMinutes: [1, 120], bombAnteBB: [1, 1000], durationMinutes: [15, 720], timeBankCards: [3, 72], timeBankSeconds: [30, 30],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (key === 'maxTotalBuyInBB' && result[key] === null) continue;
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max || key === 'maxTotalBuyInBB' && result[key] % 50) throw new Error('这个牌桌的配置不适用于新牌桌，请选择其他牌桌');
  }
  return result;
}
