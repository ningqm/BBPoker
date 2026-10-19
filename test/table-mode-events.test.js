import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableModeTracker, TABLE_MODE_OPENING_MS, TABLE_MODE_RESULT_MS, SQUID_RESULT_DELAY_MS } from '../public/table-mode-events.js';

const T = Date.parse('2026-10-16T04:00:00Z');
const clone = value => structuredClone(value);
function room({ revision = 1, handNumber = 0, at = T, bomb = false, mode = 'normal', round = 0, active = false } = {}) {
  return {
    code: '123456', meId: 'me', status: handNumber ? 'playing' : 'waiting',
    revision, serverTime: at, settings: { bigBlind: 10 },
    mini: { squid: { active, round, roundSettlementId: round ? `q${round}` : null,
      participants: ['me', 'b', 'c'], mode, tokenBudget: mode === 'unlimited' ? 6 : 2,
      unit: 20, counts: { me: 0, b: 0, c: 0 }, lastResult: null } },
    hand: handNumber ? { id: `h${handNumber}`, number: handNumber, status: 'playing',
      at: new Date(at).toISOString(), actionReadyAt: at + 1100, actionSeq: 2,
      log: [{ seq: 1, type: bomb ? 'ante' : 'smallBlind' }, { seq: 2, type: bomb ? 'ante' : 'bigBlind' }],
      bombPot: bomb, ante: bomb ? 20 : 0 } : null,
  };
}
function settled(base, { at = T + 10000, reason = 'normal' } = {}) {
  const r = clone(base); r.revision++; r.serverTime = at; r.status = 'waiting';
  r.hand.status = 'complete'; r.mini.squid.active = false;
  r.mini.squid.lastResult = { roundSettlementId: `q${r.mini.squid.round}`,
    round: r.mini.squid.round, handId: r.hand.id, settledAt: new Date(at).toISOString(), reason,
    mode: r.mini.squid.mode, unit: 20, tokenBudget: r.mini.squid.tokenBudget, tokensAwarded: 2,
    winnerIds: ['me', 'b'], loserIds: ['c'], amount: 40, changes: { me: 20, b: 20, c: -40 } };
  return r;
}
const types = events => events.map(event => event.type);

test('first visit and refresh baseline do not announce existing modes or results', () => {
  for (const initial of [room(), room({ handNumber: 1, bomb: true, active: true, round: 1 }),
    settled(room({ handNumber: 1, active: true, round: 1 }))]) {
    const tracker = createTableModeTracker();
    assert.deepEqual(tracker.update(initial, { now: initial.serverTime }), []);
    tracker.reset();
    assert.deepEqual(tracker.update(initial, { now: initial.serverTime }), []);
  }
});

test('bomb opening uses only existing deal window and carries the real ante', () => {
  const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
  const dealt = room({ revision: 2, handNumber: 1, bomb: true });
  const events = tracker.update(dealt, { now: T + 100 });
  assert.deepEqual(types(events), ['bomb-start']);
  assert.deepEqual(events[0], { id: '123456:me:bomb-start:h1', type: 'bomb-start',
    at: T, until: T + TABLE_MODE_OPENING_MS, handId: 'h1', ante: 20, bigBlind: 10 });
  assert.deepEqual(tracker.update({ ...dealt, revision: 3 }, { now: T + 200 }), []);
});

test('normal and unlimited squid round openings preserve configured fish count', () => {
  for (const mode of ['normal', 'unlimited']) {
    const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
    const dealt = room({ revision: 2, handNumber: 1, active: true, round: 1, mode });
    const [event] = tracker.update(dealt, { now: T });
    assert.equal(event.type, 'squid-start'); assert.equal(event.mode, mode);
    assert.equal(event.round, 1); assert.equal(event.participantCount, 3);
    assert.equal(event.tokenBudget, mode === 'unlimited' ? 6 : 2);
    assert.equal(event.unit, 20); assert.equal(event.until, T + 1100);
  }
});

test('simultaneous squid and bomb beginnings are both returned for one compact rendering', () => {
  const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
  const events = tracker.update(room({ revision: 2, handNumber: 1, active: true, round: 1, mode: 'unlimited', bomb: true }), { now: T });
  assert.deepEqual(types(events), ['bomb-start', 'squid-start']);
  assert.equal(events[0].until, events[1].until);
});

