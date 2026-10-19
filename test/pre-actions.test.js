import test from 'node:test';
import assert from 'node:assert/strict';
import { preActionOptions, createPreActions } from '../public/pre-actions.js';

const context = (changes = {}) => ({ identity: 'session-a', page: 'room', visible: true, connected: true,
  online: true, resync: false, busy: false, now: 1000, ...changes });
function room() {
  return { code: 'table', meId: 'hero', status: 'playing', serverTime: 1000, revision: 1,
    hand: { id: 'hand-1', street: 'preflop', status: 'playing', actingId: 'peer', currentBet: 10, actionSeq: 2,
      log: [{ seq: 1, playerId: 'hero', type: 'smallBlind' }, { seq: 2, playerId: 'blind', type: 'bigBlind' }] },
    players: [{ id: 'hero', seat: 0, inHand: true, folded: false, allIn: false, bet: 5, stack: 995 },
      { id: 'peer', seat: 1, inHand: true, folded: false, allIn: false, bet: 0, stack: 1000 },
      { id: 'blind', seat: 2, inHand: true, folded: false, allIn: false, bet: 10, stack: 990 }],
    actions: { canAct: false, turnAvailable: false, canCheck: false, canFold: false, callAmount: 0 } };
}
function turn(r, callAmount = preActionOptions(r).callAmount) {
  r.hand.actingId = r.meId;
  Object.assign(r.actions, { canAct: true, turnAvailable: true, callAmount, canCheck: callAmount === 0, canFold: true });
  return r;
}

test('off-turn options calculate the exact small blind difference rather than disabled actions.callAmount', () => {
  const r = room(), before = JSON.stringify(r), options = preActionOptions(r);
  assert.equal(options.eligible, true); assert.equal(options.callAmount, 5); assert.equal(options.currentBet, 10);
  assert.equal(options.callAllIn, false); assert.equal(options.shortCall, false);
  assert.equal(JSON.stringify(r), before);
  r.players[0].bet = 10; assert.equal(preActionOptions(r).callAmount, 0);
});

test('quote keys change on a different wager, not chat, revision, or another player calling the same bet', () => {
  const r = room(), key = preActionOptions(r).key, scope = preActionOptions(r).scopeKey;
  r.revision++; r.chat = [{ text: 'hello' }]; r.hand.actionSeq++; r.players[1].bet = 10; r.players[1].stack -= 10;
  assert.equal(preActionOptions(r).key, key);
  r.hand.currentBet = 20; r.players[1].bet = 20;
  assert.notEqual(preActionOptions(r).key, key); assert.equal(preActionOptions(r).scopeKey, scope);
});

test('controller is mutually exclusive, toggles off, exposes immutable intent, and sends no action early', () => {
  const r = room(), c = createPreActions(), ctx = context();
  assert.equal(c.toggle('check-fold', r, ctx).kind, 'check-fold');
  assert.equal(c.consume(r, ctx), null); assert.ok(c.selection);
  assert.equal(c.toggle('call-current', r, ctx).kind, 'call-current');
  assert.throws(() => { c.selection.callAmount = 10000; }, TypeError);
  assert.equal(c.toggle('call-current', r, ctx), null); assert.equal(c.selection, null);
  assert.equal(c.toggle('raise', r, ctx), null); assert.equal(c.selection, null);
});

test('check-fold checks for free and otherwise folds after any intervening raise', () => {
  for (const bet of [10, 20, 1000]) {
    const r = room(), c = createPreActions(); r.players[0].bet = 10;
    c.toggle('check-fold', r, context()); r.hand.currentBet = bet; r.players[1].bet = bet;
    assert.equal(c.update(r, context()).kind, 'check-fold');
    turn(r); assert.deepEqual(c.consume(r, context()), { type: bet === 10 ? 'check' : 'fold' });
    assert.equal(c.consume(r, context()), null);
  }
});

test('current call executes exactly once after same-price actions and ignores repeated turn frames', () => {
  const r = room(), c = createPreActions(); c.toggle('call-current', r, context());
  r.players[1].bet = 10; r.players[1].stack = 990; r.hand.actionSeq++; r.revision++;
  assert.equal(c.update(r, context()).callAmount, 5);
  turn(r); assert.deepEqual(c.consume(r, context()), { type: 'call' });
  assert.equal(c.selection, null); assert.equal(c.consume(structuredClone(r), context()), null);
});

test('any larger current bet cancels a call immediately, even when a short stack cap hides the amount change', () => {
  for (const stack of [995, 3]) {
    const r = room(), c = createPreActions(); r.players[0].stack = stack;
    c.toggle('call-current', r, context()); const before = preActionOptions(r).callAmount;
    r.hand.currentBet = 20; r.players[1].bet = 20;
    if (stack === 3) assert.equal(preActionOptions(r).callAmount, before);
    assert.equal(c.update(r, context()), null);
    turn(r); assert.equal(c.consume(r, context()), null);
  }
});

