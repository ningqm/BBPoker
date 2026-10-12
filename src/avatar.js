import { mkdirSync, chmodSync, writeFileSync, readFileSync, renameSync, rmSync, openSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const AVATAR_SIZE = 256;
export const AVATAR_UPLOAD_BYTES = 280 * 1024;
export const AVATAR_PROFILE_BODY_BYTES = 400 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BLOB_HEADER = Buffer.from('BBAV1');
const ID = /^[a-f0-9]{32}$/;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function invalid() { const error = new Error('头像图片无效，请重新选择并裁剪图片'); error.status = 400; throw error; }
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind, bytes) {
  const name = Buffer.from(kind), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
export function avatarImageId(value) { return typeof value === 'string' && ID.test(value) ? value : null; }

/** Only accept the small canvas thumbnail, never the original photograph or a URL.
 * Re-encoding a strictly bounded pixel stream discards EXIF, text and other metadata.
 */
export function normalizeAvatarUpload(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(AVATAR_UPLOAD_BYTES / 3) * 4 + 22 || !value.startsWith('data:image/png;base64,')) invalid();
  const encoded = value.slice(22);
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > AVATAR_UPLOAD_BYTES || bytes.toString('base64') !== encoded || !bytes.subarray(0, 8).equals(SIGNATURE)) invalid();
  let offset = 8, header, seenEnd = false, seenData = false, dataEnded = false, count = 0;
  const parts = [];
  while (offset < bytes.length) {
    if (++count > 128 || offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const kind = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    const data = bytes.subarray(offset + 8, end - 4);
    if (!header && kind !== 'IHDR') invalid();
    if (kind === 'IHDR') {
      if (header || length !== 13 || data.readUInt32BE(0) !== AVATAR_SIZE || data.readUInt32BE(4) !== AVATAR_SIZE || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) invalid();
      header = Buffer.from(data);
    } else if (kind === 'IDAT') {
      if (dataEnded) invalid();
      seenData = true; parts.push(data);
    } else if (kind === 'IEND') {
      if (length || !seenData || end !== bytes.length) invalid();
      seenEnd = true;
    } else {
      if (kind.charCodeAt(0) < 97 || ['acTL', 'fcTL', 'fdAT'].includes(kind)) invalid();
      if (seenData) dataEnded = true;
    }
    offset = end;
  }
  if (!header || !seenEnd) invalid();
  const rowBytes = AVATAR_SIZE * (header[9] === 6 ? 4 : 3) + 1, expected = AVATAR_SIZE * rowBytes;
  const compressed = Buffer.concat(parts); let pixels;
  try {
    const result = inflateSync(compressed, { maxOutputLength: expected, info: true });
    if (result.engine.bytesWritten !== compressed.length) invalid();
    pixels = result.buffer;
  } catch { invalid(); }
  if (pixels.length !== expected) invalid();
  for (let row = 0; row < AVATAR_SIZE; row++) if (pixels[row * rowBytes] > 4) invalid();
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** Separate encrypted blobs keep image bytes out of table snapshots and SSE updates. */
export class AvatarStore {
  constructor(store) {
    this.directory = join(store.directory, 'avatars');
    // Domain separation prevents these small files from sharing the table cipher key.
    this.key = createHmac('sha256', store.key).update('BBPoker avatar storage v1').digest();
  }
  path(id) { if (!avatarImageId(id)) throw new Error('Invalid avatar identifier'); return join(this.directory, id + '.enc'); }
  write(bytes) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    const id = randomBytes(16).toString('hex'), file = this.path(id), tmp = file + '.tmp';
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.concat([BLOB_HEADER, Buffer.from(id)]));
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
    try {
      writeFileSync(tmp, Buffer.concat([BLOB_HEADER, iv, cipher.getAuthTag(), data]), { mode: 0o600, flag: 'wx' });
      const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, file);
      const directoryFd = openSync(this.directory, 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return id;
    } catch (error) { rmSync(tmp, { force: true }); rmSync(file, { force: true }); throw error; }
  }
  read(id) {
    const file = this.path(id), size = statSync(file).size;
    if (size < 33 || size > AVATAR_UPLOAD_BYTES + 33) throw new Error('Invalid avatar file');
    const blob = readFileSync(file);
    if (!blob.subarray(0, 5).equals(BLOB_HEADER)) throw new Error('Invalid avatar file');
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(5, 17));
    decipher.setAAD(Buffer.concat([BLOB_HEADER, Buffer.from(id)])); decipher.setAuthTag(blob.subarray(17, 33));
    return Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]);
  }
  remove(id) { if (avatarImageId(id)) rmSync(this.path(id), { force: true }); }
}
