// Original synthesized BBPoker Foley. No network, voices or external samples.
// scripts/build-check-knock.mjs renders this exact buffer to the review WAV.
const SAMPLE_RATE = 44100;
const DURATION = 0.360;
const PEAK = 0.86;
const MODES = [[212, 0.84, 0.032], [367, 0.49, 0.023], [639, 0.31, 0.016], [1073, 0.19, 0.010], [1789, 0.09, 0.006]];

function seededNoise() {
  let seed = 947113;
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

export function createCheckKnockBuffer(context) {
  const random = seededNoise();
  const samples = new Float64Array(Math.round(SAMPLE_RATE * DURATION));
  // Soft contact excites inharmonic wood modes; the second knuckle is lighter.
  for (const [onset, strength, pitch] of [[0.006, 1, 1], [0.145, 0.89, 0.96]]) {
    const start = Math.round(onset * SAMPLE_RATE);
    const phases = MODES.map(() => random() * 0.36 - 0.18);
    let low = 0, slow = 0, contact = 0;
    for (let offset = 0; start + offset < samples.length; offset++) {
      const t = offset / SAMPLE_RATE, white = random() * 2 - 1;
      low += 0.29 * (white - low);
      slow += 0.038 * (white - slow);
      contact += 0.53 * (white - contact);
      const air = (low - slow) * Math.exp(-t / 0.018);
      const tap = (contact - low) * Math.exp(-t / 0.0035);
      let body = 0;
      for (let i = 0; i < MODES.length; i++) {
        const [hz, amplitude, decay] = MODES[i];
        body += amplitude * Math.exp(-t / decay) * Math.cos(2 * Math.PI * hz * pitch * t + phases[i]);
      }
      const attack = 1 - Math.exp(-t / 0.0008);
      samples[start + offset] += strength * attack * (0.39 * body + 1.45 * air + 0.36 * tap);
    }
  }
  let mean = 0;
  for (const value of samples) mean += value;
  mean /= samples.length;
  for (let i = 0; i < samples.length; i++) samples[i] -= mean;
  const fadeFrames = Math.round(SAMPLE_RATE * 0.005);
  for (let i = 0; i < fadeFrames; i++) {
    const gain = i / fadeFrames;
    samples[i] *= gain;
    samples[samples.length - 1 - i] *= gain;
  }
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const gain = PEAK / peak;
  const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
  const output = buffer.getChannelData(0);
  // PCM16 quantization makes the in-browser buffer match the review WAV.
  for (let i = 0; i < output.length; i++) output[i] = Math.round(samples[i] * gain * 32767) / 32768;
  return buffer;
}
