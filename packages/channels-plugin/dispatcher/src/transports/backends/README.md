# Per-turn agent backends

Drivers for the `per-turn` transport (`../per-turn.ts`): one CLI invocation per
user turn, with mid-turn cancel-and-respawn for the "phone-call interrupt" UX.
Each backend wraps one coding-agent CLI, builds its arg list, spawns it, and
parses stdout into an `AgentReply` (`{ text, inputTokens, outputTokens, elapsedMs }`).

The transport owns the queue + interrupt logic; backends only implement
`start()` / `respond()` / `cancel()` / `stop()` / `reset()` (see
`registry.ts` `AgentBackend`).

## Lifecycle & session model

- The backend instance **persists across turns** in `per-turn.ts`'s `states`
  Map, so in-memory `firstTurn` / id tracking survives between turns — but **not
  across a bot restart** (the Map is rebuilt empty).
- `start(opts)` receives `AgentBackendOpts`. Key fields:
  - `sessionId` — papercup's session UUID.
  - `resume` — true if papercup thinks the session already exists. For per-turn
    backends this is largely vestigial (each CLI owns its own resume), and it's
    always `false` on the first turn after a restart.
  - `cwd` — **per-session working directory** the dispatcher assigns
    (`/tmp/papercup/<id>`). Use it. See below.
- `runWithResumeRecovery` (`_recovery.ts`) wraps a turn: if the CLI throws a
  "session/thread/conversation not found" error, it flips to a fresh session
  under the same UUID and retries once (prior turns lost, session recovers).

## Working directory (important)

Spawn in the **per-session cwd**, never `process.cwd()` (which is the
dispatcher's own source tree — agents there will read/zip papercup's source).

`BaseCliBackend.resolveCwd(envWorkdir)` enforces the precedence:

```
opts.cwd (/tmp/papercup/<id>)  >  <BACKEND>_WORKDIR env  >  process.cwd()
```

A unique cwd per session is also what makes **cwd-keyed CLIs** (antigravity,
opencode, aider) resume the correct conversation without cross-session bleed.
`base-cli` `mkdir`s the cwd before spawn.

## Resume model per backend

| Backend | How it resumes | papercup wiring |
|---|---|---|
| claude-code¹ | `--session-id` then `--resume <uuid>` (adopts caller id) | works |
| codex¹ | captures its own `thread.started` id; `exec resume <thread-id>` | works |
| **antigravity (agy)** | own id, keyed by **cwd**; `--continue` resumes the cwd's conversation | per-session cwd + `--continue` |
| **opencode** | own `ses_…` id, scoped to project (**cwd**); `-c/--continue` | per-session cwd + `--continue` |
| **aider** | per-cwd history file (`.aider.chat.history.md`) | per-session cwd (implicit) |
| **gemini-cli** | `--session-id` / `--resume <uuid>` — adoption unverified | passes uuid (verify) |
| **amp** | in-prompt `@T-<thread>` | opt-in via `AMP_THREAD` only (not per-session) |
| **crush** | internal session store, not plumbed | stateless per turn |

¹ claude-code and codex are standalone (not `BaseCliBackend`); their feature
surface (stream-json, MCP, `--add-dir`, partial messages) is deeper.

> **Do not** pass papercup's UUID to `--conversation` (agy) or `--session`
> (opencode) — those CLIs generate their own ids and ignore a caller-supplied
> one, which silently starts every follow-up turn fresh (the original
> session-loss bug). Use `--continue` + a unique cwd instead.

## Capability matrix (vs claude-code baseline)

✅ works · ⚠️ partial/unverified · ❌ missing/not possible

| Capability | claude-code | codex | antigravity | opencode | gemini | aider | amp | crush |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Multi-turn resume | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ❌ |
| Resume recovery | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ | ❌ | ❌ |
| Token usage | ✅ | ✅ | ❌² | ✅ | ✅ | ❌ | ❌ | ❌ |
| Live streaming | ✅ | ❌ | ❌² | ❌³ | ❌ | ❌ | ❌ | ❌ |
| Papercup MCP tools⁴ | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ❌ | ❌ |
| Outbox attachments | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ❌ | ❌ | ❌ |
| Mid-turn interrupt | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