test('squid end uses authoritative deltas and remains shorter than the result hold', () => {
  const playing = room({ handNumber: 1, active: true, round: 1 });
  const tracker = createTableModeTracker(); tracker.update(playing, { now: T });
  const end = settled(playing), [event] = tracker.update(end, { now: end.serverTime });
  assert.equal(event.type, 'squid-end'); assert.equal(event.at, end.serverTime + SQUID_RESULT_DELAY_MS);
  assert.equal(event.until, end.serverTime + SQUID_RESULT_DELAY_MS + TABLE_MODE_RESULT_MS);
  assert.equal(event.ownDelta, 20); assert.equal(event.amount, 40);
  assert.equal(event.tokensAwarded, 2); assert.equal(event.participantCount, 3);
  assert.ok(event.until - event.at < 5000);
});

test('a combined next-round snapshot still reports a new lastResult even while squid is active', () => {
  const playing = room({ handNumber: 1, active: true, round: 1, mode: 'unlimited' });
  const tracker = createTableModeTracker(); tracker.update(playing, { now: T });
  const next = room({ revision: 3, handNumber: 2, at: T + 11000, active: true, round: 2, mode: 'unlimited', bomb: true });
  next.mini.squid.lastResult = settled(playing).mini.squid.lastResult;
  const events = tracker.update(next, { now: T + 11000 });
  assert.deepEqual(types(events), ['squid-end', 'bomb-start', 'squid-start']);
  assert.equal(events[0].round, 1); assert.equal(events[2].round, 2);
});

test('an old lastResult does not replay when the next round starts', () => {
  const playing = room({ handNumber: 1, active: true, round: 1 });
  const tracker = createTableModeTracker(); tracker.update(playing, { now: T });
  const end = settled(playing); tracker.update(end, { now: end.serverTime });
  const next = room({ revision: 3, handNumber: 2, at: T + 15000, active: true, round: 2 });
  next.mini.squid.lastResult = end.mini.squid.lastResult;
  assert.deepEqual(types(tracker.update(next, { now: next.serverTime })), ['squid-start']);
});

test('expired unseen result is dropped instead of queued over the new hand', () => {
  const playing = room({ handNumber: 1, active: true, round: 1 });
  const tracker = createTableModeTracker(); tracker.update(playing, { now: T });
  const next = room({ revision: 3, handNumber: 2, at: T + 15000, active: true, round: 2 });
  next.mini.squid.lastResult = settled(playing).mini.squid.lastResult;
  assert.deepEqual(types(tracker.update(next, { now: next.serverTime })), ['squid-start']);
});

test('manual, absent and close-room settlements are announced once', () => {
  for (const reason of ['partial', 'absent', 'forfeit']) {
    const playing = room({ handNumber: 1, active: true, round: 1 });
    const tracker = createTableModeTracker(); tracker.update(playing, { now: T });
    const end = settled(playing, { reason }); if (reason === 'partial') end.status = 'closed';
    assert.deepEqual(types(tracker.update(end, { now: end.serverTime })), ['squid-end']);
    assert.deepEqual(tracker.update(end, { now: end.serverTime + 100 }), []);
  }
});

test('chat, topups, fish awards and mid-round admissions do not replay a mode opening', () => {
  const playing = room({ handNumber: 1, active: true, round: 1, bomb: true });
  const tracker = createTableModeTracker(); tracker.update(playing, { now: T });
  const changed = clone(playing); changed.revision++;
  changed.chat = [{ text: 'hello' }]; changed.players = [{ id: 'me', pendingBuyIn: 1000 }];
  changed.mini.squid.participants.push('d'); changed.mini.squid.tokenBudget++;
  changed.mini.squid.counts.me = 1;
  assert.deepEqual(tracker.update(changed, { now: T + 200 }), []);
});

test('room and account changes rebaseline without leaking old mode events', () => {
  for (const field of ['code', 'meId']) {
    const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
    const next = room({ revision: 2, handNumber: 1, active: true, round: 1, bomb: true });
    next[field] = 'different';
    assert.deepEqual(tracker.update(next, { now: T }), []);
  }
});

test('hidden, disconnected, non-live and disabled states consume events without replay on return', () => {
  for (const key of ['visible', 'connected', 'live', 'enabled']) {
    const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
    const first = room({ revision: 2, handNumber: 1, active: true, round: 1, bomb: true });
    assert.deepEqual(tracker.update(first, { [key]: false, now: T }), []);
    const restored = settled(first, { at: T + 1000 });
    assert.deepEqual(tracker.update(restored, { now: T + 1000 }), []);
    const newRound = room({ revision: 4, handNumber: 2, at: T + 6000, active: true, round: 2 });
    newRound.mini.squid.lastResult = restored.mini.squid.lastResult;
    assert.deepEqual(types(tracker.update(newRound, { now: T + 6000 })), ['squid-start']);
  }
});

