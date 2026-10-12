import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RoomService, exportText, exportCsv } from '../src/room.js';
import { EncryptedStore } from '../src/store.js';
import { verifyProof } from '../src/fairness.js';
import { createApp } from '../server.js';

function fixture(settings = {}) {
  const store = { data: { version: 1, users: {}, rooms: {}, hands: [], ledger: [] } };
  const users = Array.from({ length: 5 }, (_, i) => ({ id: `user${i}`, name: `朋友${i}`, avatar: i }));
  users.forEach(u => { store.data.users[u.id] = u; });
  const service = new RoomService(store);
  const room = service.create(users[0], { name: '隐私验收桌', settings: { approvalRequired: false, ...settings, mushroom: false } });
  users.slice(1, 4).forEach(u => service.join(u, room.code, room.invite));
  // Preserve old-version pending approvals and mushroom balances as recovery
  // fixtures; new clients can no longer enable either room option.
  const command = (i, type, extra = {}) => {
    const result = service.command(users[i], room.code, { type, commandId: randomUUID(), handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra });
    if (settings.mushroom && type === 'start' && room.handNumber === 1) {
      const h = room.hand, pool = room.mini.mushroom;
      h.settings.mushroom = true; pool.smallBlindId = h.players.find(p => p.seat === h.smallBlindSeat).id;
      for (const p of h.players) {
        const amount = pool.unit * (p.id === pool.smallBlindId ? 2 : 1);
        p.startingStack -= amount; p.stack -= amount; room.members[p.id].stack -= amount;
        h.miniChanges[p.id] -= amount; pool.pool += amount; pool.contributions[p.id] = amount;
      }
      h.miniBefore = structuredClone(room.mini);
    }
    return result;
  };
  return { store, users, service, room, command };
}
function seat(f, count = 3) { for (let i = 0; i < count; i++) f.command(i, 'sit', { seat: i, amount: 1000 }); }
function finishWithFolds(f) {
  for (let i = 0; f.room.hand.status === 'playing'; i++) {
    assert.ok(i < 30);
    f.command(f.users.findIndex(u => u.id === f.room.hand.actingId), 'fold');
  }
}
function finishByCalling(f) {
  for (let i = 0; f.room.hand.status === 'playing'; i++) {
    assert.ok(i < 100);
    const actor = f.users.findIndex(u => u.id === f.room.hand.actingId);
    const a = f.service.state(f.room, f.users[actor].id).actions;
    f.command(actor, a.canCheck ? 'check' : 'call');
  }
}
function conserved(room) {
  const members = Object.values(room.members);
  const held = members.reduce((n, p) => n + p.stack + p.cashedOut, 0)
    + Object.values(room.mini.squid.reserves).reduce((a, b) => a + b, 0)
    + room.mini.mushroom.pool
    + (room.hand?.status === 'playing' ? room.hand.players.reduce((n, p) => n + p.contributed, 0) : 0);
  assert.equal(held, members.reduce((n, p) => n + p.totalBuyIn, 0));
}
function noSecrets(value, hand, allowedPositions) {
  const text = JSON.stringify(value);
  for (const key of ['deck', 'salts', 'levels', 'audit', 'burnIndices']) assert.equal(Object.hasOwn(value, key), false);
  for (const player of hand.players) player.cardIndices.forEach((position, i) => {
    if (!allowedPositions.includes(position)) assert.equal(text.includes(JSON.stringify(player.cards[i])), false, `hidden card at ${position} leaked`);
  });
  for (const proof of value.proofs ?? value.hand?.proofs ?? []) {
    assert.ok(allowedPositions.includes(proof.position));
    assert.equal(verifyProof(hand.id, hand.audit.root, proof), true);
  }
}

