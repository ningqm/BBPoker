import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTableFeedback, createTableSounds, createTurnCountdown, TABLE_VOICE_CUES } from '../public/table-feedback.js';

const blinds = [{ seq: 1, type: 'smallBlind', playerId: 'a', amount: 5, street: 'preflop' }, { seq: 2, type: 'bigBlind', playerId: 'b', amount: 10, street: 'preflop' }];
function frame({ log = blinds, seq = 1, actor = 'a', deadline = 30000, status = 'playing', allIn = [] } = {}) {
  return { code: '123456', meId: 'a', revision: seq, deadline, players: ['a', 'b'].map(id => ({ id, allIn: allIn.includes(id) })), hand: {
    id: 'h1', number: 1, actionSeq: log.length, status, log, actingId: actor,
    board: [],
  } };
}

test('spoken cues distinguish first bet, raise and reraise by betting street, with no blind announcements', () => {
  const tracker = createTableFeedback(); let log = [...blinds], seq = 1;
  assert.equal(tracker.update(frame()).speech, undefined);
  const action = (event, speech) => {
    log = [...log, { seq: log.length + 1, playerId: 'a', ...event }];
    assert.equal(tracker.update(frame({ log, seq: ++seq })).speech, speech);
  };
  action({ type: 'raise', to: 30, street: 'preflop' }, 'raise');
  action({ type: 'raise', to: 90, street: 'preflop' }, 'reraise');
  action({ type: 'street', street: 'flop' }, undefined);
  action({ type: 'raise', to: 40, street: 'flop' }, 'bet');
  action({ type: 'raise', to: 120, street: 'flop' }, 'raise');
  action({ type: 'raise', to: 300, street: 'flop' }, 'reraise');
  action({ type: 'street', street: 'turn' }, undefined);
  action({ type: 'check', street: 'turn' }, 'check');
  action({ type: 'raise', to: 150, street: 'turn' }, 'bet');
  action({ type: 'call', amount: 150, street: 'turn' }, 'call');
  action({ type: 'fold', street: 'turn' }, 'fold');
});

test('all-in calls are announced as all-in without counting as an extra raise; latest live action wins', () => {
  const tracker = createTableFeedback(); tracker.update(frame());
  const base = [...blinds, { seq: 3, type: 'street', street: 'flop' }, { seq: 4, type: 'raise', street: 'flop', playerId: 'a', to: 20 }];
  tracker.update(frame({ log: base, seq: 2 }));
  const called = [...base, { seq: 5, type: 'call', street: 'flop', playerId: 'b', amount: 10 }];
  const shortCall = tracker.update(frame({ log: called, seq: 3, allIn: ['b'] }));
  assert.equal(shortCall.speech, 'allin'); assert.equal(shortCall.chips, true);
  const log = [...called, { seq: 6, type: 'allin', street: 'flop', playerId: 'b', amount: 2, isRaise: false }, { seq: 7, type: 'raise', street: 'flop', playerId: 'a', to: 40 }];
  assert.equal(tracker.update(frame({ log, seq: 4, allIn: ['b'] })).speech, 'raise');
});

test('chips remain audible when an action also advances the board, changes the actor or pays a winner', () => {
  const tracker = createTableFeedback(); tracker.update(frame({ actor: 'b' }));
  const log = [...blinds, { seq: 3, type: 'call', playerId: 'b', amount: 5 }, { seq: 4, type: 'street', street: 'flop' }];
  const next = frame({ log, seq: 2 }); next.hand.board = ['As', 'Kd', '2h'];
  const cues = tracker.update(next);
  assert.equal(cues.sound, 'yourturn'); assert.equal(cues.chips, true); assert.equal(cues.speech, 'call');
  const complete = frame({ log: [...log, { seq: 5, type: 'allin', playerId: 'a' }], seq: 3, actor: null, status: 'complete' });
  assert.equal(tracker.update(complete).speech, 'allin');
  assert.equal(tracker.update(complete).speech, undefined, 'same snapshot cannot repeat speech');
});

test('restored, hidden, stale and log-rewritten states cannot announce past actions', () => {
  const tracker = createTableFeedback(); tracker.update(frame());
  const log = [...blinds, { seq: 3, type: 'raise', playerId: 'a', to: 30 }];
  assert.equal(tracker.update(frame({ log, seq: 2 }), { reconnected: true }).speech, undefined);
  assert.equal(tracker.update(frame({ log, seq: 1 })).speech, undefined);
  log.push({ seq: 4, type: 'fold', playerId: 'b' });
  assert.equal(tracker.update(frame({ log, seq: 3 }), { visible: false }).speech, undefined);
  log.push({ seq: 5, type: 'check', playerId: 'a' });
  assert.equal(tracker.update(frame({ log, seq: 4 })).speech, undefined);
  const changed = log.map(event => event.seq === 3 ? { ...event, isRaise: false } : event);
  changed.push({ seq: 6, type: 'check', playerId: 'b' });
  assert.equal(tracker.update(frame({ log: changed, seq: 5 })).speech, undefined);
});

