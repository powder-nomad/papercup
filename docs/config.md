# Configuration reference

Two surfaces:

1. **Static config** lives in `packages/bot/.env` — Discord credentials, voice pipeline tunables, TTS engine knobs, default agent backend / model. Copy `.env.example` and edit.
2. **Per-session config** lives in `data/sessions.json`, mutated at runtime by slash commands (`/pickup`, `/model`, `/effort`, `/permissions`, `/notify`). Each session can have its own model, reasoning effort, permission policy, and notification opt-in. See [Slash commands](/components/slash-commands) for the full surface.

Static-vs-session precedence: per-session settings override env defaults when the agent starts. Clearing a per-session override (`/model name:` blank, `/effort level:default`, `/permissions mode:default-for-mode`) falls back to the env value.

## Discord

| Var | Required | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | yes | Application ID |
| `DISCORD_GUILD_ID` | yes | Server ID where slash commands register |
| `BOT_TEXT_CHANNEL_ID` | no | Global fallback bound channel; per-guild `/bind` wins |
| `BOT_ALLOWED_USERS` | no | Comma-separated Discord user IDs. When set, only those users can drive the bot. **Set this before any deployment that exposes the bot to other users.** See [Security](/security#required-user-allowlist) |

## Voice pipeline

| Var | Default | Notes |
| --- | --- | --- |
| `SILENCE_MS` | `600` | End-of-utterance silence (ms). Lower = snappier, higher = fewer false stops |
| `VAD_THRESHOLD` | `0.4` | Speech probability cutoff |
| `VAD_MIN_SPEECH_WINDOWS` | `3` | Min 32ms windows of speech to count an utterance |

## Whisper STT

| Var | Default | Notes |
| --- | --- | --- |
| `WHISPER_MODEL` | `small` | `small` (multilingual, default) / `small.en` (English) / `base` (multilingual, lighter) / `base.en` (English, lightest) |
| `WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` |
| `WHISPER_COMPUTE` | `int8` | `int8` (CPU), `float16` / `float32` (GPU) |
| `WHISPER_BEAM` | `1` | Beam search width. Higher = more accurate, slower |

## TTS

The TTS layer auto-routes by detected language. Default `auto` runs Kokoro for English/JP/ZH/ES/FR/HI/IT/PT and falls back to MeloTTS or XTTS for Korean. You can pin to a single engine via `TTS_ENGINE=kokoro|melotts|xtts`, or stay on `auto` and pick which Korean engine handles the routed-to-Korean case via `TTS_KO_ENGINE`.

### Top-level routing

| Var | Default | Notes |
| --- | --- | --- |
| `TTS_ENGINE` | `auto` | `auto` (Kokoro + Korean engine) / `kokoro` / `melotts` / `xtts` |
| `TTS_KO_ENGINE` | `melotts` | When `TTS_ENGINE=auto`, picks the Korean engine: `melotts` (faster, monotone) or `xtts` (heavier, expressive) |

### Kokoro (English + 7 other langs)

| Var | Default | Notes |
| --- | --- | --- |
| `KOKORO_VOICE` | `af_heart` | Any of the 54 loaded voices |
| `KOKORO_SPEED` | `1.0` | 0.5–2.0 range |
| `KOKORO_LANG` | `en-us` | en-us, en-gb, ja, zh, es, fr, hi, it, pt-br |
| `KOKORO_MODEL` | (resolved) | Override model file path |
| `KOKORO_VOICES` | (resolved) | Override voices file path |

### MeloTTS (Korean — lightweight, monotone)

| Var | Default | Notes |
| --- | --- | --- |
| `MELOTTS_LANG` | `KR` | KR / EN / ES / FR / JP / ZH (uppercase) |
| `MELOTTS_DEVICE` | `cpu` | `cpu` or `cuda` |
| `MELOTTS_SPEED` | `1.3` | 0.8–1.5. 1.3 keeps the voice from sounding too leaden |
| `MELOTTS_PREWARM` | `1` | Set to `0` to defer the ~17s PyTorch+BERT load until first KR call |

### XTTS-v2 (Korean — heavier, ~58 speakers, voice cloning)

| Var | Default | Notes |
| --- | --- | --- |
| `XTTS_LANG` | `ko` | ko / en / ja / zh-cn / es / fr / de / it / pt / pl / tr / ru / nl / cs / ar / hu |
| `XTTS_DEVICE` | `cpu` | `cpu` or `cuda` |
| `XTTS_SPEED` | `1.0` | 0.8–1.3 |
| `XTTS_SPEAKER` | `Daisy Studious` | One of ~58 built-in Coqui speakers (Claribel Dervla, Gracie Wise, Tammie Ema, Damien Black, Andrew Chipper, Royston Min, Alma María, Lilya Stainthorpe, …) |
| `XTTS_REFERENCE_WAV` | — | Path to a 6s+ WAV. Overrides `XTTS_SPEAKER` to clone that voice instead |
| `XTTS_MODEL` | `tts_models/multilingual/multi-dataset/xtts_v2` | Override Coqui model id |
| `XTTS_PREWARM` | `1` | Set to `0` to defer the ~30s model load until first KR call |

## Speaker agent

### Env-level (apply to every session unless overridden)

| Var | Default | Notes |
| --- | --- | --- |
| `AGENT_BACKEND` | `claude-code` | `claude-code` / `codex` / `anthropic-api` |
| `AGENT_MODEL` | `haiku` | Default model. Per-session override via `/model name:<id>` or `/pickup model:<id>` |
| `AGENT_MAX_TOKENS` | `200` | For `anthropic-api` only |
| `ANTHROPIC_API_KEY` | — | Required if `AGENT_BACKEND=anthropic-api` |
| `CODEX_SANDBOX` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `SPEAKER_TOOLS` | `Read Glob Grep` | Built-in CC tools the speaker can use inline |
| `PROJECT_DIRS` | — | Comma-separated absolute paths the speaker can read |

### Per-session (set via slash commands)

These attach to the session record in `data/sessions.json` and survive `/hangup` → `/resume`.

| Field | Set via | Notes |
| --- | --- | --- |
| `model` | `/pickup model:<id>` or `/model name:<id>` | Per-session model override (e.g. `claude-opus-4-7`). Hot-swap preserves history |
| `effort` | `/pickup effort:<level>` or `/effort level:<level>` | `minimal` / `low` / `medium` / `high` / `xhigh` (Opus only) / `max` (Opus only). Maps to `--effort` on the CLI; `thinking.budget_tokens` on Anthropic API |
| `mode` | `/pickup mode:voice|text` | Voice mode applies the phone-call persona prompt; text mode passes no system prompt (default Claude Code behavior — markdown OK, multi-paragraph OK) |
| `permissionMode` | `/pickup permission-mode:<mode>` or `/permissions mode:<mode>` | Tool permission policy. Mode-aware default: text → `bypassPermissions` (vibecoding), voice → `default`. Choices: `default` / `acceptEdits` / `auto` / `bypassPermissions` / `plan` |
| `notify` | `/notify state:on|off` | When on, an extension settling fires a TTS announcement (voice) or Discord message (text) into the active container |
| `backendId` | (auto) | Backend's native session id (Claude Code UUID, Codex thread id) for resume |

## Extensions

Sandbox dirs at `data/extensions/<id>/`. MCP server picks an ephemeral localhost port. Permission policy is env-driven — see [Security](/security#extension-sandbox) for the full hardening guide.

| Var | Default | Notes |
| --- | --- | --- |
| `EXTENSION_PERMISSION_MODE` | `bypassPermissions` | `default` / `acceptEdits` / `auto` / `bypassPermissions` / `plan`. Tighten before public deployment |
| `EXTENSION_ALLOWED_TOOLS` | `default` | Whitelist for tools the extension can use (e.g. `"Read Edit Write Bash(npm *)"`) |
| `EXTENSION_DISALLOWED_TOOLS` | — | Explicit denies (e.g. `"WebFetch Bash(rm -rf *)"`) |

## Diagnostic

| Var | Default | Notes |
| --- | --- | --- |
| `DUMP_PCM` | — | Set to `1` to dump first significant utterance to `/tmp/papercup-*.f32` for offline VAD/STT debugging |
