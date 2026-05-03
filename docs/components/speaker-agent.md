# Speaker agent + backends

The speaker agent owns the call. It transcribes the user's audio (via STT), thinks, and produces text that the TTS layer speaks back.

## What it is

`SpeakerAgent` (`packages/bot/src/agent/speaker.ts`) is a thin shim around an `AgentBackend`. The shim owns the system prompt + config; the backend owns conversation state and the actual model call.

## Backends

Three backends ship today, all behind the same `AgentBackend` interface:

| Backend | `AGENT_BACKEND=` | Auth | Latency | Cost |
| --- | --- | --- | --- | --- |
| Claude Code CLI | `claude-code` | Existing `claude` login | ~5-8s/turn (CLI startup) | Standard Claude Code billing |
| Codex CLI | `codex` | Existing `codex` login | ~5-8s/turn | Standard ChatGPT/Codex billing |
| Anthropic API | `anthropic-api` | `ANTHROPIC_API_KEY` | ~0.5-1.5s/turn | Direct API |

All three accept a `--model` (e.g. `haiku`) and a system prompt. The `claude-code` backend additionally pipes through `--allowedTools` and `--mcp-config`.

## Tools

The speaker has read-only built-in tools plus MCP tools for delegating real work:

```
--allowedTools "Read Glob Grep mcp__papercup__spawn_extension mcp__papercup__check_extension mcp__papercup__list_extensions"
```

The `mcp__papercup__*` tools come from the embedded HTTP MCP server (see [Extensions](/components/extensions)). Read/Glob/Grep are restricted to directories specified in `PROJECT_DIRS` via `--add-dir`.

## System prompt

Lives at the top of `packages/bot/src/agent/speaker.ts`. Key behaviors:

- Phone-call brevity (one or two sentences)
- No markdown / bullets / code formatting (plain prose for TTS)
- Don't read out URLs or long IDs
- Use Read/Glob/Grep inline for quick file lookups
- Use `spawn_extension` for anything multi-step
- Narrate before tool calls ("let me look... ok, so...") so the user isn't sitting in silence

## Why not give it Bash directly

Speaker is on the latency-critical path. Long-running tools degrade call UX badly — a 30-second Bash call freezes the conversation. Heavy work belongs in extensions, which run async and report back when done.

## Session state

Each `/pickup` creates a `SessionStore` record with a friendly name. Each backend stores its own native session id (`backendId` field):

- claude-code: pre-allocated UUID, passed via `--session-id` (first turn) / `--resume` (subsequent)
- codex: backend assigns a thread UUID on first turn; bot syncs back via `getBackendId()`
- anthropic-api: no external session, history kept in-memory

`/resume name:foo` looks up the session, passes the right `backendId` to the backend, and continues. See [Sessions](/components/sessions).
