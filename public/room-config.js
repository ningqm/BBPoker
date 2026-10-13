// Only reusable gameplay options cross from an old room to a new form.
// Identity, invites, players and running-hand state are deliberately excluded.
export function reusableRoomSettings(input, defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
  const result = { ...defaults };
  const own = key => Object.prototype.hasOwnProperty.call(input, key);
  for (const key of Object.keys(defaults)) {
    // Retired per-stack limits are not a cumulative cap. New tables always use
    // the same per-transaction increments, irrespective of a legacy room.
    if (key === 'minBuyInBB' || key === 'maxBuyInBB' || !own(key)) continue;
    const value = input[key];
    if (key === 'maxTotalBuyInBB' && value === null) result[key] = null;
    else if (typeof defaults[key] === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
  }
  // A hand-count interval cannot be translated into minutes. Legacy rooms get
  // the current 10-minute default; the original room is never changed here.
  result.minBuyInBB = 100;
  result.maxBuyInBB = 1000;
  if (!own('squidUnitBB') && own('squidUnit')) {
    if (typeof input.squidUnit !== 'number' || !Number.isFinite(input.squidUnit)) throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
    result.squidUnitBB = input.squidUnit / result.bigBlind;
  }
  result.squidUnitBB = Math.round(result.squidUnitBB);
  const ranges = {
    maxPlayers: [2, 9], smallBlind: [1, 1000], bigBlind: [result.smallBlind * 2, 2000],
    maxTotalBuyInBB: [100, Math.floor(1e9 / result.bigBlind / 50) * 50],
    squidUnitBB: [1, Math.floor(1e6 / result.bigBlind)], actionSeconds: [15, 90],
    bombIntervalMinutes: [1, 120], bombAnteBB: [1, 1000], durationMinutes: [30, 720], timeBankCards: [0, 20], timeBankSeconds: [5, 120],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (key === 'maxTotalBuyInBB' && result[key] === null) continue;
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max || key === 'maxTotalBuyInBB' && result[key] % 50) throw new Error('这个牌桌的配置不适用于新牌桌，请选择其他牌桌');
  }
  return result;
}
