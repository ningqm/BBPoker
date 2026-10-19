// Independent, deliberately narrow verifier for an offline release restart.
// Never import the new app's migration code as the preservation oracle.
import { readFileSync, statSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDecipheriv } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const same = isDeepStrictEqual;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const reject = () => { throw new Error('Saved records changed outside the permitted restart migration.'); };

// This independent verifier does not import the activation/migration tool.
function permittedNewAdmin(proposal) {
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), keys.sort());
  if (!exactKeys(proposal, ['format', 'account', 'adminUserIds']) || proposal.format !== 'bbpoker-new-admin-v1') reject();
  const account = proposal.account;
  if (!exactKeys(account, ['id', 'username', 'name', 'avatar', 'passwordHash', 'credentialVersion', 'disabled', 'createdAt'])
    || !/^[a-f0-9]{24}$/.test(account.id) || typeof account.username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(account.username)
    || account.name !== account.username.slice(0, 18) || !Number.isInteger(account.avatar) || account.avatar < 0 || account.avatar >= 12
    || typeof account.passwordHash !== 'string' || !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(account.passwordHash)
    || account.credentialVersion !== 1 || account.disabled !== false || typeof account.createdAt !== 'string'
    || !Number.isFinite(Date.parse(account.createdAt)) || new Date(account.createdAt).toISOString() !== account.createdAt
    || !same(proposal.adminUserIds, [account.id])) reject();
  return { ...structuredClone(account), createdAt: Date.parse(account.createdAt) };
}

