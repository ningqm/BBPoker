import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayPlayback, replaySnapshot, REPLAY_SPEEDS } from '../public/replay.js';

function clock() {
  let now = 0, next = 0;
  const jobs = new Map(), all = new Map();
  return {
    setTimer(fn, delay) { const id = ++next; const job = { fn, at: now + delay }; jobs.set(id, job); all.set(id, job); return id; },
    clearTimer(id) { jobs.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...jobs].filter(([,job]) => job.at <= target).sort((a,b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id,job] = due; jobs.delete(id); now = job.at; job.fn();
      }
      now = target;
    },
    queued() { return jobs.size; },
    captured() { return [...all.values()].map(job => job.fn); },
  };
}

function fixture(total = 8) {
  const timer = clock(), frames = [];
  const playback = createReplayPlayback({ total, ...timer, onChange: state => frames.push(state) });
  return { timer, frames, playback };
}

test('automatic replay advances one frame at a time and pauses at the final frame', () => {
  const { timer, playback, frames } = fixture(3);
  assert.equal(playback.snapshot().playing, false);
  playback.play(); timer.advance(999); assert.equal(playback.snapshot().index, 0);
  timer.advance(1); assert.equal(playback.snapshot().index, 1);
  timer.advance(2000); assert.equal(playback.snapshot().index, 3);
  assert.equal(playback.snapshot().playing, false); assert.equal(timer.queued(), 0);
  timer.advance(100000); assert.deepEqual(frames.map(frame => frame.index), [0, 1, 2, 3]);
  playback.play(); assert.equal(playback.snapshot().index, 0); assert.equal(timer.queued(), 1);
});

test('speed changes keep the cursor and only a single new timeout, including slow and 4x playback', () => {
  const { timer, playback } = fixture(20);
  assert.deepEqual(REPLAY_SPEEDS, [0.5, 1, 1.5, 2, 4]);
  playback.play(); timer.advance(500); playback.setSpeed(2);
  timer.advance(499); assert.equal(playback.snapshot().index, 0);
  timer.advance(1); assert.equal(playback.snapshot().index, 1); assert.equal(timer.queued(), 1);
  playback.setSpeed(4); timer.advance(500); assert.equal(playback.snapshot().index, 3);
  playback.setSpeed(0.5); timer.advance(1999); assert.equal(playback.snapshot().index, 3);
  timer.advance(1); assert.equal(playback.snapshot().index, 4);
  assert.equal(playback.setSpeed(Infinity), false); assert.equal(playback.setSpeed(0), false);
  assert.equal(playback.snapshot().speed, 0.5);
});

test('pause and dispose invalidate already queued callbacks and never restart themselves', () => {
  const { timer, playback, frames } = fixture();
  playback.play(); const stale = timer.captured()[0];
  playback.pause(); stale(); timer.advance(60000);
  assert.equal(playback.snapshot().index, 0); assert.equal(timer.queued(), 0);
  playback.play(); const old = timer.captured().at(-1); playback.dispose();
  const count = frames.length; old(); stale(); playback.play(); playback.seek(3); playback.setSpeed(2);
  assert.equal(frames.length, count); assert.equal(timer.queued(), 0); assert.equal(playback.snapshot().playing, false);
});

test('dragging pauses playback, supports continuous seeks and resumes only if it was playing', () => {
  const { timer, playback } = fixture();
  playback.play(); timer.advance(1000); playback.beginScrub();
  playback.seek(4); playback.seek(6); timer.advance(20000);
  assert.equal(playback.snapshot().index, 6); assert.equal(playback.snapshot().playing, false);
  assert.equal(timer.queued(), 0); playback.endScrub();
  assert.equal(playback.snapshot().playing, true); timer.advance(1000); assert.equal(playback.snapshot().index, 7);
  playback.pause(); playback.beginScrub(); playback.seek(2); playback.endScrub();
  assert.equal(playback.snapshot().playing, false); assert.equal(timer.queued(), 0);
});

test('seeking to the end during play never auto-restarts and an interrupted drag stays paused', () => {
  const { timer, playback } = fixture();
  playback.play(); playback.beginScrub(); playback.seek(999); playback.endScrub();
  assert.equal(playback.snapshot().index, 8); assert.equal(playback.snapshot().playing, false);
  playback.play(); playback.beginScrub(); playback.seek(3); playback.pause(); playback.endScrub();
  assert.equal(playback.snapshot().playing, false); assert.equal(timer.queued(), 0);
  playback.play(); playback.beginScrub(); playback.seek(2); playback.endScrub({ resume: false });
  assert.equal(playback.snapshot().playing, false);
});

test('step and street navigation pause at a bounded cursor and do not reveal later cards', () => {
  const { timer, playback } = fixture(4);
  const hand = { players: [
    { id: 'me', cards: ['As','Ah'], startingStack: 100 },
    { id: 'friend', cards: ['Ks','Kh'], startingStack: 100 },
  ], log: [
    { type: 'check', playerId: 'me' },
    { type: 'street', street: 'flop', board: ['Ac','Kd','2s'] },
    { type: 'check', playerId: 'friend' },
    { type: 'street', street: 'turn', board: ['Ac','Kd','2s','3h'] },
  ] };
  playback.play(); timer.advance(3000); playback.seek(1);
  let frame = replaySnapshot(hand, playback.snapshot().index, 'me');
  assert.deepEqual(frame.board, []); assert.deepEqual(frame.players[1].cards, [null,null]);
  assert.deepEqual(frame.players[0].cards, ['As','Ah']); assert.equal(playback.snapshot().playing, false);
  playback.seek(4); frame = replaySnapshot(hand, playback.snapshot().index, 'me');
  assert.deepEqual(frame.players[1].cards, ['Ks','Kh']); playback.seek(-5);
  assert.equal(playback.snapshot().index, 0); assert.equal(playback.seek(NaN), false);
});

test('a replay closed or repositioned by its render callback cannot schedule a stale second timer', () => {
  const timer = clock(); let playback;
  playback = createReplayPlayback({ total: 5, ...timer, onChange: state => { if (state.index === 1) playback.setSpeed(4); } });
  playback.play(); timer.advance(1000); assert.equal(timer.queued(), 1);
  timer.advance(250); assert.equal(playback.snapshot().index, 2);
  playback.dispose();
  playback = createReplayPlayback({ total: 5, ...timer, onChange: state => { if (state.index === 1) playback.dispose(); } });
  playback.play(); timer.advance(1000); assert.equal(timer.queued(), 0);
});

test('empty timelines and invalid configuration cannot start or allocate a timer', () => {
  for (const total of [0, -1, NaN, 1.5, Infinity]) {
    const { timer, playback } = fixture(total);
    assert.equal(playback.play(), false); assert.equal(timer.queued(), 0);
    assert.equal(playback.snapshot().total, 0);
  }
});
