import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTableFeedback, createTableSounds, createTurnCountdown, TABLE_VOICE_CUES, TABLE_VOICE_LABELS, TABLE_AUDIO_MIX } from '../public/table-feedback.js';

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
  assert.equal(cues.sound, 'board'); assert.equal(cues.chips, true); assert.equal(cues.speech, 'call');
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
    createGain() { const values = []; return { values, gain: { setValueAtTime(value) { values.push(value); }, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBuffer(channels, count, rate) { return { duration: count / rate, noise: true, getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { const node = { connect(gain) { this.gain = gain; }, disconnect() {}, start(at) { this.started = true; this.at = at; }, stop(at) { if (at === undefined) this.stopped = true; else this.stopAt = at; } }; stats.sources.push(node); return node; }
    async decodeAudioData(data) { const cue = ['chips', ...TABLE_VOICE_CUES][new Uint8Array(data)[0]]; return { duration: cue === 'chips' ? 0.929 : 0.4, cue }; }
  }
  const fetcher = async (url, options) => {
    stats.requests.push({ url: String(url), options });
    if (fetchDelay) await fetchDelay;
    const type = new URL(url).pathname.split('/').at(-1).replace('.wav', '');
    return { ok: fetchOk, arrayBuffer: async () => new Uint8Array([['chips', ...TABLE_VOICE_CUES].indexOf(type)]).buffer };
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
  assert.equal(fixture.stats.requests.length, 8);
  for (const { url, options } of fixture.stats.requests) {
    assert.match(url, /\/public\/audio\/(chips|bet|raise|reraise|call|check|fold|allin)\.wav\?v=[\w-]+$/);
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
  assert.ok(firstVoice.started); assert.equal(fixture.stats.sources.filter(source => source.buffer.cue === 'chips').length, 1);
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
  assert.equal(fallback.playFeedback({ sound: 'chip', speech: 'raise' }), false, 'missing files stay silent instead of replaying old synthetic clicks');
  assert.equal(fallback.play('check'), true, 'ordinary procedural notifications still work');
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
    assert.ok(count / rate >= 0.25 && count / rate <= 1.6, `${type} should be concise`);
    let peak = 0; for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(data.readInt16LE(44 + i * 2)));
    assert.ok(peak >= 10000 && peak <= 19661, `${type} retains headroom for louder chips`);
    let energy = 0; for (let i = 0; i < count; i++) energy += (data.readInt16LE(44 + i * 2) / 32768) ** 2;
    assert.ok(Math.sqrt(energy / count) >= 0.11 && Math.sqrt(energy / count) < 0.16, `${type} has a steady audible body`);
  }
  assert.ok(total < 400000, 'all seven voice files together stay below 400 KB');
});

test('selected chip push is played once, retains contact energy and ends without clipping', () => {
  const wav = readFileSync(new URL('../public/audio/chips.wav', import.meta.url));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16); assert.equal(wav.toString('ascii', 36, 40), 'data');
  const rate = wav.readUInt32LE(24), count = wav.readUInt32LE(40) / 2;
  assert.ok(count / rate >= 0.8 && count / rate <= 1.2, 'one short chip push, not the repeated audition');
  const samples = Array.from({ length: count }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
  const peak = Math.max(...samples.map(Math.abs));
  assert.ok(peak > 0.2 && peak < 0.95, 'audible headroom');
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  assert.ok(rms >= 0.05 && rms < 0.15, 'recording has audible contact energy without added compression');
  const energy = (a, b) => samples.slice(Math.floor(a * rate), Math.floor(b * rate)).reduce((sum, value) => sum + value * value, 0);
  assert.ok(energy(0.1, 0.25) > 0.01 && energy(0.25, 0.4) > 0.01, 'cluster continues beyond a single tap');
  assert.ok(Math.abs(samples.at(-1)) < 0.005, 'no hard cutoff');
  assert.ok(wav.length < 110000, 'short local asset, not a streaming dependency');
});

test('chip-only output uses one reusable foley buffer without pitched oscillators', async () => {
  const fixture = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ enabled: true, voiceEnabled: false, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher, now: () => now });
  await sounds.unlock(); await sounds.preloadAudio(); sounds.play('chip');
  const first = fixture.stats.sources[0];
  assert.ok(first.started); assert.equal(first.buffer.cue, 'chips'); assert.equal(fixture.stats.oscillators.length, 0);
  assert.equal(fixture.stats.requests.length, 1, 'voice-off still preloads the chip file');
  now += 200; sounds.play('chip');
  assert.equal(fixture.stats.sources[1].buffer, first.buffer, 'reuse without reallocating on every action');
  assert.equal(first.stopped, true, 'a rapid new action replaces the previous effect');
  sounds.dispose(); assert.equal(fixture.stats.sources[1].stopped, true);
});

