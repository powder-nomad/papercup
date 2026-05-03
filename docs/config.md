# Configuration reference

All config lives in `packages/bot/.env`. Copy `.env.example` and edit.

## Discord

| Var | Required | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | yes | Application ID |
| `DISCORD_GUILD_ID` | yes | Server ID where slash commands register |
| `BOT_TEXT_CHANNEL_ID` | no | Global fallback bound channel; per-guild `/bind` wins |

## Voice pipeline

| Var | Default | Notes |
| --- | --- | --- |
| `SILENCE_MS` | `600` | End-of-utterance silence (ms). Lower = snappier, higher = fewer false stops |
| `VAD_THRESHOLD` | `0.4` | Speech probability cutoff |
| `VAD_MIN_SPEECH_WINDOWS` | `3` | Min 32ms windows of speech to count an utterance |

## Whisper STT

| Var | Default | Notes |
| --- | --- | --- |
| `WHISPER_MODEL` | `base.en` | `base.en` (English), `base` (multi), `small.en`, `small` |
| `WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` |
| `WHISPER_COMPUTE` | `int8` | `int8` (CPU), `float16` / `float32` (GPU) |
| `WHISPER_BEAM` | `1` | Beam search width. Higher = more accurate, slower |

## Kokoro TTS

| Var | Default | Notes |
| --- | --- | --- |
| `TTS_ENGINE` | `kokoro` | Currently only `kokoro`; new engines drop in via `createTts()` |
| `KOKORO_VOICE` | `af_heart` | Any of the 54 loaded voices |
| `KOKORO_SPEED` | `1.0` | 0.5–2.0 range |
| `KOKORO_LANG` | `en-us` | en-us, en-gb, ja, zh, es, fr, hi, it, pt-br |
| `KOKORO_MODEL` | (resolved) | Override model file path |
| `KOKORO_VOICES` | (resolved) | Override voices file path |

## Speaker agent

| Var | Default | Notes |
| --- | --- | --- |
| `AGENT_BACKEND` | `claude-code` | `claude-code` / `codex` / `anthropic-api` |
| `AGENT_MODEL` | `haiku` | Passed to the backend's `--model` |
| `AGENT_MAX_TOKENS` | `200` | For `anthropic-api` only |
| `ANTHROPIC_API_KEY` | — | Required if `AGENT_BACKEND=anthropic-api` |
| `CODEX_SANDBOX` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `SPEAKER_TOOLS` | `Read Glob Grep` | Built-in CC tools the speaker can use inline |
| `PROJECT_DIRS` | — | Comma-separated absolute paths the speaker can read |

## Extensions

(No env knobs today. Sandbox dirs at `data/extensions/<id>/`. MCP server picks an ephemeral localhost port.)

## Diagnostic

| Var | Default | Notes |
| --- | --- | --- |
| `DUMP_PCM` | — | Set to `1` to dump first significant utterance to `/tmp/papercup-*.f32` for offline VAD/STT debugging |
