import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTableFeedback, createTableSounds, createTurnCountdown, TABLE_VOICE_CUES, TABLE_VOICE_LABELS, TABLE_AUDIO_MIX, TABLE_TURN_TONES } from '../public/table-feedback.js';

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
  action({ type: 'check', street: 'turn' }, undefined);
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
  const stats = { sources: [], oscillators: [], requests: [], contexts: [], resumes: 0, suspended: 0, closed: 0 }, listeners = new Map();
  const doc = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sampleRate = 22050; this.listeners = new Map(); stats.contexts.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    changeState(state) { this.state = state; this.listeners.get('statechange')?.(); }
    async resume() { stats.resumes++; this.changeState('running'); }
    async suspend() { stats.suspended++; this.changeState('suspended'); }
    async close() { stats.closed++; this.changeState('closed'); }
    createOscillator() { const frequencies = []; const node = { frequencies, frequency: { setValueAtTime(value) { frequencies.push(value); }, exponentialRampToValueAtTime(value) { frequencies.push(value); } }, connect(gain) { this.gain = gain; }, disconnect() {}, start(at) { this.at = at; }, stop(at) { if (at === undefined) this.stopped = true; else this.stopAt = at; } }; stats.oscillators.push(node); return node; }
    createGain() { const values = [], ramps = []; return { values, ramps, gain: { setValueAtTime(value) { values.push(value); }, exponentialRampToValueAtTime(value) { ramps.push(value); } }, connect() {}, disconnect() {} }; }
    createBuffer(channels, count, rate) { return { duration: count / rate, noise: true, getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { const node = { playbackRate: { setValueAtTime(value) { node.rate = value; } }, connect(gain) { this.gain = gain; }, disconnect() {}, start(at) { this.started = true; this.at = at; }, stop(at) { if (at === undefined) this.stopped = true; else this.stopAt = at; } }; stats.sources.push(node); return node; }
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
  assert.equal(fixture.stats.requests.length, 7);
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

test('every approved voice is only slightly shorter, with unchanged chip, collection and check speeds', async () => {
  const f = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher, now: () => now });
  await sounds.unlock(); await sounds.preloadAudio();
  assert.ok(TABLE_AUDIO_MIX.voiceRate > 1 && TABLE_AUDIO_MIX.voiceRate <= 1.08, 'a subtle adjustment, not rushed speech');
  for (const type of TABLE_VOICE_CUES) {
    assert.equal(sounds.speak(type), true);
    const source = f.stats.sources.at(-1);
    assert.equal(source.buffer.cue, type, 'keep each existing approved recording');
    assert.equal(source.rate, TABLE_AUDIO_MIX.voiceRate);
    assert.ok(source.buffer.duration / source.rate > source.buffer.duration * 0.92, 'retain syllables and natural tails');
    assert.equal(source.stopAt, undefined, 'the full clip ends naturally, without truncation');
  }
  now += 1000; assert.equal(sounds.play('chip'), true);
  assert.equal(f.stats.sources.at(-1).rate, 1);
  now += 1000; assert.equal(sounds.play('collect'), true);
  assert.equal(f.stats.sources.at(-1).rate, TABLE_AUDIO_MIX.collectRate);
  assert.equal(sounds.play('check'), true);
  assert.equal(f.stats.sources.at(-1).rate, undefined, 'recorded knocks retain their normal default rate');
  sounds.dispose();
});

test('hidden, disabled, disposed and unavailable voice output are silent without blocking ordinary effects', async () => {
  const fixture = audioFixture(); const sounds = createTableSounds({ enabled: true, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher });
  await sounds.unlock(); await sounds.preloadVoices(); assert.equal(sounds.speak('fold'), true);
  const source = fixture.stats.sources.at(-1);
  fixture.doc.visibilityState = 'hidden'; fixture.listeners.get('visibilitychange')();
  assert.equal(source.stopped, true); assert.equal(sounds.speak('call'), false);
  fixture.doc.visibilityState = 'visible'; fixture.listeners.get('visibilitychange')(); await Promise.resolve();
  assert.equal(sounds.speak('call'), true, 'foreground can resume an already activated context without another tap');
  sounds.dispose(); assert.equal(sounds.speak('call'), false); assert.equal(fixture.listeners.size, 0);
  const failed = audioFixture({ fetchOk: false });
  const fallback = createTableSounds({ enabled: true, AudioContext: failed.AudioContext, document: failed.doc, fetch: failed.fetcher });
  await fallback.unlock(); assert.equal(await fallback.preloadVoices(), false);
  assert.equal(fallback.playFeedback({ sound: 'chip', speech: 'raise' }), false, 'missing files stay silent instead of replaying old synthetic clicks');
  assert.equal(fallback.play('check'), true, 'ordinary procedural notifications still work');
  assert.equal(failed.stats.sources.some(node => node.buffer.cue), false); fallback.dispose();
});

