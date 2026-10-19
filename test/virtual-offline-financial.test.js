import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dualTableFixture } from './helpers/dual-table-http.mjs';
import { readyRoomAction } from './helpers/room-clock.js';

// Real local HTTP commands and 18 SSE readers. Only server Date.now is advanced;
// the 89/90 second checks are not a claim of real browser background suspension.
test('virtual two-table offline boundary, reconnect, missed blind and squid accounting', { timeout: 120000 }, async t => {
  const started = performance.now();
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  const f = await dualTableFixture({ modes: ['normalBomb', 'unlimitedBomb'], registered: false, actionTickMs: 1000000 });
  t.after(() => f.close());
  const offlineIndex = 4;
  const summary = { timing: 'controlled server clock, real loopback HTTP/SSE, random production shuffle',
    productionAccess: false, connections: 18, scenarios: [], requests: 0, tables: [] };
  const tick = () => {
    for (const table of f.tables) { f.app.service.tick(f.internal(table), time); f.app.broadcast(table.code); f.conserve(table); }
    f.app.store.save();
  };
  const advance = ms => { time += ms; tick(); };
  const member = table => f.internal(table).members[table.users[offlineIndex].user.id];
  const financial = table => {
    const room = f.internal(table), q = room.mini.squid;
    return { members: Object.values(room.members).map(m => ({ id: m.id, stack: m.stack, totalBuyIn: m.totalBuyIn,
      cashedOut: m.cashedOut, debt: m.squidDebt ?? 0 })),
      fish: { active: q.active, round: q.round, counts: structuredClone(q.counts), participants: [...q.participants], tokenBudget: q.tokenBudget },
      ledger: f.app.store.data.ledger.filter(row => row.roomCode === room.code).map(row => ({ id: row.id, type: row.type, amount: row.amount, playerId: row.playerId })) };
  };
  async function waitState(table, index, predicate) {
    for (let n = 0; n < 200; n++) {
      const view = f.sockets.get(`${table.index}:${index}`)?.latest;
      if (view && predicate(view)) return view;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('SSE did not deliver the expected authoritative state');
  }
  async function finishHand(table) {
    const room = f.internal(table);
    for (let n = 0; room.hand.status === 'playing'; n++) {
      assert.ok(n < 100, 'hand finishes in bounded actions');
      readyRoomAction(f.app.service, room, value => { time = value; });
      f.app.store.save(); f.app.broadcast(table.code);
      if (room.hand.status !== 'playing') break;
      const index = table.users.findIndex(user => user.user.id === room.hand.actingId);
      assert.ok(f.sockets.has(`${table.index}:${index}`), 'offline player is never dealt a new hand');
      const view = await waitState(table, index, view => view.hand?.id === room.hand.id && view.hand?.actionSeq === room.hand.log.length && view.actions?.canAct);
      await f.command(table, index, index === 0 ? (view.actions.canCheck ? 'check' : 'call') : 'fold');
      f.conserve(table);
    }
    assert.deepEqual(room.hand.result.mainWinnerIds, [table.users[0].user.id]);
    f.conserve(table);
  }
  async function startHand(table) {
    const room = f.internal(table);
    assert.notEqual(room.hand.status, 'playing');
    await f.command(table, 0, 'start');
    for (let n = 0; room.hand.status !== 'playing'; n++) {
      assert.ok(n < 8 && Number.isFinite(room.nextHandAt), 'next hand remains scheduled');
      time = Math.max(time, room.nextHandAt); tick();
    }
    await f.command(table, 0, 'autoDeal', { paused: true });
    return room.hand;
  }
  for (const table of f.tables) { await f.command(table, 0, 'autoDeal', { paused: true }); await finishHand(table); }
  // Allow ordinary end-of-hand supplemental reveals before a no-mutation check.
  advance(6000);
  const firstOfflineAt = time;
  await f.disconnect(f.tables[0], offlineIndex);
  const initial = financial(f.tables[0]);
  const otherHandNumber = f.internal(f.tables[1]).hand.number;
  await startHand(f.tables[1]); await finishHand(f.tables[1]);
  assert.equal(f.internal(f.tables[1]).hand.number, otherHandNumber + 1);
  assert.ok(Object.values(f.internal(f.tables[1]).members).filter(m => m.seat !== null).every(m => !m.sittingOut));
  time = firstOfflineAt + 89000; tick();
  assert.equal(member(f.tables[0]).sittingOut, false);
  assert.deepEqual(financial(f.tables[0]), initial, '89 seconds offline cannot charge blinds or settle the fish');
  await f.connect(f.tables[0], offlineIndex);
  assert.equal(f.app.service.offlinePresence.has(`${f.tables[0].code}:${member(f.tables[0]).id}`), false);
  summary.scenarios.push({ name: '89 seconds offline retains seat; other table completes a hand', passed: true });

  const secondOfflineAt = time;
  for (const table of f.tables) await f.disconnect(table, offlineIndex);
  const secondBefore = f.tables.map(financial);
  advance(1000);
  for (const table of f.tables) assert.equal(member(table).sittingOut, false, 'previous disconnect is not accumulated');
  advance(88000);
  for (const table of f.tables) assert.equal(member(table).sittingOut, false, 'new uninterrupted interval is still only 89 seconds');
  advance(1000);
  assert.equal(time - secondOfflineAt, 90000);
  for (const table of f.tables) {
    assert.equal(member(table).sittingOut, true); assert.equal(member(table).autoSitOut, true);
    assert.equal(member(table).seat, offlineIndex);
    assert.deepEqual(financial(table), secondBefore[table.index], 'auto sit-out retains chips and frozen fish responsibility');
  }
  tick(); tick();
  for (const table of f.tables) assert.deepEqual(financial(table), secondBefore[table.index]);
  summary.scenarios.push({ name: 'reconnect resets continuous-offline timer; exactly 90 seconds auto-sits-out once without cashing out or fish settlement', passed: true });

  for (const table of f.tables) {
    const bomb = await startHand(table);
    assert.equal(bomb.bombPot, true); assert.equal(bomb.players.length, 8);
    assert.ok(!bomb.players.some(player => player.id === member(table).id));
    await finishHand(table);
    for (let orbit = 0; !member(table).blindEntry.missedBig; orbit++) {
      assert.ok(orbit < 3, 'ordinary blinds reach the absent seat');
      const regular = await startHand(table);
      assert.equal(regular.bombPot, false); assert.equal(regular.players.length, 8);
      await finishHand(table);
    }
    assert.equal(member(table).blindEntry.missedBig, true, 'the actual ordinary blind orbit creates the missed blind');
  }
  summary.scenarios.push({ name: 'both fish modes continue with eight online players; due bomb hands and subsequent ordinary hands do not burn the absent player blinds', passed: true });

  const entryObservations = new Map();
  for (const table of f.tables) {
    const room = f.internal(table);
    const before = financial(table);
    await f.connect(table, offlineIndex);
    assert.equal(member(table).sittingOut, true, 'reconnect alone cannot silently put a paused player into a new hand');
    await Promise.all(Array.from({ length: 3 }, () => f.api(table.users[offlineIndex], `/api/rooms/${table.code}/sync`)));
    assert.deepEqual(financial(table), before);
    const commandId = randomUUID();
    await Promise.all([f.command(table, offlineIndex, 'sitout', { value: false, entryMode: 'post', commandId }),
      f.command(table, offlineIndex, 'sitout', { value: false, entryMode: 'post', commandId })]);
    assert.equal(member(table).sittingOut, false); assert.deepEqual(financial(table), before, 'choosing post pays nothing before actually being dealt');
    for (let tries = 0; tries < 6; tries++) {
      const owedSmall = member(table).blindEntry.missedSmall;
      const hand = await startHand(table);
      const player = hand.players.find(p => p.id === member(table).id);
      if (player) {
        const entry = hand.log.filter(row => row.playerId === player.id && row.type === 'entryBlind');
        assert.equal(entry.length, 1, 'entry payment appears once in the actual hand');
        const dead = hand.log.filter(row => row.playerId === player.id && row.type === 'deadBlind');
        assert.equal(dead.length, owedSmall ? 1 : 0);
        assert.equal(entry[0].amount, room.settings.bigBlind);
        assert.equal(player.contributed, room.settings.bigBlind + (owedSmall ? room.settings.smallBlind : 0), 'one live big blind plus only an actually missed small blind');
        const view = f.app.service.state(room, table.users[offlineIndex].user.id);
        assert.equal(view.meId, member(table).id);
        entryObservations.set(table.index, { handId: hand.id, handNumber: hand.number, livePayments: entry.length,
          liveAmount: entry[0].amount, deadPayments: dead.length, deadAmount: dead.reduce((sum, row) => sum + row.amount, 0), amount: player.contributed });
        const snapshot = financial(table), handSnapshot = structuredClone(hand);
        for (let n = 0; n < 3; n++) { await f.disconnect(table, offlineIndex); await f.connect(table, offlineIndex); }
        await f.command(table, offlineIndex, 'sitout', { value: false, entryMode: 'post', commandId });
        assert.deepEqual(financial(table), snapshot); assert.deepEqual(hand, handSnapshot, 'resync/reconnect and repeated accepted command cannot charge again');
        const buyinId = randomUUID(), initialBuyin = member(table).totalBuyIn;
        await Promise.all([f.command(table, offlineIndex, 'buyin', { amountBB: 100, commandId: buyinId }),
          f.command(table, offlineIndex, 'buyin', { amountBB: 100, commandId: buyinId })]);
        assert.equal(f.app.service.pendingBuyIn(member(table)), 1000); assert.equal(member(table).totalBuyIn, initialBuyin);
        await finishHand(table);
        assert.equal(member(table).totalBuyIn, initialBuyin + 1000);
        const received = financial(table);
        await f.command(table, offlineIndex, 'buyin', { amountBB: 100, commandId: buyinId });
        assert.deepEqual(financial(table), received, 'retry after queued top-up delivery is still the same payment');
        break;
      }
      await finishHand(table);
    }
    assert.ok(entryObservations.has(table.index), 'returning player eventually posts and receives cards');
  }
  summary.scenarios.push({ name: 'returning player posts missed blind exactly once across repeated reconnects and duplicate resume commands; queued top-up delivered once', passed: true });

  for (const table of f.tables) {
    const room = f.internal(table), fish = structuredClone(room.mini.squid);
    assert.equal(fish.active, true, 'fixture has an unsettled fish round to exercise final settlement');
    const commandId = randomUUID();
    await f.command(table, 0, 'close', { commandId });
    const closed = financial(table);
    await f.command(table, 0, 'close', { commandId }); tick();
    assert.deepEqual(financial(table), closed, 'duplicate close and repeated tick cannot settle a fish round twice');
    const rows = f.app.store.data.ledger.filter(row => row.roomCode === table.code && row.type === 'squidSettlement' && row.roundSettlementId === fish.roundSettlementId);
    assert.equal(rows.length, fish.participants.length); assert.equal(new Set(rows.map(row => row.playerId)).size, rows.length);
    const totalFish = Object.values(fish.counts).reduce((sum, n) => sum + n, 0), zeros = fish.participants.filter(id => !fish.counts[id]).length;
    for (const row of rows) assert.equal(row.amount, fish.counts[row.playerId] ? fish.counts[row.playerId] * fish.unit * zeros : -totalFish * fish.unit);
    assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 0);
    const affected = rows.find(row => row.playerId === member(table).id);
    assert.equal(affected.amount, -totalFish * fish.unit, 'auto sit-out never erases previously accepted fish responsibility');
    summary.tables.push({ mode: table.mode, hands: room.handNumber, entryBlind: entryObservations.get(table.index),
      fishParticipants: rows.length, fishAwarded: totalFish, absentPlayerFishAmount: affected.amount,
      fishSettlementRows: rows.length, fishSettlementNet: 0, accounting: f.conserve(table),
      sseFrames: [...f.sockets.values()].filter(stream => stream.table === table).reduce((sum, stream) => sum + stream.frames, 0) });
  }
  summary.scenarios.push({ name: 'each fish round settles exactly once with independently computed transfers and zero-sum ledger; total points conserved on both tables', passed: true });
  assert.equal(f.errors.length, 0);
  summary.requests = f.events.length;
  summary.elapsedRealMs = Math.round(performance.now() - started);
  summary.simulatedElapsedMs = time - firstOfflineAt;
  summary.limitations = ['Node HTTP/SSE clients, not Safari or Quark engine emulation', '89/90 second threshold uses controlled server time, not physical phone backgrounding', 'All traffic is loopback; carrier routing and VPN are not represented'];
  const output = resolve('output/virtual-connection-20261019'); mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'offline-summary.json'), JSON.stringify(summary, null, 2));
  t.diagnostic(JSON.stringify({ scenarios: summary.scenarios.length, requests: summary.requests, tables: summary.tables.map(({ mode, hands, entryBlind, fishSettlementRows }) => ({ mode, hands, entryBlind, fishSettlementRows })), elapsedRealMs: summary.elapsedRealMs }));
});
