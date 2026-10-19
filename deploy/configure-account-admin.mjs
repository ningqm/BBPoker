// Offline configuration preparation only. Reads an existing encrypted archive;
// never creates an account, changes credentials, writes game data or restarts.
import { readFileSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

function regularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('需要普通文件，拒绝符号链接');
  return readFileSync(path);
}

export function prepareAccountAdmin({ dataDir, envFile, output, username }) {
  if (!dataDir || !envFile || !output || !username) throw new Error('需要数据目录、原配置、新配置路径和已有登录账号');
  if (resolve(envFile) === resolve(output)) throw new Error('不能覆盖原配置，请指定新的输出文件');
  const name = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new Error('登录账号格式无效');
  const key = regularFile(join(dataDir, 'key')), blob = regularFile(join(dataDir, 'table.enc'));
  if (key.length !== 32 || blob.length < 32 || blob.subarray(0,4).toString() !== 'TZ01') throw new Error('存档格式不正确');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(4,16));
  decipher.setAuthTag(blob.subarray(16,32));
  const data = JSON.parse(Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]).toString());
  const matches = Object.values(data.users || {}).filter(user => user.username === name);
  if (matches.length !== 1) throw new Error('未找到唯一的已有登录账号，请先核实账号名');
  const user = matches[0];
  if (user.disabled === true || !user.passwordHash || !/^[A-Za-z0-9_-]{1,80}$/.test(user.id)) throw new Error('只能授权有效的已有密码账号');
  const original = regularFile(envFile).toString(), lines = original.split(/\r?\n/), seen = new Set(), kept = [];
  for (const line of lines) {
    if (!line.trim() || /^\s*[#;]/.test(line)) { kept.push(line); continue; }
    const entry = /^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=(.*)$/.exec(line);
    if (!entry || seen.has(entry[1])) throw new Error('原配置存在重复项或未知格式，请私下检查');
    seen.add(entry[1]);
    if (entry[1] !== 'ADMIN_USER_IDS') { kept.push(line); continue; }
    const previous = entry[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (previous && previous !== user.id) throw new Error('原配置已有不同管理员，拒绝自动覆盖');
  }
  const result = `${kept.join('\n').trimEnd()}\nADMIN_USER_IDS=${user.id}\n`;
  let fd;
  try {
    fd = openSync(output, 'wx', 0o600);
    writeFileSync(fd, result); fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) { closeSync(fd); fd = undefined; unlinkSync(output); }
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
  return { configured: true, accountsModified: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'data-dir': { type: 'string' }, 'env-file': { type: 'string' },
      output: { type: 'string' }, username: { type: 'string' },
    } });
    prepareAccountAdmin({ dataDir: values['data-dir'], envFile: values['env-file'], output: values.output, username: values.username });
    console.log('已生成私有管理员配置，原账号、积分、牌谱及运行中服务均未改动。发布时再应用该配置。');
  } catch (error) {
    console.error(error.code ? '生成配置失败；请私下检查路径、权限及输出文件是否已存在。' : error.message);
    process.exitCode = 1;
  }
}