test('foreground reuses activated audio and resumes only future events without replaying hidden sounds', async () => {
  const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher });
  await sounds.unlock(); await sounds.preloadAudio();
  const audio = f.stats.contexts[0], requests = f.stats.requests.length;
  sounds.playFeedback({ eventId: 'before-hide', sound: 'chip' });
  f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')();
  const beforeReturn = f.stats.sources.length;
  assert.equal(sounds.playFeedback({ eventId: 'missed-turn', sound: 'yourturn' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'missed-check', sound: 'check', checks: ['hidden-check'] }), false);
  f.doc.visibilityState = 'visible'; f.listeners.get('visibilitychange')(); await Promise.resolve();
  assert.equal(f.stats.contexts.length, 1); assert.equal(f.stats.contexts[0], audio);
  assert.equal(f.stats.requests.length, requests, 'decoded recordings are retained across a short app switch');
  assert.equal(f.stats.sources.length, beforeReturn, 'foreground does not play a queue');
  assert.equal(sounds.playFeedback({ eventId: 'missed-turn', sound: 'yourturn' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'missed-check', sound: 'check', checks: ['hidden-check'] }), false);
  assert.equal(sounds.playFeedback({ eventId: 'new-check', sound: 'check', checks: ['live-check'] }), true);
  sounds.dispose(); assert.equal(audio.listeners.size, 0);
});

test('foreground without first activation or with sound disabled never creates or resumes audio', async () => {
  for (const mode of ['never-activated', 'muted']) {
    const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher });
    if (mode === 'muted') { await sounds.unlock(); sounds.setEnabled(false); }
    const resumes = f.stats.resumes, contexts = f.stats.contexts.length;
    f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')();
    f.doc.visibilityState = 'visible'; f.listeners.get('visibilitychange')(); await Promise.resolve();
    assert.equal(f.stats.resumes, resumes); assert.equal(f.stats.contexts.length, contexts);
    assert.equal(sounds.play('yourturn'), false); sounds.dispose();
  }
});

test('an operating-system audio interruption recovers once and never restarts interrupted sources', async () => {
  for (const state of ['interrupted', 'suspended']) {
    const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher });
    await sounds.unlock(); await sounds.preloadAudio();
    sounds.playFeedback({ eventId: 'first', sound: 'check', checks: ['first-check'] });
    const source = f.stats.sources.at(-1), audio = f.stats.contexts[0], resumes = f.stats.resumes;
    audio.changeState(state); await Promise.resolve();
    assert.equal(f.stats.resumes, resumes + 1); assert.equal(source.stopped, true);
    assert.equal(f.stats.sources.length, 1, 'interrupted audio is stopped, not replayed');
    assert.equal(sounds.playFeedback({ eventId: 'second', sound: 'check', checks: ['second-check'] }), true);
    sounds.dispose();
  }
});

test('automatic audio resume is bounded and a real gesture can always retry immediately', async () => {
  const f = audioFixture(); let blocked = false;
  class PolicyContext extends f.AudioContext {
    async resume() {
      if (blocked) { f.stats.resumes++; this.changeState('suspended'); throw new Error('user gesture required'); }
      return super.resume();
    }
  }
  const sounds = createTableSounds({ enabled: true, AudioContext: PolicyContext, document: f.doc, fetch: f.fetcher });
  await sounds.unlock(); await sounds.preloadAudio();
  const audio = f.stats.contexts[0]; blocked = true;
  f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')();
  const resumes = f.stats.resumes;
  f.doc.visibilityState = 'visible'; f.listeners.get('visibilitychange')(); await Promise.resolve();
  assert.equal(f.stats.resumes, resumes + 1);
  audio.changeState('suspended'); await Promise.resolve();
  assert.equal(f.stats.resumes, resumes + 1, 'a rejected policy resume cannot trigger a statechange retry loop');
  assert.equal(sounds.playFeedback({ eventId: 'blocked-turn', sound: 'yourturn' }), false);
  blocked = false; assert.equal(await sounds.unlock(), true);
  assert.equal(sounds.playFeedback({ eventId: 'blocked-turn', sound: 'yourturn' }), false, 'the next gesture does not replay the missed turn');
  assert.equal(sounds.playFeedback({ eventId: 'live-turn', sound: 'yourturn' }), true); sounds.dispose();
});

test('a late foreground resume cannot reenable audio after hide, mute or disposal', async () => {
  for (const mode of ['hidden', 'muted', 'disposed']) {
    const f = audioFixture(); let delay = false, finish;
    class DeferredContext extends f.AudioContext {
      resume() {
        if (!delay) return super.resume();
        f.stats.resumes++;
        return new Promise(resolve => { finish = () => { this.changeState('running'); resolve(); }; });
      }
    }
    const sounds = createTableSounds({ enabled: true, AudioContext: DeferredContext, document: f.doc, fetch: f.fetcher });
    await sounds.unlock(); delay = true;
    f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')();
    f.doc.visibilityState = 'visible'; f.listeners.get('visibilitychange')();
    if (mode === 'hidden') { f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); }
    else if (mode === 'muted') sounds.setEnabled(false);
    else sounds.dispose();
    finish(); await Promise.resolve();
    assert.equal(sounds.play('check'), false, mode); sounds.dispose();
  }
});

