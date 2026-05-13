# Limit handling & usage visibility (design notes)

> Forward-looking — not implemented. Captured 2026-05-08 from a design discussion.
> Lives outside the published sidebar; this is an internal design doc.

## Problem

Two related gaps in papercup today:

1. **No real handling when an API token / subscription token limit is reached.** The bot won't crash, but the user just sees a generic `❌ Agent failed: <raw error>` and the next utterance fails the same way until the limit resets.
2. **No visibility into current usage.** The user has no in-Discord way to see how much of their Claude Pro/Max subscription window they've consumed.

## Current state (as of 2026-05-08)

### Limit handling

`packages/bot/src/agent/`:

- `backend-anthropic-api.ts` — rethrows whatever `@anthropic-ai/sdk` throws. No `429` detection, no `Retry-After` parsing, no backoff, no `RateLimitError` special case.
- `backend-claude-code.ts` — surfaces non-zero CLI exit as `claude exited <code>: <stderr slice>`. If a Claude subscription cap is hit, the user sees that raw string.
- `backend-codex.ts` — same pattern as Claude Code backend.

`packages/bot/src/index.ts` — three `respond()` callsites (`1074`, `1137`, `1742`) catch generically:

- Voice path → status panel: `❌ Agent failed: <message>`.
- Text-into-line / text-only chat → channel reply: `❌ Agent failed: <message>`.
- Only `"cancelled"` is special-cased; rate-limit / quota / auth / network all share the same branch.

No retry, no fallback model swap, no usage budget pre-check.

### Usage tracking

- `respond()` already returns `{ inputTokens, outputTokens, elapsedMs }` (see `agent/backend.ts → AgentReply`).
- These are logged once and discarded — never persisted.
- `session/store.ts → Session` has metadata fields but no `usage` field and no rollup.

## Proposal — limit handling

Detect rate-limit / quota / subscription-cap errors and turn them into useful UX instead of `❌ Agent failed: <opaque>`:

1. **Detect** in each backend:
   - Anthropic API: `RateLimitError` (status 429) from the SDK; parse `retry-after` header.
   - Claude Code CLI: regex on stderr for `usage limit reached`, `5-hour limit`, `weekly limit`, `rate limit`. Map to a typed error.
   - Codex CLI: equivalent stderr regex (TBD by experiment).
2. **Surface a typed `LimitError`** (e.g. kind `subscription-5h` / `subscription-weekly` / `api-rate-limit` / `api-quota`) with `retryAfterSec?` and `message`.
3. **Caller behavior** (`index.ts`):
   - Voice: TTS speaks a short, plain-prose message ("I've hit my Claude rate limit — try again in about 12 minutes").
   - Text: channel reply with the same content + reset estimate.
   - Optional: enter a brief cooldown so subsequent utterances don't re-trigger the same error.
4. **Optional follow-ons** (not required for v1):
   - Retry once with `Retry-After`.
   - Auto-downgrade Sonnet → Haiku when subscription cap hits.

## Proposal — usage visibility

Anthropic does **not** expose subscription quota via any public API. There is no `GET /quota` endpoint, and the `claude` CLI has no `claude usage` subcommand. Direct query is impossible.

But the data needed to **estimate it the same way Anthropic meters it** is on disk. The Claude Code CLI writes every assistant message to `~/.claude/projects/<dir>/*.jsonl` with full usage:

```json
"message": {
  "model": "claude-opus-4-7",
  "usage": {
    "input_tokens": 5,
    "cache_creation_input_tokens": 9001,
    "cache_read_input_tokens": 16556,
    "output_tokens": 244,
    "service_tier": "standard"
  }
}
```

Plus `timestamp` and `sessionId`. Same approach as the community tool `ccusage`.

### Two layers

#### a) Local session usage (cheap — already in memory)

Persist `respond()` results into `Session` so we can show per-session totals.

- Extend `Session` with `usage: { inputTokens, outputTokens, turns, lastTurnAt }`.
- After each `respond()` in `index.ts:1074/1137/1742`, call `sessions.recordUsage(id, reply)`.
- Persist to `data/sessions.json` like the rest.

#### b) Subscription-window estimate (read JSONL transcripts)

Roughly ~150 LOC inside `packages/bot`:

- Walk `~/.claude/projects/**/*.jsonl`.
- Parse `message.usage` + `message.model` + `timestamp`.
- Bucket into 5h rolling and 7d rolling windows.
- Multiply by Anthropic's published per-million weights for Pro/Max (Opus counts more than Sonnet, etc.).
- Configurable plan tier via env: `PAPERCUP_PLAN=pro|max5x|max20x` (per-tier quotas differ).

### Surface

`/usage` slash command, three views:

- `/usage` (default — current line / chat) → "this session: 142 turns, 312k in / 48k out, ~$X.XX".
- `/usage scope:5h` → "2.1M / ~10M (21%) — resets in 2h 14m".
- `/usage scope:weekly` → rolling 7-day equivalent.
- `/usage scope:all` → lifetime aggregated across all `data/sessions.json` entries.

### Caveats to surface in the reply text

- The 5h/weekly numbers are an **estimate**, not Anthropic's authoritative counter — they can change weights or count things we don't see.
- Only counts traffic through `claude -p` (i.e. `AGENT_BACKEND=claude-code`).
- Anthropic-API-backend traffic (`AGENT_BACKEND=anthropic-api`) is billed separately and shows token counts but does **not** count against the subscription window.
- Codex backend hits OpenAI, not Anthropic — totally separate counter.

### Implementation choice

Two options:

- **(a)** Vendor a small reader (~150 LOC) inside `packages/bot`. No extra dep.
- **(b)** Shell out to `ccusage` if installed, fall back to (a).

Default to (a). Vendoring keeps install footprint clean and avoids surprise breakage when `ccusage` schema or Claude Code JSONL shape drifts (we control both ends).

## Acceptance criteria (when this gets built)

- [ ] Hitting any of the four limit kinds produces a typed `LimitError`, not a raw stderr leak.
- [ ] Voice path speaks a clean limit message via TTS; text path replies in plain prose with reset estimate.
- [ ] `/usage` shows current-session, 5h-window, weekly-window, and lifetime.
- [ ] Plan tier configurable via `PAPERCUP_PLAN`.
- [ ] Unit tests for: stderr regex on Claude Code limit messages; JSONL window aggregation; plan-tier weight math.