test('zero-price current call means check only and is cancelled by a new bet', () => {
  const r = room(), c = createPreActions(); r.players[0].bet = 10;
  c.toggle('call-current', r, context()); turn(r);
  assert.deepEqual(c.consume(r, context()), { type: 'check' });
  r.hand.actingId = 'peer'; r.actions.canAct = r.actions.turnAvailable = false;
  c.toggle('call-current', r, context()); r.hand.currentBet = 20;
  turn(r); assert.equal(c.consume(r, context()), null);
});

test('short-stack call and exact all-in call remain calls, never an all-in raise', () => {
  for (const stack of [3, 5]) {
    const r = room(), c = createPreActions(); r.players[0].stack = stack;
    assert.equal(preActionOptions(r).callAllIn, true);
    assert.equal(preActionOptions(r).shortCall, stack < 5);
    c.toggle('call-current', r, context()); turn(r);
    assert.deepEqual(c.consume(r, context()), { type: 'call' });
  }
});

test('call calculation excludes spectators/folded players and caps unmatched betting with only all-in opponents', () => {
  const r = room(); r.hand.currentBet = 200; r.players[0].bet = 0;
  Object.assign(r.players[1], { allIn: true, bet: 125, stack: 0 });
  Object.assign(r.players[2], { folded: true, bet: 200, stack: 800 });
  r.players.push({ id: 'watcher', inHand: false, stack: 5000, bet: 999 });
  assert.equal(preActionOptions(r).amountToMatch, 125); assert.equal(preActionOptions(r).callAmount, 125);
});

test('turn presentation delay preserves intent without executing; server authorization releases it', () => {
  const r = room(), c = createPreActions(); c.toggle('call-current', r, context());
  turn(r); r.actions.canAct = false; r.hand.actionReadyAt = 1500;
  assert.equal(preActionOptions(r).eligible, false); assert.equal(c.consume(r, context()), null); assert.ok(c.selection);
  r.actions.canAct = true;
  assert.equal(c.consume(r, context()), null); assert.ok(c.selection);
  r.serverTime = 1500;
  // Display clocks can be ahead after a correction; never reject fresh server authorization based on them.
  r.deadline = 2000;
  assert.deepEqual(c.consume(r, context({ now: 99999 })), { type: 'call' });
});

test('background, disconnect, sync and busy state retain intent but never execute or alter it before fresh recovery', () => {
  for (const change of [{ visible: false }, { connected: false }, { online: false }, { resync: true },
    { staleSnapshot: true }, { foregroundPending: true }, { busy: true }]) {
    const r = room(), c = createPreActions(), selected = c.toggle('call-current', r, context());
    assert.equal(c.update(r, context(change)), selected, JSON.stringify(change));
    assert.equal(c.toggle('check-fold', r, context(change)), null); assert.equal(c.selection, selected);
    turn(r); assert.equal(c.consume(r, context(change)), null); assert.equal(c.selection, selected);
    assert.deepEqual(c.consume(r, context()), { type: 'call' }); assert.equal(c.consume(r, context()), null);
  }
});

test('identity and room navigation clear intent immediately even during a temporary disconnection', () => {
  for (const change of [{ page: 'lobby' }, { identity: 'session-b' }, { identity: null }]) {
    const r = room(), c = createPreActions(); c.toggle('call-current', r, context());
    assert.equal(c.update(r, context({ connected: false, ...change })), null);
  }
  for (const change of [r => r.code = 'other-room', r => r.meId = 'other-player']) {
    const r = room(), c = createPreActions(); c.toggle('call-current', r, context()); change(r);
    assert.equal(c.update(r, context({ resync: true })), null);
  }
});

test('stale buffered data cannot permanently cancel retained intent; only a fresh matching or changed state decides', () => {
  for (const temporary of [{ connected: false }, { visible: false }, { staleSnapshot: true }, { resync: true }]) {
    const r = room(), c = createPreActions(), selected = c.toggle('call-current', r, context());
    const old = structuredClone(r); old.hand.id = 'old-hand'; old.hand.street = 'river'; old.players[0].folded = true;
    assert.equal(c.update(old, context(temporary)), selected); assert.equal(c.consume(old, context(temporary)), null);
    assert.equal(c.update(r, context()), selected);
    const changed = structuredClone(r); changed.hand.currentBet = 20; changed.players[1].bet = 20;
    assert.equal(c.update(changed, context(temporary)), selected);
    assert.equal(c.update(changed, context()), null);
  }
});

