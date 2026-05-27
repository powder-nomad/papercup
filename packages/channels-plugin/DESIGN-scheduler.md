# papercup-channels — Scheduler (cron + prompt queue + limit auto-resume)

Draft. Owner: paul. Status: design review.

Three features, one subsystem:

1. **Cron prompts** — recurring `(cron expr, sessionId, prompt)` triplets that get pushed into a session at each tick, as if the user had typed them in Discord.
2. **One-shot prompt queue** — fire-once variant. Either absolute (`at 2026-05-27T03:00`) or relative (`in 2h`). The "drop a prompt before bed" use case.
3. **Auto-resume on usage-limit hit** — watch `'reply'` events for the per-backend rate-limit signature, parse reset time, auto-queue the configured continuation prompt for `reset + grace`.

All three sit on the same `Scheduler` core; F2 is a single-fire degenerate of F1, F3 is a producer that enqueues F2 jobs.

## Boundary against the existing system

The scheduler is a **producer** of `transport.pushEvent(...)` calls. It does not understand transports, backends, voice, or Discord wire format. It only knows:

- Session IDs (from `state/sessions.ts`).
- "Fire prompt P into session S at time T."
- Whether S is alive (`transport.isAlive(s)`); if not, `ensureRunning` first.

This keeps the existing `SessionTransport` abstraction unchanged.

## Module layout

```
src/scheduler/
  index.ts          // public API: start(), stop(), addCron(), addQueue(), ...
  scheduler.ts      // tick loop + dispatch
  store.ts          // SQLite-backed persistence
  parser.ts         // cron-expression + duration parsers
  limit-watcher.ts  // F3: per-backend rate-limit detector
  acl.ts            // bot-owner + allowlist gate
src/commands/
  scheduler.ts      // new /cron, /queue, /limit-handler handlers
```

## Auth model (per answer #1)

- **Default**: only the bot owner (`BOT_OWNER_ID` env, already used elsewhere in the dispatcher) can create/edit/delete cron jobs and queue items. Listing is also owner-only.
- **Allowlist (phase 1.5)**: `/scheduler allow user:<@user>` adds a user ID to a global allowlist. Allowlisted users can manage **their own** jobs only; bot owner sees and manages everything.
- All scheduler slash commands check `acl.canManage(interaction.user.id, jobOwnerId)` and ephemeral-reject otherwise.

F1 deliverable: bot-owner-only. Allowlist is phase 1.5, behind the same code path.

## Storage (per answer #2)

**Decision: `better-sqlite3`** (sync, single npm install, no Node-version bump). Database file: `dispatcher/data/scheduler.db`.

```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,         -- uuidv7; surfaced to users as 8-char prefix, full UUID also accepted
  kind          TEXT NOT NULL,            -- 'cron' | 'queue' | 'limit-resume'
  session_id    TEXT NOT NULL,            -- FK-ish to sessions.json
  owner_id      TEXT NOT NULL,            -- Discord user who created it
  prompt        TEXT NOT NULL,
  -- cron-only
  cron_expr     TEXT,                     -- e.g. "0 9 * * *"
  tz            TEXT,                     -- IANA name, e.g. 'Asia/Seoul'; defaults to host TZ at job creation
  -- queue / limit-resume only
  fire_at       INTEGER,                  -- epoch ms (UTC)
  -- state
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER,                  -- epoch ms (UTC)
  next_fire_at  INTEGER NOT NULL,         -- epoch ms (UTC), materialized for index
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,         -- epoch ms (UTC)
  updated_at    INTEGER NOT NULL,         -- epoch ms (UTC)
  notes         TEXT
);
CREATE INDEX idx_jobs_next_fire ON jobs(next_fire_at) WHERE enabled = 1;
CREATE INDEX idx_jobs_session   ON jobs(session_id);

CREATE TABLE allowlist (
  user_id   TEXT PRIMARY KEY,
  added_by  TEXT NOT NULL,
  added_at  INTEGER NOT NULL                -- epoch ms (UTC)
);

CREATE TABLE limit_config (
  session_id  TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,              -- 'auto-nudge' | 'ask-user' | 'off'
  nudge_text  TEXT,                       -- used when mode='auto-nudge'
  grace_ms    INTEGER NOT NULL DEFAULT 30000,
  updated_at  INTEGER NOT NULL              -- epoch ms (UTC)
);
```

