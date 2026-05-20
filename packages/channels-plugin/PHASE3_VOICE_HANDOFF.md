# Phase 3 — Voice handoff

This document hands off the voice work to a fresh session. Phases 1-5 +
attachments + permission relay shipped on 2026-05-20 (see `README.md`
current-status section). Voice is the only deferred Phase from the
original DESIGN.md.

## Pickup prompt (paste verbatim into a new Claude Code session)

> Continue papercup-channels Phase 3 (voice). Read
> `packages/channels-plugin/PHASE3_VOICE_HANDOFF.md` first — it contains
> the architecture options, the existing voice-stack inventory, and the
> recommended scope. Read `packages/channels-plugin/DESIGN.md` + `PROTOCOL.md`
> for the channels protocol contract, then look at the existing bot's voice
> code in `packages/bot/src/index.ts` (search for `joinVoiceChannel`,
> `beginCaptureLoop`, `SileroVad`, `WhisperSidecar`) to see the working
> reference implementation.
>
> Implement voice as a new channel-event source on the dispatcher side:
> `/voice-join` slash command takes the bot into the caller's voice channel,
> Silero VAD detects speech turns, Whisper transcribes, the transcript is
> pushed as a `<channel source="papercup-channels-voice" …>` notification
> into the SAME session bound to the current text channel (so voice and
> text share transcript). The `reply` tool output is also TTS-synthesized
> via Kokoro and played back to the voice channel when the session has
> an active voice connection.
>
> Don't touch the existing bot at `packages/bot/` — only modify code under
> `packages/channels-plugin/`. Reuse `@papercup/voice-stack` exports
> (`SileroVad`, `WhisperSidecar`, `createTts`, `stereo48kS16ToMono16kF32`,
> `mono24kS16ToStereo48kS16`) — do not re-implement.
>
> Validate with `npx tsc -p packages/channels-plugin/dispatcher --noEmit`
> after each subsystem. End with a Phase 3 status update to the README
> and a short summary.

---

## Current state (what's done — don't redo)

| Phase | Status |
| ----- | ------ |
| 0 — Recon | ✅ `PROTOCOL.md` |
| 1 — Text MVP | ✅ One-channel end-to-end |
| 2 — Multi-channel | ✅ `/bind`, `/unbind`, `/sessions`, `/rename`, persistent state, idle reaper |
| 4 — Knobs | ✅ `/model`, `/effort`, `/permissions`, `/cancel` with kill+respawn |
| 5 — Polish | ✅ `PAPERCUP_ALLOWED_USERS` allowlist, context-pressure warnings |
| Attachments | ✅ Auto-downloaded, paths surfaced via meta |
| Permission relay | ✅ `claude/channel/permission` capability + Discord Allow/Deny buttons |
| **3 — Voice** | **❌ THIS PHASE** |

Code surface (all under `packages/channels-plugin/`):

```
dispatcher/src/
├── index.ts                 — main wiring (DO NOT rewrite; extend)
├── ipc.ts                   — UDS frame types
├── log.ts
├── uds-server.ts            — UDS NDJSON server, emits 'reply' / 'permissionRequest' / 'helloReceived' / 'pluginDisconnected'
├── claude-children.ts       — claude spawn manager with stream-json result parsing
├── discord.ts               — gateway client, postNotice, postPermissionPrompt
├── register-commands.ts
├── commands/{handlers,router,types}.ts
└── state/{sessions,guild-config}.ts
plugin/server.ts             — Bun MCP plugin; declares claude/channel + claude/channel/permission
```

---

## What "voice" means here

The existing bot in `packages/bot/` already does voice. The path is:

```
Discord voice channel  →  opus frames  →  decode + resample (stereo48k → mono16kF32)
   →  SileroVad (speech detection)  →  WhisperSidecar (STT)
   →  transcript text  →  agent backend (Claude Code)
   →  reply text  →  Kokoro TTS  →  upsample (mono24kS16 → stereo48kS16)
   →  opus encode  →  playBack to voice channel
```

`packages/voice-stack/` exports the building blocks. Look at:

| Export | What it gives you |
| ------ | ----------------- |
| `SileroVad` (`@papercup/voice-stack/vad`) | VAD over `Float32Array` 16kHz mono frames; `feed()` + `reset()` |
| `WhisperSidecar` (`@papercup/voice-stack/stt`) | Manages the Python sidecar (HTTP); `transcribe(pcm)` returns a string |
| `createTts` (`@papercup/voice-stack/tts`) | Returns a `TtsEngine` with `synthesize(text) → {pcm: Int16Array}` (24kHz mono) |
| `stereo48kS16ToMono16kF32` | Convert incoming opus-decoded audio to VAD/STT format |
| `mono24kS16ToStereo48kS16` | Convert TTS output to playback format |

The Python sidecar lives at `packages/voice-stack/sidecar/`. Boot it
once on dispatcher startup (existing bot does this).

`packages/bot/src/index.ts` is the working reference. Sections to read:

