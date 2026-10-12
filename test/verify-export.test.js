import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { RoomService } from '../src/room.js';
import { availableActions } from '../src/poker.js';
import { verifyExport } from '../scripts/verify-export.mjs';

function realExport(count = 3, folds = false) {
  const users = Array.from({ length: count }, (_, i) => ({ id: `user-${i}`, name: `朋友${i}`, avatar: 0 }));
  const store = { data: { users: Object.fromEntries(users.map(u => [u.id, u])), rooms: {}, hands: [], ledger: [] } };
  const service = new RoomService(store);
  const room = service.create(users[0], { name: '验证测试', settings: { approvalRequired: false } });
  const command = (user, type, extra = {}) => service.command(user, room.code, { commandId: randomUUID(), type, actionSeq: room.hand?.log.length, ...extra });
  for (let i = 0; i < count; i++) {
    if (i) service.join(users[i], room.code, room.invite);
    command(users[i], 'sit', { seat: i * (count === 2 ? 5 : 2), amount: 1000 });
  }
  command(users[0], 'start');
  while (room.hand.status === 'playing') {
    const actor = users.find(u => u.id === room.hand.actingId);
    const a = availableActions(room.hand, actor.id);
    command(actor, folds ? 'fold' : a.canCheck ? 'check' : 'call', { handId: room.hand.id });
  }
  return { app: '同桌', version: 1, exportedAt: new Date().toISOString(), viewerId: users[0].id,
    privacy: 'Only your own cards and publicly revealed cards are included.',
    hands: service.exports(users[0].id, room.code), adjustments: service.exportAdjustments(users[0].id, room.code) };
}

test('actual service exports verify for heads-up, multiway and hidden folded cards', () => {
  for (const count of [2, 3]) for (const folds of [false, true]) {
    const data = realExport(count, folds);
    const result = verifyExport(data);
    assert.equal(result.hands, 1);
    assert.equal(result.proofs, data.hands[0].proofs.length);
    assert.ok(result.proofs >= 2);
    if (folds) assert.ok(data.hands[0].players.some(p => p.cards.includes(null)));
  }
});

test('root, payload, position, displayed board and proof tampering are rejected', () => {
  const original = realExport();
  const cases = [
    data => { data.hands[0].commitment = '0'.repeat(64); },
    data => { data.hands[0].proofs[0].salt = '0'.repeat(64); },
    data => { data.hands[0].proofs[0].position = 52; },
    data => { data.hands[0].proofs[0].siblings[0].hash = '0'.repeat(64); },
    data => { data.hands[0].proofs[0].siblings[0].side = 'invalid'; },
    data => { data.hands[0].proofs[0].siblings.pop(); },
    data => { [data.hands[0].board[0], data.hands[0].board[1]] = [data.hands[0].board[1], data.hands[0].board[0]]; },
    data => { data.hands[0].proofs.pop(); },
    data => { data.hands[0].id += '-changed'; },
  ];
  for (const mutate of cases) {
    const data = structuredClone(original); mutate(data);
    assert.throws(() => verifyExport(data), /第 1 手/);
  }
});

test('duplicate positions, duplicate hands and unsupported versions fail closed', () => {
  const original = realExport();
  const duplicate = structuredClone(original);
  duplicate.hands[0].proofs.push(structuredClone(duplicate.hands[0].proofs[0]));
  assert.throws(() => verifyExport(duplicate), /位置重复/);
  const repeated = structuredClone(original); repeated.hands.push(structuredClone(repeated.hands[0]));
  assert.throws(() => verifyExport(repeated), /手牌编号重复/);
  const wrongVersion = structuredClone(original); wrongVersion.hands[0].verificationVersion = 'tz-merkle-sha256-v99';
  assert.throws(() => verifyExport(wrongVersion), /不支持的承诺验证版本/);
  assert.throws(() => verifyExport({ ...original, version: 2 }), /不支持的导出格式或版本/);
});

test('CLI reports counts privately, exits 1 for tampering, and handles malformed JSON without echoing it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tongzhuo-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'hands.json');
  const script = fileURLToPath(new URL('../scripts/verify-export.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
  const data = realExport();
  writeFileSync(path, JSON.stringify(data));
  const success = run();
  assert.equal(success.status, 0);
  assert.match(success.stdout, /验证通过：1 手牌/);
  assert.match(success.stdout, /不证明服务器最初公平发牌、未更换承诺/);
  const cards = data.hands[0].players.flatMap(p => p.cards).filter(Boolean);
  for (const card of cards) assert.ok(!success.stdout.includes(card));
  assert.ok(!success.stdout.includes(data.viewerId));
  data.hands[0].proofs.push(data.hands[0].proofs[0]);
  writeFileSync(path, JSON.stringify(data));
  const failure = run();
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /位置重复/);
  for (const card of cards) assert.ok(!failure.stderr.includes(card));
  writeFileSync(path, '{"secretCard":"As", broken');
  const malformed = run();
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /不是有效的 JSON/);
  assert.ok(!malformed.stderr.includes('secretCard'));
  assert.ok(!malformed.stderr.includes('As'));
});

test('empty exports explicitly verify zero records', () => {
  const empty = { app: '同桌', version: 1, viewerId: 'user-0', hands: [], adjustments: [] };
  assert.deepEqual(verifyExport(empty), { hands: 0, proofs: 0, verificationVersion: 'tz-merkle-sha256-v1' });
});
