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
        "check": "过牌", "fold": "弃牌", "allin": "全下"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--voice", default="zf_001")
    parser.add_argument("--speed", type=float, default=1.05)
    args = parser.parse_args()
    if not 0.8 <= args.speed <= 1.3:
        raise ValueError("Use a natural speech speed between 0.8 and 1.3")
    root = args.model_dir
    model = Kokoro(str(root / "kokoro-v1.1-zh.onnx"), str(root / "voices-v1.1-zh.bin"),
                   vocab_config=str(root / "config.json"))
    g2p = zh.ZHG2P(version="1.1")
    args.output.mkdir(parents=True, exist_ok=True)
    result = {}
    for name, text in CUES.items():
        phonemes, _ = g2p(text + "。")
        samples, rate = model.create(phonemes, voice=args.voice, speed=args.speed, is_phonemes=True)
        samples = np.asarray(samples, dtype=np.float64)
        samples -= samples.mean()
        # Trim padding only, preserving consonants plus natural start/end breaths.
        loud = np.flatnonzero(np.abs(samples) >= 0.004)
        if not loud.size:
            raise ValueError(f"Silent speech cue: {name}")
        start = max(0, int(loud[0]) - round(rate * 0.025))
        end = min(len(samples), int(loud[-1]) + round(rate * 0.055))
        samples = samples[start:end]
        # Leave 6 dB of peak headroom; playback volume is controlled separately.
        samples *= 0.50 / np.max(np.abs(samples))
        fade = min(round(rate * 0.006), len(samples) // 2)
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
        result[name] = {"text": text, "seconds": round(len(samples) / rate, 3),
                        "bytes": path.stat().st_size,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    print(json.dumps({"model": "Kokoro-82M-v1.1-zh", "voice": args.voice,
                      "speed": args.speed, "cues": result}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