test('foreground never recreates a closed audio context; a later gesture may create its replacement', async () => {
  const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher });
  await sounds.unlock(); const old = f.stats.contexts[0]; old.changeState('closed');
  f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')();
  f.doc.visibilityState = 'visible'; f.listeners.get('visibilitychange')(); await Promise.resolve();
  assert.equal(f.stats.contexts.length, 1); assert.equal(sounds.play('yourturn'), false);
  assert.equal(await sounds.unlock(), true); assert.equal(f.stats.contexts.length, 2); assert.equal(old.listeners.size, 0);
  sounds.dispose();
});

test('a stale automatic resume rejection cannot relock audio after a newer real gesture succeeds', async () => {
  const f = audioFixture(); let deferNext = false, rejectOld;
  class DeferredContext extends f.AudioContext {
    resume() {
      if (!deferNext) return super.resume();
      deferNext = false; f.stats.resumes++;
      return new Promise((resolve, reject) => { rejectOld = reject; });
    }
  }
  const sounds = createTableSounds({ enabled: true, AudioContext: DeferredContext, document: f.doc, fetch: f.fetcher });
  await sounds.unlock();
  f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')();
  deferNext = true; f.doc.visibilityState = 'visible'; f.listeners.get('visibilitychange')();
  assert.equal(await sounds.unlock(), true, 'new gesture succeeds while the earlier automatic attempt is still pending');
  rejectOld(new Error('earlier automatic resume denied')); await Promise.resolve();
  assert.equal(sounds.play('check'), true, 'old rejection cannot clear a newer activation');
  sounds.dispose();
});

test('an old gesture completion cannot overwrite activation of a replacement audio context', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const f = audioFixture(); let finishOld;
    class ReplacedContext extends f.AudioContext {
      resume() {
        if (f.stats.contexts.indexOf(this) !== 0) return super.resume();
        f.stats.resumes++;
        return new Promise((resolve, reject) => {
          finishOld = () => {
            if (outcome === 'reject') reject(new Error('old context failed'));
            else { this.changeState('running'); resolve(); }
          };
        });
      }
    }
    const sounds = createTableSounds({ enabled: true, AudioContext: ReplacedContext, document: f.doc, fetch: f.fetcher });
    const oldAttempt = sounds.unlock(); f.stats.contexts[0].changeState('closed');
    assert.equal(await sounds.unlock(), true);
    const replacement = f.stats.contexts[1]; finishOld();
    assert.equal(await oldAttempt, false, 'completion belongs to the retired context');
    assert.equal(f.stats.contexts.at(-1), replacement); assert.equal(sounds.play('check'), true, outcome);
    sounds.dispose();
  }
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