test('background timeout check cancels old check-fold intent before a later turn in the same street', () => {
  const r = room(), c = createPreActions(); r.players[0].bet = 10;
  const selected = c.toggle('check-fold', r, context());
  r.hand.log.push({ seq: 3, playerId: 'hero', type: 'check' }, { seq: 4, playerId: 'peer', type: 'raise', to: 20 });
  r.hand.actionSeq = 4; r.hand.currentBet = 20; r.players[1].bet = 20;
  turn(r);
  assert.equal(c.update(r, context({ visible: false })), selected);
  assert.equal(c.consume(r, context({ connected: false })), null);
  assert.equal(c.update(r, context()), null); assert.equal(c.consume(r, context()), null);
  assert.equal(r.players[0].bet, 10); assert.equal(r.players[0].stack, 995);
});

test('every new own betting action clears retained intent while opponent actions and non-betting entries preserve it', () => {
  for (const type of ['fold', 'check', 'call', 'bet', 'raise', 'allin']) {
    const r = room(), c = createPreActions(); c.toggle('check-fold', r, context());
    r.hand.log.push({ seq: 3, playerId: 'hero', type });
    assert.equal(c.update(r, context()), null, type);
  }
  const r = room(), c = createPreActions();
  r.hand.log.push({ seq: 3, playerId: 'hero', type: 'check' });
  const selected = c.toggle('check-fold', r, context());
  r.hand.log.push({ seq: 4, playerId: 'peer', type: 'raise' }, { seq: 5, playerId: 'hero', type: 'timebank' });
  assert.equal(c.update(r, context()), selected);
  r.hand.log.push({ seq: 6, playerId: 'hero', type: 'check' });
  assert.equal(c.update(r, context()), null);
});

test('a tracked full log cannot disappear or lose own action history; legacy fixtures without a log still work', () => {
  for (const alter of [r => delete r.hand.log, r => { r.hand.log = []; }]) {
    const r = room(), c = createPreActions(); r.hand.log.push({ seq: 3, playerId: 'hero', type: 'check' });
    c.toggle('check-fold', r, context()); alter(r);
    assert.equal(c.update(r, context({ resync: true }))?.kind, 'check-fold');
    assert.equal(c.update(r, context()), null);
  }
  const r = room(), c = createPreActions(); delete r.hand.log;
  c.toggle('call-current', r, context()); turn(r);
  assert.deepEqual(c.consume(r, context()), { type: 'call' });
});

test('hand, street, room, account, participation and presentation changes clear both kinds of intent', () => {
  const changes = [r => r.hand.id = 'next', r => r.hand.street = 'flop', r => r.code = 'other', r => r.meId = 'peer',
    r => r.hand.status = 'complete', r => r.status = 'closed', r => r.hand.transition = { kind: 'street' },
    r => r.hand.runout = { active: true }, r => r.players[0].folded = true, r => r.players[0].allIn = true,
    r => r.players[0].inHand = false, r => r.players[0].seat = null, r => r.players[0].sittingOut = true,
    r => r.players[0].leftRoom = true, r => r.players[0].pendingDeparture = 'leave', r => r.players[0].bet++, r => r.players[0].stack--];
  for (const kind of ['check-fold', 'call-current']) for (const change of changes) {
    const r = room(), c = createPreActions(); c.toggle(kind, r, context()); change(r);
    assert.equal(c.update(r, context()), null);
  }
});

test('mismatched action authorization cannot spend a different amount and consumes the obsolete intent', () => {
  for (const mutate of [r => r.actions.callAmount = 6, r => r.actions.callAmount = 5.5,
    r => r.actions.callAmount = NaN, r => r.actions.canCheck = true]) {
    const r = room(), c = createPreActions(); c.toggle('call-current', r, context()); turn(r); mutate(r);
    assert.equal(c.consume(r, context()), null); assert.equal(c.selection, null);
  }
});

test('malformed and unsafe chip values never enable a pre-action', () => {
  for (const value of [-1, 0.5, NaN, Infinity, '10', null, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ['currentBet', 'bet', 'stack']) {
      const r = room(); if (field === 'currentBet') r.hand.currentBet = value; else r.players[0][field] = value;
      assert.equal(preActionOptions(r).eligible, false, `${field}:${String(value)}`);
      assert.equal(createPreActions().toggle('call-current', r, context()), null);
    }
  }
  const r = room(); r.players[0].stack = Number.MAX_SAFE_INTEGER;
  assert.equal(preActionOptions(r).eligible, false);
  for (const value of [null, {}, { hand: {} }, { players: {} }, { players: [null] }]) assert.equal(preActionOptions(value).eligible, false);
});

test('a new selection is impossible during own turn or without safe foreground context', () => {
  const r = room(); turn(r);
  assert.equal(preActionOptions(r).eligible, false); assert.equal(createPreActions().toggle('check-fold', r, context()), null);
  for (const bad of [undefined, {}, context({ identity: null }), context({ visible: false }), context({ connected: false })]) {
    assert.equal(createPreActions().toggle('check-fold', room(), bad), null);
  }
});
