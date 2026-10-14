// Positions describe the actual dealt players, never the room's seat limit.
const BY_SIZE = {
  2: ['BTN', 'SB', 'BB'], 3: ['BTN', 'SB', 'BB'], 4: ['CO', 'BTN', 'SB', 'BB'],
  5: ['HJ', 'CO', 'BTN', 'SB', 'BB'], 6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  7: ['UTG', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  8: ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
};
const LABELS = { BTN: '庄位 BTN', 'BTN/SB': '庄位兼小盲', SB: '小盲 SB', BB: '大盲 BB',
  CO: '庄前一位 CO', HJ: '庄前两位 HJ', LJ: '庄前三位 LJ',
  UTG: '翻前首位 UTG', 'UTG+1': '翻前第二位 UTG+1', MP: '中间位 MP',
  bomb: '炸弹池无盲位', unknown: '位置未记录' };
export function positionLabel(position, tableSize, { bombPot = false } = {}) {
  if (bombPot && position === 'unknown') return LABELS.bomb;
  if (Number(tableSize) === 2 && position === 'BTN') return '庄位兼小盲';
  return LABELS[position] ?? LABELS.unknown;
}
export function positionOptions(tableSize = 'all') {
  const positions = BY_SIZE[Number(tableSize)] ?? BY_SIZE[9];
  return [['all', '全部位置'], ...positions.map(code => [code, positionLabel(code, tableSize)]),
    ['bomb', LABELS.bomb], ['unknown', LABELS.unknown]];
}