test('own-turn warning ticks exactly once per remaining second from seven through one, then stops', () => {
  const tracker = createTurnCountdown(), room = frame();
  assert.deepEqual(tracker.update(room, { now: 22000 }), { remaining: 8, urgent: false, sound: null });
  for (let remaining = 7; remaining >= 1; remaining--) {
    const now = 30000 - remaining * 1000;
    const result = tracker.update(room, { now });
    assert.equal(result.urgent, true); assert.equal(result.remaining, remaining);
    assert.equal(result.sound, remaining <= 3 ? 'countdown-last' : 'countdown');
    assert.equal(tracker.update(room, { now: now + 200 }).sound, null);
  }
  assert.deepEqual(tracker.update(room, { now: 30000 }), { remaining: 0, urgent: false, sound: null });
  assert.deepEqual(tracker.update(frame({ actor: 'b' }), { now: 27000 }), { remaining: null, urgent: false, sound: null });
  assert.deepEqual(tracker.update(frame({ status: 'complete' }), { now: 27000 }), { remaining: null, urgent: false, sound: null });
});

test('countdown foreground and reconnect use silent baselines, no replay of skipped seconds; time-bank resets', () => {
  const tracker = createTurnCountdown(), room = frame();
  assert.equal(tracker.update(room, { now: 23000 }).sound, null, 'first state is silent');
  assert.equal(tracker.update(room, { now: 24000 }).sound, 'countdown');
  assert.deepEqual(tracker.update(room, { now: 25000, visible: false }), { remaining: 5, urgent: false, sound: null });
  assert.equal(tracker.update(room, { now: 27000 }).sound, null, 'return is not a catch-up cue');
  assert.equal(tracker.update(room, { now: 28000 }).sound, 'countdown-last');
  const extended = frame({ deadline: 60000 });
  assert.equal(tracker.update(extended, { now: 28100 }).urgent, false);
  assert.equal(tracker.update(extended, { now: 53000 }).sound, 'countdown');
  assert.equal(tracker.update(extended, { now: 54000, connected: false }).sound, null);
  assert.equal(tracker.update(extended, { now: 55000, reconnected: true }).sound, null);
  assert.equal(tracker.update(extended, { now: 56000 }).sound, null);
  assert.equal(tracker.update(extended, { now: 57000 }).sound, 'countdown-last');
  tracker.reset(); assert.equal(tracker.update(extended, { now: 58000 }).sound, null);
  assert.equal(tracker.update(extended, { now: 59000, live: false }).urgent, false);
});

test('server-clock corrections and repeated renders cannot repeat an already sounded second', () => {
  const tracker = createTurnCountdown(), room = frame();
  tracker.update(room, { now: 22000 });
  assert.equal(tracker.update(room, { now: 23000 }).sound, 'countdown');
  assert.equal(tracker.update(room, { now: 22200 }).sound, null);
  assert.equal(tracker.update(room, { now: 23000 }).sound, null);
  assert.equal(tracker.update(room, { now: 24000 }).sound, 'countdown');
});

function audioFixture({ fetchOk = true, fetchDelay = null } = {}) {
  const stats = { sources: [], oscillators: [], requests: [], suspended: 0, closed: 0 }, listeners = new Map();
  const doc = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sampleRate = 22050; }
    async resume() { this.state = 'running'; }
    async suspend() { stats.suspended++; this.state = 'suspended'; }
    async close() { stats.closed++; this.state = 'closed'; }
    createOscillator() { const node = { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} }; stats.oscillators.push(node); return node; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBuffer(channels, count, rate) { return { duration: count / rate, noise: true, getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { const node = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } }; stats.sources.push(node); return node; }
    async decodeAudioData(data) { return { duration: 0.4, cue: TABLE_VOICE_CUES[new Uint8Array(data)[0]] }; }
  }
  const fetcher = async (url, options) => {
    stats.requests.push({ url: String(url), options });
    if (fetchDelay) await fetchDelay;
    const type = String(url).split('/').at(-1).replace('.wav', '');
    return { ok: fetchOk, arrayBuffer: async () => new Uint8Array([TABLE_VOICE_CUES.indexOf(type)]).buffer };
  };
  return { stats, doc, listeners, AudioContext, fetcher };
}