All timestamps are UTC epoch milliseconds. Cron expressions evaluated in host-local time (see Timezone section); the resulting fire instant is normalized to UTC before persisting.

Deleting a session removes its jobs and `limit_config` row (cascade via app-level cleanup hook in `state/sessions.ts`).

## Timezone (per answer #3)

- All cron expressions evaluated in the **host IANA timezone** (`Intl.DateTimeFormat().resolvedOptions().timeZone`), passed to `cron-parser` via its `{ tz }` option so the iterator is DST-aware (see DST section below for the spring-forward caveat).
- The IANA name is **stored** in `jobs.tz` (e.g. `Asia/Seoul`); it is **not displayed**.
- All slash command responses display TZ as `<ABBR>(UTC±H)` per the bot owner's preference:
  > `Cron registered: 0 9 * * * (interpreted as KST(UTC+9), host local).`
- Abbreviation derived from `Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'short' })`; if the short token isn't a recognized abbreviation, fall back to `UTC±H` only (no abbreviation).
- `next_fire_at` is stored in UTC epoch ms; rendering converts on the way out.
- No per-user TZ override in F1.

### DST behavior (decision: option A — accept, document, fix later)

`cron-parser` with `{ tz }` is **DST-aware but skips fires inside the spring-forward gap**. Concretely, in a TZ that observes DST:

- **Spring-forward** (clocks 01:59 → 03:00): any wall-clock minute in the skipped hour does not exist. A pattern like `0 2 * * *` is silently skipped that day. Result: **one missed fire per affected job per year**.
- **Fall-back** (clocks 03:00 → 02:00): the 02:00 hour happens twice. `cron-parser` fires once (the first occurrence). Result: correct, no action needed.

**Decision for F1**: accept the spring-forward skip. Document it in the package README. Revisit later if a non-KST user hits it.

For the current bot owner (KST, no DST), **this is dead code in practice** — the gap never opens.

Documentation lands in `packages/channels-plugin/README.md` under a new "Scheduler" section, written when F1 ships. Until then, this DESIGN doc is the source of truth.

## Wake-up behavior (per answer #4)

On each tick, for a due job:

```ts
if (!transport.isAlive(job.session_id)) {
  await transport.ensureRunning(sessionCfgFor(job.session_id))
}
await transport.pushEvent({ sessionId: job.session_id, text: job.prompt, kind: 'text' })
```

If the session has been **deleted** (not just stopped), the cleanup hook in `state/sessions.ts` already removed the job. Belt-and-suspenders: if a job's `session_id` is missing from the session store at fire time, the job is silently disabled and the owner is DM'd `"job <id> targeted deleted session, disabled"`.

## F3 — limit auto-resume (per answers #5, #6)

### Detection

`limit-watcher.ts` subscribes to `transport.on('reply', ...)`. Per-backend matchers:

```ts
interface LimitMatcher {
  backend: 'claude-code' | 'gemini' | 'codex' | ...
  match(replyText: string): { resetAtEpochMs: number } | null
}
```

**Phase 1 — claude-code**: claude emits a recognizable message of the form `"You've hit your usage limit. Resets at 14:00 UTC"` (verify exact wording from a real captured transcript before shipping the regex; do not hand-roll without a fixture).

**Phase 2 — gemini**: TBD. The CLI doesn't reliably surface a reset time today; matcher may have to fall back to a fixed cool-down (e.g. 60 min) and treat the result as best-effort.

### Behavior (configurable per session)

`limit_config.mode`:

- `auto-nudge` (default) — at `reset + grace_ms`, enqueue `nudge_text` (default: `"Resume where you left off."`) as a one-shot job.
- `ask-user` — **deferred to a separate epic** (see "DM-based interactions" below). For F2 this mode rejects with `"DM-based interaction is a planned feature, not yet shipped"`.
- `off` — passive notification only, posted into the bound guild channel.

Slash commands: `/limit-handler mode:<auto-nudge|off>` (no `ask-user` until DM epic), `/limit-handler set-nudge text:"..."`.

### Owner alerts — guild channel only in F1/F2 (per answer to follow-up Q)

All owner-facing alerts (catch-up notices, failure DMs, limit-hit notifications) post into the **bound guild channel for the affected session**, not Discord DMs. This keeps F1/F2 entirely guild-scoped.

A separate follow-up epic ("DM-based interactions") will introduce:

- DM round-trip for `ask-user` limit mode.
- Cross-guild reach for owners with many bots.
- DM-side reply parsing extending the existing DM handler.

