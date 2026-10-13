import test from 'node:test';
import assert from 'node:assert/strict';
import { raiseFromSlider, sliderFromRaise, createTableFeedback, createTableSounds } from '../public/table-feedback.js';

test('nonlinear raise slider is bounded, monotonic and exact at both endpoints', () => {
  for (const [min, max, bb] of [[20, 2000, 10], [2000, 1000000000, 1000], [20, 21, 10], [0, 0, 1], [10, 10, 10], [3, 17, 1]]) {
    assert.equal(raiseFromSlider(0, min, max, bb), min);
    assert.equal(raiseFromSlider(1000, min, max, bb), max);
    assert.equal(raiseFromSlider(-200, min, max, bb), min);
    assert.equal(raiseFromSlider(1200, min, max, bb), max);
    let last = min;
    for (let step = 0; step <= 1000; step++) {
      const amount = raiseFromSlider(step, min, max, bb);
      assert.ok(Number.isSafeInteger(amount) && amount >= last && amount <= max);
      const position = sliderFromRaise(amount, min, max, bb);
      assert.ok(position >= 0 && position <= 1000);
      const lower = raiseFromSlider(position - 1, min, max, bb);
      const upper = raiseFromSlider(position + 1, min, max, bb);
      assert.ok(amount >= lower && amount <= upper, `${amount} remains in its slider bin`);
      last = amount;
    }
  }
});

test('raise slider retains small-bet precision before accelerating, and exact manual amounts survive mapping', () => {
  const settings = [20, 2000, 10];
  assert.ok(raiseFromSlider(100, ...settings) - 20 < 10);
  assert.ok(raiseFromSlider(1000, ...settings) - raiseFromSlider(900, ...settings) > 500);
  const manualAmount = 731;
  assert.ok(Number.isInteger(sliderFromRaise(manualAmount, ...settings)));
  assert.equal(manualAmount, 731);
  assert.equal(sliderFromRaise(20, ...settings), 0);
  assert.equal(sliderFromRaise(2000, ...settings), 1000);
  assert.equal(raiseFromSlider(NaN, ...settings), 20);
  assert.equal(sliderFromRaise(NaN, ...settings), 0);
  assert.equal(raiseFromSlider(500, 10, 9, 0), 10);
});

const blindLog = [{ seq: 1, type: 'smallBlind', playerId: 'a', amount: 5 }, { seq: 2, type: 'bigBlind', playerId: 'b', amount: 10 }];
function room({ code = '123456', meId = 'a', revision = 1, handId = 'h1', number = 1,
  log = blindLog, actor = 'a', status = 'playing', board = [], result = null } = {}) {
  return { code, meId, revision, hand: handId === null ? null : {
    id: handId, number, actionSeq: log.length, log: structuredClone(log), actingId: actor,
    status, board, result,
  } };
}
const quiet = tracker => assert.deepEqual(tracker, { animations: [], sound: null });

test('feedback ignores initial snapshots, duplicate SSE, chat/profile noise and stale frames', () => {
  const tracker = createTableFeedback();
  quiet(tracker.update(room()));
  quiet(tracker.update(room()));
  quiet(tracker.update({ ...room({ revision: 2 }), chat: [{ id: 'message' }], players: [{ id: 'a', name: 'renamed' }] }));
  const raised = room({ revision: 3, actor: 'b', log: [...blindLog, { seq: 3, type: 'raise', playerId: 'a', amount: 15, to: 20 }] });
  const response = tracker.update(raised);
  assert.equal(response.sound, 'chip');
  assert.deepEqual(response.animations, [{ type: 'action', playerId: 'a', action: 'raise', seq: 3 }, { type: 'turn', playerId: 'b' }]);
  quiet(tracker.update(room({ revision: 1 })));
  quiet(tracker.update(raised));
});

test('feedback detects consecutive actions with the same actor from their new sequence', () => {
  const tracker = createTableFeedback();
  tracker.update(room());
  const checked = [...blindLog, { seq: 3, type: 'check', playerId: 'a' }];
  assert.equal(tracker.update(room({ revision: 2, log: checked })).sound, 'check');
  assert.equal(tracker.update(room({ revision: 3, log: [...checked, { seq: 4, type: 'raise', playerId: 'a', amount: 20 }] })).sound, 'chip');
});

test('board and winner cues combine meaningful animations but select only one sound', () => {
  const tracker = createTableFeedback();
  tracker.update(room({ actor: 'b' }));
  const log = [...blindLog, { seq: 3, type: 'call', playerId: 'b', amount: 5 }, { seq: 4, type: 'street', street: 'flop' }];
  const board = ['Ac', 'Kd', '2s'];
  const next = tracker.update(room({ revision: 2, log, board, actor: 'a' }));
  assert.equal(next.sound, 'yourturn');
  assert.deepEqual(next.animations.find(event => event.type === 'board'), { type: 'board', from: 0 });
  const end = tracker.update(room({ revision: 3, log: [...log, { seq: 5, type: 'fold', playerId: 'a' }, { seq: 6, type: 'payout', playerId: 'b', amount: 20 }], board, actor: null, status: 'complete', result: { mainWinnerIds: ['b'] } }));
  assert.equal(end.sound, 'win');
  assert.deepEqual(end.animations.at(-1), { type: 'win', playerIds: ['b'] });
});

