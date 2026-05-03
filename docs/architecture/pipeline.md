# Pipeline stages

Every conversational turn flows through these stages. Each has a distinctive log signature for diagnosis.

| # | Stage | Implementation | Failure signature |
| - | --- | --- | --- |
| 1 | Discord gateway | discord.js Client | `Used disallowed intents`, `Invalid token` |
| 2 | Voice connect | @discordjs/voice + DAVE | stuck in `connecting → signalling`, never `ready` |
| 3 | Audio capture | receiver subscription, Opus → PCM via prism-media | no `[capture] first opus frame` after speaking |
| 4 | Resample | 48kHz s16 stereo → 16kHz mono f32 | s16 peak high but f32 peak ~0 |
| 5 | VAD | Silero ONNX, 32ms windows w/ 64-sample context | every utterance flagged `noise-only` |
| 6 | STT | faster-whisper (Python sidecar) | `[stt] sidecar exited`, empty transcripts |
| 7 | Speaker agent | claude-code / codex / anthropic-api | `[agent] llm failed`, agent claims it can't do things it should |
| 8 | TTS | Kokoro via kokoro-onnx (Python sidecar) | `[tts] synth failed` |
| 9 | Upsample | 24kHz mono → 48kHz stereo s16 | playback sounds half-speed or chipmunky |
| 10 | Audio playback | createAudioPlayer + Discord voice | `[player] error`, audio silent on the call |

## Latency budget

Per-turn loop on a 4-core CPU homelab:

| Stage | Cost |
| --- | --- |
| End-of-utterance silence | `SILENCE_MS=600` |
| Whisper STT (`small` int8) | ~0.5-0.8 RTF (multilingual default) |
| Whisper STT (`base.en` int8) | ~0.3-0.5 RTF (English-only path) |
| Speaker agent | ~5-8s for CLI backends, ~0.5-1.5s for direct API |
| Kokoro TTS (en/ja/zh/es/fr/hi/it/pt) | ~0.5-0.85 RTF |
| MeloTTS (Korean, monotone) | ~2.3 RTF |
| XTTS-v2 (Korean, ~58 speakers) | ~2.5-3.0 RTF |
| Playback start | ~200ms |
| **Total (English path)** | **~3-8s typical** |
| **Total (Korean path)** | **~10-25s typical** (TTS dominates) |

The CLI backends dominate. If you have an Anthropic API key, `AGENT_BACKEND=anthropic-api` cuts ~5s off every turn.

## Capture loop self-healing

The receive subscription can wedge on DAVE decryption errors (Discord's E2E voice protocol) or network glitches. Both `pcmStream.error` and `opusStream.error` trigger an immediate re-subscribe via a one-shot guard so the loop doesn't double-subscribe. Without this, the bot would just go silent after one bad packet.

## Concurrency

Capture, STT, agent, and TTS are async per-utterance. The capture loop doesn't block on inference — it re-subscribes immediately after passing the buffer to `runAgent()`. If you talk faster than the bot can respond, multiple turns can be in flight; the AudioPlayer is single-resource so only the latest synthesized response actually plays. Phase 4 will introduce a turn-management layer.