test('explicit reconnect consumes the fresh snapshot and never replays it', () => {
  const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
  const next = room({ revision: 2, handNumber: 1, active: true, round: 1, bomb: true });
  assert.deepEqual(tracker.update(next, { now: T, reconnected: true }), []);
  assert.deepEqual(tracker.update(next, { now: T + 100 }), []);
});

test('stale, already acted, future and missing-timestamp deals are quiet', () => {
  for (const mutate of [r => { r.hand.at = new Date(T - 1100).toISOString(); },
    r => { r.hand.log.push({ seq: 3, type: 'check' }); r.hand.actionSeq++; },
    r => { r.hand.at = new Date(T + 1).toISOString(); },
    r => { delete r.hand.at; }, r => { delete r.hand.log; },
    r => { r.hand.actionReadyAt = T; }]) {
    const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
    const next = room({ revision: 2, handNumber: 1, bomb: true, active: true, round: 1 });
    mutate(next); assert.deepEqual(tracker.update(next, { now: T }), []);
  }
});

test('a bomb where all ante stacks are all-in can announce without an acting-player deadline', () => {
  const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
  const next = room({ revision: 2, handNumber: 1, bomb: true });
  next.hand.actionReadyAt = null; next.hand.runout = { active: true };
  assert.deepEqual(types(tracker.update(next, { now: T })), ['bomb-start']);
});

test('skipped hands and skipped squid rounds are restored without imagined openings', () => {
  const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
  assert.deepEqual(tracker.update(room({ revision: 10, handNumber: 5, bomb: true, active: true, round: 3 }), { now: T }), []);
  const next = room({ revision: 11, handNumber: 6, at: T + 100, active: true, round: 5 });
  assert.deepEqual(tracker.update(next, { now: T + 100 }), []);
});

test('older revisions, hands and logs never replace the current baseline or duplicate an opening', () => {
  const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
  const next = room({ revision: 3, handNumber: 1, bomb: true, active: true, round: 1 });
  assert.equal(tracker.update(next, { now: T }).length, 2);
  assert.deepEqual(tracker.update(room({ revision: 2 }), { now: T + 1 }), []);
  assert.deepEqual(tracker.update(next, { now: T + 2 }), []);
  const stale = clone(next); stale.revision = 4; stale.hand.actionSeq = 1;
  assert.deepEqual(tracker.update(stale, { now: T + 3 }), []);
  assert.deepEqual(tracker.update({ ...next, revision: 5 }, { now: T + 4 }), []);
});

test('transport-stale frames, malformed identities and invalid clocks never animate', () => {
  const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
  const next = room({ revision: 2, handNumber: 1, active: true, round: 1, bomb: true });
  next.serverTime = T - 5001;
  assert.deepEqual(tracker.update(next, { now: T }), []);
  assert.deepEqual(tracker.update(null), []);
  assert.deepEqual(tracker.update({ ...next, meId: null }), []);
  tracker.update(room(), { now: T });
  assert.deepEqual(tracker.update(next, { now: NaN }), []);
});

test('tracker does not mutate room, copy private fields or retain an emitted event by reference', () => {
  const tracker = createTableModeTracker(); tracker.update(room(), { now: T });
  const next = room({ revision: 2, handNumber: 1, active: true, round: 1, bomb: true });
  next.invite = 'secret-invite'; next.hand.deck = ['secret-deck'];
  next.players = [{ name: 'private-name', cards: ['secret-cards'], token: 'secret-token' }];
  const before = clone(next), events = tracker.update(next, { now: T });
  assert.deepEqual(next, before);
  assert.doesNotMatch(JSON.stringify(events), /secret|private-name|deck|cards|token"/);
  events[0].id = 'modified-consumer-value';
  assert.deepEqual(tracker.update(next, { now: T + 100 }), []);
});

test('spectator receives no own-result marker; an actual zero-net participant still receives zero', () => {
  const first = room({ handNumber: 1, active: true, round: 1 });
  const tracker = createTableModeTracker(); tracker.update(first, { now: T });
  const end = settled(first); delete end.mini.squid.lastResult.changes.me;
  assert.equal(tracker.update(end, { now: end.serverTime })[0].ownDelta, null);
  const another = createTableModeTracker(); another.update(first, { now: T });
  end.mini.squid.lastResult.changes.me = 0;
  assert.equal(another.update(end, { now: end.serverTime })[0].ownDelta, 0);
});
