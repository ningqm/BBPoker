import { fail } from './room.js';

export const AVATAR_COUNT = 12;
export const NICKNAME_LIMIT = 18;

export function nickname(value) {
  if (typeof value !== 'string' || /\p{Cs}/u.test(value)) fail('昵称需为 1–18 个字符');
  // Remove control and invisible formatting characters; never interpret a name as HTML.
  const name = value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  const length = Array.from(name).length;
  if (!length || length > NICKNAME_LIMIT) fail('昵称需为 1–18 个字符');
  return name;
}

export function avatar(value) {
  if (!Number.isInteger(value) || value < 0 || value >= AVATAR_COUNT) fail('请选择提供的头像');
  return value;
}

export function profilePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('资料格式错误');
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !['name', 'avatar'].includes(key))) fail('只能修改昵称和头像');
  const patch = {};
  if (Object.hasOwn(input, 'name')) patch.name = nickname(input.name);
  if (Object.hasOwn(input, 'avatar')) patch.avatar = avatar(input.avatar);
  return patch;
}
