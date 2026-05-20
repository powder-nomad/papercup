# papercup-channels — Design

Discord bot with **two transports under one roof**:

1. **channels** — long-lived `claude --channels` child per session (the
   original motivation for this package; uses claude.ai subscription auth).
2. **per-turn** — `claude -p --resume <session-id>` spawned per turn, with
   mid-turn injection ("phone-call interrupt" UX).

Both transports share the same Discord gateway, slash commands, voice
subsystem, session store, and reply path. Sessions stamp which one they
want via the `transport: "channels" | "per-turn"` field; the dispatcher
routes events to the right driver.

The existing `packages/bot/` is the legacy multi-backend bot (codex,
aider, gemini-cli, etc.) and remains its own thing until those backends
are lifted into the new transport-pluggable dispatcher (see "Future"
below).

## Why a new package, not a refactor

The existing bot spawns `claude -p` per turn. Every spawn re-runs
SessionStart hooks, re-attaches the ~30KB skill_listing blob, and pays
~500-1000ms of process-startup latency. Measured cost: ~6-8k extra
cache-write tokens per turn on Opus 4.x with the user's plugin set.

Channels (introduced in claude 2.1.80, hidden from `--help`) let one
long-lived `claude --channels plugin:<name>` process receive events
pushed in from an MCP server. Hooks fire once per process. Prompt cache
stays warm across turns. This is the structural fix for the per-turn
overhead.

Docs: <https://code.claude.com/docs/en/channels>
Anthropic's official Discord channel plugin (reference implementation):
<https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord>

## SessionTransport — the unifying abstraction

Voice and text were never really different things — they're both ways for the
user to *push an event into a session*. The dispatcher used to bake that into
the channels-only code path; it now talks to a `SessionTransport` interface
that each driver implements:

```ts
interface SessionTransport {
  readonly name: 'channels' | 'per-turn'
  ensureRunning(cfg)           // idempotent spawn (or refresh config)
  pushEvent(event)             // text or voice utterance → agent
  on('reply'|'permissionRequest'|'turnComplete', listener)
  resolvePermission(rid, behavior, userId)
  cancel(sessionId)            // SIGTERM the running child
  stopSession(sessionId)
  isAlive(sessionId)
}
```

The dispatcher (`src/index.ts`) doesn't care which transport is under a
session. It calls `transport.pushEvent(...)` on text inbound, voice
utterances, and any future input source; it listens for `reply` /
`permissionRequest` / `turnComplete` events the same way regardless of the
underlying CLI invocation pattern.

### Channels transport — long-lived

```
                                Discord gateway
                                      │
                                      ▼
                  ┌──────────────────────────────────┐
                  │   dispatcher                     │
                  │ • single bot gateway connection  │
                  │ • voice + STT/TTS                │
                  │ • TransportRegistry              │
                  │ • channelId → sessionId map      │
                  └──────────────────────────────────┘
                                      │
                                      │ Unix domain socket
                                      ▼
                  ┌──────────────────────────────────┐
                  │ claude --channels                │
                  │ plugin:papercup-channels         │
                  │ --resume <session-A>             │
                  └──────────────────────────────────┘
                                      ↑
                                      │ MCP `reply` tool
                                      │ MCP `permission` callbacks
                                      ▼
                  ┌──────────────────────────────────┐
                  │  Bun plugin (plugin/server.ts)   │
                  └──────────────────────────────────┘
```

One claude child per bound channel. Hooks fire once per process. Prompt
cache stays warm across turns. Mid-turn injection is native — push another
event while claude is mid-reply and the channels protocol delivers it as a
second turn.

### Per-turn transport — phone-call interrupts

```
                                Discord gateway
                                      │
                                      ▼
                  ┌──────────────────────────────────┐
                  │   dispatcher                     │
                  │ + PerTurnTransport               │
                  │ + queue<SessionEvent>            │
                  └──────────────────────────────────┘
                                      │
                                      ▼ spawn / SIGTERM
                  ┌──────────────────────────────────┐
                  │ claude -p "<merged prompt>"      │
                  │ --resume <session-A>             │
                  │ --output-format stream-json      │
                  └──────────────────────────────────┘
                                      │ stdout (stream-json)
                                      ▼
                  reply text + token usage → onReply event
```

One `claude -p` per turn, with `--session-id` on first turn and `--resume`
on subsequent turns. Mid-turn injection works by **cancel-and-restart**:

1. User sends message → spawn `claude -p` with prompt #1.
2. User sends another message before reply lands → enqueue, SIGTERM the
   in-flight child.
3. On exit, the queue is non-empty → spawn a new `claude -p` with a merged
   prompt that includes both utterances, tagged so the agent knows the user
   interrupted.

This matches the "phone-call over Discord" UX papercup was originally
designed for: speaking over the bot interrupts and redirects it, just like
talking over a person.