| Lines (approx) | What it shows |
| -------------- | ------------- |
| 660-731 | `joinVoiceChannel` + `createAudioPlayer` + `entersState(Ready)` setup |
| `beginCaptureLoop` | The audio-capture loop using `connection.receiver.subscribe(userId, ...)` |
| `playBack` | Encoding + writing PCM to the audio player |
| Around line 2173 | Voice receiver subscription, opus → PCM decode |

---

## Architecture options (pick one)

**Option A — Voice and text are independent channel sources, same session.**

Run `/voice-join` in a channel that's already `/bind`-ed for text. The
dispatcher opens a voice connection, captures audio, transcribes, and pushes
the transcript as a channel event tagged `meta.source=voice` to the existing
session. TTS the reply tool's output back to the voice channel; ALSO post
the reply text to the bound text channel as a sticky log.

✅ **Recommended.** Cleanest UX (one session, one transcript, voice is just
another input/output modality). Matches the existing bot's voice+text
merge pattern.

**Option B — Voice-only sessions, separate from text.**

`/voice-join` creates a fresh session not tied to any text channel. No
text-channel record; replies only synthesised back to voice.

Avoids merging concerns but loses transcript surface; user can't scroll
back. Skip unless the text-merge gets ugly.

**Option C — Voice as a second binding type.**

`/bind-voice` binds a voice channel like `/bind` binds a text channel.
Two separate channel→session maps. Probably overengineered for our
single-user use case.

Go with **A**.

---

## Recommended implementation plan

1. **Add `dispatcher/src/voice/` directory.**
   - `voice-line.ts` — owns one voice connection per guild (`Map<guildId, VoiceLine>`). Mirrors `LineState` in `packages/bot/src/index.ts`.
   - `capture.ts` — receiver subscription, opus decode (via `prism-media`), resample, VAD-driven turn segmentation, fires `onTurnComplete(pcm: Float32Array)`.
   - `playback.ts` — TTS engine + upsample + opus encode + push to audio player.

2. **New slash commands:**
   - `/voice-join` — bot joins the caller's voice channel for the guild. Requires the user to be in a voice channel; the bot uses the text channel of the command for the bound session.
   - `/voice-leave` — bot leaves the voice channel; transcript history preserved.
   - `/say <text>` — make the bot speak arbitrary text (useful for debugging TTS).

3. **Inbound voice → channel event:** after Whisper transcribes a turn, emit a UDS `event` frame with the transcript as `content`, plus `meta.source=voice` (existing meta keys for `user`, `user_id`, `ts` apply too). Plugin pushes it as the same `<channel source="papercup-channels" …>` tag — channel notifications don't distinguish input modality at the protocol level, but the `source` attribute can carry it. Update plugin's `instructions` block to teach claude that `meta.source=voice` means "user spoke this; consider replying briefly so TTS doesn't drone".

4. **Outbound reply → TTS:** in the dispatcher's `uds.on('reply', …)` handler, after posting to the text channel, check if there's an active voice line for the same guild. If yes, synth + play.

5. **Lifecycle pairing with the idle reaper:** if a session is voice-connected, treat it as not-idle even if no Discord messages arrive — the heartbeat is "audio frames received in the last N seconds." Otherwise the reaper would kill claude during a long voice listen.

6. **Voice-stack sidecar boot:** add a `voice/sidecar.ts` module that spawns the Python Whisper sidecar process if not already running. Existing bot does this — model is loaded once at startup.

---

## Caveats and known gotchas (from the existing bot's experience)

- **Whisper sidecar startup is slow** (~5-10s). Boot it early during dispatcher
  init, not lazily on first voice-join.
- **VAD tail latency** — Silero settles on speech-end about 300-500ms after
  silence. That's the floor for round-trip latency. Document it.
- **Opus encoding/decoding** — `@discordjs/opus` + `sodium-native` are native
  modules. They're already in `packages/bot/package.json`; the channels
  dispatcher will need them too. Add to `dispatcher/package.json`.
- **Echo cancellation** — the bot intentionally pauses VAD while TTS is
  playing so the bot doesn't transcribe its own voice. Reuse this pattern.
  Look for the `playingSince` timestamp guard in `bot/src/index.ts`.
- **`selfDeaf: false`** is required for the bot to receive audio. Existing
  bot sets this.
- **Per-user receiver subscription** — `connection.receiver.subscribe(userId, ...)`.
  The bot listens to ONE user per voice line (the one who ran /pickup). Decide
  whether to support multi-user voice channels — probably defer.

---

## Testing strategy

- Manual: have the user join a voice channel, run `/voice-join` in a bound
  text channel, speak a short prompt, verify the transcript appears in text
  channel + claude replies via both text post AND TTS playback.
- Latency target: < 3s from speech-end to TTS-start in a "fast turn" (no
  tool calls in the agent's response). Track in dispatcher logs.

---

## After Phase 3

DESIGN.md's phases will all be complete. Optional follow-ups:

- Multi-user voice (subscribe to multiple userIds, tag each transcript)
- `/compact` (port from `bot/src/index.ts:handleCompact`)
- Persistent permission-prompt history in the channel (for audit)
- Move the channels-plugin into the top-level monorepo workspaces array so
  `npm install` at root installs both halves
