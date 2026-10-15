#!/usr/bin/env python3
"""Build short table-check cues from explicitly licensed CC0 field recordings.

Requires numpy + soundfile with MP3 decoding. Download inputs separately from
the original author's official preview URLs in docs/check-knock-sound.md.
There is no network request in this script or in the resulting browser module.
"""
import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import wave

import numpy as np
import soundfile as sf

RATE = 44100
SOURCES = {
    "462317": "257a830b3ca7facabff9bb8bd0b920e99bc061151007690160bf779837df6d0a",
    "560225": "120f19cfaf9714fb394610d101cd432bab03f08049e501a058a82a080d54a2e8",
}
VARIANTS = [
    # Two different real impacts, not one impact copied or synthesized twice.
    dict(name="01-natural-double-tap", source="462317", starts=[.252, .451],
         hp=105, lp=3000, gap=.165, length=.150, tail=.055, peak=.80),
    dict(name="02-light-double-tap", source="462317", starts=[.252, .451],
         hp=165, lp=3600, gap=.145, length=.125, tail=.045, peak=.73),
    dict(name="03-wood-double-tap", source="560225", starts=[.676, 1.017],
         hp=90, lp=2600, gap=.175, length=.155, tail=.060, peak=.78),
]


def biquad(x, cutoff, highpass=False):
    """Second-order Butterworth; no external DSP runtime or random input."""
    omega = 2 * math.pi * cutoff / RATE
    cs, sn = math.cos(omega), math.sin(omega)
    alpha = sn / math.sqrt(2)
    if highpass:
        b = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2]
    else:
        b = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2]
    a = [1 + alpha, -2 * cs, 1 - alpha]
    b = [v / a[0] for v in b]
    a = [v / a[0] for v in a]
    result = np.zeros(len(x), dtype=np.float64)
    z1 = z2 = 0.0
    for i, value in enumerate(x):
        out = b[0] * value + z1
        z1 = b[1] * value - a[1] * out + z2
        z2 = b[2] * value - a[2] * out
        result[i] = out
    return result


def render(source, variant):
    output = np.zeros(round(.36 * RATE), dtype=np.float64)
    for index, onset in enumerate(variant["starts"]):
        clip = source[round(onset * RATE):round((onset + variant["length"]) * RATE)].copy()
        clip -= np.mean(clip)
        clip = biquad(biquad(clip, variant["hp"], True), variant["lp"])
        # Keep the attack and real early resonance; taper only the room tail.
        fade_in = round(.003 * RATE)
        fade_out = round(variant["tail"] * RATE)
        clip[:fade_in] *= np.linspace(0, 1, fade_in)
        clip[-fade_out:] *= np.linspace(1, 0, fade_out) ** 1.5
        clip *= (1 if index == 0 else .84) / np.max(np.abs(clip))
        offset = round((.004 + index * variant["gap"]) * RATE)
        output[offset:offset + len(clip)] += clip
    output *= variant["peak"] / np.max(np.abs(output))
    return np.rint(output * 32767).astype("<i2")


def write_wav(path, pcm):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(pcm.tobytes())


def write_module(path, pcm):
    encoded = base64.b64encode(pcm.tobytes()).decode("ascii")
    chunks = " +\n".join("  '" + encoded[i:i + 120] + "'" for i in range(0, len(encoded), 120))
    path.write_text("""// Recorded table taps by Rvgerxini, CC0 1.0; Freesound sound 462317.
// Cropped, filtered and faded by scripts/build-recorded-check-knock.py.
// Embedded PCM prevents a network/decode race swallowing the first check.
// See docs/check-knock-sound.md for source, permission and reproducibility.
const SAMPLE_RATE = 44100;
const PCM16_BASE64 =
""" + chunks + ";\n\n" + """let samples;
function recordedSamples() {
  if (!samples) {
    const bytes = atob(PCM16_BASE64);
    samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) {
      const unsigned = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8);
      samples[i] = (unsigned >= 32768 ? unsigned - 65536 : unsigned) / 32768;
    }
  }
  return samples;
}

export function createCheckKnockBuffer(context) {
  const pcm = recordedSamples();
  const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(pcm);
  return buffer;
}
""")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--install-app", type=Path)
    args = parser.parse_args()
    sources = {}
    for sid, expected in SOURCES.items():
        path = args.source_dir / f"{sid}.mp3"
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f"Source {sid} hash mismatch: {actual}")
        x, rate = sf.read(path, always_2d=True, dtype="float64")
        x = x.mean(axis=1)
        if rate != RATE:
            # Both sources have negligible energy near Nyquist; candidate 3 is
            # subsequently low-passed at 2.6 kHz. Selected candidate is 44.1 kHz.
            x = np.interp(np.arange(round(len(x) * RATE / rate)) / RATE, np.arange(len(x)) / rate, x)
        sources[sid] = x
    results = []
    for variant in VARIANTS:
        pcm = render(sources[variant["source"]], variant)
        path = args.output_dir / f'{variant["name"]}.wav'
        write_wav(path, pcm)
        value = pcm.astype(float) / 32768
        results.append({**variant, "path": str(path), "duration": len(pcm) / RATE,
                        "rms": float(np.sqrt(np.mean(value ** 2))),
                        "actual_peak": float(np.max(np.abs(value))),
                        "clipped": int(np.sum(np.abs(pcm.astype(int)) >= 32767)),
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        if args.install_app and variant == VARIANTS[0]:
            write_wav(args.install_app / 'public/audio/check-knock.wav', pcm)
            write_module(args.install_app / 'public/check-knock.js', pcm)
    (args.output_dir / 'manifest.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
