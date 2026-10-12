const { app, BrowserWindow, Menu, protocol, session, ipcMain, dialog, safeStorage } = require('electron');
const { readFile, writeFile, mkdir, rename, unlink } = require('node:fs/promises');
const path = require('node:path');
const { isLocalPage, assetPath, validateExport, validateIdentity } = require('./security.cjs');
const WEB_ROOT = path.join(__dirname, '..', 'dist', 'web');
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const smoke = process.argv.includes('--smoke-test');
let mainWindow;

// Preserve the pre-rename profile and macOS Keychain service name.
app.setName('同桌');
app.setPath('userData', path.join(app.getPath('appData'), '同桌'));
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), `tongzhuo-smoke-${process.pid}`));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(start).catch(error => { console.error('客户端启动失败:', error.message); app.exit(1); });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

async function start() {
  const config = JSON.parse(await readFile(path.join(WEB_ROOT, 'client-config.json'), 'utf8'));
  const allowedOrigin = config.apiBase || null;
  const apiUrl = allowedOrigin ? new URL(allowedOrigin) : null;
  const localDevelopment = config.development && !app.isPackaged && apiUrl?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname);
  if (apiUrl && ((!localDevelopment && apiUrl.protocol !== 'https:') || apiUrl.origin !== allowedOrigin)) throw new Error('服务地址必须是 HTTPS 来源');
  if (app.isPackaged && config.development) throw new Error('开发配置不能用于分发安装包');
  const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${allowedOrigin ? ' ' + allowedOrigin : ''}; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'`;
  protocol.handle('app', async request => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('不支持的方法', { status: 405 });
      const file = assetPath(WEB_ROOT, request.url), type = CONTENT_TYPES[path.extname(file)];
      if (!type) return new Response('资源不存在', { status: 404 });
      const bytes = await readFile(file);
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'Content-Type': type + (/text|json|svg/.test(type) ? '; charset=utf-8' : ''), 'Content-Security-Policy': csp, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('资源不存在', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'clipboard-sanitized-write' && isLocalPage(contents.getURL())));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => permission === 'clipboard-sanitized-write' && isLocalPage(origin));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try { const u = new URL(details.url); allowed = (u.protocol === 'app:' && u.host === 'localhost') || (u.origin === allowedOrigin && (u.protocol === 'https:' || localDevelopment)); } catch {}
    callback({ cancel: !allowed });
  });
  session.defaultSession.on('will-download', event => event.preventDefault());
  const trusted = event => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !isLocalPage(event.senderFrame.url)) throw new Error('不允许此页面访问本机功能');
  };
  ipcMain.handle('tongzhuo:save-file', async (event, payload) => {
    trusted(event);
    const file = validateExport(payload);
    const result = await dialog.showSaveDialog(mainWindow, { title: '保存我的牌谱', defaultPath: path.join(app.getPath('downloads'), file.name), filters: [{ name: '牌谱', extensions: [file.extension] }], properties: ['showOverwriteConfirmation'] });
    if (result.canceled || !result.filePath) return { canceled: true, saved: false };
    await writeFile(result.filePath, file.content, { encoding: 'utf8', mode: 0o600 });
    return { saved: true };
  });
  const identityPath = path.join(app.getPath('userData'), 'identity.enc');
  let identityQueue = Promise.resolve();
  const serialIdentity = action => { const result = identityQueue.then(action); identityQueue = result.catch(() => {}); return result; };
  const requireSecureStorage = () => { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储尚不可用，请使用恢复码登录'); };
  ipcMain.handle('tongzhuo:identity-read', async event => {
    trusted(event); requireSecureStorage();
    return serialIdentity(async () => {
      try { const record = JSON.parse(safeStorage.decryptString(await readFile(identityPath))); return record.apiBase === allowedOrigin ? validateIdentity(record.token) : null; }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error('无法读取本机身份，请使用恢复码登录'); }
    });
  });
  ipcMain.handle('tongzhuo:identity-write', async (event, token) => {
    trusted(event); requireSecureStorage(); validateIdentity(token);
    return serialIdentity(async () => {
      await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
      await writeFile(identityPath + '.tmp', safeStorage.encryptString(JSON.stringify({ apiBase: allowedOrigin, token })), { mode: 0o600 });
      await rename(identityPath + '.tmp', identityPath);
    });
  });
  ipcMain.handle('tongzhuo:identity-clear', async (event, expectedToken) => {
    trusted(event);
    if (expectedToken !== undefined) { requireSecureStorage(); validateIdentity(expectedToken); }
    return serialIdentity(async () => {
      if (expectedToken !== undefined) {
        try {
          const record = JSON.parse(safeStorage.decryptString(await readFile(identityPath)));
          if (record.apiBase !== allowedOrigin || record.token !== expectedToken) return false;
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }
      try { await unlink(identityPath); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
  });
  app.setAboutPanelOptions({ applicationName: 'BBPoker', applicationVersion: app.getVersion(), copyright: 'BBPoker · 朋友积分局' });
  const brandMenu = { label: 'BBPoker', submenu: [
    { role: 'about', label: '关于 BBPoker' }, { type: 'separator' }, { role: 'services', label: '服务' },
    { type: 'separator' }, { role: 'hide', label: '隐藏 BBPoker' }, { role: 'hideOthers', label: '隐藏其他' },
    { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { role: 'quit', label: '退出 BBPoker' },
  ] };
  Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === 'darwin' ? [brandMenu, { role: 'editMenu' }, { role: 'windowMenu' }] : [{ role: 'editMenu' }, { role: 'windowMenu' }]));
  createWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({ title: 'BBPoker', width: 1280, height: 860, minWidth: 390, minHeight: 600, backgroundColor: '#f6f7f3', show: !smoke,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!isLocalPage(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-redirect', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  if (smoke) {
    const deadline = setTimeout(() => app.exit(1), 20000);
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const state = await mainWindow.webContents.executeJavaScript('({title:document.title,origin:location.href,bridge:typeof window.tongzhuoDesktop?.saveFile,node:typeof window.require,configured:Boolean(window.TONGZHUO_CONFIG?.apiBase)})');
        if (!isLocalPage(state.origin) || state.bridge !== 'function' || state.node !== 'undefined') throw new Error('桌面隔离验收失败');
        console.log(JSON.stringify({ ok: true, ...state })); clearTimeout(deadline); app.exit(0);
      } catch (error) { console.error(error.message); app.exit(1); }
    });
  }
  mainWindow.loadURL('app://localhost/index.html');
}
