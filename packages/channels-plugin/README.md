# papercup-channels

Discord bot with **two transports under one roof**:

- `channels` — long-lived `claude --channels` per bound session. claude.ai
  subscription auth, prompt cache stays warm, permission relay via Discord
  buttons. Default.
- `per-turn` — `claude -p --resume` per turn with **mid-turn injection**:
  speaking/typing during a reply interrupts and redirects, like a phone call.
  No permission relay (runs with `--dangerously-skip-permissions`).

Both share the same Discord gateway, voice subsystem (Silero VAD + Whisper
STT + Kokoro/Melo TTS), slash commands, idle reaper, allowlist, and
context-pressure indicator. See `DESIGN.md` for the architectural rationale
and `PROTOCOL.md` for the channels MCP contract.

```
   Discord                                claude session(s)
      ▲                                        ▲
      │                                        │ stdio MCP
      │                ┌────────────────┐      │
      └────────────────►                ◄──────┘
                       │   dispatcher    │
   Discord gateway     │ + UDS server   │      ┌──────────────┐
        ─►             │ + claude spawn ├──────► papercup-    │
                       └────────────────┘  UDS │ channels     │
                              │                │ plugin (Bun) │
                              ▼                └──────────────┘
                      ~/.papercup-channels/
                              ├── dispatcher.sock
                              └── runtime-mcp.json
```

This package is two npm/Bun packages in one directory:

- `dispatcher/` — Node, discord.js, owns the gateway and the UDS server.
- `plugin/` — Bun, MCP server claude loads via `--channels`.

## Current status

All DESIGN.md phases shipped: text, multi-channel, voice, knobs, polish + attachments + permission relay.

**Done:**
- Phase 1: text round-trip end-to-end (long-lived claude session via channels).
- Phase 2: multi-channel routing, `/bind`/`/unbind`/`/sessions`/`/rename`, persistent bindings (`~/.papercup-channels/{sessions,guild-config}.json`), 30min idle reaper.
- Phase 3: voice. `/voice-join` attaches a Discord voice connection to the session already bound to a text channel. Silero VAD + Whisper STT transcribe utterances into the same session (`meta.source=voice`); replies are TTS-synthesised back via Kokoro/Melo. Idle reaper honours an audio-frame heartbeat so sessions aren't reaped mid-conversation.
- Phase 4: `/model`, `/effort`, `/permissions`, `/cancel` (each kills the claude child; next message respawns with the new flags).
- Phase 5: `PAPERCUP_ALLOWED_USERS` allowlist (gates inbound + permission-button clicks), context-pressure indicator (warns at 150k / 180k input tokens per session per spawn).
- Attachments: Discord attachments auto-downloaded to `~/.papercup-channels/inbox/<channelId>/<messageId>-<attachmentId>.<ext>`, paths surfaced in the `<channel attachments="…">` attribute so claude can Read them.
- Permission relay: `claude/channel/permission` capability declared, prompts surfaced as Discord buttons in the bound channel (Allow/Deny). Allowlisted users only. Verdicts forwarded back via `notifications/claude/channel/permission`.

## Prerequisites