test('board, turn and timer prompts preserve the full chip tail without repeating the recording', async () => {
  for (const prompt of ['board', 'yourturn', 'win', 'countdown', 'countdown-last', 'check', 'fold']) {
    const fixture = audioFixture(); let now = 1000;
    const sounds = createTableSounds({ enabled: true, voiceEnabled: false, AudioContext: fixture.AudioContext,
      document: fixture.doc, fetch: fixture.fetcher, now: () => now });
    await sounds.unlock(); await sounds.preloadAudio();
    sounds.playFeedback({ eventId: 'bet', sound: 'chip', chips: true });
    const chip = fixture.stats.sources[0];
    assert.equal(chip.stopped, undefined);
    assert.ok(chip.stopAt >= chip.buffer.duration, 'scheduled stop permits the complete recording');
    now += 200; sounds.play(prompt);
    assert.equal(chip.stopped, undefined, `${prompt} cannot interrupt the recorded chip tail`);
    assert.equal(fixture.stats.sources.filter(source => source.buffer.cue === 'chips').length, 1);
    sounds.dispose(); assert.equal(chip.stopped, true);
  }
});

test('disconnect cleanup stops both channels without losing event deduplication or gesture unlock', async () => {
  const fixture = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext,
    document: fixture.doc, fetch: fixture.fetcher, now: () => now });
  await sounds.unlock(); await sounds.preloadAudio();
  const action = { eventId: 'before-disconnect', sound: 'chip', chips: true, speech: 'call' };
  sounds.playFeedback(action);
  const playing = [...fixture.stats.sources];
  sounds.stopPlayback();
  assert.ok(playing.every(source => source.stopped), 'no audible tail survives disconnect or leaving the table');
  now += 1000;
  assert.equal(sounds.playFeedback(action), false, 'reconnect cannot replay the consumed action');
  assert.equal(sounds.playFeedback({ ...action, eventId: 'after-reconnect' }), true, 'a new action can use the existing unlock');
  sounds.dispose();
});

test('a following check or fold voice ducks the surviving chip tail without restarting it', async () => {
  for (const speech of ['check', 'fold']) {
    const fixture = audioFixture(); let now = 1000;
    const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext,
      document: fixture.doc, fetch: fixture.fetcher, now: () => now });
    await sounds.unlock(); await sounds.preloadAudio();
    sounds.playFeedback({ eventId: 'first-bet', sound: 'chip' });
    const chip = fixture.stats.sources[0];
    assert.deepEqual(chip.gain.values, [TABLE_AUDIO_MIX.chips]);
    now += 100; sounds.playFeedback({ eventId: 'next-player', sound: speech, speech });
    assert.equal(chip.stopped, undefined);
    assert.deepEqual(chip.gain.values, [TABLE_AUDIO_MIX.chips, TABLE_AUDIO_MIX.chipsUnderVoice]);
    assert.equal(fixture.stats.sources.filter(source => source.buffer.cue === 'chips').length, 1);
    assert.equal(fixture.stats.sources.at(-1).buffer.cue, speech);
    sounds.dispose();
  }
});