test('security: member and host checks reject outsider reads, guessed invitations and forged commands', () => {
  const f = fixture({ approvalRequired: true });
  assert.throws(() => f.service.state(f.room, f.users[4].id), e => e.status === 403);
  assert.throws(() => f.service.join(f.users[4], f.room.code, 'wrong'), e => e.status === 403);
  assert.throws(() => f.service.exports(f.users[4].id, f.room.code), e => e.status === 403);
  // A request written by the older approval-based release is still guarded.
  f.room.pending.push({ id: randomUUID(), playerId: f.users[1].id, name: f.users[1].name, seat: 1, amount: 1000 });
  assert.equal(f.room.members[f.users[1].id].seat, null);
  assert.throws(() => f.command(2, 'approve', { requestId: f.room.pending[0].id }), e => e.status === 403);
  assert.throws(() => f.command(1, 'start'), e => e.status === 403);
  assert.equal(f.service.state(f.room, f.users[2].id).pending.length, 0);
  f.command(0, 'approve', { requestId: f.room.pending[0].id });
  assert.equal(f.room.members[f.users[1].id].stack, 1000);
});

test('security: hidden folded cards stay out of state, history, exports and proofs; owner may reveal one', () => {
  const f = fixture(); seat(f); f.command(0, 'start');
  const h = f.room.hand;
  for (let viewer = 0; viewer < 4; viewer++) {
    const allowed = h.players.find(p => p.id === f.users[viewer].id)?.cardIndices ?? [];
    noSecrets(f.service.state(f.room, f.users[viewer].id), h, allowed);
  }
  finishWithFolds(f);
  const observer = f.users[3].id;
  noSecrets(f.service.state(f.room, observer), h, []);
  noSecrets(f.service.handFor(observer, f.room.code, h.id), h, []);
  assert.deepEqual(f.service.exports(observer, f.room.code), []);
  const hand = f.service.exports(f.users[0].id, f.room.code)[0];
  noSecrets(hand, h, h.players[0].cardIndices);
  const allExports = exportText([hand]) + exportCsv([hand], f.users[0].id);
  for (const p of h.players.slice(1)) for (const c of p.cards) assert.equal(new RegExp(`(^|[^A-Za-z0-9])${c}(?=$|[^A-Za-z0-9])`).test(allExports), false);
  assert.deepEqual(hand.result.handNames, {});
  f.command(0, 'show', { indices: [0], playerId: f.users[1].id });
  const reveal = f.service.handFor(observer, f.room.code, h.id);
  assert.deepEqual(reveal.players[0].cards, [h.players[0].cards[0], null]);
  assert.deepEqual(reveal.players[1].cards, [null, null]);
  noSecrets(reveal, h, [h.players[0].cardIndices[0]]);
});

test('security: host transfer accepts only an actual room member and cannot strand the room on inherited properties', () => {
  const f = fixture();
  for (const playerId of ['__proto__', 'constructor', 'toString', 'missing-user', [f.users[1].id]]) {
    assert.throws(() => f.command(0, 'transferHost', { playerId }), e => e.status === 403);
    assert.equal(f.room.hostId, f.users[0].id);
  }
  f.command(0, 'transferHost', { playerId: f.users[1].id });
  assert.equal(f.room.hostId, f.users[1].id);
  f.command(1, 'close');
  assert.equal(f.room.status, 'closed');
});

test('security: a delayed reveal for a previous hand never exposes cards from the current hand', () => {
  const f = fixture(); seat(f); f.command(0, 'start'); finishWithFolds(f);
  const previousHandId = f.room.hand.id;
  f.command(0, 'start'); finishWithFolds(f);
  assert.throws(() => f.command(0, 'show', { handId: previousHandId, indices: [0, 1] }), e => e.status === 409);
  assert.equal(Object.hasOwn(f.room.hand.shown, f.users[0].id), false);
  f.command(0, 'show', { handId: f.room.hand.id, indices: [0] });
  assert.deepEqual(f.room.hand.shown[f.users[0].id], [0]);
});