test('only a fresh consecutive live hand is dealt; late joins, missed hands and log rewrites are quiet', () => {
  const tracker = createTableFeedback();
  tracker.update(room({ handId: null }));
  const dealt = tracker.update(room({ revision: 2 }));
  assert.equal(dealt.sound, 'deal');
  assert.equal(dealt.animations[0].type, 'deal');
  tracker.update(room({ revision: 3, status: 'complete', actor: null }));
  assert.equal(tracker.update(room({ handId: 'h2', number: 2, revision: 4 })).sound, 'deal');
  quiet(tracker.update(room({ handId: 'h4', number: 4, revision: 8 })));
  quiet(tracker.update(room({ handId: 'h4', number: 4, revision: 9, log: [{ ...blindLog[0], amount: 99 }, blindLog[1], { seq: 3, type: 'raise', playerId: 'a' }] })));
  quiet(tracker.update(room({ code: '654321' })));
  quiet(tracker.update(room({ code: '654321', meId: 'b', revision: 2 })));
});

test('reconnect, hidden updates and the first visible restore never replay old sounds', () => {
  const tracker = createTableFeedback();
  tracker.update(room());
  const log = [...blindLog, { seq: 3, type: 'check', playerId: 'a' }];
  quiet(tracker.update(room({ revision: 2, log }), { reconnected: true }));
  log.push({ seq: 4, type: 'check', playerId: 'b' });
  quiet(tracker.update(room({ revision: 3, log }), { visible: false }));
  log.push({ seq: 5, type: 'check', playerId: 'a' });
  quiet(tracker.update(room({ revision: 4, log })));
  log.push({ seq: 6, type: 'check', playerId: 'b' });
  assert.equal(tracker.update(room({ revision: 5, log })).sound, 'check');
  tracker.reset();
  quiet(tracker.update(room({ revision: 5, log })));
  log.push({ seq: 7, type: 'raise', playerId: 'a' });
  quiet(tracker.update(room({ revision: 6, log }), { live: false }));
  quiet(tracker.update(room({ revision: 6, log })));
});

test('invalid or rolled back action sequences do not produce feedback', () => {
  const tracker = createTableFeedback();
  tracker.update(room());
  const invalid = room({ revision: 2, log: [...blindLog, { seq: 8, type: 'raise', playerId: 'a' }] });
  quiet(tracker.update(invalid));
  const mismatch = room({ revision: 3 }); mismatch.hand.actionSeq = 7;
  quiet(tracker.update(mismatch));
  quiet(tracker.update(null));
  quiet(tracker.update(room()));
});

function audioFixture() {
  const stats = { created: 0, started: 0, stopped: 0, disconnected: 0, suspended: 0, closed: 0 };
  const listeners = new Map();
  const doc = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  class AudioContext {
    constructor() { stats.created++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() { this.state = 'running'; }
    async suspend() { stats.suspended++; this.state = 'suspended'; }
    async close() { stats.closed++; this.state = 'closed'; }
    createOscillator() { return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() { stats.disconnected++; }, start() { stats.started++; }, stop() { stats.stopped++; } }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() { stats.disconnected++; } }; }
  }
  return { stats, doc, AudioContext, listeners };
}

test('sounds require an explicit gesture unlock and enabled preference; hidden sounds stop without queuing', async () => {
  const fixture = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ AudioContext: fixture.AudioContext, document: fixture.doc, now: () => now });
  assert.equal(sounds.play('deal'), false);
  assert.equal(await sounds.unlock(), false);
  assert.equal(fixture.stats.created, 0);
  sounds.setEnabled(true);
  assert.equal(sounds.play('deal'), false);
  assert.equal(await sounds.unlock(), true);
  assert.equal(sounds.play('deal'), true);
  assert.equal(sounds.play('win'), false, 'rapid duplicate is not stacked');
  now += 200;
  assert.equal(sounds.play('chip'), true);
  fixture.doc.visibilityState = 'hidden'; fixture.listeners.get('visibilitychange')();
  assert.equal(sounds.play('win'), false);
  assert.ok(fixture.stats.suspended && fixture.stats.disconnected);
  fixture.doc.visibilityState = 'visible'; now += 1000;
  assert.equal(sounds.play('yourturn'), false, 'returning to foreground is not an audio gesture');
  assert.equal(await sounds.unlock(), true);
  assert.equal(sounds.play('yourturn'), true);
  sounds.setEnabled(false); now += 200;
  assert.equal(sounds.play('check'), false);
  sounds.dispose();
  assert.equal(fixture.stats.closed, 1);
  assert.equal(fixture.listeners.size, 0);
  sounds.setEnabled(true);
  assert.equal(await sounds.unlock(), false);
});

test('unsupported or blocked Web Audio and an interrupted unlock fail quietly', async () => {
  const unsupported = createTableSounds({ enabled: true, AudioContext: null });
  assert.equal(await unsupported.unlock(), false);
  assert.equal(unsupported.play('deal'), false);
  unsupported.dispose();
  const fixture = audioFixture();
  class BlockedContext extends fixture.AudioContext { async resume() { throw new Error('gesture required'); } }
  const blocked = createTableSounds({ enabled: true, AudioContext: BlockedContext });
  assert.equal(await blocked.unlock(), false);
  assert.equal(blocked.play('deal'), false);
  blocked.dispose();
  let resume;
  class DelayedContext extends fixture.AudioContext { resume() { return new Promise(resolve => { resume = () => { this.state = 'running'; resolve(); }; }); } }
  const delayed = createTableSounds({ enabled: true, AudioContext: DelayedContext });
  const pending = delayed.unlock();
  delayed.setEnabled(false); resume();
  assert.equal(await pending, false);
  assert.equal(delayed.play('deal'), false);
  delayed.dispose();
});
