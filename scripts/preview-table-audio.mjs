#!/usr/bin/env node
// Offline review artifact: concatenate the shipped voice files and exact chip
// recording at runtime gains. This never connects to a room or speech service.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TABLE_AUDIO_MIX, TABLE_VOICE_CUES, TABLE_VOICE_LABELS } from '../public/table-feedback.js';

const index = process.argv.indexOf('--output');
if (index < 0 || !process.argv[index + 1]) throw new Error('Use --output /path/to/review.wav');
const output = resolve(process.argv[index + 1]), rate = 24000, chunks = [], marks = [];
let cursor = 0;
const push = samples => { chunks.push(samples); cursor += samples.length; };
const silence = seconds => push(new Float32Array(Math.round(rate * seconds)));
function readClip(type) {
  const wav = readFileSync(new URL(`../public/audio/${type}.wav`, import.meta.url));
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt16LE(20) !== 1 ||
      wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16 ||
      wav.toString('ascii', 36, 40) !== 'data') throw new Error(`Unsupported preview format: ${type}`);
  const sourceRate = wav.readUInt32LE(24), count = wav.readUInt32LE(40) / 2;
  const source = Float32Array.from({ length: count }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
  // Offline linear resampling for review; the browser decodes at its AudioContext rate.
  return Float32Array.from({ length: Math.round(count * rate / sourceRate) }, (_, i) => {
    const at = i * sourceRate / rate, lo = Math.floor(at), fraction = at - lo;
    return source[lo] * (1 - fraction) + source[Math.min(lo + 1, count - 1)] * fraction;
  });
}
const chipClip = readClip('chips');
const chips = (underVoice = false) => Float32Array.from(chipClip, value => value * (underVoice ? TABLE_AUDIO_MIX.chipsUnderVoice : TABLE_AUDIO_MIX.chips));
silence(0.15); marks.push({ label: '筹码', seconds: cursor / rate }); push(chips()); silence(0.6);
marks.push({ label: '过牌 · 敲桌', seconds: cursor / rate });
push(Float32Array.from(readClip('check-knock'), value => value * TABLE_AUDIO_MIX.check)); silence(0.45);
for (const type of TABLE_VOICE_CUES) {
  const voice = readClip(type), lead = Math.round(rate * TABLE_AUDIO_MIX.voiceLead);
  const contact = ['bet', 'raise', 'reraise', 'call', 'allin'].includes(type) ? chips(true) : new Float32Array();
  const samples = new Float32Array(Math.max(voice.length + lead, contact.length));
  for (let i = 0; i < voice.length; i++) samples[lead + i] = voice[i] * TABLE_AUDIO_MIX.voice;
  for (let i = 0; i < contact.length; i++) samples[i] += contact[i];
  marks.push({ label: TABLE_VOICE_LABELS[type], seconds: Math.round(cursor / rate * 1000) / 1000 });
  push(samples); silence(0.45);
}
const bytes = cursor * 2, data = Buffer.alloc(44 + bytes);
data.write('RIFF'); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32);
data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
let offset = 44;
for (const chunk of chunks) for (const sample of chunk) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), offset); offset += 2;
}
writeFileSync(output, data);
console.log(JSON.stringify({ output, seconds: cursor / rate, marks }, null, 2));
