import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomService } from '../src/room.js';

function fixture(settings = {}) {
  const users = Array.from({ length: 3 }, (_, i) => ({ id: `transfer-${i}`, name: `朋友${i}` }));
  const data = { users: Object.fromEntries(users.map(user => [user.id, user])), rooms: {}, hands: [], ledger: [] };
  const service = new RoomService({ data }), room = service.create(users[0], { settings });
  for (const user of users.slice(1)) service.join(user, room.code, room.invite);
  const cmd = (i, type, extra = {}) => service.command(users[i], room.code, { type, commandId: randomUUID(), ...extra });
  return { users, data, service, room, cmd };
}

test('before play a changed cumulative cap cannot invalidate an already credited member', () => {
  const f = fixture();
  f.cmd(0, 'sit', { seat: 0, amountBB: 500 }); f.cmd(0, 'stand');
  const before = structuredClone(f.data);
  assert.throws(() => f.cmd(0, 'settings', { settings: { maxTotalBuyInBB: 450 } }), /已有带入/);
  assert.deepEqual(f.data, before);
  f.cmd(0, 'settings', { settings: { maxTotalBuyInBB: 600 } });
  f.cmd(0, 'sit', { seat: 1, amountBB: 100 });
  assert.throws(() => f.cmd(0, 'buyin', { amountBB: 100 }), /累计带入/);
  assert.equal(f.room.members[f.users[0].id].totalBuyIn, 6000);
});

test('the session allowance is per player and raw point requests use the current blind', () => {
  const f = fixture({ smallBlind: 2, bigBlind: 5, maxTotalBuyInBB: 150 });
  for (let i = 0; i < 3; i++) f.cmd(i, 'sit', { seat: i, amount: 750 });
  assert.equal(f.data.ledger.reduce((sum, row) => sum + row.amount, 0), 2250);
  assert.ok(Object.values(f.room.members).every(member => member.totalBuyIn === 750));
  for (let i = 0; i < 3; i++) assert.throws(() => f.cmd(i, 'buyin', { amount: 500 }), /累计带入/);
});

test('failed due-hand preparations leave both the bomb clock and hand state untouched', t => {
  let timestamp = 1800000000000; t.mock.method(Date, 'now', () => timestamp);
  const f = fixture({ bombPot: true, bombIntervalMinutes: 1, squid: true });
  f.cmd(0, 'sit', { seat: 0, amountBB: 100 }); f.cmd(1, 'sit', { seat: 1, amountBB: 100 });
  f.room.startedAt = timestamp - 60000; f.room.endsAt = timestamp + 3600000; f.room.nextBombAt = timestamp;
  const before = structuredClone(f.data);
  assert.throws(() => f.service.start(f.room, timestamp), /至少需要三人/);
  assert.deepEqual(f.data, before, 'failed start cannot consume a due event or reserve fish funds');
  timestamp += 45000; f.cmd(2, 'sit', { seat: 2, amountBB: 100 });
  f.service.start(f.room, timestamp);
  assert.equal(f.room.hand.bombPot, true); assert.equal(f.room.nextBombAt, timestamp + 60000);
});
