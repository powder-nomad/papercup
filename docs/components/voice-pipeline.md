# Voice pipeline (VAD / STT / TTS)

The voice stack lives in `@papercup/voice-stack`. Node wrappers + Python sidecars (one for STT, one per TTS engine) + ONNX models.

## VAD: Silero

**Where:** `packages/voice-stack/src/vad/silero.ts` (Node, in-process via `onnxruntime-node`)

**Model:** `silero_vad.onnx` (~2.3 MB)

**Input:** 16 kHz mono float32 PCM, 512-sample (32 ms) windows.

**Critical detail:** the official Silero ONNX requires a **64-sample rolling context buffer** prepended to each window — the model actually sees `[1, 576]`, not `[1, 512]`. Without this, output is ~0.001 for everything including real speech. This was the original "VAD always says noise" bug.

```ts
import { SileroVad } from "@papercup/voice-stack/vad";

const vad = new SileroVad();
await vad.load();
for (const window of windows512) {
  const probability = await vad.run(window);  // 0..1
}
vad.reset();  // clears LSTM state + context
```

## STT: Whisper (via faster-whisper sidecar)

**Where:**
- Node client: `packages/voice-stack/src/stt/whisper.ts`
- Python sidecar: `packages/voice-stack/sidecar/stt.py`

**Model:** Configurable via `WHISPER_MODEL` env var. Defaults to `small` for multilingual TTS paths (`auto`/`melotts`/`xtts`), `base` for kokoro-only.

**Compute:** `int8` on CPU (fits 4-core homelab at ~0.3 RTF). Use `float16` on GPU.

**Wire protocol** (see top of `stt.py` for the spec):
- Node→sidecar: 8-byte header (req id, sample count) + float32 LE PCM
- Sidecar→Node: one JSON line per request: `{id, text, lang, duration, elapsed, rtf}`

The sidecar is one Python subprocess for the bot's lifetime. Restarting it costs ~1s of model load on cached weights.

```ts
import { WhisperSidecar } from "@papercup/voice-stack/stt";

const stt = new WhisperSidecar();
await stt.start();
const { text, rtf } = await stt.transcribe(mono16kFloat32);
```

## TTS: three engines + an auto-router

**Where:**
- Pluggable interface: `packages/voice-stack/src/tts/index.ts`
- Per-engine wrappers: `kokoro.ts`, `melotts.ts`, `xtts.ts`, `auto.ts`
- Python sidecars: `sidecar/tts_kokoro.py`, `tts_melotts.py`, `tts_xtts.py`

`TTS_ENGINE=auto` (default) routes per-utterance based on Whisper's detected language:

| Detected language | Engine | Why |
| --- | --- | --- |
| `ko` | MeloTTS or XTTS-v2 (picked via `TTS_KO_ENGINE`) | Kokoro doesn't ship Korean |
| anything else | Kokoro | Light, real-time on CPU |

### Kokoro

**Models:** `kokoro-v1.0.onnx` (~325 MB) + `kokoro-voices-v1.0.bin` (~28 MB)

**Native sample rate:** 24 kHz mono. Upsampled to 48 kHz stereo for Discord via `mono24kS16ToStereo48kS16`.

**Voices:** 54 loaded by default. American English (`af_*`, `am_*`), British (`bf_*`, `bm_*`), Japanese (`jf_*`, `jm_*`), Mandarin (`zf_*`, `zm_*`), and others.

**Languages:** en/ja/zh/es/fr/hi/it/pt. **No Korean.**

### MeloTTS (Korean — lightweight)

**Models:** ~200 MB (Korean voice + g2p) + ~440 MB (Korean BERT cached on first use).

**Native sample rate:** 44.1 kHz mono.

**Speakers:** 1 per language (no voice variety in Korean — single monotone speaker).

**Pre-warm:** loads ~17s on cached weights. `MELOTTS_PREWARM=0` defers to first KR call.

### XTTS-v2 (Korean — heavier, voice cloning)

**Model:** Coqui XTTS-v2 ~1.8 GB; speaker embeddings file ~7 MB.

**Native sample rate:** 24 kHz mono.

**Speakers:** ~58 built-in (Daisy Studious, Claribel Dervla, Gracie Wise, Damien Black, Andrew Chipper, …) + voice cloning via `XTTS_REFERENCE_WAV`.

**Pre-warm:** loads ~30s on cached weights. `XTTS_PREWARM=0` defers.

### Wire protocol (all sidecars share)

Mixed binary + line-buffered text:
- Node→sidecar: 8-byte header (req id, text byte length) + UTF-8 text
- Sidecar→Node: 16-byte header (id, ok flag, sample count, sample rate) + s16 LE PCM, then a JSON line

```ts
import { createTts } from "@papercup/voice-stack/tts";

const tts = createTts(process.env.TTS_ENGINE ?? "auto");
await tts.start();
const { pcm, sampleRate, durationMs } = await tts.synthesize("hello world", { lang: "en" });
```

## Audio plumbing

`packages/voice-stack/src/audio/`:

- `resample.ts` — 48 kHz s16 stereo (Discord output) → 16 kHz mono float32 (Silero/Whisper input). Decimates by 3 with L+R averaging. No anti-alias filter.
- `upsample.ts` — 24 kHz s16 mono (Kokoro output) → 48 kHz s16 stereo (Discord input). Linear interpolation 2× + duplicate to both channels.

Both are pure functions, no dependencies, easy to test in isolation.

## Adding a new TTS engine

Mirror the Kokoro impl. Three pieces:

1. New Python sidecar at `packages/voice-stack/sidecar/tts_<name>.py` with the same stdio framing
2. Node wrapper class implementing `TtsEngine` (`start()`, `synthesize()`, `stop()`)
3. Register in `createTts()` in `packages/voice-stack/src/tts/index.ts`

Then `TTS_ENGINE=<name>` in `.env` selects it.
