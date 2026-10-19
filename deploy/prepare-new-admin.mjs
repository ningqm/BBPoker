// Prepare a private, hashed account proposal. This is not a public bootstrap
// endpoint and does not modify a running server, its data or its permissions.
import { randomBytes, randomInt } from 'node:crypto';
import { openSync, writeFileSync, fsyncSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { username, hashPassword } from '../src/auth.js';
import { AVATAR_COUNT } from '../src/profile.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function prepareNewAdmin({ accountName, password, output }) {
  const name = username(accountName);
  if (!output || !isAbsolute(output)) throw new Error('请将私有账号资料保存到源码目录外的绝对路径');
  // Validate and use the canonical parent, so an external-looking symlink
  // cannot redirect a credential hash into public source or a release bundle.
  const destination = resolve(realpathSync(dirname(output)), basename(output));
  const source = realpathSync(ROOT);
  if (destination === source || destination.startsWith(source + sep)) throw new Error('请将私有账号资料保存到源码目录外的绝对路径');
  const passwordHash = await hashPassword(password);
  const id = randomBytes(12).toString('hex');
  const proposal = { format: 'bbpoker-new-admin-v1',
    account: { id, username: name, name: name.slice(0,18), avatar: randomInt(AVATAR_COUNT), passwordHash,
      credentialVersion: 1, disabled: false, createdAt: new Date().toISOString() },
    adminUserIds: [id],
  };
  let fd;
  try {
    fd = openSync(destination, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(proposal)); fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) { closeSync(fd); fd = undefined; unlinkSync(destination); }
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
  return { prepared: true, activated: false };
}

function readHiddenPassword() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('请在交互终端输入密码；不接受命令行或环境变量中的明文密码');
  return new Promise((accept, reject) => {
    let value = '';
    const finish = error => {
      process.stdin.off('data', onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');
      if(error) reject(error);else accept(value);value='';
    };
    const onData = buffer => {
      for (const character of buffer.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') return finish(new Error('已取消'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0,-1);
        else { value += character; if (value.length > 128) return finish(new Error('密码最多 128 位')); }
      }
    };
    process.stdout.write('输入密码（不回显）：');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data', onData);
  });
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values}=parseArgs({options:{username:{type:'string'},output:{type:'string'}}});
    await prepareNewAdmin({accountName:values.username,password:await readHiddenPassword(),output:values.output});
    console.log('账号哈希资料已私下准备，尚未创建线上账号或授予管理权限。');
  } catch(error) {
    console.error(error.code ? '准备失败，请检查私有文件路径及权限；不会覆盖现有文件。' : error.message);process.exitCode=1;
  }
}