test('a following fold voice ducks the surviving chip tail without restarting it', async () => {
  for (const speech of ['fold']) {
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
    assert.equal(result.speech, type === 'check' ? undefined : type);
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
  assert.deepEqual(TABLE_VOICE_CUES.map(type => TABLE_VOICE_LABELS[type]), ['下注', '加注', '再加注', '跟注', '弃牌', 'All-in']);
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
  assert.equal(fixture.stats.requests.length, 7, 'chip request shared, six voices; checks need no download');
  done(); assert.equal(await pending, true);
  assert.equal(fixture.stats.sources.length, 0);
  assert.equal(sounds.playFeedback({ eventId: 'loading', sound: 'chip', speech: 'allin' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'new', sound: 'chip', speech: 'allin' }), true);
  sounds.dispose();
});

test('actual multiwinner side-pot settlement produces one collection cue, never a cue for refunds or reveals', () => {
  const tracker = createTableFeedback();
  const base = frame({ actor: null });
  base.hand.board = ['As', 'Kd', '2h', '3c', '4d'];
  tracker.update(base);
  const refund = structuredClone(base); refund.revision = 2;
  refund.hand.log.push({ seq: 3, type: 'refund', playerId: 'a', amount: 50 }); refund.hand.actionSeq = 3;
  assert.equal(tracker.update(refund).sound, null);
  const complete = structuredClone(refund); complete.revision = 3; complete.hand.status = 'complete';
  complete.hand.result = { mainWinnerIds: ['a', 'b'], payouts: { a: 150, b: 200, c: 0 }, pots: [{ amount: 300 }, { amount: 50 }] };
  complete.hand.log.push({ seq: 4, type: 'payout', playerId: 'a', amount: 150 }, { seq: 5, type: 'payout', playerId: 'b', amount: 200 }); complete.hand.actionSeq = 5;
  const cue = tracker.update(complete);
  assert.equal(cue.sound, 'collect'); assert.equal(cue.chips, false); assert.equal(cue.speech, undefined);
  assert.equal(cue.animations.filter(item => item.type === 'win').length, 1);
  assert.match(cue.eventId, /:payout$/);
  assert.equal(tracker.update(complete).sound, null);
  assert.equal(tracker.update({ ...complete, revision: 4, chat: [{ id: 'new-chat' }] }).sound, null);
  const emptyTracker = createTableFeedback(); emptyTracker.update(base);
  const unpaid = structuredClone(base); unpaid.revision = 2; unpaid.hand.status = 'complete';
  unpaid.hand.result = { mainWinnerIds: [], payouts: { a: 0 } };
  assert.equal(emptyTracker.update(unpaid).sound, null, 'a complete label alone is not a collected pot');
});

test('payout restore, background, disconnected, delayed and replay states remain silent', () => {
  const complete = frame({ seq: 2, actor: null, status: 'complete', log: [...blinds, { seq: 3, type: 'payout', playerId: 'a', amount: 15 }] });
  complete.hand.result = { payouts: { a: 15 }, mainWinnerIds: ['a'] };
  for (const options of [{ reconnected: true }, { visible: false }, { connected: false }, { live: false }, { now: 10000 }]) {
    const tracker = createTableFeedback(); tracker.update({ ...frame(), serverTime: 1000 }, { now: 1000 });
    assert.equal(tracker.update({ ...complete, serverTime: 2000 }, { now: 2000, ...options }).sound, null);
    assert.equal(tracker.update({ ...complete, revision: 3, serverTime: 11000 }, { now: 11000 }).sound, null, 'return does not replay settlement');
  }
  assert.equal(createTableFeedback().update(complete).sound, null, 'opening an already completed hand is silent');
});

test('collection reuses selected foley once, replaces a recent chip cue and has a fuller body without synthesized fanfare', async () => {
  const fixture = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ enabled: true, voiceEnabled: false, AudioContext: fixture.AudioContext, document: fixture.doc, fetch: fixture.fetcher, now: () => now });
  await sounds.unlock(); await sounds.preloadAudio();
  sounds.playFeedback({ eventId: 'last-action', sound: 'chip' });
  const bet = fixture.stats.sources[0]; now += 10;
  const payout = { eventId: 'paid-hand:payout', sound: 'collect', chips: true };
  assert.equal(sounds.playFeedback(payout), true, 'payout is not swallowed by final-action cooldown');
  assert.equal(fixture.stats.sources.length, 2, 'one collection source even if a legacy caller supplies chips:true');
  const collect = fixture.stats.sources[1];
  assert.equal(collect.buffer, bet.buffer); assert.equal(bet.stopped, true);
  assert.equal(collect.rate, TABLE_AUDIO_MIX.collectRate); assert.ok(collect.rate < 1 && collect.rate >= 0.9);
  assert.deepEqual(collect.gain.values, [TABLE_AUDIO_MIX.collect]);
  assert.ok(collect.stopAt > collect.buffer.duration, 'complete tail survives the lower playback rate');
  assert.equal(fixture.stats.oscillators.length, 0); assert.equal(fixture.stats.requests.length, 1);
  now += 1000; assert.equal(sounds.playFeedback(payout), false);
  assert.equal(fixture.stats.sources.length, 2, 'split-pot results and SSE retries cannot stack collection sounds');
  sounds.setEnabled(false); assert.equal(collect.stopped, true);
  assert.equal(sounds.playFeedback({ eventId: 'muted-payout', sound: 'collect' }), false);
  sounds.setEnabled(true); await sounds.unlock(); now += 1000;
  assert.equal(sounds.playFeedback({ eventId: 'muted-payout', sound: 'collect' }), false, 'unmuting cannot replay skipped payout');
  assert.equal(sounds.playFeedback({ eventId: 'next-payout', sound: 'collect' }), true);
  const next = fixture.stats.sources.at(-1); fixture.doc.visibilityState = 'hidden'; fixture.listeners.get('visibilitychange')();
  assert.equal(next.stopped, true); assert.equal(sounds.playFeedback({ eventId: 'hidden-payout', sound: 'collect' }), false);
  sounds.dispose();
});


test('a check has a separate knock when the next turn, board or collection shares its update', async () => {
  for (const transition of ['yourturn','board','collect','raise']) {
    const f=audioFixture(),sounds=createTableSounds({enabled:true,voiceEnabled:false,AudioContext:f.AudioContext,document:f.doc,fetch:f.fetcher});
    await sounds.unlock();await sounds.preloadAudio();
    const tracker=createTableFeedback();tracker.update(frame({actor:'b'}));
    const log=[...blinds,{seq:3,type:'check',playerId:'b',street:'flop'}];
    if(transition==='raise')log.push({seq:4,type:'raise',playerId:'a',to:20,amount:20,street:'flop'});
    const next=frame({log,seq:2,actor:transition==='yourturn'?'a':null,status:transition==='collect'?'complete':'playing'});
    if(transition==='board')next.hand.board=['As','Kd','2h'];
    if(transition==='collect')next.hand.result={payouts:{b:15},mainWinnerIds:['b']};
    const cues=tracker.update(next);assert.equal(cues.checks.length,1);assert.equal(cues.speech,transition==='raise'?'bet':undefined);
    sounds.playFeedback(cues);
    const knocks=f.stats.sources.filter(s=>s.buffer.noise);assert.equal(knocks.length,1,transition);assert.equal(knocks[0].stopped,undefined,transition);
    assert.equal(sounds.playFeedback(cues),false,'duplicate response must not replay the tap');
    assert.equal(f.stats.sources.filter(s=>s.buffer.noise).length,1);sounds.dispose();
  }
});

