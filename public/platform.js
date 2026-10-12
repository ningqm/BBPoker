// This module is shared by the browser, Electron and Capacitor clients.
export function createRequestGuard() {
  let generation = 0;
  return {
    invalidate() { generation++; },
    capture() {
      const captured = generation;
      return { valid: () => captured === generation, check() {
        if (captured !== generation) throw Object.assign(new Error('页面或身份已更新'), { stale: true });
      } };
    },
  };
}

export function clientConfig(raw = globalThis.TONGZHUO_CONFIG || {}, href = globalThis.location?.href || 'http://localhost/') {
  const page = new URL(href);
  const native = raw.native === true || ['app:', 'capacitor:'].includes(page.protocol);
  function serverOrigin(value) {
    const u = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('服务器地址需要使用 HTTPS，且不能包含路径或账号');
    return u.origin;
  }
  if (native && !raw.apiBase) throw new Error('这个安装包尚未配置服务器地址。请使用配置好地址的安装包，或先用朋友分享的网页版。');
  const apiBase = raw.apiBase ? serverOrigin(raw.apiBase) : page.origin;
  const publicBase = raw.publicBase ? serverOrigin(raw.publicBase) : apiBase;
  return { native, apiBase, publicBase };
}

export function apiUrl(path, config = clientConfig()) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('\\')) throw new Error('接口地址无效');
  const url = new URL(path, config.apiBase);
  if (url.origin !== config.apiBase || !url.pathname.startsWith('/api/')) throw new Error('接口地址无效');
  return url.href;
}

export function inviteUrl(room, config = clientConfig()) {
  return `${config.publicBase}/#/room/${encodeURIComponent(room.code)}/${encodeURIComponent(room.invite)}`;
}

// Server selection is fixed by the signed build; never obtained from an invite.
export function parseInvite(value, config = clientConfig()) {
  const text = value.trim();
  let hash = text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    const url = new URL(text);
    if (url.origin !== config.publicBase || url.username || url.password || url.pathname !== '/' || url.search) throw new Error('这条邀请属于另一个服务器，请打开朋友分享的原链接');
    hash = url.hash;
  }
  const match = /^#?\/?room\/([0-9]{6})\/([A-Za-z0-9_-]{20,100})$/.exec(hash);
  if (!match) throw new Error('请粘贴包含邀请口令的完整链接，仅房间号无法加入。');
  return `/room/${match[1]}/${match[2]}`;
}

function identityKey() { const c = clientConfig(); return `tongzhuo.identity.v1${c.native ? ':' + c.apiBase : ''}`; }
let identityQueue=Promise.resolve();
function identityOperation(operation){
  const next=identityQueue.then(operation,operation);
  identityQueue=next.catch(()=>{});return next;
}
export function readIdentity() {
  return identityOperation(async()=>{
    if (globalThis.tongzhuoDesktop?.identityRead) {
      try { return (await globalThis.tongzhuoDesktop.identityRead()) || ''; } catch { return ''; }
    }
    try { return localStorage.getItem(identityKey()) || ''; } catch { return ''; }
  });
}
export function writeIdentity(token) {
  return identityOperation(()=>{
    if (globalThis.tongzhuoDesktop?.identityWrite) return globalThis.tongzhuoDesktop.identityWrite(token);
    localStorage.setItem(identityKey(), token);
  });
}
export function clearIdentity(expectedToken) {
  return identityOperation(async()=>{
    const desktop=globalThis.tongzhuoDesktop;
    if (desktop?.identityClear) {
      // Older bridges ignore arguments, so also check before calling them.
      // Updated bridges repeat this comparison atomically in their disk queue.
      if (expectedToken!==undefined&&(!desktop.identityRead||await desktop.identityRead()!==expectedToken))return false;
      return desktop.identityClear(expectedToken);
    }
    const key=identityKey();
    // A stale tab must never remove the login saved by a newer tab.
    if(expectedToken!==undefined&&localStorage.getItem(key)!==expectedToken)return false;
    localStorage.removeItem(key);return true;
  });
}

export function canShare() { return Boolean(globalThis.tongzhuoNative?.share || globalThis.navigator?.share); }
export async function shareInvitation(payload) {
  if (globalThis.tongzhuoNative?.share) return globalThis.tongzhuoNative.share(payload);
  try { await navigator.share(payload); return { saved: true }; }
  catch (error) { if (error.name === 'AbortError') return { canceled: true }; throw error; }
}

export async function saveExport({ name, content, mime }) {
  if (globalThis.tongzhuoDesktop?.saveFile) {
    const result = await globalThis.tongzhuoDesktop.saveFile({ name, content, mime });
    if (result.error) throw new Error(result.error);
    return result;
  }
  if (globalThis.tongzhuoNative?.saveFile) return globalThis.tongzhuoNative.saveFile({ name, content, mime });
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { saved: true };
}

export function bindNativeLifecycle({ resume, back }) {
  globalThis.tongzhuoNative?.onResume(resume);
  globalThis.tongzhuoNative?.onBack(back);
}
