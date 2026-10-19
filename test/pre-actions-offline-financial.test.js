import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dualTableFixture } from './helpers/dual-table-http.mjs';
import { readyRoomAction } from './helpers/room-clock.js';
import { createPreActions, preActionOptions } from '../public/pre-actions.js';

// Real local HTTP/SSE and production pre-action controller. Only server time
// is controlled; no browser suspension or production network is simulated.
test('pre-actions survive short SSE loss but cannot outlive timeout or auto sit-out; both fish modes preserve return accounting', { timeout: 120000 }, async t => {
  const started = performance.now();
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  const f = await dualTableFixture({ modes: ['normalBomb', 'unlimitedBomb'], registered: false, actionTickMs: 1000000 });
  t.after(() => f.close());
  const target = 4, controllers = new Map(), scenarios = [], observations = new Map();
  const member = (table, index = target) => f.internal(table).members[table.users[index].user.id];
  const context = (table, index = target, extra = {}) => ({ identity: table.users[index].token, page: 'room',
    connected: true, visible: true, resync: false, busy: false, staleSnapshot: false, online: true, ...extra });
  const writes = () => f.events.filter(event => event.kind === 'write').length;
  const tick = table => { f.app.service.tick(f.internal(table), time); f.app.store.save(); f.app.broadcast(table.code); f.conserve(table); };
  const ready = table => { readyRoomAction(f.app.service, f.internal(table), value => { time = value; });
    f.app.store.save(); f.app.broadcast(table.code); };
  const sync = async (table, index = target) => (await f.api(table.users[index], `/api/rooms/${table.code}/sync`)).room;
  const money = table => ({ members: Object.values(f.internal(table).members).map(m => ({ id: m.id, stack: m.stack,
    totalBuyIn: m.totalBuyIn, cashedOut: m.cashedOut, debt: m.squidDebt ?? 0 })),
    ledger: f.app.store.data.ledger.filter(row => row.roomCode === table.code),
    fish: structuredClone(f.internal(table).mini.squid) });
  async function stateFromSse(table, index, predicate) {
    for (let tries = 0; tries < 200; tries++) {
      const state = f.sockets.get(`${table.index}:${index}`)?.latest;
      if (state && predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('SSE did not deliver the expected authoritative turn');
  }
  async function finish(table) {
    const room = f.internal(table);
    for (let turns = 0; room.hand.status === 'playing'; turns++) {
      assert.ok(turns < 100, 'hand completes within bounded actions');
      ready(table);
      if (room.hand.status !== 'playing') break;
      const index = table.users.findIndex(user => user.user.id === room.hand.actingId);
      assert.ok(f.sockets.has(`${table.index}:${index}`));
      const view = await stateFromSse(table, index, view => view.hand?.id === room.hand.id
        && view.hand.actionSeq === room.hand.log.length && view.actions.canAct);
      await f.command(table, index, index === 0 ? (view.actions.canCheck ? 'check' : 'call') : 'fold');
      f.conserve(table);
    }
    assert.deepEqual(room.hand.result.mainWinnerIds, [table.users[0].user.id]);
    f.conserve(table);
  }
  async function start(table) {
    const room = f.internal(table);
    await f.command(table, 0, 'start');
    for (let n = 0; room.hand.status !== 'playing'; n++) {
      assert.ok(n < 10 && Number.isFinite(room.nextHandAt));
      time = Math.max(time, room.nextHandAt); tick(table);
    }
    await f.command(table, 0, 'autoDeal', { paused: true }); ready(table);
    return room.hand;
  }
  for (const table of f.tables) await f.command(table, 0, 'autoDeal', { paused: true });

  // A current-price preselected call is retained during real SSE loss. It is
  // gated while disconnected/resyncing and consumed before the HTTP request.
  for (const table of f.tables) {
    ready(table);
    const initial = await sync(table), controller = createPreActions();
    assert.ok(preActionOptions(initial).eligible);
    const selection = controller.toggle('call-current', initial, context(table));
    assert.ok(selection); assert.equal(selection.callAmount, 10);
    const before = writes(), paidBefore = f.internal(table).hand.players.find(p => p.id === initial.meId).contributed;
    await f.disconnect(table, target);
    assert.equal(controller.consume(initial, context(table, target, { connected: false, resync: true })), null);
    assert.equal(controller.selection, selection); assert.equal(writes(), before);
    const actor = table.users.findIndex(user => user.user.id === f.internal(table).hand.actingId);
    await f.command(table, actor, 'call'); time += 500; ready(table);
    await f.connect(table, target);
    const current = await sync(table);
    assert.equal(current.hand.actingId, current.meId);
    assert.equal(controller.consume(current, context(table, target, { resync: true })), null);
    assert.equal(controller.selection, selection);
    const decision = controller.consume(current, context(table));
    assert.deepEqual(decision, { type: 'call' });
    assert.equal(controller.consume(current, context(table)), null);
    const commandId = randomUUID(), guard = { commandId, handId: current.hand.id, actionSeq: current.hand.actionSeq };
    await Promise.all([f.command(table, target, decision.type, guard), f.command(table, target, decision.type, guard)]);
    assert.equal(f.internal(table).hand.players.find(p => p.id === current.meId).contributed, paidBefore + selection.callAmount);
    assert.equal(f.internal(table).hand.log.filter(row => row.playerId === current.meId && row.type === 'call').length, 1);
    observations.set(table.index, { shortDisconnectCall: selection.callAmount, acceptedCallDeliveries: 2, executedCalls: 1 });
    await finish(table);
  }
  scenarios.push('both modes: brief SSE loss retains preselected call without writes; fresh synchronization consumes once and duplicate HTTP delivery charges once');

  // The server can finish a missed turn while the tab is absent. Feeding the
  // actual HTTP snapshot back into the controller must erase the old intent.
  for (const table of f.tables) {
    await start(table);
    const room = f.internal(table), actor = table.users.findIndex(user => user.user.id === room.hand.actingId);
    const nextIndex = (actor + 1) % 9, controller = createPreActions();
    const initial = await sync(table, nextIndex);
    assert.ok(controller.toggle('check-fold', initial, context(table, nextIndex)));
    await f.disconnect(table, nextIndex);
    await f.command(table, actor, initial.hand.bombPot ? 'check' : 'call'); ready(table);
    assert.equal(room.hand.actingId, table.users[nextIndex].user.id);
    time = room.deadline + 1; tick(table);
    assert.equal(room.hand.log.filter(row => row.playerId === table.users[nextIndex].user.id && row.type === 'timeout').length, 1);
    await f.connect(table, nextIndex);
    const fresh = await sync(table, nextIndex), count = writes(), snapshot = money(table);
    assert.equal(controller.consume(fresh, context(table, nextIndex)), null);
    assert.equal(controller.selection, null); assert.equal(writes(), count); assert.deepEqual(money(table), snapshot);
    const handBefore = structuredClone(room.hand);
    await f.command(table, nextIndex, 'call', { handId: initial.hand.id, actionSeq: initial.hand.actionSeq }, 409);
    assert.deepEqual(room.hand, handBefore, 'server independently rejects a queued command carrying the expired turn');
    await finish(table);
  }
  scenarios.push('both modes: server turn timeout invalidates retained intent; queued old turn receives 409 and cannot alter hand or chips');

  // Keep the original hand live at the 90-second boundary: this distinguishes
  // invalidation for auto sit-out from the simpler next-hand identity guard.
  for (const table of f.tables) {
    await start(table);
    const view = await sync(table), controller = createPreActions();
    assert.ok(controller.toggle('check-fold', view, context(table)));
    controllers.set(table.index, controller);
  }
  const offlineAt = time;
  for (const table of f.tables) await f.disconnect(table, target);
  time = offlineAt + 89000;
  for (const table of f.tables) {
    tick(table); assert.equal(member(table).sittingOut, false);
    assert.ok(controllers.get(table.index).selection);
  }
  time = offlineAt + 90000;
  for (const table of f.tables) {
    const room = f.internal(table), before = member(table).stack;
    tick(table); assert.equal(member(table).sittingOut, true); assert.equal(member(table).autoSitOut, true);
    assert.equal(room.hand.status, 'playing'); assert.equal(member(table).stack, before);
    await f.connect(table, target);
    const current = await sync(table), count = writes(), controller = controllers.get(table.index);
    assert.equal(controller.consume(current, context(table)), null); assert.equal(controller.selection, null);
    assert.equal(writes(), count); assert.equal(member(table).sittingOut, true);
    await finish(table);
  }
  scenarios.push('both modes: 89 seconds keeps participation; 90 seconds auto sit-out cancels old intent in the same still-live hand; reconnect cannot silently resume');

  // The same production blind orbit and bomb scheduler continue with eight
  // players; fish responsibility stays frozen for the absent participant.
  for (const table of f.tables) {
    const bomb = await start(table);
    assert.equal(bomb.bombPot, true); assert.equal(bomb.players.length, 8);
    assert.ok(!bomb.players.some(p => p.id === member(table).id));
    await finish(table);
    for (let orbit = 0; !member(table).blindEntry.missedBig; orbit++) {
      assert.ok(orbit < 10, 'ordinary blind orbit reaches the paused seat');
      const hand = await start(table);
      assert.equal(hand.players.length, 8); assert.ok(!hand.players.some(p => p.id === member(table).id));
      await finish(table);
    }
  }
  scenarios.push('both modes: due bomb hands and ordinary blind orbit continue with eight players; paused player pays no new hand ante or blinds');

  for (const table of f.tables) {
    const room = f.internal(table), resumeId = randomUUID(), before = money(table);
    await Promise.all([f.command(table, target, 'sitout', { value: false, entryMode: 'post', commandId: resumeId }),
      f.command(table, target, 'sitout', { value: false, entryMode: 'post', commandId: resumeId })]);
    assert.deepEqual(money(table), before, 'selecting return does not charge before a new deal');
    let posted = false;
    for (let tries = 0; tries < 8 && !posted; tries++) {
      const owedSmall = member(table).blindEntry.missedSmall, hand = await start(table);
      const player = hand.players.find(p => p.id === member(table).id);
      if (!player) { await finish(table); continue; }
      const live = hand.log.filter(row => row.playerId === player.id && row.type === 'entryBlind');
      const dead = hand.log.filter(row => row.playerId === player.id && row.type === 'deadBlind');
      assert.equal(live.length, 1); assert.equal(live[0].amount, room.settings.bigBlind);
      assert.equal(dead.length, owedSmall ? 1 : 0);
      assert.equal(player.contributed, room.settings.bigBlind + (owedSmall ? room.settings.smallBlind : 0));
      const charged = money(table), unchangedHand = structuredClone(hand);
      for (let n = 0; n < 2; n++) { await f.disconnect(table, target); await f.connect(table, target); await sync(table); }
      await f.command(table, target, 'sitout', { value: false, entryMode: 'post', commandId: resumeId });
      assert.deepEqual(money(table), charged); assert.deepEqual(hand, unchangedHand);
      assert.equal(controllers.get(table.index).consume(await sync(table), context(table)), null, 'return cannot revive the cancelled pre-action');
      const buyinId = randomUUID(), buyinBefore = member(table).totalBuyIn;
      await Promise.all([f.command(table, target, 'buyin', { amountBB: 100, commandId: buyinId }),
        f.command(table, target, 'buyin', { amountBB: 100, commandId: buyinId })]);
      assert.equal(f.app.service.pendingBuyIn(member(table)), 1000); assert.equal(member(table).totalBuyIn, buyinBefore);
      await finish(table);
      assert.equal(member(table).totalBuyIn, buyinBefore + 1000);
      const delivered = money(table);
      await f.command(table, target, 'buyin', { amountBB: 100, commandId: buyinId });
      assert.deepEqual(money(table), delivered);
      Object.assign(observations.get(table.index), { entryHand: hand.number, entryLive: live[0].amount,
        entryDead: dead.reduce((sum, row) => sum + row.amount, 0), queuedTopup: 1000, topupDeliveries: 3, topupsApplied: 1 });
      posted = true;
    }
    assert.ok(posted);
  }
  scenarios.push('both modes: duplicate return and repeated reconnect post live/dead blinds once; queued top-up survives duplicate delivery once and cannot revive old selection');

  const tables = [];
  for (const table of f.tables) {
    const room = f.internal(table), fish = structuredClone(room.mini.squid), commandId = randomUUID();
    assert.equal(fish.active, true);
    await f.command(table, 0, 'close', { commandId });
    const settled = money(table);
    await f.command(table, 0, 'close', { commandId }); tick(table); tick(table);
    assert.deepEqual(money(table), settled);
    const rows = f.app.store.data.ledger.filter(row => row.roomCode === table.code && row.type === 'squidSettlement'
      && row.roundSettlementId === fish.roundSettlementId);
    const count = Object.values(fish.counts).reduce((sum, value) => sum + value, 0), zeros = fish.participants.filter(id => !fish.counts[id]).length;
    assert.ok(count > 0); assert.equal(rows.length, fish.participants.length);
    assert.equal(new Set(rows.map(row => row.playerId)).size, rows.length);
    for (const row of rows) assert.equal(row.amount, fish.counts[row.playerId] ? fish.counts[row.playerId] * fish.unit * zeros : -count * fish.unit);
    assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 0);
    tables.push({ mode: table.mode, ...observations.get(table.index), hands: room.handNumber,
      fishAwardedAtClose: count, fishSettlementRows: rows.length, fishSettlementNet: 0, accounting: f.conserve(table) });
  }
  scenarios.push('both modes: final fish transfers match independent arithmetic, one row per participant, repeated close/tick cannot double settle and points remain conserved');
  assert.deepEqual(f.errors, []);
  const summary = { environment: 'local isolated HTTP/SSE and real pre-action controller', productionAccess: false,
    controlledServerTime: true, initialSseConnections: 18, scenarios: scenarios.map(name => ({ name, passed: true })), tables,
    requests: f.events.length, elapsedRealMs: Math.round(performance.now() - started),
    limitations: ['Node HTTP/SSE clients are not Safari/Quark physical browser acceptance',
      '89/90 seconds uses a controlled server clock, not actual phone background suspension',
      'Loopback traffic does not reproduce carrier routing, VPN or Hong Kong network latency'] };
  const output = resolve('output/pre-actions-integration-20261019'); mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'offline-financial-summary.json'), JSON.stringify(summary, null, 2));
  t.diagnostic(JSON.stringify({ scenarios: scenarios.length, requests: summary.requests, tables, elapsedRealMs: summary.elapsedRealMs }));
});
