import { randomUUID } from 'node:crypto';
import { digest, secret, hashPassword, SESSION_MS } from '../../src/auth.js';

// Test-only fixture seeding. Account creation is deliberately not an HTTP
// capability: every caller supplies an isolated createApp temporary store.
function publicUser(user) {
  return { id: user.id, username: user.username ?? null, name: user.name, avatar: user.avatar, avatarImage: user.avatarImage ?? null };
}
export function seedLegacyAccount(app, { name = '测试朋友', avatar = 0, id = randomUUID() } = {}) {
  const token = secret();
  const user = { id, name, avatar, createdAt: new Date().toISOString() };
  app.store.data.users[digest(token)] = user;
  app.store.save();
  return { token, user: publicUser(user) };
}
export async function seedAssignedAccount(app, { username = `fixture_${randomUUID().replaceAll('-', '').slice(0, 12)}`, password = 'fixture-only-password', name = '测试朋友', avatar = 0, id = randomUUID() } = {}) {
  const token = secret(), recoveryCode = secret();
  const user = { id, username: username.toLowerCase(), name, avatar, createdAt: new Date().toISOString(), passwordHash: await hashPassword(password), recoveryHash: digest(recoveryCode), credentialVersion: 1 };
  app.store.data.users[id] = user;
  app.store.data.sessions[digest(token)] = { userId: id, version: 1, createdAt: Date.now(), expiresAt: Date.now() + SESSION_MS };
  app.store.save();
  return { token, user: publicUser(user), recoveryCode };
}