test('nine rapid independent checks bypass notification throttling without cutting off earlier knocks', async()=>{
  for(const gap of [0,50,89]){
    const f=audioFixture();let now=1000;
    const sounds=createTableSounds({enabled:true,voiceEnabled:false,AudioContext:f.AudioContext,document:f.doc,fetch:f.fetcher,now:()=>now});
    await sounds.unlock();await sounds.preloadAudio();sounds.play('yourturn');
    const tracker=createTableFeedback();tracker.update(frame({actor:'p0'}));let log=[...blinds];
    for(let i=0;i<9;i++){
      log=[...log,{seq:log.length+1,type:'check',playerId:'p'+i,street:'flop'}];now+=gap;
      assert.equal(sounds.playFeedback(tracker.update(frame({log,seq:i+2,actor:i===8?null:'p'+(i+1)}))),true);
    }
    const knocks=f.stats.sources.filter(s=>s.buffer.noise);assert.equal(knocks.length,9,'one sound for each player');
    assert.ok(knocks.every(s=>s.started&&!s.stopped&&s.stopAt>=s.at+s.buffer.duration));
    assert.ok(knocks.at(-1).at<=0.8,'live bursts remain short, not a historical playback queue');
    now+=100;sounds.play('board');now+=100;sounds.play('countdown');
    assert.ok(knocks.every(s=>!s.stopped),'turn, board and countdown cannot truncate knocks');
    assert.equal(sounds.speak('check'),false,'no second spoken check');sounds.dispose();assert.ok(knocks.every(s=>s.stopped));
  }
});

test('coalesced checks retain every player action even when the latest action is a raise',async()=>{
  const f=audioFixture(),sounds=createTableSounds({enabled:true,AudioContext:f.AudioContext,document:f.doc,fetch:f.fetcher});
  await sounds.unlock();await sounds.preloadAudio();const tracker=createTableFeedback();tracker.update(frame());
  const log=[...blinds,...Array.from({length:8},(_,i)=>({seq:i+3,type:'check',playerId:'p'+i,street:'flop'})),{seq:11,type:'raise',playerId:'last',street:'flop',to:20,amount:20}];
  const cues=tracker.update(frame({log,seq:2,actor:null}));assert.equal(cues.checks.length,8);assert.equal(new Set(cues.checks).size,8);assert.equal(cues.speech,'bet');
  sounds.playFeedback(cues);assert.equal(f.stats.sources.filter(s=>s.buffer.noise).length,8);assert.equal(f.stats.sources.filter(s=>s.buffer.cue==='bet').length,1);
  sounds.playFeedback({...cues,eventId:'another-render-with-same-checks',sound:null,speech:null});
  assert.equal(f.stats.sources.filter(s=>s.buffer.noise).length,8,'per-action IDs deduplicate overlapping batches');sounds.dispose();
});

test('the first unlocked check works while every remote audio request is still loading',async()=>{
  let finish;const delay=new Promise(resolve=>finish=resolve),f=audioFixture({fetchDelay:delay});
  const sounds=createTableSounds({enabled:true,AudioContext:f.AudioContext,document:f.doc,fetch:f.fetcher});await sounds.unlock();
  assert.equal(sounds.playFeedback({eventId:'first-check',sound:'check',checks:['check-1']}),true);
  assert.equal(f.stats.sources.filter(s=>s.buffer.noise).length,1);assert.ok(f.stats.requests.every(r=>!r.url.includes('check')));
  finish();await sounds.preloadAudio();assert.equal(f.stats.sources.length,1,'downloads cannot replay it');sounds.dispose();
});

test('muting, hiding and disconnecting stop all scheduled knocks and never replay consumed actions',async()=>{
  for(const mode of ['mute','hidden','disconnect']){
    const f=audioFixture(),sounds=createTableSounds({enabled:true,voiceEnabled:false,AudioContext:f.AudioContext,document:f.doc,fetch:f.fetcher});await sounds.unlock();
    const cue={eventId:'live-checks',sound:'check',checks:['a','b','c']};sounds.playFeedback(cue);const taps=[...f.stats.sources];assert.equal(taps.length,3);
    if(mode==='mute')sounds.setEnabled(false);else if(mode==='hidden'){f.doc.visibilityState='hidden';f.listeners.get('visibilitychange')();}else sounds.stopPlayback();
    assert.ok(taps.every(s=>s.stopped));f.doc.visibilityState='visible';sounds.setEnabled(true);await sounds.unlock();
    assert.equal(sounds.playFeedback(cue),false);assert.equal(f.stats.sources.length,3);
    assert.equal(sounds.playFeedback({eventId:'new-check',sound:'check',checks:['d']}),true);sounds.dispose();
  }
});

