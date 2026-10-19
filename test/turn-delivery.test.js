import test from 'node:test';
import assert from 'node:assert/strict';
import { turnDeliveryReceipt, publicTurnDelivery } from '../src/turn-delivery.js';
import { createTurnDelivery } from '../public/turn-delivery.js';

const makeRoom = () => ({ status: 'playing', deadline: 22000,
  hand: { id: 'h1', status: 'playing', actingId: 'a', log: [1, 2, 3] },
  presentation: { handId: 'h1', actionReadyAt: 2000, turnStartedAt: 2000 } });
const receipt = { handId: 'h1', actionSeq: 3 };

test('timely delivery preserves the exact deadline and consumes the once-only receipt', () => {
  const room = makeRoom();
  assert.deepEqual(turnDeliveryReceipt(room, 'a', receipt, 2500), { accepted: true, changed: true, grace: 0 });
  assert.equal(room.deadline, 22000);
  assert.deepEqual(turnDeliveryReceipt(room, 'a', receipt, 20000), { accepted: true, changed: false });
  assert.equal(room.deadline, 22000);
});

test('late delivery adds real bounded time once, survives reload, and preserves time cards', () => {
  let room = makeRoom(); room.deadline += 30000;
  assert.equal(turnDeliveryReceipt(room, 'a', receipt, 8000).grace, 6000);
  assert.equal(room.deadline, 58000);
  room = structuredClone(room);
  assert.deepEqual(turnDeliveryReceipt(room, 'a', receipt, 18000), { accepted: true, changed: false });
  assert.equal(room.deadline, 58000);
  assert.deepEqual(publicTurnDelivery(room), { acknowledged: true, seconds: 6, at: 8000 });
  const slow = makeRoom(); assert.equal(turnDeliveryReceipt(slow, 'a', receipt, 19000).grace, 8000);
  assert.equal(slow.deadline, 30000, 'an intentionally delayed receipt cannot extend indefinitely');
});

test('old turn, other player, presentation gate, completed hand and timeout never receive grace', () => {
  for (const change of [r => r.hand.actingId = 'b', r => r.hand.log.push(4), r => r.hand.id = 'h2',
    r => r.hand.transition = {}, r => r.hand.runout = { active: true }, r => r.hand.status = 'complete',
    r => r.status = 'closed', r => r.deadline = 7000, r => r.presentation.actionReadyAt = 9000]) {
    const room = makeRoom(); change(room); const before = structuredClone(room);
    assert.deepEqual(turnDeliveryReceipt(room, 'a', receipt, 8000), { accepted: false, changed: false });
    assert.deepEqual(room, before);
  }
  assert.equal(turnDeliveryReceipt(makeRoom(), 'a', receipt, 22000).accepted, false);
});

test('only the exact current actor/action can expose delivery acknowledgement', () => {
  const room = makeRoom(); turnDeliveryReceipt(room, 'a', receipt, 8000);
  room.hand.log.push(4); assert.equal(publicTurnDelivery(room), null);
  room.presentation = { handId: 'h1', actionReadyAt: 10000 }; room.deadline = 30000;
  assert.equal(turnDeliveryReceipt(room, 'a', { handId: 'h1', actionSeq: 4 }, 12000).grace, 0,
    'another street in the same hand cannot claim another grace');
});