test('muting and backgrounding immediately stop the preserved chip channel', async () => {
  for (const mode of ['mute', 'hidden']) {
    const fixture = audioFixture();
    const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext,
      document: fixture.doc, fetch: fixture.fetcher });
    await sounds.unlock(); await sounds.preloadAudio();
    sounds.playFeedback({ sound: 'chip', speech: 'raise' });
    const playing = [...fixture.stats.sources];
    if (mode === 'mute') sounds.setEnabled(false);
    else { fixture.doc.visibilityState = 'hidden'; fixture.listeners.get('visibilitychange')(); }
    assert.ok(playing.every(source => source.stopped), `${mode} stops both voice and chip immediately`);
    sounds.dispose();
  }
});

test('batched actions cannot attach an old bet sound to the latest fold or check', () => {
  for (const type of ['check', 'fold']) {
    const tracker = createTableFeedback(); tracker.update(frame());
    const log = [...blinds, { seq: 3, type: 'raise', playerId: 'a', amount: 30, to: 40 },
      { seq: 4, type, playerId: 'b' }];
    const result = tracker.update(frame({ log, seq: 2, actor: null }));
    assert.equal(result.speech, type);
    assert.equal(result.sound, type);
    assert.equal(result.chips, false, 'chips follow the announced action, not earlier events in the batch');
    assert.equal(result.animations.filter(event => event.type === 'action').length, 2, 'both actions remain available to the visual layer');
  }
});

test('zero-chip actions, timebank, chat, buyin and refund-only updates do not produce chip impacts', () => {
  const tracker = createTableFeedback(); tracker.update(frame());
  let log = [...blinds, { seq: 3, type: 'call', playerId: 'b', amount: 0 }];
  const zero = tracker.update(frame({ log, seq: 2 }));
  assert.equal(zero.chips, false); assert.notEqual(zero.sound, 'chip');
  log.push({ seq: 4, type: 'refund', playerId: 'a', amount: 10 });
  const refund = tracker.update(frame({ log, seq: 3 }));
  assert.equal(refund.sound, null); assert.equal(refund.speech, undefined);
  for (const extra of [{ deadline: 60000 }, { chat: [{ id: 'm1' }] }, { players: [{ id: 'a', stack: 5000 }] }]) {
    const next = tracker.update({ ...frame({ log, seq: 4 }), ...extra });
    assert.equal(next.sound, null); assert.equal(next.speech, undefined);
  }
});

test('late server snapshots and disconnected updates are silent, with no delayed playback after recovery', () => {
  const tracker = createTableFeedback(); tracker.update({ ...frame(), serverTime: 1000 }, { now: 1000 });
  const log = [...blinds, { seq: 3, type: 'raise', playerId: 'a', amount: 30 }];
  assert.equal(tracker.update({ ...frame({ log, seq: 2 }), serverTime: 2000 }, { now: 8000 }).sound, null);
  assert.equal(tracker.update({ ...frame({ log, seq: 2 }), serverTime: 8000 }, { now: 8000 }).sound, null);
  log.push({ seq: 4, type: 'call', playerId: 'b', amount: 25 });
  assert.equal(tracker.update({ ...frame({ log, seq: 3 }), serverTime: 8100 }, { now: 8100, connected: false }).sound, null);
  log.push({ seq: 5, type: 'check', playerId: 'a' });
  assert.equal(tracker.update({ ...frame({ log, seq: 4 }), serverTime: 8200 }, { now: 8200 }).sound, null);
  log.push({ seq: 6, type: 'raise', playerId: 'b', amount: 50 });
  assert.equal(tracker.update({ ...frame({ log, seq: 5 }), serverTime: 8300 }, { now: 8300 }).sound, 'chip');
});

test('playback consumes a sound event once across duplicate SSE/response hooks, even while disabled', async () => {
  const fixture = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher, now: () => now });
  await sounds.unlock(); await sounds.preloadVoices();
  const cue = { eventId: '123456:a:h1:3', sound: 'chip', chips: true, speech: 'allin' };
  assert.equal(sounds.playFeedback(cue), true);
  const count = fixture.stats.sources.length;
  now += 1000; assert.equal(sounds.playFeedback(cue), false);
  assert.equal(fixture.stats.sources.length, count, 'no duplicate voice or chip source');
  sounds.setEnabled(false);
  const muted = { ...cue, eventId: '123456:a:h1:4' };
  assert.equal(sounds.playFeedback(muted), false);
  sounds.setEnabled(true); await sounds.unlock(); now += 1000;
  assert.equal(sounds.playFeedback(muted), false, 'enable cannot replay the skipped action');
  assert.equal(sounds.playFeedback({ ...cue, eventId: '123456:a:h2:3' }), true, 'same action number in a new hand is fresh');
  sounds.dispose();
});