test('late, hidden, disconnected and restored snapshots never create knock events',()=>{
  for(const options of [{reconnected:true},{visible:false},{connected:false},{live:false},{now:8000}]){
    const tracker=createTableFeedback();tracker.update({...frame(),serverTime:1000},{now:1000});
    const next={...frame({log:[...blinds,{seq:3,type:'check',playerId:'b'}],seq:2}),serverTime:2000};
    assert.equal(tracker.update(next,{now:2000,...options}).checks,undefined);
    assert.equal(tracker.update({...next,serverTime:9000},{now:9000}).checks,undefined);
  }
});


test('a fold uses only the selected spoken word, with no synthetic downward tone or fake chip sound', async () => {
  const f = audioFixture();
  const sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher });
  await sounds.unlock(); await sounds.preloadAudio();
  assert.equal(sounds.playFeedback({ eventId: 'fold-clean', sound: 'fold', speech: 'fold', chips: false }), true);
  assert.equal(f.stats.oscillators.length, 0);
  assert.deepEqual(f.stats.sources.map(node => node.buffer.cue), ['fold']);
  sounds.setVoiceEnabled(false);
  assert.equal(sounds.playFeedback({ eventId: 'fold-muted', sound: 'fold', speech: 'fold' }), false);
  assert.equal(f.stats.oscillators.length, 0); sounds.dispose();
});

test('the final-seconds warning remains audible beside ordinary prompts and does not stack duplicate ticks', async () => {
  const f = audioFixture(); let clock = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher, now: () => clock });
  await sounds.unlock(); await sounds.preloadAudio();
  sounds.play('yourturn'); const regular = [...f.stats.oscillators];
  clock += 10; assert.equal(sounds.play('countdown'), true, 'not swallowed by the 90 ms prompt throttle');
  const warning = f.stats.oscillators.at(-1);
  assert.ok(warning.stopAt - warning.at >= 0.12);
  assert.ok(warning.gain.ramps[0] >= 0.14, 'warning has enough level above the former tiny click');
  assert.ok(regular.every(node => !node.stopped), 'warning does not cut off a pending turn notification');
  assert.equal(sounds.play('countdown'), false, 'repeated renderer cannot stack the same tick');
  clock += 200; sounds.play('board');
  assert.equal(warning.stopped, undefined, 'board cue cannot cut off the warning');
  clock += 800; const before = f.stats.oscillators.length;
  assert.equal(sounds.play('countdown-last'), true);
  const final = f.stats.oscillators.slice(before);
  assert.equal(final.length, 2, 'last three seconds have a distinct double pulse');
  assert.ok(final[1].at - final[0].at >= 0.14);
  sounds.suspend(); assert.ok(final.every(node => node.stopped)); sounds.dispose();
});

test('the action-ready cue is one short bell strike with simultaneous partials, not sequential beeps', async () => {
  const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher });
  await sounds.unlock();
  assert.equal(sounds.playFeedback({ yourTurnId: 'room:me:hand:1' }), true);
  const bells = f.stats.oscillators;
  assert.equal(bells.length, 3);
  assert.deepEqual(bells.map(node => node.at), [0, 0, 0]);
  assert.deepEqual(bells.map(node => node.frequencies[0]), TABLE_TURN_TONES.map(partial => partial[0]));
  assert.deepEqual(bells.map(node => node.gain.ramps[0]), [0.08, 0.025, 0.009]);
  assert.ok(Math.max(...bells.map(node => node.stopAt - node.at)) <= 0.25);
  assert.equal(f.stats.sources.length, 0, 'bell needs no recording download');
  sounds.dispose();
});

test('a fresh turn bell bypasses an adjacent board cue and ordinary prompts cannot cut it off', async () => {
  const f = audioFixture(); let now = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher, now: () => now });
  await sounds.unlock(); await sounds.preloadAudio();
  sounds.play('board'); now += 10;
  assert.equal(sounds.playFeedback({ yourTurnId: 'street:flop:first-action' }), true, 'recent board audio cannot swallow readiness');
  const bells = f.stats.oscillators.slice(-3);
  now += 100; sounds.play('board');
  assert.ok(bells.every(node => !node.stopped), 'board audio cannot truncate the bell tail');
  now += 10; sounds.play('countdown');
  assert.ok(bells.every(node => !node.stopped), 'countdown remains on its own channel');
  sounds.suspend(); assert.ok(bells.every(node => node.stopped), 'background stop still reaches the separate channel');
  sounds.dispose();
});