test('security: delayed actions from an earlier turn of the same hand are rejected without changing points', () => {
  const f = fixture(); seat(f); f.command(0, 'start');
  const handId = f.room.hand.id;
  const oldSeq = f.service.state(f.room, f.users[0].id).hand.actionSeq;
  assert.equal(oldSeq, f.room.hand.log.length);
  f.command(0, 'call'); f.command(1, 'call'); f.command(2, 'check');
  f.command(1, 'check'); f.command(2, 'check');
  assert.equal(f.room.hand.id, handId);
  assert.equal(f.room.hand.actingId, f.users[0].id);
  assert.equal(f.room.hand.street, 'flop');
  assert.ok(f.room.hand.log.length > oldSeq);
  const before = structuredClone(f.store.data);
  for (const type of ['fold', 'check', 'call', 'raise', 'allin']) {
    for (const actionSeq of [oldSeq, undefined]) {
      assert.throws(() => f.command(0, type, { actionSeq, amount: 20 }), e => e.status === 409);
      assert.deepEqual(f.store.data, before);
    }
  }
  const currentSeq = f.service.state(f.room, f.users[0].id).hand.actionSeq;
  assert.equal(currentSeq, f.room.hand.log.length);
  f.command(0, 'check', { actionSeq: currentSeq });
  assert.ok(f.room.hand.log.length > currentSeq);
  conserved(f.room);
});

test('security: showdown reveals live contenders but keeps a folded player hidden', () => {
  const f = fixture(); seat(f); f.command(0, 'start');
  f.command(0, 'fold'); finishByCalling(f);
  const h = f.room.hand, visible = [...h.boardIndices, ...h.players.slice(1).flatMap(p => p.cardIndices)];
  const projected = f.service.handFor(f.users[3].id, f.room.code, h.id);
  assert.equal(h.result.showdown, true);
  assert.deepEqual(projected.players[0].cards, [null, null]);
  assert.equal(Object.hasOwn(projected.result.handNames, f.users[0].id), false);
  noSecrets(projected, h, visible);
});

test('settlement: squid reserves plus legacy mushroom pools remain conserved and closing refunds contributors', () => {
  const f = fixture({ squid: true, squidUnit: 20, mushroom: true, mushroomUnit: 5 });
  seat(f); conserved(f.room);
  f.command(0, 'start'); conserved(f.room); finishWithFolds(f); conserved(f.room);
  assert.equal(f.room.mini.squid.active, true);
  assert.throws(() => f.command(0, 'stand'), /鱿鱼/);
  f.command(0, 'start'); conserved(f.room); finishWithFolds(f); conserved(f.room);
  assert.equal(f.room.mini.squid.active, false);
  assert.ok(f.room.mini.mushroom.pool > 0);
  f.command(0, 'stand'); conserved(f.room);
  const cashedBefore = f.room.members[f.users[0].id].cashedOut;
  const owed = f.room.mini.mushroom.contributions[f.users[0].id];
  f.command(0, 'close'); conserved(f.room);
  assert.equal(f.room.members[f.users[0].id].cashedOut, cashedBefore + owed);
  assert.equal(f.room.mini.mushroom.pool, 0);
  assert.equal(f.users.reduce((n, u) => n + f.service.stats(u.id).net, 0), 0);
});

test('settlement: repeated command is idempotent and closing an unfinished squid round refunds reserves', () => {
  const f = fixture({ squid: true }); seat(f);
  const cmd = { type: 'start', commandId: randomUUID() };
  f.service.command(f.users[0], f.room.code, cmd);
  const snapshot = structuredClone(f.room);
  f.service.command(f.users[0], f.room.code, cmd);
  assert.deepEqual(f.room, snapshot);
  finishWithFolds(f); f.command(0, 'close'); conserved(f.room);
  assert.deepEqual(f.room.mini.squid.reserves, {});
  assert.equal(f.service.stats(f.users[0].id).miniNet, 0);
});