² agy `-p` emits **plain text** — no token stats and no incremental output, so
tokens/streaming aren't possible through that interface.
³ opencode's `--format json` token usage + resume are now implemented and
verified (qwen3-14b); but the stream is **buffered** (flushed at turn end, not
line-by-line), so live `TurnEvent` streaming isn't possible via `run` — it'd
need `opencode serve` + SSE. Models: gemma4-e4b, gemma4-12b, and qwen3-14b all
verified completing opencode turns end-to-end (e4b ~8s/turn). Bigger models are
preferable for complex multi-step tool orchestration, but e4b is usable.
Pitfalls that look like "the model stalled": (1) `OPENCODE_DEFAULT_MODEL` /
`--model` naming a model ollama doesn't have — opencode hangs on a request that
never resolves; (2) a cold first load of a large-context model. Neither is an
e4b limitation.
⁴ opencode is wired to the papercup bun MCP plugin (`server.ts`) via a
per-session `OPENCODE_CONFIG` (`writePapercupMcpConfig`), giving it the
background-process tools (`spawn_bg`/`list_bg`/`kill_bg`/`tail_bg`) routed to
the dispatcher by `PAPERCUP_SESSION_ID` over the shared UDS — verified
end-to-end. **Default on; opt out with `PAPERCUP_OPENCODE_MCP=0`.** (Earlier,
opencode-spawned plugins could orphan and leak to OOM; `plugin/server.ts` now
has an orphan self-exit guard + reconnect backoff that prevent that, so it's
safe on by default.) Caveats: the plugin's
`reply` tool is a no-op for per-turn sessions (the channels transport drops
replies for sessions it doesn't own); `present_options`/`spawn_extension` are
NOT in this plugin (they belonged to the dormant `PAPERCUP_MCP_URL` HTTP
server). claude-code's full MCP surface still exceeds this.

## Required env / deployment notes

| Backend | Notes |
|---|---|
| antigravity | binary `agy` (`ANTIGRAVITY_BINARY`); remote Gemini auth in `~/.gemini`. `ANTIGRAVITY_PRINT_TIMEOUT` defaults `24h`. |
| opencode | binary auto-detected at `~/.opencode/bin/opencode` if not on PATH; override with `OPENCODE_BINARY`. Provider/model via `opencode.jsonc` (`OPENCODE_DEFAULT_MODEL`). |
| codex | binary `codex` (override `CODEX_BINARY`). `CODEX_SANDBOX` = `read-only`\|`workspace-write`\|`danger-full-access` (default **workspace-write** so it can edit). Per-session cwd via opts.cwd. Resume: captures the real thread id from the `thread.started` JSON event, resumes via `codex exec resume <id>`. **Not installed on this host — adapter verified against docs, not runtime-tested.** Don't wire codex MCP while using `--json` (codex bug: `--json` is silently ignored when MCP servers are active → malformed output). |
| gemini-cli | binary `gemini` (`GEMINI_BINARY`). |
| aider / amp / crush | binaries `aider` / `amp` / `crush` (`*_BINARY`). |

`PAPERCUP_TURN_TIMEOUT_S` (default 0 = off) caps any turn across all backends.

## Known TODO (parity gaps)

- opencode: token tracking, streaming, MCP — blocked on a working model to
  observe the `--format json` schema.
- gemini-cli: verify `--session-id` actually adopts a caller-supplied UUID.
- codex: docs-hardened (workspace-write default, per-session cwd, CODEX_BINARY,
  outbox via --add-dir) but **runtime-untested** — install codex and verify a
  real two-turn run (resume + token parsing + outbox). MCP intentionally not
  wired (codex `--json` + MCP is broken upstream).
- MCP papercup tools for the per-turn CLIs that support MCP (codex, opencode).
