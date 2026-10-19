import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableSounds } from '../public/table-feedback.js';

// Model touch activation at release, rather than granting activation to a
// direct unlock() call. Real targets retain every lifecycle listener.
function fixture({ enabled = true, voiceEnabled = true } = {}) {
  let clock = 1000, timerId = 0, activatedEvent = false, policy = 'open';
  const timers = new Map(), pendingResumes = [], pendingSuspends = [];
  const stats = { contexts: [], resumes: 0, suspends: 0, closes: 0, sources: [], oscillators: [] };
  const timerApi = {
    setTimeout(fn, delay = 0) { const id = ++timerId; timers.set(id, { fn, at: clock + Number(delay) }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  function eventTarget() {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, fn, options) {
        if (!listeners.has(type)) listeners.set(type, new Map());
        listeners.get(type).set(fn, options);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); if (!listeners.get(type)?.size) listeners.delete(type); },
      dispatch(type, fields = {}) {
        const previous = activatedEvent;
        activatedEvent = type === 'touchend' || type === 'click' || type === 'keydown' ||
          (type === 'pointerup' && ['touch', 'pen'].includes(fields.pointerType)) ||
          (type === 'pointerdown' && fields.pointerType === 'mouse');
        const event = { type, isTrusted: true, ...fields };
        for (const listener of [...(listeners.get(type)?.keys() || [])]) listener(event);
        activatedEvent = previous;
      },
    };
  }
  const win = eventTarget(), doc = Object.assign(eventTarget(), { visibilityState: 'visible', defaultView: win });
  const node = () => ({
    connect(gain) { this.gain = gain; }, disconnect() {},
    start(at) { this.started = true; this.at = at; },
    stop(at) { if (at === undefined) this.stopped = true; else this.stopAt = at; },
  });
  class AudioContext {
    constructor() {
      this.state = 'suspended'; this.destination = {}; this.sampleRate = 22050;
      this.baseTime = 0; this.runningAt = clock; this.stalled = false;
      this.repairable = false; this.suspendedWhileStalled = false; this.listeners = new Map();
      this.deferNextSuspend = false; this.suspendGate = null;
      stats.contexts.push(this);
    }
    get currentTime() { return this.baseTime + (this.state === 'running' && !this.stalled ? (clock - this.runningAt) / 1000 : 0); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
    changeState(state) {
      this.baseTime = this.currentTime; this.runningAt = clock; this.state = state;
      this.listeners.get('statechange')?.();
    }
    resume() {
      stats.resumes++;
      if (policy !== 'open' && !activatedEvent) {
        if (policy === 'reject') return Promise.reject(new Error('touch release required'));
        return new Promise((resolve, reject) => pendingResumes.push({ context: this, resolve, reject }));
      }
      const complete = () => {
        if (this.stalled && this.repairable && this.suspendedWhileStalled) this.stalled = false;
        this.changeState('running');
      };
      if (this.suspendGate) return new Promise(resolve => this.suspendGate.queued.push(() => { complete(); resolve(); }));
      complete(); return Promise.resolve();
    }
    suspend() {
      stats.suspends++; if (this.stalled) this.suspendedWhileStalled = true;
      if (this.deferNextSuspend) {
        this.deferNextSuspend = false;
        return new Promise(resolve => {
          const gate = { queued: [], resolve: () => {
            this.changeState('suspended'); this.suspendGate = null; resolve();
            for (const resume of gate.queued) resume();
          } };
          this.suspendGate = gate; pendingSuspends.push(gate);
        });
      }
      this.changeState('suspended'); return Promise.resolve();
    }
    close() { stats.closes++; this.changeState('closed'); return Promise.resolve(); }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBuffer(channels, count, sampleRate) { return { duration: count / sampleRate, getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { const result = { ...node(), playbackRate: { setValueAtTime() {} } }; stats.sources.push(result); return result; }
    createOscillator() { const result = { ...node(), frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; stats.oscillators.push(result); return result; }
    decodeAudioData() { return Promise.resolve({ duration: 0.4 }); }
  }
  const sounds = createTableSounds({ enabled, voiceEnabled, AudioContext, document: doc, window: win,
    now: () => clock, ...timerApi,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
  });
  return {
    stats, doc, win, sounds, timers, pendingResumes, pendingSuspends, flush,
    setPolicy(value) { policy = value; },
    async event(type, fields) { doc.dispatch(type, fields); await flush(); },
    async windowEvent(type, fields) { win.dispatch(type, fields); await flush(); },
    async visibility(value) { doc.visibilityState = value; doc.dispatch('visibilitychange'); await flush(); },
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = Math.max(clock, next[1].at); timers.delete(next[0]); next[1].fn(); await flush();
      }
      clock = end; await flush();
    },
  };
}

for (const policy of ['reject', 'pending']) {
  for (const release of ['pointerup', 'touchend', 'click']) {
    test(`a ${policy} foreground resume recovers on ordinary ${release} without using the sound menu`, async () => {
      const f = fixture();
      try {
        await f.event('click'); await f.sounds.preloadAudio();
        assert.equal(f.sounds.playFeedback({ eventId: 'before-hidden', sound: 'chip', speech: 'call' }), true);
        const previous = [...f.stats.sources];
        await f.visibility('hidden'); f.setPolicy(policy); await f.visibility('visible');
        assert.ok(previous.every(source => source.stopped));
        assert.equal(f.sounds.playFeedback({ eventId: 'missed', sound: 'chip', speech: 'raise' }), false);
        const attempts = f.stats.resumes;
        await f.event('pointerdown', { pointerType: 'touch' });
        assert.equal(f.stats.resumes, attempts, 'touch press is not treated as the browser activation event');
        await f.event(release, { pointerType: 'touch' });
        assert.equal(f.stats.contexts.length, 1, 'policy recovery reuses the working context');
        assert.equal(f.stats.contexts[0].state, 'running');
        assert.equal(f.sounds.playFeedback({ eventId: 'missed', sound: 'chip', speech: 'raise' }), false, 'no missed action is replayed');
        assert.equal(f.sounds.playFeedback({ eventId: 'fresh', sound: 'chip', speech: 'allin', yourTurnId: 'fresh-turn' }), true);
        assert.ok(f.stats.sources.length > previous.length);
        assert.ok(f.stats.oscillators.length > 0, 'turn bell recovers alongside recorded action sounds');
        for (const old of f.pendingResumes) old.reject(new Error('late policy failure'));
        await f.flush(); await f.advance(400);
        assert.equal(f.sounds.play('countdown'), true, 'late rejection cannot relock the successful gesture');
      } finally { f.sounds.dispose(); }
    });
  }
}

test('healthy mouse, touch, click and keyboard activity does not interrupt or resume an already playing context', async () => {
  const f = fixture();
  try {
    await f.event('pointerdown', { pointerType: 'mouse' }); await f.sounds.preloadAudio();
    assert.equal(f.stats.contexts.length, 1);
    assert.equal(f.sounds.speak('call'), true); const voice = f.stats.sources.at(-1);
    const resumes = f.stats.resumes, suspends = f.stats.suspends;
    for (const [event, fields] of [['pointerdown', { pointerType: 'touch' }], ['pointerup', { pointerType: 'touch' }], ['touchend', {}], ['click', {}], ['keydown', { key: 'Tab' }]]) await f.event(event, fields);
    assert.equal(f.stats.resumes, resumes); assert.equal(f.stats.suspends, suspends);
    assert.equal(voice.stopped, undefined, 'browsing the table should not cut off a live voice');
  } finally { f.sounds.dispose(); }
});

test('disabled sound never creates a context or reenables itself on gestures, foreground or restore', async () => {
  const f = fixture({ enabled: false });
  try {
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) await f.event(type, { pointerType: 'touch' });
    await f.visibility('hidden'); await f.visibility('visible'); f.sounds.restore(); await f.advance(2000);
    assert.equal(f.stats.contexts.length, 0); assert.equal(f.stats.resumes, 0);
    assert.equal(f.sounds.play('check'), false);
  } finally { f.sounds.dispose(); }
});

test('voice-disabled preference survives a policy-blocked return while checks and turn bells recover', async () => {
  const f = fixture({ voiceEnabled: false });
  try {
    await f.event('touchend'); await f.sounds.preloadAudio();
    await f.visibility('hidden'); f.setPolicy('reject'); await f.visibility('visible');
    await f.event('touchend');
    assert.equal(f.sounds.speak('allin'), false);
    assert.equal(f.sounds.play('check'), true);
    assert.equal(f.sounds.playFeedback({ yourTurnId: 'returned' }), true);
  } finally { f.sounds.dispose(); }
});

test('public restore lets an already activated native foreground recover without another menu action', async () => {
  const f = fixture();
  try {
    await f.event('click'); f.sounds.suspend();
    assert.equal(f.sounds.play('check'), false);
    f.sounds.restore(); await f.flush();
    assert.equal(f.sounds.play('check'), true);
  } finally { f.sounds.dispose(); }
});

test('a genuinely advancing context passes the foreground watchdog without a suspend or replacement', async () => {
  const f = fixture();
  try {
    await f.event('click'); await f.visibility('hidden'); await f.visibility('visible');
    const resumed = f.stats.resumes, suspended = f.stats.suspends, old = f.stats.contexts[0];
    await f.advance(2400);
    assert.ok(old.currentTime > 0); assert.equal(f.stats.resumes, resumed);
    assert.equal(f.stats.suspends, suspended); assert.equal(f.stats.contexts.length, 1);
    assert.equal(f.sounds.play('check'), true);
  } finally { f.sounds.dispose(); }
});

test('a running-but-stalled foreground context receives one bounded suspend/resume repair', async () => {
  const f = fixture();
  try {
    await f.event('click'); const old = f.stats.contexts[0];
    old.stalled = true; old.repairable = true;
    await f.windowEvent('focus'); const suspended = f.stats.suspends, resumed = f.stats.resumes;
    await f.advance(799); assert.equal(f.stats.suspends, suspended, 'allow the audio clock time to advance first');
    await f.advance(1);
    assert.equal(f.stats.suspends, suspended + 1); assert.equal(f.stats.resumes, resumed + 1);
    await f.advance(2400);
    assert.equal(f.stats.suspends, suspended + 1); assert.equal(f.stats.contexts.length, 1);
    assert.ok(old.currentTime > 0); assert.equal(f.sounds.play('check'), true);
  } finally { f.sounds.dispose(); }
});

test('a slow foreground resume starts its progress check after success rather than losing the check while suspended', async () => {
  const f = fixture();
  try {
    await f.event('click'); await f.visibility('hidden');
    f.setPolicy('pending'); await f.visibility('visible');
    await f.advance(900);
    const old = f.stats.contexts[0];
    assert.equal(old.state, 'suspended');
    old.stalled = true; old.repairable = true; f.setPolicy('open');
    for (const pending of f.pendingResumes) { pending.context.changeState('running'); pending.resolve(); }
    await f.flush(); const suspended = f.stats.suspends;
    await f.advance(799); assert.equal(f.stats.suspends, suspended);
    await f.advance(1);
    assert.equal(f.stats.suspends, suspended + 1, 'late successful resume must still be checked for a frozen rendering clock');
    await f.advance(800); assert.ok(old.currentTime > 0);
    assert.equal(f.stats.contexts.length, 1);
  } finally { f.sounds.dispose(); }
});

test('a persistently stalled context is replaced only by a real release gesture and never replays old sounds', async () => {
  const f = fixture();
  try {
    await f.event('click'); await f.sounds.preloadAudio();
    f.sounds.playFeedback({ eventId: 'old-action', sound: 'chip', speech: 'raise' });
    const oldSources = [...f.stats.sources], old = f.stats.contexts[0]; old.stalled = true;
    await f.windowEvent('focus'); await f.advance(2400);
    assert.equal(f.stats.contexts.length, 1, 'watchdog must not create new contexts outside a gesture');
    const suspended = f.stats.suspends;
    await f.advance(8000); assert.equal(f.stats.suspends, suspended, 'persistent failure cannot become an automatic recovery loop');
    await f.event('pointerdown', { pointerType: 'touch' }); assert.equal(f.stats.contexts.length, 1);
    await f.event('touchend'); await f.sounds.preloadAudio();
    assert.equal(f.stats.contexts.length, 2); assert.equal(old.state, 'closed');
    assert.ok(oldSources.every(source => source.stopped)); assert.equal(old.listeners.size, 0);
    assert.equal(f.sounds.playFeedback({ eventId: 'old-action', sound: 'chip', speech: 'raise' }), false);
    assert.equal(f.sounds.playFeedback({ eventId: 'new-action', sound: 'chip', speech: 'call' }), true);
  } finally { f.sounds.dispose(); }
});

test('a failed suspend repair of a frozen running context remains recoverable with an ordinary tap', async () => {
  const f = fixture();
  try {
    await f.event('click'); const old = f.stats.contexts[0]; old.stalled = true;
    old.suspend = () => { f.stats.suspends++; return Promise.reject(new Error('audio route rejected suspend')); };
    await f.windowEvent('focus'); await f.advance(800);
    assert.equal(old.state, 'running'); assert.equal(f.stats.contexts.length, 1);
    await f.event('touchend');
    assert.equal(f.stats.contexts.length, 2, 'a rejected repair must not leave the next tap in the running-context fast path');
    assert.equal(old.state, 'closed');
    assert.equal(f.sounds.play('check'), true);
  } finally { f.sounds.dispose(); }
});

test('a tap during a pending watchdog suspend queues a gesture-authorized resume after that suspend', async () => {
  const f = fixture();
  try {
    await f.event('click'); const old = f.stats.contexts[0];
    old.stalled = true; old.repairable = true; old.deferNextSuspend = true;
    await f.windowEvent('focus'); await f.advance(800);
    assert.equal(f.pendingSuspends.length, 1); assert.equal(old.state, 'running');
    f.setPolicy('reject'); const attempts = f.stats.resumes;
    await f.event('touchend');
    assert.equal(f.stats.resumes, attempts + 1, 'the pending suspend needs a resume request while the tap is still activated');
    f.pendingSuspends[0].resolve(); await f.flush();
    assert.equal(old.state, 'running', 'late suspension must not undo the user gesture and leave the table silent');
    assert.equal(f.stats.contexts.length, 1);
    assert.equal(f.sounds.play('check'), true);
    await f.advance(1600); assert.ok(old.currentTime > 0);
  } finally { f.sounds.dispose(); }
});

for (const terminal of ['hidden', 'muted', 'disposed']) {
  test(`a pending recovery and watchdog cannot reactivate ${terminal} audio`, async () => {
    const f = fixture();
    try {
      await f.event('click'); await f.visibility('hidden'); f.setPolicy('pending'); await f.visibility('visible');
      assert.ok(f.pendingResumes.length > 0);
      if (terminal === 'hidden') await f.visibility('hidden');
      else if (terminal === 'muted') f.sounds.setEnabled(false);
      else f.sounds.dispose();
      for (const pending of f.pendingResumes) { pending.context.changeState('running'); pending.resolve(); }
      await f.flush(); const resumes = f.stats.resumes, contexts = f.stats.contexts.length;
      await f.advance(4000); await f.event('touchend');
      assert.equal(f.stats.resumes, resumes); assert.equal(f.stats.contexts.length, contexts);
      assert.equal(f.sounds.play('check'), false);
      assert.equal(f.timers.size, 0);
    } finally { f.sounds.dispose(); }
  });
}

test('dispose removes every gesture/lifecycle listener and all recovery timers', async () => {
  const f = fixture();
  await f.event('click'); f.stats.contexts[0].stalled = true;
  await f.windowEvent('focus');
  assert.ok(f.doc.listeners.size > 1); assert.ok(f.win.listeners.size > 0);
  f.sounds.dispose();
  assert.equal(f.doc.listeners.size, 0); assert.equal(f.win.listeners.size, 0); assert.equal(f.timers.size, 0);
  const contexts = f.stats.contexts.length;
  await f.event('click'); await f.advance(2000); assert.equal(f.stats.contexts.length, contexts);
});
