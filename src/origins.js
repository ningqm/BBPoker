// Native clients authenticate with bearer tokens, never cross-site cookies.
// Custom schemes have URL.origin === 'null', so compare a validated serialization.
export function canonicalOrigin(value, { native = false } = {}) {
  if (typeof value !== 'string' || !value || value === 'null') throw new Error('服务来源必须是完整的网址来源');
  const url = new URL(value);
  const protocols = native ? ['http:', 'https:', 'app:', 'capacitor:'] : ['http:', 'https:'];
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('服务来源不能包含路径、账号或查询参数');
  if (['app:', 'capacitor:'].includes(url.protocol) && (url.hostname !== 'localhost' || url.port)) throw new Error('原生客户端来源必须使用 localhost');
  return `${url.protocol}//${url.host}`;
}

export function originPolicy(publicOrigin = '', clientOrigins = '') {
  const publicBase = publicOrigin ? canonicalOrigin(publicOrigin) : '';
  const allowed = new Set((Array.isArray(clientOrigins) ? clientOrigins : clientOrigins.split(',')).map(x => x.trim()).filter(Boolean).map(x => canonicalOrigin(x, { native: true })));
  if (publicBase) allowed.add(publicBase);
  return (req, res) => {
    if (!req.headers.origin) return;
    let origin;
    try { origin = canonicalOrigin(req.headers.origin, { native: true }); }
    catch { throw Object.assign(new Error('来源无效'), { status: 403 }); }
    const directOrigin = `${req.socket.encrypted ? 'https:' : 'http:'}//${req.headers.host}`;
    if (origin !== directOrigin && !allowed.has(origin)) throw Object.assign(new Error('不允许跨站请求'), { status: 403 });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const headers = (req.headers['access-control-request-headers'] || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
      if (!['GET', 'POST'].includes(method) || headers.some(h => !['authorization', 'content-type'].includes(h))) throw Object.assign(new Error('不允许此跨站请求'), { status: 403 });
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  };
}
