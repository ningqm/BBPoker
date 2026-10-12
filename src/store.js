import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/** All player data, active decks and histories are encrypted on disk.
 * The server still necessarily knows dealt cards; this is not operator-blind poker.
 * Keep data/key separate from shared exports; back up both privately for recovery.
 */
export class EncryptedStore {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.file = join(this.directory, 'table.enc');
    const keyFile = join(this.directory, 'key');
    if (!existsSync(keyFile)) {
      if (existsSync(this.file)) throw new Error('加密密钥丢失，不能覆盖已有牌局。请恢复 data/key。');
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    chmodSync(keyFile, 0o600);
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('加密密钥格式错误');
    this.data = existsSync(this.file) ? this.read() : { version: 1, users: {}, rooms: {}, hands: [], ledger: [] };
  }

  read() {
    const blob = readFileSync(this.file);
    if (blob.subarray(0, 4).toString() !== 'TZ01') throw new Error('未知存档格式');
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    const plain = Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  }

  save() {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.data), 'utf8'), cipher.final()]);
    const bytes = Buffer.concat([Buffer.from('TZ01'), iv, cipher.getAuthTag(), encrypted]);
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, bytes, { mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}
