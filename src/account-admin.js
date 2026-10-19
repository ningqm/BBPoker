import { randomInt, randomBytes, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { fail } from './room.js';
import { avatarImageId } from './avatar.js';
import { AVATAR_COUNT } from './profile.js';

// Only deployment configuration grants this capability. Never read a role from
// the request, account profile, username, registration order or stored metadata.
export function configuredAdminIds(value = '') {
  return new Set(String(value).split(',').map(id => id.trim()).filter(Boolean));
}
export function isAccountAdmin(user, ids) {
  return Boolean(user && user.disabled !== true && ids.has(user.id));
}
export function requireAccountAdmin(user, ids) {
  if (!isAccountAdmin(user, ids)) fail('仅管理员可以管理账号', 403);
  return user;
}
export function assignedPassword() {
  // Unbiased cryptographic draws; omit visually ambiguous letters and digits.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let password;
  do { password = Array.from({length:12}, () => alphabet[randomInt(alphabet.length)]).join(''); }
  while (!/[a-z]/.test(password) || !/[2-9]/.test(password));
  return password;
}
export function accountSummary(user, ids) {
  return {
    id: user.id, username: user.username ?? null, name: user.name,
    avatar: Number.isInteger(user.avatar) && user.avatar >= 0 && user.avatar < AVATAR_COUNT ? user.avatar : 0,
    avatarImage: avatarImageId(user.avatarImage), createdAt: user.createdAt ?? null,
    disabled: user.disabled === true, isAdmin: ids.has(user.id),
  };
}
export function revokeAccountSessions(db, user) {
  // Legacy identity tokens are themselves the users-map key. Move the same
  // identity to its stable ID so enable cannot revive a revoked bearer token.
  for (const [key, stored] of Object.entries(db.users)) if (stored.id === user.id && key !== user.id) delete db.users[key];
  db.users[user.id] = user;
  user.credentialVersion = (user.credentialVersion ?? 0) + 1;
  for (const [key, session] of Object.entries(db.sessions ?? {})) if (session.userId === user.id) delete db.sessions[key];
}


// A lost response must not create a second identity or rotate a password again.
// Receipt passwords are independently encrypted even inside the encrypted store,
// so JSON diagnostics, snapshots and account listings never contain cleartext.
export const ACCOUNT_RECEIPT_PASSWORD_MS = 15 * 60 * 1000;
export const ACCOUNT_RECEIPT_RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_RECEIPTS = 1000;
const receiptDigest = value => createHash('sha256').update(value).digest('hex');
function receiptFailure(code, message) {
  const error = new Error(message); error.status = 409; error.publicCode = code; throw error;
}
const receiptCipherKey = key => createHmac('sha256', key).update('bbpoker-account-receipt-v1').digest();

export function accountOperation(adminId, requestId, parameters) {
  // Support already-open older clients; updated clients always send a stable ID.
  if (requestId === undefined) return null;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) fail('请求标记无效，请重新打开分配窗口');
  return {
    key: receiptDigest(JSON.stringify([adminId, requestId])),
    adminId,
    fingerprint: receiptDigest(JSON.stringify(parameters)),
  };
}

export function pruneAccountReceipts(db, timestamp = Date.now()) {
  for (const [key, receipt] of Object.entries(db.accountReceipts ?? {})) {
    if (!Number.isFinite(receipt.retainUntil) || receipt.retainUntil <= timestamp) delete db.accountReceipts[key];
    else if (receipt.passwordUntil <= timestamp) delete receipt.passwordCipher;
  }
}

export function replayAccountOperation(db, encryptionKey, operation, adminIds, timestamp = Date.now()) {
  if (!operation) return null;
  const receipt = db.accountReceipts?.[operation.key];
  if (!receipt) return null;
  if (receipt.adminId !== operation.adminId || receipt.fingerprint !== operation.fingerprint) receiptFailure('ACCOUNT_OPERATION_MISMATCH', '这次请求的内容已经改变，请重新提交');
  const target = Object.values(db.users).find(user => user.id === receipt.targetId);
  if (!target || target.credentialVersion !== receipt.credentialVersion || receiptDigest(target.passwordHash ?? '') !== receipt.passwordHashDigest) {
    receiptFailure('ACCOUNT_OPERATION_CHANGED', '账号密码或状态已变更，请刷新账号列表；不会重复创建或重置');
  }
  if (receipt.passwordUntil <= timestamp || !receipt.passwordCipher) receiptFailure('ACCOUNT_OPERATION_EXPIRED', '操作已完成，但临时密码的取回时间已过，请在账号列表中手动重置密码');
  let temporaryPassword;
  try {
    const cipher = receipt.passwordCipher, decipher = createDecipheriv('aes-256-gcm', receiptCipherKey(encryptionKey), Buffer.from(cipher.iv, 'base64url'));
    decipher.setAAD(Buffer.from(JSON.stringify([operation.key, operation.fingerprint, receipt.targetId, receipt.credentialVersion])));
    decipher.setAuthTag(Buffer.from(cipher.tag, 'base64url'));
    temporaryPassword = Buffer.concat([decipher.update(Buffer.from(cipher.data, 'base64url')), decipher.final()]).toString('utf8');
  } catch { receiptFailure('ACCOUNT_OPERATION_UNAVAILABLE', '操作已完成，但取回临时密码失败，请刷新账号列表后处理'); }
  return { account: accountSummary(target, adminIds), credentials: { username: target.username, password: temporaryPassword } };
}

export function rememberAccountOperation(db, encryptionKey, operation, target, temporaryPassword, timestamp = Date.now()) {
  if (!operation) return;
  pruneAccountReceipts(db, timestamp);
  const receipts = db.accountReceipts ??= {};
  // Never evict a still-valid request: a delayed retry must not run twice.
  if (Object.keys(receipts).length >= MAX_ACCOUNT_RECEIPTS) fail('账号操作较多，请稍后再分配', 503);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', receiptCipherKey(encryptionKey), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([operation.key, operation.fingerprint, target.id, target.credentialVersion])));
  const encrypted = Buffer.concat([cipher.update(temporaryPassword, 'utf8'), cipher.final()]);
  receipts[operation.key] = {
    adminId: operation.adminId, fingerprint: operation.fingerprint, targetId: target.id,
    credentialVersion: target.credentialVersion, passwordHashDigest: receiptDigest(target.passwordHash),
    passwordUntil: timestamp + ACCOUNT_RECEIPT_PASSWORD_MS, retainUntil: timestamp + ACCOUNT_RECEIPT_RETAIN_MS,
    passwordCipher: { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') },
  };
}
