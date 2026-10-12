import { mkdir, readFile, writeFile, readdir, copyFile, rm, lstat } from 'node:fs/promises';
import { resolve, join, relative, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_EXTENSIONS = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.webmanifest', '.woff', '.woff2', '.mp3', '.ogg', '.wav']);

export function httpsOrigin(value, name, allowLocalhost = false) {
  if (!value) return '';
  const u = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  const localDevelopment = allowLocalhost && loopback && u.protocol === 'http:';
  if ((!localDevelopment && (u.protocol !== 'https:' || loopback)) || u.username || u.password || u.pathname !== '/' || u.search || u.hash || !u.hostname) throw new Error(`${name} 必须是正式 HTTPS 来源地址（不带路径、账号或查询参数）`);
  return u.origin;
}
export function clientConfig(options = {}) {
  const apiBase = httpsOrigin(options.apiBase ?? '', 'apiBase', options.allowLocalhost);
  const publicBase = httpsOrigin(options.publicBase ?? apiBase, 'publicBase', options.allowLocalhost);
  if ((!apiBase) !== (!publicBase)) throw new Error('API 与邀请地址必须同时配置');
  return { apiBase, publicBase, native: true, ...(options.allowLocalhost ? { development: true } : {}) };
}
export function nativeCsp(config) {
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${config.apiBase ? ' ' + config.apiBase : ''}; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`;
}
async function copyPublic(source, destination, base = source) {
  await mkdir(destination, { recursive: true });
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'sw.js' || item.name === 'client-config.js' || item.name === 'native-bridge.js') continue;
    const from = join(source, item.name), to = join(destination, item.name);
    if ((await lstat(from)).isSymbolicLink()) throw new Error('网页资源不允许符号链接：' + relative(base, from));
    if (item.isDirectory()) await copyPublic(from, to, base);
    else if (ALLOWED_EXTENSIONS.has(extname(item.name).toLowerCase())) await copyFile(from, to);
  }
}
export async function buildClient(target, options = {}) {
  if (!['desktop', 'mobile'].includes(target)) throw new Error('target 必须是 desktop 或 mobile');
  if (target === 'mobile' && options.allowLocalhost) throw new Error('本机 HTTP 仅允许桌面开发验收，移动工程使用 HTTPS');
  const root = options.root ?? ROOT, config = clientConfig(options);
  const output = join(root, 'apps', target, 'dist', 'web');
  await rm(output, { recursive: true, force: true });
  await copyPublic(join(root, 'public'), output);
  const script = `window.TONGZHUO_CONFIG = Object.freeze(${JSON.stringify(config).replaceAll('<', '\\u003c')});\n`;
  await writeFile(join(output, 'client-config.js'), script);
  await writeFile(join(output, 'client-config.json'), JSON.stringify(config, null, 2) + '\n');
  let html = await readFile(join(output, 'index.html'), 'utf8');
  html = html.replace(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '')
    .replace(/<script\b[^>]*src=["'][^"']*(?:client-config|native-bridge)\.js["'][^>]*>\s*<\/script>/gi, '');
  html = html.replace(/<head([^>]*)>/i, `<head$1>\n<meta http-equiv="Content-Security-Policy" content="${nativeCsp(config)}">\n<script src="/client-config.js"></script>${target === 'mobile' ? '\n<script src="/native-bridge.js"></script>' : ''}`);
  if (!config.apiBase) html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${nativeCsp(config)}"><title>BBPoker · 尚未配置服务</title><script src="/client-config.js"></script><style>body{background:#f6f7f3;color:#243b33;font:18px system-ui;display:grid;place-items:center;min-height:90vh;margin:24px}main{max-width:480px}p{line-height:1.8;color:#5b6c63}.brand{width:96px;height:96px}.eyebrow{color:#d6b778;font-size:12px;letter-spacing:.16em}.tagline{font-size:20px}.notice{font-size:12px;color:#98a6ae}</style></head><body><main><img class="brand" src="/icon.svg" alt="BBPoker"><h1>BBPoker</h1><h2>还没有连接牌桌服务</h2><p>这是尚未配置服务地址的安装包。请向房主索取配置完成的版本，再与朋友同桌。</p></main></body></html>`;
  await writeFile(join(output, 'index.html'), html);
  if (target === 'mobile' && !options.skipBridge) {
    const { build } = await import(pathToFileURL(join(root, 'apps/mobile/node_modules/esbuild/lib/main.js')).href);
    await build({ entryPoints: [join(root, 'apps/mobile/src/native-bridge.js')], outfile: join(output, 'native-bridge.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', target: ['es2022'], sourcemap: false });
  }
  return { target, output, configured: Boolean(config.apiBase), config };
}

async function main() {
  const args = process.argv.slice(2), opts = { target: 'all', apiBase: process.env.TONGZHUO_API_BASE, publicBase: process.env.TONGZHUO_PUBLIC_BASE };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--allow-localhost') { opts.allowLocalhost = true; i--; continue; }
    const key = { '--target': 'target', '--api-base': 'apiBase', '--public-base': 'publicBase' }[args[i]];
    if (!key || !args[i + 1]) throw new Error('参数：--target all|desktop|mobile --api-base https://... --public-base https://...');
    opts[key] = args[i + 1];
  }
  const targets = opts.target === 'all' ? ['desktop', 'mobile'] : [opts.target];
  for (const target of targets) {
    const result = await buildClient(target, opts);
    console.log(`${target}: ${relative(ROOT, result.output)} — ${result.configured ? result.config.apiBase : '未配置服务：生成明确提示页，不连接开发机'}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
