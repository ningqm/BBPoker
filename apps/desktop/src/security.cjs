const path = require('node:path');

const MIME_EXTENSIONS = Object.freeze({ 'application/json': ['json'], 'text/csv': ['csv'], 'text/plain': ['txt', 'phh', 'phhs'] });
function isLocalPage(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'app:' && u.hostname === 'localhost' && !u.port && !u.username && !u.password
      && ['', '/', '/index.html'].includes(u.pathname) && !u.search;
  } catch { return false; }
}
function assetPath(webRoot, value) {
  const u = new URL(value);
  if (u.protocol !== 'app:' || u.host !== 'localhost' || u.username || u.password) throw new Error('禁止访问此地址');
  const pathname = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(p => p.startsWith('.'))) throw new Error('无效资源路径');
  const resolved = path.resolve(webRoot, '.' + pathname);
  if (!resolved.startsWith(path.resolve(webRoot) + path.sep)) throw new Error('资源越界');
  return resolved;
}
function validateExport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('导出内容无效');
  const { name, content, mime } = payload;
  if (typeof name !== 'string' || name.length > 120 || !/^[^\x00-\x1f\x7f/\\:]+$/.test(name) || name.startsWith('.')) throw new Error('文件名无效');
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024) throw new Error('导出内容超过 16 MB');
  const normalizedMime = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  const extension = path.extname(name).slice(1).toLowerCase();
  if (!MIME_EXTENSIONS[normalizedMime]?.includes(extension)) throw new Error('仅支持 JSON、CSV、TXT、PHH 牌谱');
  return { name, content, mime: normalizedMime, extension };
}
function validateIdentity(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{30,100}$/.test(token)) throw new Error('身份恢复码格式无效');
  return token;
}
module.exports = { isLocalPage, assetPath, validateExport, validateIdentity };