test('turn bells coexist with chips, action speech and checks without delaying or replacing those cues', async () => {
  for (const action of ['call', 'check']) {
    const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher, now: () => 1000 });
    await sounds.unlock(); await sounds.preloadAudio();
    const feedback = action === 'call'
      ? { eventId: 'action', yourTurnId: 'turn', sound: 'chip', chips: true, speech: 'call' }
      : { eventId: 'action', yourTurnId: 'turn', sound: 'check', checks: ['check:1'] };
    assert.equal(sounds.playFeedback(feedback), true);
    const bells = f.stats.oscillators;
    assert.equal(bells.length, 3); assert.ok(bells.every(node => node.at === 0 && !node.stopped));
    if (action === 'call') {
      assert.equal(f.stats.sources.filter(node => node.buffer.cue === 'chips').length, 1);
      assert.equal(f.stats.sources.filter(node => node.buffer.cue === 'call').length, 1);
    } else assert.equal(f.stats.sources.filter(node => node.buffer.noise).length, 1);
    assert.equal(sounds.playFeedback(feedback), false, 'repeated action and turn IDs remain silent');
    assert.equal(f.stats.oscillators.length, 3);
    sounds.dispose();
  }
});

test('readiness IDs deduplicate independently of action IDs and do not throttle a different real turn', async () => {
  const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher, now: () => 1000 });
  await sounds.unlock(); await sounds.preloadAudio();
  sounds.playFeedback({ eventId: 'same-action', sound: 'chip', speech: 'call' });
  const recordings = f.stats.sources.length;
  assert.equal(sounds.playFeedback({ eventId: 'same-action', yourTurnId: 'turn:1', sound: 'chip', speech: 'call' }), true, 'duplicate action can carry newly ready turn');
  assert.equal(f.stats.sources.length, recordings, 'the action is not replayed');
  assert.equal(f.stats.oscillators.length, 3);
  assert.equal(sounds.playFeedback({ eventId: 'same-action', yourTurnId: 'turn:1' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'same-action', yourTurnId: 'turn:2' }), true, 'no arbitrary 90 ms throttle on a different turn');
  assert.equal(f.stats.oscillators.length, 6);
  sounds.dispose();
});

test('legacy yourturn sound with a readiness ID rings once while retaining accompanying chips and speech', async () => {
  const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher, now: () => 1000 });
  await sounds.unlock(); await sounds.preloadAudio();
  const feedback = { eventId: 'legacy-action', yourTurnId: 'legacy-turn', sound: 'yourturn', chips: true, speech: 'call' };
  assert.equal(sounds.playFeedback(feedback), true);
  assert.equal(f.stats.oscillators.length, 3);
  assert.ok(f.stats.oscillators.every(node => node.at === 0), 'bell does not wait behind the chip effect');
  assert.deepEqual(f.stats.sources.map(node => node.buffer.cue), ['chips', 'call']);
  assert.equal(sounds.playFeedback(feedback), false); assert.equal(f.stats.oscillators.length, 3);
  sounds.dispose();
});

test('muted or hidden turn IDs are consumed without delayed replay after audio is enabled again', async () => {
  for (const mode of ['muted', 'hidden']) {
    const f = audioFixture(), sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher });
    await sounds.unlock(); await sounds.preloadAudio();
    if (mode === 'muted') sounds.setEnabled(false);
    else { f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); }
    assert.equal(sounds.playFeedback({ yourTurnId: 'missed-turn' }), false);
    assert.equal(f.stats.oscillators.length, 0);
    if (mode === 'muted') sounds.setEnabled(true);
    else { f.doc.visibilityState = 'visible'; f.listeners.get('visibilitychange')(); }
    await sounds.unlock();
    assert.equal(sounds.playFeedback({ yourTurnId: 'missed-turn' }), false);
    assert.equal(sounds.playFeedback({ yourTurnId: 'live-turn' }), true);
    assert.equal(f.stats.oscillators.length, 3);
    sounds.dispose();
  }
});

test('later live events recover a transiently rejected resume with bounded retries and no stale action playback', async () => {
  const f = audioFixture(); let clock = 1000, blocked = false;
  class TransientContext extends f.AudioContext {
    async resume() { if (blocked) { f.stats.resumes++; throw new Error('audio route temporarily unavailable'); } return super.resume(); }
  }
  const sounds = createTableSounds({ enabled: true, AudioContext: TransientContext, document: f.doc, fetch: f.fetcher, now: () => clock });
  await sounds.unlock(); await sounds.preloadAudio();
  const audio = f.stats.contexts[0]; blocked = true; audio.changeState('interrupted');
  await Promise.resolve(); const attempts = f.stats.resumes;
  for (let i = 0; i < 10; i++) { assert.equal(sounds.playFeedback({ eventId: `missed-${i}`, sound: 'chip' }), false); await Promise.resolve(); }
  assert.equal(f.stats.resumes, attempts, 'live state updates cannot create a tight resume loop');
  blocked = false; clock += 3100;
  assert.equal(sounds.playFeedback({ eventId: 'repair-trigger', sound: 'chip' }), false, 'repair does not delay this event into a later action');
  await Promise.resolve();
  assert.equal(f.stats.resumes, attempts + 1);
  assert.equal(sounds.playFeedback({ eventId: 'repair-trigger', sound: 'chip' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'future-live', sound: 'chip' }), true);
  assert.equal(f.stats.sources.length, 1); sounds.dispose();
});

