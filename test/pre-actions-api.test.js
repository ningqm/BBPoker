import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { seedLegacyAccount } from './helpers/accounts.js';
import { readyRoomAction } from './helpers/room-clock.js';
import { preActionOptions, createPreActions } from '../public/pre-actions.js';

const context = { identity: 'isolated-session', page: 'room', connected: true, visible: true,
  resync: false, busy: false, staleSnapshot: false, online: true };

// Real loopback HTTP and production account/room/action handlers. Presence and
// the server clock are controlled locally; no production accounts are touched.
async function fixture(t, buyins = [200, 200, 200]) {
  let time = 1800000000000; t.mock.method(Date, 'now', () => time);
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-preactions-'));
  const app = createApp({ dataDir: directory, actionTickMs: 1000000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let writes = 0;
  const users = buyins.map((_, i) => seedLegacyAccount(app, { name: `预操作验收${i + 1}` }));
  async function api(index, path, body, expected = 200) {
    if (body) writes++;
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users[index].token}` },
      body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  const created = (await api(0, '/api/rooms', { name: '预操作 HTTP 验收', settings: {
    smallBlind: 5, bigBlind: 10, maxPlayers: 9, durationMinutes: 30,
  } }, 201)).room;
  const code = created.code, path = `/api/rooms/${code}`, room = () => app.store.data.rooms[code];
  const id = index => users[index].user.id;
  const command = (index, type, extra = {}, expected = 200) => api(index, path + '/action', {
    type, commandId: randomUUID(), handId: room().hand?.id, actionSeq: room().hand?.log.length, ...extra,
  }, expected);
  for (let i = 0; i < users.length; i++) {
    if (i) await api(i, path + '/join', { invite: created.invite });
    await command(i, 'sit', { seat: i, amountBB: buyins[i] });
    app.service.connections.set(`${code}:${id(i)}`, 1);
  }
  await command(0, 'start');
  const ready = () => { readyRoomAction(app.service, room(), value => { time = value; }); app.store.save(); };
  const conserve = () => {
    const r = room(), members = Object.values(r.members);
    const held = members.reduce((sum, player) => sum + player.stack + player.cashedOut - (player.squidDebt ?? 0), 0)
      + (r.hand?.status === 'playing' ? r.hand.players.reduce((sum, player) => sum + player.contributed, 0) : 0);
    assert.equal(held, members.reduce((sum, player) => sum + player.totalBuyIn, 0));
  };
  ready(); conserve();
  return { app, room, id, command, ready, conserve, api, path, get writes() { return writes; },
    timeout() { time = room().deadline; app.service.tick(room(), time); app.store.save(); },
    view: index => api(index, path), player: index => room().hand.players.find(player => player.id === id(index)) };
}

test('preselected current call uses authoritative turn quote and duplicate HTTP delivery charges only once', async t => {
  const f = await fixture(t), controller = createPreActions(), initial = await f.view(1);
  assert.equal(initial.actions.callAmount, 0, 'off-turn server action mask is intentionally empty');
  assert.equal(preActionOptions(initial).callAmount, 5, 'small blind already invested 5 of the current 10');
  const beforeWrites = f.writes;
  assert.ok(controller.toggle('call-current', initial, context));
  assert.equal(controller.consume(initial, context), null);
  assert.equal(f.writes, beforeWrites, 'selection cannot post a game action before its turn');
  await f.command(0, 'call'); f.ready();
  const current = await f.view(1), selected = controller.consume(current, context);
  assert.deepEqual(selected, { type: 'call' });
  assert.equal(controller.consume(current, context), null, 'consume removes the selection before asynchronous I/O');
  const commandId = randomUUID(), handId = current.hand.id, actionSeq = current.hand.actionSeq;
  const before = f.player(1).contributed;
  const first = await f.command(1, selected.type, { commandId, handId, actionSeq });
  assert.ok(first.room.acceptedCommandIds.includes(commandId));
  const after = structuredClone(f.room().hand);
  assert.equal(f.player(1).contributed, before + 5);
  await f.command(1, selected.type, { commandId, handId, actionSeq });
  assert.deepEqual(f.room().hand, after, 'lost response retry cannot act again or charge another call');
  assert.equal(f.room().hand.log.filter(row => row.playerId === f.id(1) && row.type === 'call').length, 1);
  f.conserve();
});

test('a raise invalidates the selected call rather than silently following the higher price', async t => {
  const f = await fixture(t), controller = createPreActions(), initial = await f.view(1);
  assert.ok(controller.toggle('call-current', initial, context));
  const before = f.player(1).contributed;
  await f.command(0, 'raise', { amount: 40 }); f.ready();
  const current = await f.view(1), beforeWrites = f.writes;
  assert.equal(current.actions.callAmount, 35);
  assert.equal(controller.update(current, context), null);
  assert.equal(controller.consume(current, context), null);
  assert.equal(f.writes, beforeWrites); assert.equal(f.player(1).contributed, before);
  const snapshot = structuredClone(f.room().hand);
  await f.command(1, 'call', { handId: initial.hand.id, actionSeq: initial.hand.actionSeq }, 409);
  assert.deepEqual(f.room().hand, snapshot, 'server also rejects a racing old action sequence without changing money');
  f.conserve();
});

test('preselected check-or-fold checks the big blind for free after unchanged calls', async t => {
  const f = await fixture(t), controller = createPreActions(), initial = await f.view(2);
  assert.equal(preActionOptions(initial).callAmount, 0);
  assert.ok(controller.toggle('check-fold', initial, context));
  await f.command(0, 'call'); f.ready();
  assert.ok(controller.update(await f.view(2), context));
  await f.command(1, 'call'); f.ready();
  const current = await f.view(2), selected = controller.consume(current, context);
  assert.equal(current.actions.canCheck, true); assert.deepEqual(selected, { type: 'check' });
  const before = f.player(2).contributed;
  await f.command(2, selected.type);
  assert.equal(f.player(2).contributed, before);
  assert.equal(f.player(2).folded, false);
  assert.equal(f.room().hand.log.filter(row => row.playerId === f.id(2) && row.type === 'check').length, 1);
  assert.equal(controller.consume(current, context), null);
  f.conserve();
});

test('preselected check-or-fold folds when a preceding player raises', async t => {
  const f = await fixture(t), controller = createPreActions(), initial = await f.view(1);
  assert.ok(controller.toggle('check-fold', initial, context));
  await f.command(0, 'raise', { amount: 40 }); f.ready();
  const current = await f.view(1), selected = controller.consume(current, context);
  assert.equal(current.actions.canCheck, false); assert.deepEqual(selected, { type: 'fold' });
  const before = f.player(1).contributed;
  await f.command(1, selected.type);
  assert.equal(f.player(1).contributed, before); assert.equal(f.player(1).folded, true);
  assert.equal(f.room().hand.log.filter(row => row.playerId === f.id(1) && row.type === 'fold').length, 1);
  f.conserve();
});

test('short-stack preselected call spends only the shown remaining stack and never becomes an all-in raise', async t => {
  const f = await fixture(t, [300, 100, 200, 300]), controller = createPreActions();
  assert.equal(f.room().hand.actingId, f.id(3));
  await f.command(3, 'allin'); f.ready();
  const initial = await f.view(1), options = preActionOptions(initial);
  assert.equal(initial.hand.actingId, f.id(0));
  assert.equal(options.callAmount, 995); assert.equal(options.callAllIn, true);
  assert.ok(controller.toggle('call-current', initial, context));
  await f.command(0, 'fold'); f.ready();
  const current = await f.view(1), selected = controller.consume(current, context);
  assert.equal(current.actions.callAmount, 995); assert.deepEqual(selected, { type: 'call' });
  const commandId = randomUUID(), handId = current.hand.id, actionSeq = current.hand.actionSeq;
  await f.command(1, selected.type, { commandId, handId, actionSeq });
  assert.equal(f.player(1).stack, 0); assert.equal(f.player(1).allIn, true);
  assert.equal(f.player(1).contributed, 1000);
  const calls = f.room().hand.log.filter(row => row.playerId === f.id(1) && row.type === 'call');
  assert.equal(calls.length, 1); assert.equal(calls[0].amount, 995);
  assert.equal(f.room().hand.log.some(row => row.playerId === f.id(1) && row.type === 'allin'), false);
  const snapshot = structuredClone(f.room().hand);
  await f.command(1, selected.type, { commandId, handId, actionSeq });
  assert.deepEqual(f.room().hand, snapshot); f.conserve();
});

test('background keeps a current call without posting and fresh foreground confirmation consumes it once', async t => {
  const f = await fixture(t), controller = createPreActions(), initial = await f.view(1);
  const hidden = { ...context, visible: false, resync: true };
  controller.toggle('call-current', initial, context);
  const selected = controller.selection;
  assert.equal(controller.update(initial, hidden), selected);
  await f.command(0, 'call'); f.ready();
  const current = await f.view(1), beforeWrites = f.writes, before = f.player(1).contributed;
  assert.equal(controller.consume(current, hidden), null);
  assert.equal(controller.selection, selected); assert.equal(f.writes, beforeWrites);
  assert.equal(controller.consume(current, { ...context, resync: true }), null);
  const decision = controller.consume(current, context);
  assert.deepEqual(decision, { type: 'call' });
  await f.command(1, decision.type);
  assert.equal(f.player(1).contributed, before + 5);
  assert.equal(controller.consume(current, context), null); f.conserve();
});

test('background price change cancels the retained call when the actual turn is synchronized', async t => {
  const f = await fixture(t), controller = createPreActions(), initial = await f.view(1);
  controller.toggle('call-current', initial, context);
  controller.update(initial, { ...context, visible: false });
  await f.command(0, 'raise', { amount: 40 }); f.ready();
  const current = await f.view(1), beforeWrites = f.writes, before = f.player(1).contributed;
  assert.equal(controller.consume(current, context), null);
  assert.equal(controller.selection, null); assert.equal(f.writes, beforeWrites);
  assert.equal(f.player(1).contributed, before); f.conserve();
});

test('a missed automatic check invalidates old check-fold before a later raise in the same street', async t => {
  const f = await fixture(t), controller = createPreActions();
  await f.command(0, 'call'); f.ready(); await f.command(1, 'call'); f.ready();
  await f.command(2, 'check'); f.ready();
  const initial = await f.view(2);
  assert.equal(initial.hand.street, 'flop'); assert.equal(initial.hand.actingId, f.id(1));
  assert.ok(controller.toggle('check-fold', initial, context));
  const hidden = { ...context, visible: false, connected: false, resync: true };
  controller.update(initial, hidden);
  await f.command(1, 'check'); f.ready();
  assert.equal(f.room().hand.actingId, f.id(2));
  const before = f.player(2).contributed, beforeStack = f.player(2).stack;
  f.timeout();
  assert.equal(f.room().hand.log.filter(row => row.playerId === f.id(2) && row.type === 'timeout').length, 1);
  assert.equal(f.room().hand.street, 'flop'); assert.equal(f.room().hand.actingId, f.id(0));
  await f.command(0, 'raise', { amount: 20 }); f.ready();
  await f.command(1, 'call'); f.ready();
  const current = await f.view(2), beforeWrites = f.writes;
  assert.equal(current.hand.street, initial.hand.street); assert.equal(current.hand.id, initial.hand.id);
  assert.equal(current.actions.callAmount, 20); assert.equal(f.player(2).contributed, before);
  assert.equal(f.player(2).stack, beforeStack, 'an automatic check changes neither stack nor bet');
  assert.equal(controller.consume(current, context), null, 'prior check-or-fold must not fold a later decision after its missed check');
  assert.equal(controller.selection, null); assert.equal(f.writes, beforeWrites);
  assert.equal(f.player(2).folded, false); f.conserve();
});

test('a consumed middle-position preselected check is one-shot when a later player raises', async t => {
  for (const kind of ['check-fold', 'call-current']) await t.test(kind, async subtest => {
    const f = await fixture(subtest), controller = createPreActions();
    await f.command(0, 'call'); f.ready(); await f.command(1, 'call'); f.ready();
    await f.command(2, 'check'); f.ready();
    const initial = await f.view(2);
    assert.equal(initial.hand.street, 'flop'); assert.equal(initial.hand.actingId, f.id(1));
    assert.equal(preActionOptions(initial).callAmount, 0);
    assert.ok(controller.toggle(kind, initial, context));
    await f.command(1, 'check'); f.ready();
    const current = await f.view(2), beforeWrites = f.writes;
    const decision = controller.consume(current, context);
    assert.deepEqual(decision, { type: 'check' });
    assert.equal(controller.selection, null, 'selection is consumed before sending its first HTTP action');
    assert.equal(f.writes, beforeWrites);
    await f.command(2, decision.type); f.ready();
    assert.equal(f.room().hand.actingId, f.id(0));
    assert.equal(f.room().hand.log.filter(row => row.street === 'flop' && row.playerId === f.id(2) && row.type === 'check').length, 1);
    const before = f.player(2).contributed;
    await f.command(0, 'raise', { amount: 20 }); f.ready();
    await f.command(1, 'call'); f.ready();
    const nextTurn = await f.view(2), writesAfterRaise = f.writes;
    assert.equal(nextTurn.hand.id, initial.hand.id); assert.equal(nextTurn.hand.street, initial.hand.street);
    assert.equal(nextTurn.hand.actingId, f.id(2)); assert.equal(nextTurn.actions.callAmount, 20);
    assert.equal(controller.consume(nextTurn, context), null, 'a new decision cannot inherit the earlier consumed check');
    assert.equal(controller.selection, null); assert.equal(f.writes, writesAfterRaise);
    assert.equal(f.player(2).folded, false); assert.equal(f.player(2).contributed, before);
    await f.command(2, 'call');
    assert.equal(f.player(2).contributed, before + 20, 'manual action remains usable after the earlier one-shot selection');
    assert.equal(f.player(2).folded, false); f.conserve();
  });
});
