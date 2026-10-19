// Offline-only, one-account activation while the updater has stopped the app.
// Private proposals are never source/release files. No passwords, hashes, user
// records, environment values, or decrypted game data are printed by this tool.
import { readFileSync, lstatSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chownSync, chmodSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join, resolve, isAbsolute, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const fail = () => { throw new Error('Prepared administrator activation refused; inspect the private inputs and preserve the original snapshot.'); };
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort());

export function validatePreparedAdmin(proposal) {
  if (!keysAre(proposal, ['format', 'account', 'adminUserIds']) || proposal.format !== 'bbpoker-new-admin-v1') fail();
  const a = proposal.account;
  if (!keysAre(a, ['id', 'username', 'name', 'avatar', 'passwordHash', 'credentialVersion', 'disabled', 'createdAt'])
    || !/^[a-f0-9]{24}$/.test(a.id) || typeof a.username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(a.username)
    || a.name !== a.username.slice(0, 18) || !Number.isInteger(a.avatar) || a.avatar < 0 || a.avatar >= 12
    || typeof a.passwordHash !== 'string' || !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(a.passwordHash)
    || a.credentialVersion !== 1 || a.disabled !== false || typeof a.createdAt !== 'string'
    || !Number.isFinite(Date.parse(a.createdAt)) || new Date(a.createdAt).toISOString() !== a.createdAt
    || !Array.isArray(proposal.adminUserIds) || proposal.adminUserIds.length !== 1 || proposal.adminUserIds[0] !== a.id) fail();
  return proposal;
}

function regularFile(path, { privateOnly = false } = {}) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (privateOnly && (stat.mode & 0o077))) fail();
  return { bytes: readFileSync(path), stat };
}
export function readPreparedAdmin(path) {
  if (!path || !isAbsolute(path)) fail();
  const canonical = realpathSync(path), source = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  if (canonical === source || canonical.startsWith(source + sep) || canonical.startsWith('/opt/bbpoker/releases/')) fail();
  const file = regularFile(path, { privateOnly: true });
  if (file.bytes.length > 8192) fail();
  return validatePreparedAdmin(JSON.parse(file.bytes.toString('utf8')));
}

// Preserve every unrelated byte of the operator's environment file.
export function preparedAdminEnvironment(original, id) {
  if (typeof original !== 'string' || /\r(?!\n)/.test(original)) fail();
  const lines = original.match(/[^\r\n]*(?:\r\n|\n|$)/g).filter(Boolean), seen = new Set();
  let found = false;
  const updated = lines.map(line => {
    const end = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '', body = end ? line.slice(0, -end.length) : line;
    if (!body.trim() || /^\s*[#;]/.test(body)) return line;
    const entry = /^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=(.*)$/.exec(body);
    if (!entry || seen.has(entry[1])) fail();
    seen.add(entry[1]);
    if (entry[1] !== 'ADMIN_USER_IDS') return line;
    const current = entry[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (current && current !== id) fail();
    found = true;
    return `ADMIN_USER_IDS=${id}${end}`;
  }).join('');
  return found ? updated : `${original}${original && !original.endsWith('\n') ? '\n' : ''}ADMIN_USER_IDS=${id}\n`;
}

function decode(bytes, key) {
  if (key.length !== 32 || bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'TZ01') fail();
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
  decipher.setAuthTag(bytes.subarray(16, 32));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString());
}
function encode(data, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('TZ01'), iv, cipher.getAuthTag(), encrypted]);
}
function replaceFile(path, bytes, stat) {
  const staging = `${path}.admin-${randomBytes(8).toString('hex')}`;
  let fd;
  try {
    fd = openSync(staging, 'wx', 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    const staged = lstatSync(staging);
    if (staged.uid !== stat.uid || staged.gid !== stat.gid) chownSync(staging, stat.uid, stat.gid);
    chmodSync(staging, stat.mode & 0o777);
    renameSync(staging, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function syncDirectories(paths) {
  for (const directory of new Set(paths.map(dirname))) {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

export function activatePreparedAdmin({ dataDir, envFile, proposalFile, validateOnly = false, beforeEnvCommit = () => {} }) {
  const proposal = readPreparedAdmin(proposalFile), account = proposal.account;
  const archivePath = join(dataDir, 'table.enc'), archive = regularFile(archivePath), key = regularFile(join(dataDir, 'key'));
  const environment = regularFile(envFile), before = decode(archive.bytes, key.bytes), after = structuredClone(before);
  if (!before.users || typeof before.users !== 'object' || Array.isArray(before.users)
    || Object.hasOwn(before.users, account.id) || Object.values(before.users).some(u => u.id === account.id || u.username?.toLowerCase() === account.username)) fail();
  const nextEnv = preparedAdminEnvironment(environment.bytes.toString('utf8'), account.id);
  // The private preparation format uses an ISO date; live account records use
  // milliseconds. This is the sole field normalization allowed by activation.
  after.users[account.id] = { ...structuredClone(account), createdAt: Date.parse(account.createdAt) };
  if (validateOnly) return { validated: true, accountsAdded: 1 };
  let archiveCommitted = false, envCommitted = false;
  try {
    replaceFile(archivePath, encode(after, key.bytes), archive.stat); archiveCommitted = true;
    beforeEnvCommit();
    replaceFile(envFile, Buffer.from(nextEnv), environment.stat); envCommitted = true;
    syncDirectories([archivePath, envFile]);
  } catch (error) {
    // The outer updater also restores the full data/key/config snapshot. This
    // immediate rollback protects standalone controlled fixture/operator use.
    if (envCommitted) replaceFile(envFile, environment.bytes, environment.stat);
    if (archiveCommitted) replaceFile(archivePath, archive.bytes, archive.stat);
    if (archiveCommitted || envCommitted) syncDirectories([archivePath, envFile]);
    throw error;
  }
  return { activated: true, accountsAdded: 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'env-file': { type: 'string' }, proposal: { type: 'string' }, 'validate-only': { type: 'boolean' } } });
    console.log(JSON.stringify(activatePreparedAdmin({ dataDir: values['data-dir'], envFile: values['env-file'], proposalFile: values.proposal, validateOnly: values['validate-only'] })));
  } catch {
    console.error('Prepared administrator activation failed; no private inputs are printed. Keep public access closed until snapshot verification or rollback completes.');
    process.exitCode = 1;
  }
}