test('a missed audio statechange is recovered on the next live event without restarting old sounds', async () => {
  const f = audioFixture(); let clock = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, fetch: f.fetcher, now: () => clock });
  await sounds.unlock(); await sounds.preloadAudio();
  sounds.playFeedback({ eventId: 'before-suspension', sound: 'chip' });
  const previousSource = f.stats.sources.at(-1); clock += 1000;
  f.stats.contexts[0].state = 'suspended'; // Browser reports state but omitted the event.
  const attempts = f.stats.resumes;
  assert.equal(sounds.playFeedback({ eventId: 'repair', sound: 'chip' }), false);
  await Promise.resolve();
  assert.equal(f.stats.resumes, attempts + 1);
  assert.equal(previousSource.stopped, true, 'interrupted tail cannot resume with a later player');
  assert.equal(sounds.playFeedback({ eventId: 'repair', sound: 'chip' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'new-live', sound: 'chip' }), true); sounds.dispose();
});

test('BFCache, focus and network restoration recover activated audio and remove their listeners on disposal', async () => {
  for (const event of ['pageshow', 'focus', 'online']) {
    const f = audioFixture(), lifecycle = new Map();
    const win = { addEventListener: (type, listener) => lifecycle.set(type, listener), removeEventListener: type => lifecycle.delete(type) };
    const sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, window: win, fetch: f.fetcher });
    await sounds.unlock(); await sounds.preloadAudio();
    f.stats.contexts[0].state = 'suspended';
    lifecycle.get(event)(); await Promise.resolve();
    assert.equal(sounds.play('check'), true, event);
    sounds.dispose(); assert.equal(lifecycle.size, 0);
  }
});

test('failed recordings are warmed again by later live events without a tap or replaying missed bets', async () => {
  const f = audioFixture(); let failed = true, clock = 1000;
  const sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, now: () => clock,
    fetch: async (...args) => failed ? { ok: false } : f.fetcher(...args) });
  await sounds.unlock(); assert.equal(await sounds.preloadAudio(), false);
  assert.equal(sounds.playFeedback({ eventId: 'old-bet', sound: 'chip', speech: 'allin' }), false);
  clock += 3100; failed = false;
  assert.equal(sounds.playFeedback({ eventId: 'warming-bet', sound: 'chip', speech: 'allin' }), false);
  await sounds.preloadAudio();
  assert.equal(f.stats.sources.length, 0, 'successful download does not play prior actions');
  assert.equal(sounds.playFeedback({ eventId: 'warming-bet', sound: 'chip', speech: 'allin' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'fresh-bet', sound: 'chip', speech: 'allin' }), true);
  assert.deepEqual(f.stats.sources.map(node => node.buffer.cue), ['chips', 'allin']); sounds.dispose();
});

test('an unresolved policy resume cannot accumulate automatic retries and a real gesture supersedes it', async () => {
  const f = audioFixture(); let clock = 1000, pending = false, release;
  class PendingContext extends f.AudioContext {
    resume() {
      if (!pending) return super.resume();
      f.stats.resumes++;
      return new Promise(resolve => { release = () => { this.changeState('running'); resolve(); }; });
    }
  }
  const sounds = createTableSounds({ enabled: true, AudioContext: PendingContext, document: f.doc, fetch: f.fetcher, now: () => clock });
  await sounds.unlock(); await sounds.preloadAudio();
  pending = true; f.stats.contexts[0].changeState('interrupted');
  const resumes = f.stats.resumes;
  for (let i = 0; i < 12; i++) { clock += 4000; sounds.playFeedback({ eventId: `pending-${i}`, sound: 'chip' }); }
  assert.equal(f.stats.resumes, resumes, 'one unresolved automatic promise, not one per incoming action');
  pending = false; assert.equal(await sounds.unlock(), true);
  release(); await Promise.resolve();
  assert.equal(f.stats.sources.length, 0);
  assert.equal(sounds.playFeedback({ eventId: 'pending-11', sound: 'chip' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'after-gesture', sound: 'chip' }), true); sounds.dispose();
});

test('pagehide stops old sources even without visibilitychange and pageshow resumes only future cues', async () => {
  const f = audioFixture(), lifecycle = new Map();
  const win = { addEventListener: (type, listener) => lifecycle.set(type, listener), removeEventListener: type => lifecycle.delete(type) };
  const sounds = createTableSounds({ enabled: true, AudioContext: f.AudioContext, document: f.doc, window: win, fetch: f.fetcher });
  await sounds.unlock(); await sounds.preloadAudio();
  sounds.playFeedback({ eventId: 'before-pagehide', sound: 'chip', speech: 'raise' });
  const playing = [...f.stats.sources];
  lifecycle.get('pagehide')();
  assert.ok(playing.every(node => node.stopped));
  assert.equal(sounds.play('check'), false);
  lifecycle.get('pageshow')(); await Promise.resolve();
  assert.equal(sounds.playFeedback({ eventId: 'before-pagehide', sound: 'chip', speech: 'raise' }), false);
  assert.equal(sounds.playFeedback({ eventId: 'new-page-check', sound: 'check' }), true);
  sounds.dispose(); assert.equal(lifecycle.size, 0);
});
