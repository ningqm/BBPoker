#!/usr/bin/env python3
"""Build the user-selected BBPoker chip push from Joma86's CC0 recording.

Dependencies: numpy and soundfile with MP3 support. The source stays outside
the app. See docs/chip-sound-source.md for provenance and the source URL.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import wave

import numpy as np
import soundfile as sf


SOURCE_SHA256 = "e76b9c44412b7ba1bade5b8b24ef38f739ae1d824cbe2853d38214056af751d2"
PEAK = 0.95


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-mp3", type=Path, required=True)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).resolve().parents[1] / "public/audio/chips.wav")
    args = parser.parse_args()
    source = args.source_mp3.read_bytes()
    source_hash = hashlib.sha256(source).hexdigest()
    if source_hash != SOURCE_SHA256:
        raise SystemExit(f"Unexpected source hash: {source_hash}")

    samples, sample_rate = sf.read(io.BytesIO(source), dtype="float64", always_2d=True)
    if samples.shape[1] != 1:
        raise SystemExit("Expected the selected mono chip recording")
    samples = samples[:, 0]
    # Preserve the auditioned recording in full, once. Flat attenuation only:
    # the MP3 decoder can produce peaks slightly above full scale.
    decoded_peak = float(np.max(np.abs(samples)))
    gain = min(1.0, PEAK / decoded_peak)
    samples = samples * gain
    # Match the PCM16 quantization of the three-pass audition, without its
    # repetitions or inserted silence.
    pcm = np.floor(samples * 32768).astype("<i2")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())
    rendered = args.output.read_bytes()
    print(json.dumps({
        "source_sha256": source_hash,
        "output": str(args.output),
        "sample_rate": sample_rate,
        "channels": 1,
        "seconds": len(samples) / sample_rate,
        "decoded_source_peak": decoded_peak,
        "flat_gain": gain,
        "peak": float(np.max(np.abs(pcm.astype(float))) / 32768),
        "rms": float(np.sqrt(np.mean((pcm.astype(float) / 32768) ** 2))),
        "bytes": len(rendered),
        "sha256": hashlib.sha256(rendered).hexdigest(),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
