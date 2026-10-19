import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { fail } from './room.js';

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
const PARAMETERS = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const DUMMY = `scrypt-v1$${randomBytes(16).toString('hex')}$${randomBytes(32).toString('hex')}`;
let running = 0;
const waiting = [];

export function username(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{3,24}$/.test(value.trim())) fail('账号需为 3–24 位字母、数字或下划线');
  return value.trim().toLowerCase();
}

export function password(value) {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) fail('密码需为 6–128 位字符');
  return value;
}

// Bound both CPU/memory work and queued requests. Scrypt never blocks the event loop.
async function derive(value, salt) {
  if (running >= 2) {
    if (waiting.length >= 12) fail('登录请求较多，请稍后再试', 503);
    await new Promise(resolve => waiting.push(resolve));
  } else running++;
  try {
    return await new Promise((resolve, reject) => scrypt(value, salt, 32, PARAMETERS, (error, result) => error ? reject(error) : resolve(result)));
  } finally {
    const next = waiting.shift();
    if (next) next(); else running--;
  }
}

export async function hashPassword(value) {
  password(value);
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await derive(value, salt)).toString('hex')}`;
}

export async function verifyPassword(value, stored) {
  const valid = typeof value === 'string' && value.length >= 6 && value.length <= 128;
  const record = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored ?? '') ?? /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(DUMMY);
  const actual = await derive(valid ? value : '', record[1]);
  return timingSafeEqual(actual, Buffer.from(record[2], 'hex')) && valid && typeof stored === 'string';
}

export function verifySecret(value, stored) {
  const candidate = typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.trim()) ? digest(value.trim()) : digest('');
  const expected = typeof stored === 'string' && /^[a-f0-9]{64}$/.test(stored) ? stored : digest('invalid-secret');
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex')) && typeof stored === 'string';
}