Tradeoffs:
- Per-turn pays ~500-1000ms process startup per turn (no prompt-cache warmth
  across turns; claude-code's local session store handles the transcript).
- No permission relay — the CLI runs with `--dangerously-skip-permissions`.
  Users who need permission gates should pick the channels transport.
- Token usage is parsed from the stream-json `result` event at end-of-turn,
  same as channels.

### TransportRegistry

`src/transports/registry.ts` constructs one of each transport at boot
(currently `channels` + `per-turn`). The dispatcher resolves per-session via
`transports.get(session.transport)`. Adding a new transport (e.g.
`codex-per-turn`, `gemini-per-turn`) requires:

1. Implement `SessionTransport` (file in `src/transports/`).
2. Register in `TransportRegistry` constructor.
3. Extend `SessionTransportName` union in `state/sessions.ts`.
4. Add the choice to the `/bind transport:` and `/transport mode:` slash
   command option lists in `register-commands.ts`.

## Architecture (locked)

```
                            Discord gateway
                                  │
                                  ▼
              ┌──────────────────────────────────┐
              │   papercup-channels-dispatcher   │   Node, long-lived
              │  • single bot gateway connection │
              │  • voice connections + STT/TTS   │
              │  • channelId → claudePid map     │
              │  • spawns claude children        │
              │  • routes events over UDS        │
              └──────────────────────────────────┘
                                  │ Unix domain socket
                                  │ ~/.papercup-channels/dispatcher.sock
                                  │ NDJSON line protocol
                  ┌───────────────┼───────────────┐
                  │               │               │
                  ▼               ▼               ▼
       ┌──────────────────┐ ┌──────────────┐ ┌──────────────┐
       │ claude --channels│ │ claude --... │ │ claude --... │
       │ plugin:papercup- │ │              │ │              │
       │ channels         │ │  (session B) │ │  (session C) │
       │ --resume <A>     │ │              │ │              │
       │                  │ │              │ │              │
       │  ┌────────────┐  │ │ ┌─────────┐  │ │ ┌─────────┐  │
       │  │ MCP plugin │  │ │ │ plugin  │  │ │ │ plugin  │  │
       │  │ (Bun)      │  │ │ │ (Bun)   │  │ │ │ (Bun)   │  │
       │  └────────────┘  │ │ └─────────┘  │ │ └─────────┘  │
       └──────────────────┘ └──────────────┘ └──────────────┘
        ↑      session A      session B          session C
        │
        each plugin instance is the MCP server claude --channels loaded.
        On startup it connects to the dispatcher's UDS, registers its
        session id (from CLI arg/env), then awaits events.
```

### Components

1. **`papercup-channels-dispatcher`** (Node, single process)
   - One Discord gateway connection (configured once via dev portal).
   - Discord guild+channel state, voice connection pool, audio I/O.
   - `channelId → { sessionId, claudePid, socketPeer }` map persisted
     to disk like the existing bot's `data/sessions.json`.
   - Spawns `claude --channels plugin:papercup-channels --session-id <uuid>
     --resume` children when `/bind` happens.
   - Slash commands: `/bind`, `/unbind`, `/pickup`, `/effort`,
     `/model`, `/permissions`, `/sessions`, `/rename`, `/compact`.
     (Lift from existing `packages/bot/src/register-commands.ts`.)
   - Owns voice: VAD → Whisper → text event over UDS; reply text →
     Kokoro → opus encode → playback. Reuses `@papercup/voice-stack`.

2. **`papercup-channels-plugin`** (Bun, MCP server)
   - Loaded by claude via `claude --channels plugin:papercup-channels`.
   - On startup: dial the dispatcher socket, send a `hello` line with
     this process's session id (passed via env `PAPERCUP_SESSION_ID`
     set by the dispatcher when spawning).
   - Reads NDJSON lines from the socket; for each `event` frame,
     emits the corresponding channel-event into the claude session
     (the channels MCP "push event" mechanism — needs verification
     against Anthropic's discord plugin source in Phase 0).
   - Exposes a `reply` MCP tool. When claude calls it, the plugin
     writes a `{type:"reply", session, text}` frame back over UDS.

3. **Per-session claude child**
   - `claude --channels plugin:papercup-channels --resume <session-uuid>
      --add-dir <project-dirs> --model <...> --effort <...>`
   - One per bound channel. Idle-killed by the dispatcher after a
     configurable timeout (default ~30 min) to free resources.
   - Restart-on-demand when a new message arrives for a channel whose
     claude child has been reaped.

### IPC protocol (UDS, NDJSON)

Plugin → dispatcher:
```jsonc
{ "type": "hello", "session": "<uuid>", "pid": 12345 }
{ "type": "reply", "session": "<uuid>", "text": "…", "msgId": "abc" }
{ "type": "log", "level": "warn", "msg": "…" }
```

Dispatcher → plugin:
```jsonc
{ "type": "event", "source": "discord-text|discord-voice",
  "session": "<uuid>", "userId": "...", "text": "…",
  "attachments": [...] }
{ "type": "shutdown", "session": "<uuid>" }
```

Framing: one JSON object per line, UTF-8. Close-on-disconnect; plugin
process exits if dispatcher dies (claude child gets reaped via SIGPIPE
when next reply attempt fails).

## Phased plan

| Phase | Scope | Validates |
|---|---|---|
| **0. Recon** | Read Anthropic's discord plugin source. Document the actual channels MCP contract (event message shape, `reply` tool signature, plugin manifest format, registration handshake). Update this DESIGN.md with concrete protocol details. | Architecture viability |
| **1. Text-only MVP** | Bun plugin + Node dispatcher. One Discord channel, hardcoded session id. End-to-end: Discord text → dispatcher → UDS → plugin → claude → reply tool → UDS → Discord text. | Channels round-trip works for our use case |
| **2. Multi-session `/bind`** | Dispatcher spawns claude children per binding. `/bind` and `/unbind` slash commands. Persist `data/bindings.json`. Idle reaper. | Multi-channel routing without per-bot pain |
| **3. Voice** | Port `@papercup/voice-stack` (Whisper STT, Kokoro TTS, VAD, audio adapters). Voice-channel join, transcript event push, TTS playback. | Voice path equivalent to existing bot |
| **4. Session knobs** | `/effort`, `/model`, `/permissions`, `/sessions`, `/rename`, `/compact`. Lift logic from `packages/bot/src/index.ts`. | Feature parity |
| **5. Polish** | Context-pressure indicator (port from `packages/bot`), `/status` summary, ephemeral replies, allowlist (mirror existing bot's `BOT_ALLOWED_USERS`). | Production-quality UX |

## Phase 0 deliverable (next session)

Write `PROTOCOL.md` with answers to:

1. How does Anthropic's discord plugin push events into claude? Is it
   a specific MCP tool call from plugin side, or does claude poll via
   a tool the plugin exposes?
2. What does the channel-event message look like in the claude turn
   stream? (Docs hint at `<channel source="discord">` wrapping —
   confirm the exact shape.)
3. What does `reply` look like? Is it `{ text: string }` only, or does
   it support attachments, embeds, threading?
4. How does the plugin discover its claude-parent's session id?
5. Does `claude --channels` work with `-p` + `--input-format stream-json`
   for headless operation, or does it require an interactive TTY?
6. Plugin manifest format (Bun `package.json` shape, MCP tool
   registration, claude plugin marketplace entry).

Read order:
1. `claude-plugins-official/external_plugins/discord/` — package.json,
   server entry point, MCP tool declarations
2. `claude-plugins-official/external_plugins/fakechat/` — the demo
   localhost channel, simpler to grok
3. `code.claude.com/docs/en/channels-reference` — official protocol doc
   (linked from the channels overview page)

## Open questions to resolve later

- **Auth boundary**: each claude child uses the user's claude.ai
  subscription auth from `~/.claude/`. No new auth surface, but every
  spawned child counts as a session on the user's plan.
- **Multi-guild**: dispatcher needs to handle bindings across
  multiple guilds, or scope to one guild via env like the existing
  bot does.
- **Permission relay**: when claude needs a permission prompt, the
  docs mention channels can relay it. Decide whether to surface in
  Discord (ephemeral button reply) or just always run with
  `--dangerously-skip-permissions`.
- **Outbox**: existing bot uses `data/outbox/...` for agent-written
  files attached to replies. Reuse the pattern via a tool the plugin
  exposes? Or symlink the convention so claude writes there directly?
- **Migration**: should `/compact` / `/pickup` semantics from the
  existing bot carry over verbatim, or be redesigned to fit the
  channels lifecycle (long-lived sessions don't need /compact as
  often since prompt cache stays warm — but it's still useful when
  the conversation transcript itself gets large)?

## Pointers to existing code worth borrowing

- `packages/bot/src/session/store.ts` — Session shape, persistence
- `packages/bot/src/config/guild-config.ts` — boundChannels list,
  recently rewritten this session
- `packages/bot/src/index.ts` — slash-command handlers (`handleBind`,
  `handleUnbind`, `handleCompact`, `maybeWarnContextPressure`),
  message routing, voice line setup, TTS replay, `replyChunked`
- `packages/bot/src/agent/backend-claude-code.ts` — how to assemble
  `claude` CLI args (allowedTools, MCP config, model, effort,
  permission-mode, project dirs)
- `packages/voice-stack/` — VAD, STT (Whisper), TTS (Kokoro), audio
  format adapters

## Out of scope

- Voice mode for non-text-bound channels (the existing bot's
  voice-only mode without a text channel binding)
- Multi-backend support (this package is claude-code-only by design;
  multi-backend stays in `packages/bot/`)
- Self-hosted alternative authentication (claude.ai subscription
  required by channels)
