const types = { 'application/json': ['json'], 'text/csv': ['csv'], 'text/plain': ['txt', 'phh', 'phhs'] };
export function exportFile(payload) {
  const { name, content, mime } = payload ?? {};
  const type = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  if (typeof name !== 'string' || name.length > 120 || name.startsWith('.') || !/^[^\x00-\x1f\x7f/\\:]+$/.test(name) || !types[type]?.some(extension => name.toLowerCase().endsWith('.' + extension))) throw new Error('仅支持 JSON、CSV、TXT、PHH 牌谱');
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > 16 * 1024 * 1024) throw new Error('导出内容超过 16 MB');
  return { name, content };
}
