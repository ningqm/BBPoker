import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomService } from '../src/room.js';
import { createHand, applyAction } from '../src/poker.js';
import { handGameMode, handGameMatches } from '../src/record-games.js';
import { recordFilters } from '../src/records.js';
import { positionLabel, positionOptions } from '../public/hand-position.js';

test('six combinations filter frozen per-hand modes rather than current room settings', () => {
  const users = { a: { id: 'a', name: '本人' }, b: { id: 'b', name: '对手' } };
  const db = { users, rooms: {}, hands: [], ledger: [] }, service = new RoomService({ data: db });
  const room = service.create(users.a, {}); service.join(users.b, room.code, room.invite);
  for (const type of ['holdem', 'bomb']) for (const squid of ['none', 'normal', 'unlimited']) {
    const h = createHand({ id: `${type}-${squid}`, players: [{ id: 'a', seat: 0, stack: 1000 }, { id: 'b', seat: 3, stack: 1000 }],
      buttonSeat: 0, smallBlind: 5, bigBlind: 10, bombPot: type === 'bomb', ante: type === 'bomb' ? 20 : 0 });
    applyAction(h, h.actingId, 'fold');
    Object.assign(h, { at: '2026-10-14T03:00:00.000Z', roomCode: room.code, roomName: room.name, settings: { bigBlind: 10 },
      squidRound: squid === 'none' ? null : 1, squidMode: squid === 'none' ? null : squid });
    db.hands.push(h);
  }
  room.settings.squid = true; room.settings.squidMode = 'normal'; room.settings.bombPot = false;
  for (const type of ['all', 'holdem', 'bomb']) for (const squid of ['all', 'none', 'normal', 'unlimited']) {
    const result = service.handLibrary('a', { type, squid });
    assert.equal(result.hands.length, (type === 'all' ? 2 : 1) * (squid === 'all' ? 3 : 1));
    for (const row of result.hands) assert.ok(row.id.startsWith(type === 'all' ? '' : type) && (squid === 'all' || row.id.endsWith(squid)));
  }
});

test('legacy active-round evidence is supported, an explicitly absent round wins over old snapshots', () => {
  assert.equal(handGameMode({ miniBefore: { squid: { active: true, round: 2, mode: 'unlimited' } } }).squid, 'unlimited');
  assert.equal(handGameMode({ squidRound: null, miniBefore: { squid: { active: true, round: 2 } } }).squid, 'none');
  assert.equal(handGameMatches({ squidRound: 2, squidMode: 'normal', bombPot: true }, recordFilters({ squid: 'normal', type: 'bomb' })), true);
  assert.throws(() => recordFilters({ squid: 'invented' }), e => e.status === 400);
});

test('position labels and available options reflect actual dealt count', () => {
  assert.equal(positionLabel('CO', 4), '庄前一位 CO');
  assert.equal(positionLabel('HJ', 5), '庄前两位 HJ');
  assert.equal(positionOptions(4).some(([key]) => key === 'HJ'), false);
  assert.equal(positionOptions(5).some(([key]) => key === 'UTG'), false);
  assert.equal(positionOptions(9).some(([key]) => key === 'UTG'), true);
  assert.equal(positionLabel('BTN', 2), '庄位兼小盲');
  assert.equal(positionLabel('bomb', 4), '炸弹池无盲位');
});