- Node ≥ 20
- [Bun](https://bun.sh) — the plugin runs on Bun
- A Discord application + bot token (see Anthropic discord plugin's
  README.md "Quick Setup" steps 1-3 for the bot-creation flow)
- Claude Code 2.1.80+ logged in via `claude auth` (claude.ai subscription)
- (Voice only) Python 3.10+ in `packages/voice-stack/sidecar/.venv` —
  `npm run setup-venv` at the repo root creates it. Silero VAD + Whisper
  models need to be downloaded once via `npm run download-models`.

## Install

```sh
cd packages/channels-plugin/dispatcher && npm install
cd ../plugin && bun install
```

## Configure

Copy `.env.example` to `dispatcher/.env` and fill in:

```
DISCORD_BOT_TOKEN=<bot token>
DISCORD_CLIENT_ID=<application id>     # only needed for `npm run register`
DISCORD_GUILD_ID=<guild snowflake>     # only needed for `npm run register`
# Optional:
# PAPERCUP_PROJECT_DIR=/home/papercup/workspaces/papercup
# PAPERCUP_IDLE_TIMEOUT_MS=1800000
```

Add the bot to your Discord server with at minimum **View Channels** + **Send
Messages** + **Read Message History** + **Use Application Commands** permissions,
and enable **Message Content Intent** in the dev portal (otherwise inbound
`msg.content` is empty).

## Run

One-time: register slash commands with your guild.

```sh
cd packages/channels-plugin/dispatcher
npm run register
```

Then start the dispatcher:

```sh
npm start
```

The dispatcher boots, opens the UDS socket, connects to the Discord gateway,
loads any previously-bound sessions from `sessions.json`, and re-spawns their
claude children. Use the slash commands to manage bindings:

| Command | Effect |
| --- | --- |
| `/bind` (in a channel) | Bind this channel to a new (or existing) claude session. Spawns the child. |
| `/bind name:foo` | Bind this channel to existing session `foo`. |
| `/bind transport:per-turn` | Bind a new session using the per-turn transport (phone-call interrupts). Omit `transport:` for the default `channels`. |
| `/bind backend:<…>` | Pick the agent CLI: `claude-code` (default), `codex`, `gemini-cli`, `aider-cli`, `opencode-cli`, `crush-cli`, `amp-cli`. Non-claude backends auto-pick `transport:per-turn`. |
| `/transport mode:<channels\|per-turn>` | Switch this channel's bound session to a different transport. Kills + respawns. |
| `/backend name:<…>` | Switch this channel's bound session to a different backend CLI. Kills + respawns. Channels-transport sessions are pinned to `claude-code`. |
| `/unbind` | Kill this channel's claude child and drop the binding. Session metadata kept. |
| `/resume name:foo` | In this bound channel, switch to session `foo` (create if missing). Mirrors `claude --resume <name>`. Kills the previously-bound session's child; transcripts persist on disk so a future `/resume name:<prev>` brings it back. |
| `/sessions` | List all sessions, idle time, model/effort/perm overrides. 🟢 = plugin connected. |
| `/rename name:new` | Rename the session bound to this channel. |
| `/model name:opus` | Set the model for this channel's session. Empty `name` clears the override. Kills the child; next message respawns. |
| `/effort level:high` | Set reasoning effort. `default` clears the override. Kills the child; next message respawns. |
| `/permissions mode:plan` | Set tool permission policy. `default-for-mode` clears the override (back to `bypassPermissions`). Kills the child; next message respawns. |
| `/cancel` | Abort the in-flight turn (SIGTERM the claude child). Next message respawns the session. |
| `/voice-join` | Bot joins your current voice channel and routes your speech into this text channel's session. Requires this text channel to be `/bind`'d and you to already be in a voice channel. Transcripts post here as `🎙️ …`; replies are TTS'd back. |
| `/voice-leave` | Disconnect the voice line for this guild. The claude session is preserved — text still works. |
| `/say text:<text>` | Make the bot speak arbitrary text in the active voice line. Debug helper for the TTS pathway. |
| `/compact [name:<session>]` | Fork this channel's session into a new one (`<base>-c2`, `-c3`, …) seeded with a summarised handoff. Kills the source child, persists the handoff to `~/.papercup-channels/handoffs/<newName>.md`, and rebinds the channel to the new session. Falls back to the bound session if `name:` is omitted. |

Boot-time log when you have a bound channel:

```
[dispatcher] boot: home=/home/.../.papercup-channels, sessions=1, plugin=...
[uds] listening at /home/.../dispatcher.sock
[discord] gateway connected as papercup-channels#0123
[claude] spawning claude (session=..., model=default, resume)
[uds] plugin hello (session=..., pid=...)
[discord] inbound: paul@... (...): hi
[claude] stdout(...): {"type":"assistant","message":{...}}
[discord] reply sent: session=..., msgId=m..., discord_ids=...
```

## Choosing a transport

| | `channels` | `per-turn` |
| --- | --- | --- |
| Lifecycle | One long-lived child per session | New `claude -p` per turn |
| Mid-turn injection | Native (channels protocol delivers as new turn) | Cancel-and-restart with merged prompt |
| Prompt cache | Warm across turns | Cold each turn (~500-1000ms startup) |
| Permission relay | ✅ Discord buttons | ❌ `--dangerously-skip-permissions` |
| Auth | claude.ai subscription | claude.ai subscription |
| Best for | Coding sessions, long multi-turn work | Voice / phone-call UX where interruption is the norm |

Voice + text always share the same session — the difference is only how the
underlying claude process is driven.

After ~30min idle, the reaper SIGTERMs the child:

```
[claude] reaper: killing idle session ch-2026-05-20-0427 (31m)
[claude] claude exited (session=..., code=null, signal=SIGTERM)
```

Next message in the channel respawns via `--resume`, picking up the transcript.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `plugin not yet connected for session=... — dropping message` | First message after boot landed before the plugin's UDS handshake. Send again — handshake takes ~1-2s. |
| Dispatcher boots but the plugin never says `hello` | Check claude stderr in the dispatcher log. Most likely a `bun: not found` (install Bun) or a `Failed to load MCP server` from a bad `runtime-mcp.json` (check perms on `~/.papercup-channels/`). |
| `is not on the approved channels allowlist` from claude | The `--dangerously-load-development-channels server:papercup-channels` flag isn't being passed. Check `dispatcher/src/claude-children.ts` was modified or that you're on claude ≥ 2.1.80. |
| Inbound Discord messages have empty `content` | **Message Content Intent** isn't enabled in the Discord dev portal. |
| Bot replies in Discord but the plugin process keeps respawning | UDS socket got deleted or `~/.papercup-channels/` perms changed. Both should be `0o700`/`0o600`. |

## Voice — env vars

These tune the voice subsystem (defaults in parentheses):

| Var | Default | Effect |
| --- | --- | --- |
| `PAPERCUP_TTS_ENGINE` | `auto` | TTS engine: `kokoro`, `melotts`, or `auto` (routes per detected language). |
| `PAPERCUP_SILENCE_MS` | `600` | Trailing-silence ms that ends an utterance for the Discord receiver subscription. |
| `PAPERCUP_VAD_THRESHOLD` | `0.4` | Silero speech-probability threshold per 32ms window. |
| `PAPERCUP_VAD_MIN_SPEECH_WINDOWS` | `3` | Minimum number of speech windows for an utterance to be transcribed (noise filter). |
| `PAPERCUP_VOICE_HEARTBEAT_MS` | `60000` | Audio-frame heartbeat: if a voice line received audio inside this window, the reaper skips the session. |

Caveats:

- Whisper sidecar startup takes 5-10s; the dispatcher boots it eagerly so the
  first `/voice-join` doesn't pay the tax. If the sidecar fails (no `.venv`
  yet), text + permission relay keep working and `/voice-join` reports
  "voice unavailable".
- Echo suppression is best-effort: while TTS playback is active the capture
  loop drops the utterance instead of transcribing the bot's own voice.
- One voice line per guild, subscribed to the user who ran `/voice-join`.
  Multi-user voice is not yet supported.
