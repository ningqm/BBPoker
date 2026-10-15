import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCheckKnockBuffer } from '../public/check-knock.js';

function audioContext(sampleRate = 48000) {
  return { sampleRate, createBuffer(channels, length, rate) {
    const samples = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate: rate,
      duration: length / rate, getChannelData: channel => { assert.equal(channel, 0); return samples; } };
  } };
}

test('offline check knock and audition WAV match sample by sample', () => {
  const buffer = createCheckKnockBuffer(audioContext());
  const wav = readFileSync(new URL('../public/audio/check-knock.wav', import.meta.url));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), buffer.numberOfChannels);
  assert.equal(wav.readUInt32LE(24), buffer.sampleRate);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), buffer.length * 2);
  const samples = buffer.getChannelData(0);
  let largestError = 0;
  for (let i = 0; i < samples.length; i++) {
    largestError = Math.max(largestError, Math.abs(samples[i] * 32768 - wav.readInt16LE(44 + i * 2)));
  }
  assert.ok(largestError <= 1, `PCM difference: ${largestError}`);
});

test('check knock is deterministic across context rates and has two clear, unclipped soft impacts', () => {
  const first = createCheckKnockBuffer(audioContext(22050));
  const next = createCheckKnockBuffer(audioContext(48000));
  assert.equal(first.sampleRate, 44100); assert.equal(first.numberOfChannels, 1);
  assert.equal(first.duration, 0.36);
  const samples = first.getChannelData(0);
  assert.deepEqual(samples, next.getChannelData(0));
  assert.equal(samples[0], 0); assert.equal(samples.at(-1), 0);
  const rms = (start, end) => {
    const values = samples.slice(Math.round(start * first.sampleRate), Math.round(end * first.sampleRate));
    return Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
  };
  const peak = samples.reduce((max, value) => { assert.ok(Number.isFinite(value)); return Math.max(max, Math.abs(value)); }, 0);
  assert.ok(peak >= 0.8 && peak < 0.9);
  assert.ok(rms(0, 0.12) > 0.08, 'first knock is audible');
  assert.ok(rms(0.145, 0.265) > 0.08, 'second knock is audible');
  assert.ok(rms(0.12, 0.14) < 0.01, 'separate the two knocks with a quiet gap');
  assert.ok(rms(0.33, 0.36) < 0.002, 'the sound ends without a long ringing tail');
});