test('the fixed action vocabulary uses the usual All-in term and never player-provided speech', () => {
  assert.equal(TABLE_VOICE_LABELS.allin, 'All-in');
  assert.deepEqual(TABLE_VOICE_CUES.map(type => TABLE_VOICE_LABELS[type]), ['下注', '加注', '再加注', '跟注', '过牌', '弃牌', 'All-in']);
  assert.ok(Object.isFrozen(TABLE_VOICE_LABELS));
});

test('street transitions and card reveal guards have no countdown until the full turn begins', () => {
  const tracker=createTurnCountdown(),base=frame({deadline:21000});
  base.actions={canAct:true};base.hand.actionReadyAt=1000;
  assert.deepEqual(tracker.update(base,{now:900}),{remaining:null,urgent:false,sound:null});
  const pending=structuredClone(base);pending.hand.transition={kind:'street',nextAt:900};
  // Even a stale actor/deadline cannot create a warning during a transition.
  assert.deepEqual(tracker.update(pending,{now:16000}),{remaining:null,urgent:false,sound:null});
  const waiting=structuredClone(base);waiting.actions.canAct=false;
  assert.deepEqual(tracker.update(waiting,{now:1000}),{remaining:null,urgent:false,sound:null});
  assert.deepEqual(tracker.update(base,{now:1000}),{remaining:20,urgent:false,sound:null});
  assert.deepEqual(tracker.update(base,{now:14000}),{remaining:7,urgent:true,sound:'countdown'});
  assert.equal(tracker.update(base,{now:14001}).sound,null);
});


test('chip effects duck only for an available spoken cue and preserve the voice onset', async () => {
  const fixture = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher, now: () => now });
  await sounds.unlock(); await sounds.preloadAudio();
  sounds.playFeedback({ sound: 'chip', speech: 'allin' });
  const chip = fixture.stats.sources.find(source => source.buffer.cue === 'chips');
  const voice = fixture.stats.sources.find(source => source.buffer.cue === 'allin');
  assert.deepEqual(chip.gain.values, [TABLE_AUDIO_MIX.chipsUnderVoice]);
  assert.deepEqual(voice.gain.values, [TABLE_AUDIO_MIX.voice]);
  assert.equal(voice.at, TABLE_AUDIO_MIX.voiceLead);
  assert.ok(TABLE_AUDIO_MIX.chipsUnderVoice < TABLE_AUDIO_MIX.chips);
  sounds.setVoiceEnabled(false); now += 300;
  sounds.playFeedback({ sound: 'chip', speech: 'allin' });
  assert.deepEqual(fixture.stats.sources.at(-1).gain.values, [TABLE_AUDIO_MIX.chips]);
  sounds.dispose();
});

test('enabling voice during chip preload loads only missing clips and never queues an action', async () => {
  let done; const wait = new Promise(resolve => { done = resolve; });
  const fixture = audioFixture({ fetchDelay: wait });
  const sounds = createTableSounds({ enabled: true, voiceEnabled: false, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher });
  await sounds.unlock(); assert.equal(fixture.stats.requests.length, 1);
  assert.equal(sounds.playFeedback({ eventId: 'loading', sound: 'chip', speech: 'allin' }), false);
  sounds.setVoiceEnabled(true); const pending = sounds.preloadAudio();
  assert.equal(fixture.stats.requests.length, 8, 'chip request shared, seven voice requests added');
  done(); assert.equal(await pending, true);
  assert.equal(fixture.stats.sources.length, 0);
  assert.equal(sounds.playFeedback({ eventId: 'loading', sound: 'chip', speech: 'allin' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'new', sound: 'chip', speech: 'allin' }), true);
  sounds.dispose();
});