test('short voice clips are same-origin, warmed by gesture and never queue stale speech while loading', async () => {
  let done; const loading = new Promise(resolve => { done = resolve; });
  const fixture = audioFixture({ fetchDelay: loading });
  const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher });
  assert.equal(sounds.speak('fold'), false); assert.equal(fixture.stats.requests.length, 0);
  await sounds.unlock(); const pending = sounds.preloadVoices();
  assert.equal(sounds.speak('fold'), false);
  done(); assert.equal(await pending, true);
  assert.equal(fixture.stats.sources.length, 0, 'resource completion must not play the missed action');
  assert.equal(sounds.speak('raise'), true);
  assert.equal(fixture.stats.sources.at(-1).buffer.cue, 'raise');
  assert.equal(fixture.stats.requests.length, 7);
  for (const { url, options } of fixture.stats.requests) {
    assert.match(url, /\/public\/audio\/(bet|raise|reraise|call|check|fold|allin)\.wav$/);
    assert.equal(options.credentials, 'omit');
  }
  sounds.dispose();
});

test('new action replaces speech; timer sounds do not cancel voice; voice-off retains chip effects', async () => {
  const fixture = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher, now: () => now });
  await sounds.unlock(); await sounds.preloadVoices();
  sounds.playFeedback({ sound: 'yourturn', chips: true, speech: 'call' });
  const firstVoice = fixture.stats.sources.find(source => source.buffer.cue === 'call');
  assert.ok(firstVoice.started); assert.equal(fixture.stats.sources.filter(source => source.buffer.noise).length, 4);
  now += 1000; sounds.play('countdown'); assert.equal(firstVoice.stopped, undefined, 'timer cue coexists with short speech');
  sounds.speak('raise'); assert.equal(firstVoice.stopped, true);
  const secondVoice = fixture.stats.sources.at(-1); assert.equal(secondVoice.buffer.cue, 'raise');
  sounds.setVoiceEnabled(false); assert.equal(secondVoice.stopped, true);
  assert.equal(sounds.speak('allin'), false);
  now += 200; assert.equal(sounds.playFeedback({ sound: 'chip', chips: true, speech: 'raise' }), true);
  sounds.setEnabled(false); assert.equal(sounds.playFeedback({ sound: 'chip', speech: 'raise' }), false);
  sounds.dispose();
});

test('hidden, disabled, disposed and unavailable voice output are silent without blocking ordinary effects', async () => {
  const fixture = audioFixture(); const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher });
  await sounds.unlock(); await sounds.preloadVoices(); assert.equal(sounds.speak('fold'), true);
  const source = fixture.stats.sources.at(-1);
  fixture.doc.visibilityState = 'hidden'; fixture.listeners.get('visibilitychange')();
  assert.equal(source.stopped, true); assert.equal(sounds.speak('call'), false);
  fixture.doc.visibilityState = 'visible'; assert.equal(sounds.speak('call'), false, 'foreground without a new gesture cannot resume old audio');
  await sounds.unlock(); assert.equal(sounds.speak('call'), true);
  sounds.dispose(); assert.equal(sounds.speak('call'), false); assert.equal(fixture.listeners.size, 0);
  const failed = audioFixture({ fetchOk: false });
  const fallback = createTableSounds({ enabled: true, AudioContext: failed.AudioContext, document: failed.doc, fetch: failed.fetcher });
  await fallback.unlock(); assert.equal(await fallback.preloadVoices(), false);
  assert.equal(fallback.playFeedback({ sound: 'chip', speech: 'raise' }), true);
  assert.equal(failed.stats.sources.some(node => node.buffer.cue), false); fallback.dispose();
});

test('bundled recorded cues are short mono PCM WAV with real non-silent audio', () => {
  let total = 0;
  for (const type of TABLE_VOICE_CUES) {
    const data = readFileSync(new URL(`../public/audio/${type}.wav`, import.meta.url)); total += data.length;
    assert.equal(data.toString('ascii', 0, 4), 'RIFF'); assert.equal(data.toString('ascii', 8, 12), 'WAVE');
    assert.equal(data.readUInt16LE(20), 1); assert.equal(data.readUInt16LE(22), 1);
    const rate = data.readUInt32LE(24); assert.equal(data.readUInt16LE(34), 16);
    assert.equal(data.toString('ascii', 36, 40), 'data'); const count = data.readUInt32LE(40) / 2;
    assert.ok(count / rate >= 0.25 && count / rate <= 1, `${type} should be concise`);
    let peak = 0; for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(data.readInt16LE(44 + i * 2)));
    assert.ok(peak >= 10000 && peak < 32767, `${type} is audible without clipping`);
  }
  assert.ok(total < 150000, 'no oversized media payload for mobile players');
});