That epic owns its own design doc and is out of scope here.

### Last-prompt cache

For the *future* "re-send the last user prompt verbatim" option (not part of F1), the dispatcher can keep `lastUserPromptBySession: Map<sessionId, string>` in memory and persist to `limit_config.last_user_prompt`. Out of scope for the first cut — start with fixed nudge text only.

## Slash command surface

```
/cron add expr:"<cron>" prompt:"<text>" [session:<id|name>]
/cron list [session:<id|name>]
/cron edit id:<jobId> [expr:"..."] [prompt:"..."] [enabled:true|false]
/cron delete id:<jobId>

/queue add at:"<ISO|HH:MM|+2h>" prompt:"<text>" [session:<id|name>]
/queue list [session:<id|name>]
/queue delete id:<jobId>

/limit-handler mode:<auto-nudge|ask-user|off> [session:<id|name>]
/limit-handler set-nudge text:"<text>" [session:<id|name>]
/limit-handler show [session:<id|name>]

/scheduler allow user:<@user>      // bot-owner only
/scheduler deny  user:<@user>      // bot-owner only
/scheduler allowlist               // bot-owner only — lists current allowlist
```

If `session:` is omitted, the command applies to the session currently bound to the channel.

Times accepted by `/queue add at:`:

- ISO 8601 (`2026-05-27T03:00:00`).
- 24h clock for "today/tonight" (`03:00` → next occurrence of 03:00 host-local).
- Relative duration (`+2h`, `+30m`, `+1d`).

## Scheduler tick loop

```ts
// scheduler.ts
const TICK_MS = 1000
let timer: NodeJS.Timeout | null = null

export function start(deps: { store, transport, sessions, log }) {
  if (timer) return
  timer = setInterval(() => tickOnce(deps).catch(deps.log.error), TICK_MS)
}

async function tickOnce(deps) {
  const now = Date.now()
  const due = deps.store.dueJobs(now)        // SELECT ... WHERE next_fire_at <= ? AND enabled = 1
  for (const job of due) {
    await fireOne(job, deps).catch(err => deps.store.recordFailure(job.id, err))
  }
}
```

`fireOne`:

1. Resolve session; abort + DM owner if deleted.
2. `ensureRunning` if needed.
3. `transport.pushEvent({ sessionId, text: job.prompt, kind: 'text' })`.
4. Update `last_fired_at = now`, recompute `next_fire_at` (cron: next match; queue/limit-resume: disable the job).
5. On failure, increment `failure_count`; if >= 5, disable + DM owner.

## Phasing

- **F1 (week 1)** — cron + queue + auth + storage + slash commands. No limit detection.
- **F2 (week 2)** — limit-watcher for claude-code with `auto-nudge` mode.
- **F3 (week 3)** — `ask-user` mode via DM round-trip; gemini matcher (best-effort).
- **Later** — allowlist UI polish, per-job timezone override, last-prompt cache.

## Resolved decisions

- **Cron parsing lib** → **`cron-parser`**. Lightweight, no native deps, supports `{ tz }`.
- **Owner alerts channel** → **bound guild channel only** in F1/F2. DM-based flow is a separate epic.
- **Job IDs** → uuidv7; rendered as 8-char prefix in slash args; both prefix and full UUID accepted.
- **DST** → option A: accept `cron-parser` default skip on spring-forward, document on README. Fix-later epic.
- **SQLite lib** → **`better-sqlite3`**. Works with current `engines.node >= 20`, no Node bump.

## Remaining open questions

- **Concurrency** — if two cron jobs fire on the same tick for the same session, second push will queue inside the SessionTransport. Verify per-turn transport handles that gracefully (channels transport is fine; per-turn may need a small inbound queue).
- **Boot-time recovery** — on dispatcher restart, do we fire jobs whose `next_fire_at` is in the past, or skip them silently? Recommend: fire if missed by < 10 min, skip + log otherwise.
- **Tick frequency vs CPU** — 1s tick polls SQLite once per second. Acceptable on a homelab. If it becomes noisy in logs, bump to 5s. Document the trade-off.

## Out of scope for this design

- Multi-prompt-per-tick (e.g., a job that fires three sequential prompts) — possible later via a `steps: string[]` column.
- Cross-session orchestration (one job that touches multiple sessions).
- Pause-during-active-turn (deferring a fire if the session is mid-turn). Simpler to just push; the transport already serializes.
- Web UI. CLI only.