test('regression: standing cancels the seated player pending rebuy so approval cannot reseat them', () => {
  const f = fixture({ approvalRequired: true });
  f.command(1, 'sit', { seat: 1, amount: 1000 });
  f.room.pending.push({ id: randomUUID(), playerId: f.users[1].id, name: f.users[1].name, seat: 1, amount: 200 });
  const pendingId = f.room.pending[0].id;
  f.command(1, 'stand');
  assert.equal(f.room.pending.some(p => p.id === pendingId), false);
  assert.throws(() => f.command(0, 'approve', { requestId: pendingId }), /不存在|已处理/);
  assert.equal(f.room.members[f.users[1].id].seat, null);
});

test('security: encrypted archive authenticates data and restores the same private deck and commitment', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tongzhuo-private-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(); seat(f); f.command(0, 'start');
  const storage = new EncryptedStore(directory); storage.data = f.store.data; storage.save();
  const bytes = readFileSync(storage.file);
  assert.equal(bytes.subarray(0, 4).toString(), 'TZ01');
  assert.equal(bytes.includes(Buffer.from('隐私验收桌')), false);
  assert.equal(statSync(storage.file).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'key')).mode & 0o777, 0o600);
  const recovered = new EncryptedStore(directory);
  assert.deepEqual(recovered.data.rooms[f.room.code].hand.deck, f.room.hand.deck);
  assert.deepEqual(recovered.data.rooms[f.room.code].hand.audit, f.room.hand.audit);
  const restored = createApp({ dataDir: directory });
  t.after(() => restored.close());
  assert.deepEqual(restored.service.room(f.room.code).hand.deck, f.room.hand.deck);
  assert.equal(restored.service.room(f.room.code).hand.audit.root, f.room.hand.audit.root);
  assert.ok(restored.service.room(f.room.code).deadline > Date.now());
});

test('security: altered ciphertext is rejected rather than loading modified private state', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tongzhuo-tamper-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new EncryptedStore(directory); storage.save();
  const tampered = readFileSync(storage.file); tampered[tampered.length - 1] ^= 1;
  writeFileSync(storage.file, tampered);
  assert.throws(() => new EncryptedStore(directory));
});

test('regression: CSV keeps negative numeric results summable while escaping untrusted text', () => {
  const f = fixture({ mushroom: true }); seat(f); f.command(0, 'start'); finishWithFolds(f);
  const hands = f.service.exports(f.users[0].id, f.room.code);
  hands[0].roomName = '=SUM(1,2)';
  const csv = exportCsv(hands, f.users[0].id);
  assert.ok(csv.includes("'=SUM(1,2)"));
  assert.ok(!csv.includes("'-5"), 'Numeric losses must not become text cells.');
});

test('regression: career curve applies an earlier room refund before hands from a later room', () => {
  const f = fixture({ mushroom: true }); seat(f); f.command(0, 'start'); finishWithFolds(f); f.command(0, 'close');
  f.store.data.hands[0].at = '2020-01-01T00:00:00.000Z';
  for (const adjustment of f.store.data.ledger.filter(l => l.type === 'mushroomRefund')) adjustment.at = '2020-01-02T00:00:00.000Z';
  const second = f.service.create(f.users[0], { settings: { approvalRequired: false } });
  const command = (i, type, extra = {}) => f.service.command(f.users[i], second.code, { type, commandId: randomUUID(), handId: second.hand?.id, actionSeq: second.hand?.log.length, ...extra });
  for (let i = 0; i < 3; i++) {
    if (i) f.service.join(f.users[i], second.code, second.invite);
    command(i, 'sit', { seat: i, amount: 1000 });
  }
  command(0, 'start');
  while (second.hand.status === 'playing') command(f.users.findIndex(u => u.id === second.hand.actingId), 'fold');
  f.store.data.hands[1].at = '2020-01-03T00:00:00.000Z';
  const stats = f.service.stats(f.users[0].id);
  assert.deepEqual(stats.curve.map(p => p.at), ['2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', '2020-01-03T00:00:00.000Z']);
  assert.deepEqual(stats.curve.map(p => p.net), [-5, 0, 0]);
  assert.equal(stats.curve.at(-1).net, stats.net);
});

