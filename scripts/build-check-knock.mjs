#!/usr/bin/env node
// Render the exact browser algorithm to PCM16 WAV for reproducible audition.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheckKnockBuffer } from '../public/check-knock.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/build-check-knock.mjs [--output file.wav]');
const output = args[1] || fileURLToPath(new URL('../public/audio/check-knock.wav', import.meta.url));
const context = {
  createBuffer(channels, count, sampleRate) {
    const samples = new Float32Array(count);
    return { channels, length: count, sampleRate, getChannelData: () => samples };
  },
};
const rendered = createCheckKnockBuffer(context), samples = rendered.getChannelData(0);
const wav = Buffer.alloc(44 + samples.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rendered.sampleRate, 24); wav.writeUInt32LE(rendered.sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
let peak = 0, squared = 0, clipped = 0;
for (let i = 0; i < samples.length; i++) {
  const value = Math.round(samples[i] * 32768);
  wav.writeInt16LE(value, 44 + i * 2);
  peak = Math.max(peak, Math.abs(samples[i])); squared += samples[i] ** 2;
  if (Math.abs(value) >= 32767) clipped++;
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, wav);
console.log(JSON.stringify({ output, sample_rate: rendered.sampleRate, channels: 1,
  seconds: samples.length / rendered.sampleRate, frames: samples.length, peak,
  rms: Math.sqrt(squared / samples.length), clipped_samples: clipped, bytes: wav.length,
  sha256: createHash('sha256').update(wav).digest('hex') }, null, 2));
