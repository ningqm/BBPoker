# Table audio assets

## Action voice cues

`public/audio/{bet,raise,reraise,call,check,fold,allin}.wav` are locally generated
Action cues: 下注、加注、再加注、跟注、过牌、弃牌、All-in.
The model is **Kokoro-82M-v1.1-zh**. Every cue, including All-in, uses the
same male speaker `zm_009` at speed `1.08`. At the user's request, All-in is
spoken like Mandarin **凹印** (ao1 yin4), generated through the same Mandarin
G2P as the other cues (`ㄠ1/阴4.` in the model's phoneme notation). Its UI label
remains All-in. This supersedes the previous English-phoneme pronunciation.
A 3:1 envelope compressor (normalized threshold 0.12, 4 ms look-ahead, 45 ms
release) evens out weak syllables. The target RMS is 0.145 with peak capped at
0.60; actual clips range 0.125–0.145 RMS. Clips retain 25 ms leading protection,
30 ms trailing padding and 4 ms fades. The Mandarin All-in lasts 0.833 seconds,
RMS 0.1340, peak 0.6000. The other six voice files
and user-selected chip recording are unchanged. Its SHA-256 is
`d2bf7cafd1a0a4df06ae6827c7ad2e088749db0c03a986fd9f100120d0b61193`.
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
   To rebuild only All-in, append `--cues allin`; `--allin-speed` defaults to `1.08`.
3. Run `node --test test/table-audio.test.js test/table-feedback.test.js`.
4. For a reviewable sample using the actual shipped files and playback gains,
   run `node scripts/preview-table-audio.mjs --output /tmp/bbpoker-audio-review.wav`.
   The sequence is chips alone, then 下注、加注、再加注、跟注、过牌、弃牌、All-in.

SHA-256 of the build inputs used for this asset set:

| Input | SHA-256 |
| --- | --- |
| `kokoro-v1.1-zh.onnx` | `859f9ded9f53be16c24857cdab3254a45da53c3afd5ba6ef134c7de3f822e326` |
| `voices-v1.1-zh.bin` | `14cb6186c99e4f6016871405f62046c5df863ae27465cbdc4ee08be7dd703acd` |
| `config.json` | `bc333efa5ce4ceff433c8c8e5d027a1eca0166001e4e4a62bea2d26ff7a46890` |

The build trims surplus silence with consonant-safe padding, applies short fades,
and keeps over 4 dB of peak headroom. Short same-origin PCM assets avoid differences in
browser/system voices and delayed online synthesis. A missing clip stays silent;
it is never queued and played after a later player's action.

## Chip effects

`public/audio/chips.wav` is the user-selected 929 ms **AllInPushChips.wav**
recording by Joma86 (CC0), decoded from its official public HQ MP3 preview.
Each betting sound plays the full recorded chip push once. Only flat attenuation
to a 0.95 peak is applied to prevent MP3 decoding overshoot; there is no EQ,
compression, pitch shift or repetition. See [source and reproducible
processing](chip-sound-source.md) for hashes, license and build instructions.

All media is preloaded from this website and decoded once per audio context.
Chip effects also load when voice is disabled. Missing/loading recordings stay
silent; there is no late playback or synthetic click fallback. The mix constants
are shared with the preview builder: chips alone 0.70, chips beneath an available
voice 0.42, voice 0.80 with a 25 ms onset. This gives the spoken word priority.

Chip recordings have their own playback channel: board, turn and countdown
prompts do not cut off the natural tail. A new betting-chip cue replaces an
unfinished chip cue instead of layering repeated impacts. Muting, backgrounding
and the explicit `stopPlayback()` lifecycle cleanup stop both effects and voices.
A later check/fold voice also ducks any surviving chip tail to the same 0.42
level before speech starts, so preserving a tail does not introduce clipping.

Audio still requires an enabled preference and a user gesture; backgrounding,
muting and leaving a table stop playback. Action tracking continues to prevent
duplicate announcements on reconnect, stale frames and repeated renders.

## Event-to-sound contract

- Only a new action in the current live hand can announce an action. Chat, buy-in,
  time-bank, profile updates and refunds are not betting sounds.
- If a response contains multiple actions, visuals may show all of them but audio
  describes only the latest action. A preceding raise must not add a chip sound to
  somebody else's subsequent fold or check.
- `{room, viewer, hand, action sequence}` identifies each playback event. Duplicate
  command/SSE hooks cannot replay its voice or chips, even after an audio toggle.
- A snapshot received over five seconds late is a silent restore. Call the tracker
  with the server-adjusted clock; missing `serverTime` stays backward compatible.
- Disconnection, backgrounding and first foreground state establish a silent
  baseline. Missing or still-loading clips are skipped, never queued for later.
- Render the corresponding state before calling `playFeedback` immediately; do
  not schedule historical action sounds behind board animations.

## Product references checked 2026-10-14

- [PokerStars sound settings](https://www.pokerstars.com/help/articles/sound-settings/)
  documents sound controls, individual desktop levels and preview. We retain
  separate voice/effect choices and supply a local preview for this review.
- [GGPoker table social features](https://legal.ggpoker.com/poker-games/table-social-features/)
  describes action-triggered voices and voice preview. We use short fixed action
  cues, not descriptions of unrelated UI events or chat messages.
- [PokerStars terminology](https://www.pokerstars.com/poker/learn/strategies/poker-terms-glossary/)
  uses All-in for committing the remaining stack and distinguishes Raise from a
  first Bet. The UI label stays All-in; its spoken cue is the Mandarin pronunciation specified above. Other Chinese cues stay 下注、加注、再加注、跟注、过牌、弃牌.
- [WPK's public site](https://www.wpk.com/) did not provide an inspectable sound
  specification. We do not claim its exact timbre, timing or voice pack was tested.

These references guide semantics and settings only. No WPK, GGPoker or PokerStars audio was copied or included. The separately
licensed Joma86 chip recording and generated neutral speech are the bundled sources.
The new voice is generated speech; whether its timbre is preferable remains a
listening decision for the user, not something unit tests can establish.