export function verifyEnvironment(before, after, preparedAdmin) {
  if (!preparedAdmin) { if (before !== after) reject(); return { preserved: true, administratorConfigured: false }; }
  const account = permittedNewAdmin(preparedAdmin);
  if (typeof before !== 'string' || typeof after !== 'string' || /\r(?!\n)/.test(before)) reject();
  const lines = before.match(/[^\r\n]*(?:\r\n|\n|$)/g).filter(Boolean), seen = new Set();
  let found = false;
  const allowed = lines.map(line => {
    const end = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '', body = end ? line.slice(0, -end.length) : line;
    if (!body.trim() || /^\s*[#;]/.test(body)) return line;
    const entry = /^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=(.*)$/.exec(body);
    if (!entry || seen.has(entry[1])) reject();
    seen.add(entry[1]);
    if (entry[1] !== 'ADMIN_USER_IDS') return line;
    const current = entry[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (current && current !== account.id) reject();
    found = true; return `ADMIN_USER_IDS=${account.id}${end}`;
  }).join('');
  const expected = found ? allowed : `${before}${before && !before.endsWith('\n') ? '\n' : ''}ADMIN_USER_IDS=${account.id}\n`;
  if (expected !== after) reject();
  return { preserved: true, administratorConfigured: true };
}

export function restartBlocker(data, timestamp = Date.now()) {
  for (const room of Object.values(data.rooms ?? {})) {
    if (room.hand?.status === 'playing') return 'A hand is in progress. Update deferred; finish the hand first.';
    if (room.status === 'closed') continue;
    if (room.hand?.rabbit?.active) return 'Public cards are still being revealed. Update deferred; wait for the reveal to finish.';
    if (room.mini?.squid?.active) return 'A squid round is unfinished. Update deferred; finish the round first.';
    if (room.rebuyGrace && Number.isFinite(room.rebuyGrace.endsAt) && timestamp < room.rebuyGrace.endsAt) {
      return 'A rebuy grace period is running. Update deferred; wait for it to finish.';
    }
    if (Number.isFinite(room.endsAt) && room.endsAt <= timestamp + 60000) {
      return 'A table is due to finish within one minute. Update deferred; let its normal settlement finish first.';
    }
  }
  return null;
}

function revisionWithin(before, after, low, high) {
  const updated = Date.parse(after.updatedAt);
  return Number.isSafeInteger(before.revision) && before.revision >= 1 && after.revision === before.revision + 1
    && Number.isFinite(updated) && new Date(updated).toISOString() === after.updatedAt && updated >= low && updated <= high;
}
function idleRestart(before, after, low, high) {
  if (before.status !== 'waiting' || after.status !== 'waiting' || before.startedAt !== null || after.startedAt !== null
    || before.handNumber !== 0 || after.handNumber !== 0 || before.hand != null || after.hand != null
    || !revisionWithin(before, after, low, high) || !uuid.test(after.idleEpoch) || after.idleEpoch === before.idleEpoch
    || !Number.isSafeInteger(after.idleSince) || after.idleSince < low || after.idleSince > high
    || Date.parse(after.updatedAt) < after.idleSince) return false;
  const expected = { ...before, idleSince: after.idleSince, idleEpoch: after.idleEpoch, revision: after.revision, updatedAt: after.updatedAt };
  return same(expected, after);
}
// A restarted process observes no SSE clients. It may begin a fresh host
// absence observation (or clear one for an unopened, empty room), but that is
// not permission to transfer ownership, unpause a table or change any balance.
// Strip only a fully validated observation triplet before the existing exact
// room comparisons; the shared timer tick still permits just one revision.
function hostObservationRestart(before, after, low, high) {
  const keys = ['hostAbsentSince', 'hostAbsentEpoch', 'hostAbsentId'];
  if (keys.every(key => own(before, key) === own(after, key) && same(before[key], after[key]))) return null;
  if (before.status !== 'waiting' || typeof before.hostId !== 'string' || !own(before.members ?? {}, before.hostId)
    || keys.some(key => !own(after, key)) || !revisionWithin(before, after, low, high)) return null;
  const started = Number.isFinite(before.startedAt) && before.handNumber >= 1 && before.hand?.status === 'complete';
  const unopened = before.startedAt === null && before.handNumber === 0 && before.hand == null;
  const reset = uuid.test(after.hostAbsentEpoch) && after.hostAbsentEpoch !== before.hostAbsentEpoch
    && after.hostAbsentId === before.hostId && Number.isSafeInteger(after.hostAbsentSince)
    && after.hostAbsentSince >= low && after.hostAbsentSince <= high
    && Date.parse(after.updatedAt) >= after.hostAbsentSince;
  const clear = keys.every(key => after[key] === null) && Number.isSafeInteger(before.hostAbsentSince)
    && uuid.test(before.hostAbsentEpoch) && before.hostAbsentId === before.hostId;
  if (!(reset && (started || unopened && before.members[before.hostId].leftRoom === true)
    || clear && unopened && before.members[before.hostId].leftRoom !== true)) return null;
  const stripped = structuredClone(after);
  for (const key of keys) { if (own(before, key)) stripped[key] = before[key]; else delete stripped[key]; }
  return stripped;
}
function observationOnly(before, after, low, high) {
  return revisionWithin(before, after, low, high)
    && same({ ...before, revision: after.revision, updatedAt: after.updatedAt }, after);
}
function automaticDealDefaultRestart(before, after, low, high) {
  if (own(before, 'autoDealPaused') || after.autoDealPaused !== false || before.status !== 'waiting'
    || !revisionWithin(before, after, low, high)
    || !(before.startedAt === null && before.handNumber === 0 && before.hand == null
      || Number.isFinite(before.startedAt) && before.handNumber >= 1 && before.hand?.status === 'complete')) return null;
  const stripped = structuredClone(after); delete stripped.autoDealPaused;
  return stripped;
}
function expectedBank(room, member, hands) {
  if (member.timeBank?.version === 2) return member.timeBank;
  const duration = room.settings.durationMinutes ?? 60;
  if (!Number.isSafeInteger(duration) || duration < 15 || duration > 720) reject();
  const granted = 3 * Math.ceil(duration / 30);
  if (Number.isSafeInteger(member.timeBank?.remaining) && member.timeBank.remaining >= 0) {
    return { version: 2, granted, remaining: member.timeBank.remaining, legacyPreserved: true };
  }
  // Refuse invalid legacy balances rather than silently treating them as absent.
  if (member.timeBank && own(member.timeBank, 'remaining')) reject();
  const unique = new Map(hands.filter(hand => hand.roomCode === room.code).map(hand => [hand.id, hand]));
  if (room.hand) unique.set(room.hand.id, room.hand);
  const used = [...unique.values()].reduce((sum, hand) => sum + (hand.timeBankUses ?? []).filter(use => use.playerId === member.id).length, 0);
  return { version: 2, granted, remaining: Math.max(0, granted - used) };
}
function bankMigration(before, after, hands, low, high) {
  if (before.status !== 'waiting' || before.startedAt == null || before.handNumber < 1
    || before.hand?.status !== 'complete' || !revisionWithin(before, after, low, high)) return 0;
  const expected = structuredClone(before); let migrated = 0;
  for (const member of Object.values(expected.members)) {
    if (member.timeBank?.version === 2) continue;
    member.timeBank = expectedBank(before, member, hands); migrated++;
  }
  if (!migrated) return 0;
  expected.revision = after.revision; expected.updatedAt = after.updatedAt;
  return same(expected, after) ? migrated : 0;
}

// Independently reproduce only the old escrow -> available-balance movement.
// Live hands are deliberately excluded: they refund at their ordinary finish,
// not under the narrow offline-release preservation exception.
function releasedReserve(before, after, low, high) {
  const old = before.mini?.squid, current = after.mini?.squid;
  if (before.status === 'closed' || before.hand?.status === 'playing' || !old?.active || old.accounting === 'settle-at-end') return null;
  const at = Date.parse(current?.reserveRelease?.at);
  if (!Number.isFinite(at) || at < low || at > high || new Date(at).toISOString() !== current.reserveRelease.at) return null;
  const expected = structuredClone(before), q = expected.mini.squid;
  for (const [id, amount] of Object.entries(old.reserves ?? {})) {
    const m = expected.members[id];
    if (!m || !Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(m.squidDebt ?? 0) || (m.squidDebt ?? 0) < 0) return null;
    const debt = m.squidDebt ?? 0, repaid = Math.min(debt, amount);
    if (debt) m.squidDebt = debt - repaid;
    const field = m.seat === null ? 'cashedOut' : 'stack';
    m[field] += amount - repaid;
    if (!Number.isSafeInteger(m[field]) || m[field] < 0) return null;
  }
  q.reserveRelease = { at: current.reserveRelease.at, amounts: structuredClone(old.reserves ?? {}) };
  q.reserves = {}; q.accounting = 'settle-at-end'; q.rulesVersion = 7;
  expected.revision++;
  // Any subsequent allowed timer migration shares the final observation time.
  expected.updatedAt = after.updatedAt;
  const updated = Date.parse(after.updatedAt);
  if (!Number.isFinite(updated) || updated < low || updated > high || new Date(updated).toISOString() !== after.updatedAt) return null;
  return expected;
}

export function verifySaved(before, after, { observedAfter, observedBefore, preparedAdmin }) {
  if (!Number.isSafeInteger(observedAfter) || !Number.isSafeInteger(observedBefore) || observedAfter > observedBefore) reject();
  const expected = structuredClone(before);
  let accountsAdded = 0;
  if (preparedAdmin) {
    const account = permittedNewAdmin(preparedAdmin);
    if (own(before.users, account.id) || Object.values(before.users).some(user => user.id === account.id || user.username?.toLowerCase() === account.username)) reject();
    expected.users[account.id] = structuredClone(account); accountsAdded = 1;
  }
  // createApp already removes expired authentication sessions on every restart.
  // A surviving session is byte-for-byte identical; live sessions cannot vanish.
  let expiredSessionsRemoved = 0;
  expected.sessions ??= {};
  for (const [key, session] of Object.entries(expected.sessions)) {
    if (own(after.sessions ?? {}, key)) continue;
    if (!Number.isFinite(session.expiresAt) || session.expiresAt > observedBefore) reject();
    delete expected.sessions[key]; expiredSessionsRemoved++;
  }
  // Independently permit only expired allocation receipt cleanup. Never accept
  // changed identities, fingerprints, live ciphertext or credential metadata.
  for (const [key, receipt] of Object.entries(expected.accountReceipts ?? {})) {
    const current = after.accountReceipts?.[key];
    if (!own(after.accountReceipts ?? {}, key)) {
      if (!Number.isFinite(receipt.retainUntil) || receipt.retainUntil > observedBefore) reject();
      delete expected.accountReceipts[key];
    } else if (own(receipt, 'passwordCipher') && !own(current, 'passwordCipher')) {
      if (!Number.isFinite(receipt.passwordUntil) || receipt.passwordUntil > observedBefore) reject();
      delete receipt.passwordCipher;
    }
  }
  if (!same(Object.keys(before.rooms).sort(), Object.keys(after.rooms).sort())) reject();
  let idleObservationResets = 0, hostObservationResets = 0, automaticDealDefaults = 0, timeBankRoomsMigrated = 0, timeBanksMigrated = 0, squidReserveRoomsReleased = 0;
  for (const [key, room] of Object.entries(before.rooms)) {
    const current = after.rooms[key];
    if (same(room, current)) continue;
    const released = releasedReserve(room, current, observedAfter, observedBefore);
    const baseline = released ?? room;
    const hostNormalized = hostObservationRestart(baseline, current, observedAfter, observedBefore);
    const defaultNormalized = automaticDealDefaultRestart(baseline, hostNormalized ?? current, observedAfter, observedBefore);
    const comparable = defaultNormalized ?? hostNormalized ?? current;
    if (released && same(released, comparable)) squidReserveRoomsReleased++;
    else if (idleRestart(baseline, comparable, observedAfter, observedBefore)) { idleObservationResets++; if (released) squidReserveRoomsReleased++; }
    else if ((hostNormalized || defaultNormalized) && observationOnly(baseline, comparable, observedAfter, observedBefore)) { if (released) squidReserveRoomsReleased++; }
    else {
      const count = bankMigration(baseline, comparable, before.hands, observedAfter, observedBefore);
      if (!count) reject();
      timeBankRoomsMigrated++; timeBanksMigrated += count; if (released) squidReserveRoomsReleased++;
    }
    if (hostNormalized) hostObservationResets++;
    if (defaultNormalized) automaticDealDefaults++;
    expected.rooms[key] = current;
  }
  // Covers every top-level field, including sessions and unknown future fields.
  // No normalization of accounts, cards, histories, actions or settings; balances
  // can move only by the exact independently reconstructed legacy escrow refund.
  if (!same(expected, after)) reject();
  return { preserved: true, idleObservationResets, hostObservationResets, automaticDealDefaults, timeBankRoomsMigrated, timeBanksMigrated, squidReserveRoomsReleased, expiredSessionsRemoved, accountsAdded,
    users: Object.keys(after.users).length, rooms: Object.keys(after.rooms).length, hands: after.hands.length, ledgerEntries: after.ledger.length };
}

function readSaved(directory) {
  const bytes = readFileSync(join(directory, 'table.enc'));
  if (bytes.subarray(0, 4).toString() !== 'TZ01') reject();
  const decipher = createDecipheriv('aes-256-gcm', readFileSync(join(directory, 'key')), bytes.subarray(4, 16));
  decipher.setAuthTag(bytes.subarray(16, 32));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString('utf8'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 && process.argv.length !== 5) reject();
    const [snapshot, directory, proposalFile] = process.argv.slice(2);
    let preparedAdmin;
    if (proposalFile) {
      const stat = lstatSync(proposalFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 8192) reject();
      preparedAdmin = JSON.parse(readFileSync(proposalFile, 'utf8')); permittedNewAdmin(preparedAdmin);
    }
    const observedAfter = Math.floor(statSync(join(snapshot, 'previous-release.txt')).mtimeMs), observedBefore = Date.now();
    // Configuration is verified by the same offline command and never printed.
    // The production updater always supplies the existing fixed env path.
    const envFile = process.env.BBPOKER_VERIFY_ENV_FILE;
    if (preparedAdmin && !envFile) reject();
    if (envFile) verifyEnvironment(readFileSync(join(snapshot, 'app.env'), 'utf8'), readFileSync(envFile, 'utf8'), preparedAdmin);
    console.log(JSON.stringify(verifySaved(readSaved(snapshot), readSaved(directory), { observedAfter, observedBefore, preparedAdmin })));
  } catch {
    console.error('Existing account or game records changed unexpectedly; restore follows before public reopening.');
    process.exitCode = 1;
  }
}
