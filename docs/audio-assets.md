# Table audio assets

## Mandarin action cues

`public/audio/{bet,raise,reraise,call,check,fold,allin}.wav` are locally generated
Mandarin cues: 下注、加注、再加注、跟注、过牌、弃牌、全下.
The model is **Kokoro-82M-v1.1-zh**, voice `zf_001`, speed `1.05`.
They are generated speech, not a recording of an identified user or a voice clone.
No game data or user text is sent to a speech service.

Model provenance: [hexgrad model card](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh),
published under Apache-2.0. The model card describes the licensed professional
Mandarin dataset. Inference uses [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)
(MIT) and [Misaki](https://github.com/hexgrad/misaki) (Apache-2.0).
Only generated WAV assets are served; model weights and build dependencies are
not part of the application, release package or source upload.

Rebuild in an isolated Python environment with `kokoro-onnx==0.6.1`,
`misaki[zh]==0.9.4`, `numpy` and `onnxruntime`:

1. Obtain `kokoro-v1.1-zh.onnx` and `voices-v1.1-zh.bin` from the
   [official wrapper release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1),
   and `config.json` from the [original model](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/blob/main/config.json).
2. Run `python scripts/generate-table-voices.py --model-dir /path/to/model --output public/audio`.
3. Run `node --test test/table-audio.test.js test/table-feedback.test.js`.

SHA-256 of the build inputs used for this asset set:

| Input | SHA-256 |
| --- | --- |
| `kokoro-v1.1-zh.onnx` | `859f9ded9f53be16c24857cdab3254a45da53c3afd5ba6ef134c7de3f822e326` |
| `voices-v1.1-zh.bin` | `14cb6186c99e4f6016871405f62046c5df863ae27465cbdc4ee08be7dd703acd` |
| `config.json` | `bc333efa5ce4ceff433c8c8e5d027a1eca0166001e4e4a62bea2d26ff7a46890` |

The build trims surplus silence with consonant-safe padding, applies short fades,
and keeps 6 dB peak headroom. Short same-origin PCM assets avoid differences in
browser/system voices and delayed online synthesis. A missing clip stays silent;
it is never queued and played after a later player's action.

## Chip effects

`chipContactSamples()` in `public/table-feedback.js` is original procedural foley.
It combines five irregular, rapidly damped material contacts with a quiet felt
tail. It has no high-pitched frequency sweep, downloaded sample or external
licensing dependency. A single 320 ms buffer is cached per audio context.
The seeded noise is only a sound effect and is unrelated to poker randomness.

Audio still requires an enabled preference and a user gesture; backgrounding,
muting and leaving a table stop playback. Action tracking continues to prevent
duplicate announcements on reconnect, stale frames and repeated renders.
