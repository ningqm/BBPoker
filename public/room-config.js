// Only reusable gameplay options cross from an old room to a new form.
// Identity, invites, players and running-hand state are deliberately excluded.
export function reusableRoomSettings(input, defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
  const result = { ...defaults };
  const own = key => Object.prototype.hasOwnProperty.call(input, key);
  for (const key of Object.keys(defaults)) {
    if (!own(key)) continue;
    const value = input[key];
    if (key === 'maxBuyInBB' && value === null) result[key] = null;
    else if (typeof defaults[key] === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
  }
  // Older rooms stored point amounts, including non-multiples of the big blind.
  // The new form uses whole BB: round minimums up and caps down.
  for (const [bb, points, round] of [['minBuyInBB', 'minBuyIn', Math.ceil], ['maxBuyInBB', 'maxBuyIn', Math.floor], ['squidUnitBB', 'squidUnit', Math.round]]) {
    if (!own(bb) && own(points)) {
      if (points === 'maxBuyIn' && input[points] === null) result[bb] = null;
      else if (typeof input[points] === 'number' && Number.isFinite(input[points])) result[bb] = round(input[points] / result.bigBlind);
      else throw new Error('这个牌桌的配置无法读取，请选择其他牌桌');
    } else if (typeof result[bb] === 'number') result[bb] = round(result[bb]);
  }
  const ranges = {
    maxPlayers: [2, 9], smallBlind: [1, 1000], bigBlind: [result.smallBlind * 2, 2000],
    minBuyInBB: [10, Math.floor(1e9 / result.bigBlind)], maxBuyInBB: [result.minBuyInBB, Math.floor(1e9 / result.bigBlind)],
    squidUnitBB: [1, Math.floor(1e6 / result.bigBlind)], actionSeconds: [15, 90],
    bombEveryHands: [1, 100], bombAnteBB: [1, 1000], durationMinutes: [30, 720], timeBankCards: [0, 20], timeBankSeconds: [5, 120],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (key === 'maxBuyInBB' && result[key] === null) continue;
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) throw new Error('这个牌桌的配置不适用于新牌桌，请选择其他牌桌');
  }
  return result;
}