test('per-player budgets persist across hands and reset only after a genuine thirty-minute window', () => {
  const room = makeRoom(); room.startedAt = 0;
  const play = (id, start, player = 'a') => {
    room.hand.id = id; room.hand.actingId = player;
    room.presentation = { handId: id, actionReadyAt: start }; room.deadline = start + 20000;
    return turnDeliveryReceipt(room, player, { handId: id, actionSeq: 3 }, start + 10000).grace;
  };
  assert.equal(play('h1', 2000), 8000);
  assert.equal(play('h2', 32000), 8000);
  assert.equal(play('h3', 62000), 4000);
  assert.equal(play('h4', 92000), 0);
  assert.equal(room.deliveryBudgets.a.used, 20000);
  assert.equal(play('h4', 122000, 'b'), 8000, 'other players have independent allowances');
  room.deliveryBudgets = structuredClone(room.deliveryBudgets);
  assert.equal(play('h5', 152000), 0, 'reloaded budgets cannot be reset by a new hand');
  assert.equal(play('h6', 1801000), 8000);
  assert.equal(room.deliveryBudgets.a.used, 8000);
  assert.equal(play('h6', 3601000), 0, 'a long hand cannot claim twice even across budget windows');
});

test('the recovered startup turn cannot claim fresh compensation for an unflushed timely receipt', () => {
  const room = makeRoom();
  const before = room.deadline;
  assert.equal(turnDeliveryReceipt(room, 'a', receipt, 15000, { allowGrace: false }).grace, 0);
  assert.equal(room.deadline, before);
});

function client() {
  let time = 3000;
  const room = { code: '123456', meId: 'a', actions: { canAct: true }, hand: { id: 'h1', status: 'playing', actingId: 'a', actionSeq: 3 } };
  const context = { room, page: 'room', identity: 'session', visible: true, online: true, connected: true, resync: false, busy: false };
  const calls = [], applied = [], timers = new Map(); let nextTimer = 0;
  const delivery = createTurnDelivery({ getContext: () => context, clock: () => time,
    acknowledge: (code, body, signal) => new Promise((resolve, reject) => {
      calls.push({ code, body, signal, resolve, reject }); signal.addEventListener('abort', () => reject(new Error('aborted')));
    }), apply: room => applied.push(room),
    setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; }, clearTimer: id => timers.delete(id) });
  return { context, room, calls, applied, delivery, at: value => { time = value; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); } } };
}

test('client acknowledges once without changing buttons and accepts only a matching private response', async () => {
  const h = client(), original = structuredClone(h.room), job = h.delivery.check();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].body, receipt); assert.deepEqual(h.room, original);
  assert.equal(await h.delivery.check(), false);
  h.calls[0].resolve({ accepted: true, room: { ...h.room, deadline: 28000 } }); await job;
  assert.equal(h.applied.length, 1); h.at(15000); assert.equal(await h.delivery.check(), false);
  assert.equal(h.context.busy, false);
});

test('failed receipt retries independently and an identity/turn change cannot apply a stale response', async () => {
  const h = client(), first = h.delivery.check(); h.calls[0].reject(new Error('transport')); await first;
  h.at(4999); assert.equal(await h.delivery.check(), false);
  h.at(5000); const second = h.delivery.check(); h.context.identity = 'other';
  h.calls[1].resolve({ accepted: true, room: h.room }); await second; assert.equal(h.applied.length, 0);
  h.delivery.reset(); h.context.identity = 'session';
  const third = h.delivery.check(); h.delivery.reset(); await third; assert.equal(h.calls[2].signal.aborted, true);
});

test('a new action need not wait for a lost old receipt and the old completion cannot clear its request', async () => {
  const h = client(), first = h.delivery.check();
  h.room.hand.actionSeq = 4; const second = h.delivery.check(); await first;
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(await h.delivery.check(), false);
  h.calls[1].resolve({ accepted: true, room: h.room }); await second;
});

for (const [key, value] of [['visible', false], ['online', false], ['connected', false], ['resync', true], ['busy', true]]) {
  test(`no delivery claim while ${key}=${value}`, async () => {
    const h = client(); h.context[key] = value; assert.equal(await h.delivery.check(), false); assert.equal(h.calls.length, 0);
  });
}

test('authoritative receipt seen on another device suppresses a second claim', async () => {
  const h = client(); h.room.hand.deliveryGrace = { acknowledged: true, seconds: 8 };
  assert.equal(await h.delivery.check(), false); assert.equal(h.calls.length, 0);
});
