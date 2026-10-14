#!/usr/bin/env python3
"""Offline asset build only; no speech engine is deployed to BBPoker.

See docs/audio-assets.md for model provenance, downloads and dependencies.
"""
import argparse
import hashlib
import json
from pathlib import Path
import wave

import numpy as np
from kokoro_onnx import Kokoro
from misaki import zh


CUES = {"bet": "下注", "raise": "加注", "reraise": "再加注", "call": "跟注",
        "check": "过牌", "fold": "弃牌", "allin": "All-in"}


def steady_voice(samples, rate):
    """Offline, look-ahead envelope compression; no pitch change or hard clipping."""
    samples = samples / np.max(np.abs(samples))
    lookahead = round(rate * 0.004)
    future = np.pad(np.abs(samples), (0, lookahead))
    peaks = np.maximum.reduce([
        future[offset:offset + len(samples)] for offset in range(lookahead + 1)
    ])
    envelope, release = 0.0, np.exp(-1 / (rate * 0.045))
    gains = np.ones(len(samples))
    for index, peak in enumerate(peaks):
        envelope = max(peak, envelope * release)
        if envelope > 0.12:
            gains[index] = (0.12 / envelope) ** (1 - 1 / 3)
    samples *= gains
    rms = np.sqrt(np.mean(samples * samples))
    # Make quiet syllables audible while retaining over 4 dB of peak headroom.
    samples *= min(0.145 / rms, 0.60 / np.max(np.abs(samples)))
    return samples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--voice", default="zm_009")
    parser.add_argument("--speed", type=float, default=1.08)
    parser.add_argument("--allin-speed", type=float, default=1.08)
    parser.add_argument("--cues", nargs="+", choices=list(CUES), default=list(CUES))
    args = parser.parse_args()
    if not all(0.8 <= speed <= 1.3 for speed in (args.speed, args.allin_speed)):
        raise ValueError("Use a natural speech speed between 0.8 and 1.3")
    root = args.model_dir
    model = Kokoro(str(root / "kokoro-v1.1-zh.onnx"), str(root / "voices-v1.1-zh.bin"),
                   vocab_config=str(root / "config.json"))
    g2p = zh.ZHG2P(version="1.1")
    args.output.mkdir(parents=True, exist_ok=True)
    result = {}
    for name, text in CUES.items():
        if name not in args.cues:
            continue
        # The requested table call sounds like Mandarin "凹印" (ao1 yin4).
        # Keep the displayed action label All-in and the same speaker as other cues.
        spoken_text = "凹印" if name == "allin" else text
        phonemes = g2p(spoken_text + "。")[0]
        speed = args.allin_speed if name == "allin" else args.speed
        samples, rate = model.create(phonemes, voice=args.voice, speed=speed, is_phonemes=True)
        samples = np.asarray(samples, dtype=np.float64)
        samples -= samples.mean()
        # Trim padding only, preserving consonants plus natural start/end breaths.
        loud = np.flatnonzero(np.abs(samples) >= 0.004)
        if not loud.size:
            raise ValueError(f"Silent speech cue: {name}")
        start = max(0, int(loud[0]) - round(rate * 0.025))
        end = min(len(samples), int(loud[-1]) + round(rate * 0.030))
        samples = samples[start:end]
        samples = steady_voice(samples, rate)
        fade = min(round(rate * 0.004), len(samples) // 2)
        samples[:fade] *= np.linspace(0, 1, fade)
        samples[-fade:] *= np.linspace(1, 0, fade)
        if not 0.25 <= len(samples) / rate <= 1.6:
            raise ValueError(f"Unexpected cue duration: {name}: {len(samples) / rate:.3f}s")
        pcm = np.rint(samples * 32767).astype("<i2")
        path = args.output / (name + ".wav")
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(pcm.tobytes())
        result[name] = {"text": text, "spokenText": spoken_text,
                        "voice": args.voice, "speed": speed, "phonemes": phonemes,
                        "seconds": round(len(samples) / rate, 3),
                        "rms": round(float(np.sqrt(np.mean(samples * samples))), 4),
                        "peak": round(float(np.max(np.abs(samples))), 4),
                        "bytes": path.stat().st_size,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    print(json.dumps({"model": "Kokoro-82M-v1.1-zh", "voice": args.voice,
                      "speed": args.speed, "processing": {
                          "compressorRatio": 3, "normalizedThreshold": 0.12,
                          "lookaheadMs": 4, "releaseMs": 45,
                          "targetRms": 0.145, "peakCeiling": 0.6,
                      }, "cues": result},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