test('regression: JSON, text and CSV exports retain closing refunds and date filters apply to adjustments', async t => {
  const f = fixture({ mushroom: true }); seat(f); f.command(0, 'start'); finishWithFolds(f); f.command(0, 'close');
  f.store.data.hands[0].at = '2020-01-01T00:00:00.000Z';
  for (const adjustment of f.store.data.ledger.filter(l => l.type === 'mushroomRefund')) adjustment.at = '2020-01-02T00:00:00.000Z';
  const directory = mkdtempSync(join(tmpdir(), 'tongzhuo-export-'));
  const app = createApp({ dataDir: directory });
  app.store.data = f.store.data; app.service.db = app.store.data;
  const token = randomBytes(32).toString('base64url');
  app.store.data.users[createHash('sha256').update(token).digest('hex')] = f.users[0]; app.store.save();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${app.server.address().port}/api/export?room=${f.room.code}`;
  const get = async suffix => {
    const response = await fetch(endpoint + suffix, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); return response;
  };
  const exported = await (await get('&format=json')).json();
  assert.equal(exported.adjustments.length, 1);
  assert.equal(exported.adjustments[0].amount, 5);
  const miniFromHands = exported.hands.reduce((n, h) => n + h.players.find(p => p.id === f.users[0].id).miniNet, 0);
  assert.equal(miniFromHands + exported.adjustments.reduce((n, a) => n + a.amount, 0), f.service.stats(f.users[0].id).miniNet);
  const filtered = await (await get('&format=json&from=2020-01-02&to=2020-01-02')).json();
  assert.equal(filtered.hands.length, 0); assert.equal(filtered.adjustments.length, 1);
  const empty = await (await get('&format=json&to=2019-12-31')).json();
  assert.equal(empty.hands.length, 0); assert.equal(empty.adjustments.length, 0);
  const csv = await (await get('&format=csv')).text();
  assert.ok(csv.includes('记录类型')); assert.ok(csv.includes('退款')); assert.ok(!csv.includes("'-5"));
  const txt = await (await get('&format=txt')).text();
  assert.ok(txt.includes(exported.adjustments[0].id));
  assert.ok(txt.includes(exported.adjustments[0].note));
  assert.ok(txt.includes('Mini +5 points'));
});

test('security: failed HTTP persistence rolls back the full attempted action and rejected turn changes nothing', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tongzhuo-rollback-'));
  const app = createApp({ dataDir: directory });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const token = randomBytes(32).toString('base64url'), user = { id: 'rollback-owner', name: '回滚检查', avatar: 0 };
  app.store.data.users[createHash('sha256').update(token).digest('hex')] = user;
  const room = app.service.create(user, { settings: { approvalRequired: false } });
  const peer = { id: 'rollback-peer', name: '朋友', avatar: 1 };
  app.store.data.users.peer = peer; app.service.join(peer, room.code, room.invite);
  for (const [i, u] of [user, peer].entries()) app.service.command(u, room.code, { type: 'sit', seat: i, amount: 1000, commandId: randomUUID() });
  app.service.command(user, room.code, { type: 'start', commandId: randomUUID() }); app.store.save();
  const before = structuredClone(app.store.data), disk = readFileSync(app.store.file);
  const endpoint = `http://127.0.0.1:${app.server.address().port}/api/rooms/${room.code}/action`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const invalid = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ type: 'check', handId: room.hand.id, actionSeq: room.hand.log.length, commandId: randomUUID() }) });
  assert.equal(invalid.status, 400); assert.deepEqual(app.store.data, before);
  const save = app.store.save.bind(app.store);
  app.store.save = () => { const error = new Error('simulated disk full'); error.code = 'ENOSPC'; throw error; };
  const failed = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ type: 'raise', amount: 30, handId: room.hand.id, actionSeq: room.hand.log.length, commandId: randomUUID() }) });
  app.store.save = save;
  assert.equal(failed.status, 500);
  assert.deepEqual(app.store.data, before); assert.equal(app.service.db, app.store.data);
  assert.deepEqual(readFileSync(app.store.file), disk);
});
