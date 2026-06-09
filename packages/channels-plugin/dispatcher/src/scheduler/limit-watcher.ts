/**
 * F2 — Limit auto-resume watcher.
 *
 * Subscribes to per-session `reply` events, detects backend-specific
 * "usage limit reached" signatures, and enqueues a one-shot nudge job at
 * `reset + graceMs` via the scheduler.
 *
 * The watcher is intentionally minimal:
 *   - One matcher per backend (claude-code shipped; others slot in later).
 *   - Per-session config in the `limit_config` SQLite table.
 *   - Default behaviour when no row exists: `auto-nudge` with
 *     `DEFAULT_NUDGE_TEXT` and `DEFAULT_GRACE_MS`.
 *
 * Producer side only — does not post anything to Discord directly. The
 * scheduler tick will fire the enqueued nudge as a normal queue job, which
 * routes through the existing transport.pushEvent path.
 */

import type { Logger } from '../log.ts'
import type { SessionStore } from '../state/sessions.ts'
import type { ReplyEvent } from '../transports/types.ts'
import type { LimitConfig, LimitMode, SchedulerStore } from './store.ts'
import type { Scheduler } from './index.ts'

export const DEFAULT_NUDGE_TEXT = 'Resume where you left off.'
export const DEFAULT_GRACE_MS = 30_000
export const DEFAULT_LIMIT_MODE: LimitMode = 'auto-nudge'

export type LimitMatch = { resetAtEpochMs: number }

export type LimitMatcher = {
  backend: string
  match(replyText: string): LimitMatch | null
}

/**
 * Claude Code matcher.
 *
 * Recent claude-code releases emit a recognizable rate-limit message; the
 * canonical form carries the UTC reset instant as a unix-seconds integer
 * separated from the prose by `|` or `:`. We require both the gating phrase
 * AND the parseable timestamp; partial matches return null so we don't fire
 * on false positives. Update fixtures in scheduler.limit-watcher.test.ts when
 * a new claude version changes the wording.
 */
export const claudeCodeMatcher: LimitMatcher = {
  backend: 'claude-code',
  match(replyText: string): LimitMatch | null {
    if (typeof replyText !== 'string' || replyText.length === 0) return null
    if (!/usage\s+limit\s+reached/i.test(replyText)) return null
    const m = /usage\s+limit\s+reached\s*[|:]?\s*(\d{9,11})/i.exec(replyText)
    if (!m) return null
    const ts = Number.parseInt(m[1], 10) * 1000
    if (!Number.isFinite(ts) || ts <= 0) return null
    return { resetAtEpochMs: ts }
  },
}

export const antigravityCliMatcher: LimitMatcher = {
  backend: 'antigravity-cli',
  match(replyText: string): LimitMatch | null {
    // Succession-era agy emits a similar signature to claude-code
    return claudeCodeMatcher.match(replyText)
  },
}

export const geminiCliMatcher: LimitMatcher = {
  backend: 'gemini-cli',
  match(replyText: string): LimitMatch | null {
    return claudeCodeMatcher.match(replyText)
  },
}

const BUILTIN_MATCHERS: LimitMatcher[] = [
  claudeCodeMatcher,
  antigravityCliMatcher,
  geminiCliMatcher,
]

export type LimitWatcherDeps = {
  scheduler: Scheduler
  store: SchedulerStore
  sessions: SessionStore
  log: Logger
  botOwnerId: string
  matchers?: LimitMatcher[]
  /** Optional notice hook so the dispatcher can post to the bound guild channel. */
  notify?(channelId: string, text: string): void
}

export interface LimitWatcher {
  handleReply(e: ReplyEvent): void
}

class LimitWatcherImpl implements LimitWatcher {
  private readonly byBackend = new Map<string, LimitMatcher>()

  constructor(private readonly deps: LimitWatcherDeps) {
    const matchers = deps.matchers ?? BUILTIN_MATCHERS
    for (const m of matchers) this.byBackend.set(m.backend, m)
  }

  handleReply(e: ReplyEvent): void {
    try {
      this.processReply(e)
    } catch (err) {
      this.deps.log.error('limit-watcher: handleReply failed:', err)
    }
  }

  private processReply(e: ReplyEvent): void {
    const session = this.deps.sessions.findById(e.sessionId)
    if (!session) return
    const matcher = this.byBackend.get(session.backend)
    if (!matcher) return
    const hit = matcher.match(e.text)
    if (!hit) return

    const cfg = this.resolveConfig(e.sessionId)
    const resetIso = new Date(hit.resetAtEpochMs).toISOString()

    if (cfg.mode === 'off') {
      this.deps.log.info(
        `limit-watcher: session=${e.sessionId} backend=${session.backend} hit limit; mode=off, no nudge scheduled`,
      )
      this.deps.notify?.(
        e.channelId,
        `⏸️ ${session.backend} usage limit reached (resets ${resetIso}). Auto-resume is off.`,
      )
      return
    }
    if (cfg.mode === 'ask-user') {
      this.deps.log.warn(
        `limit-watcher: session=${e.sessionId} mode=ask-user is deferred; treating as off`,
      )
      this.deps.notify?.(
        e.channelId,
        `⏸️ ${session.backend} usage limit reached (resets ${resetIso}). ask-user mode is not yet shipped — no nudge will fire.`,
      )
      return
    }

    const fireAt = hit.resetAtEpochMs + cfg.graceMs
    const now = Date.now()
    const safeFireAt = fireAt > now ? fireAt : now + 1_000
    const prompt = cfg.nudgeText ?? DEFAULT_NUDGE_TEXT
    const job = this.deps.scheduler.addQueue({
      sessionId: e.sessionId,
      ownerId: this.deps.botOwnerId,
      prompt,
      fireAtEpochMs: safeFireAt,
      notes: 'limit-resume',
    })
    this.deps.log.info(
      `limit-watcher: scheduled nudge job=${job.id.slice(0, 8)} session=${e.sessionId} fireAt=${new Date(safeFireAt).toISOString()}`,
    )
    this.deps.notify?.(
      e.channelId,
      `⏸️ ${session.backend} usage limit reached. Auto-resume scheduled at ${new Date(safeFireAt).toISOString()}.`,
    )
  }

  private resolveConfig(sessionId: string): LimitConfig {
    const row = this.deps.store.getLimitConfig(sessionId)
    if (row) return row
    return {
      sessionId,
      mode: DEFAULT_LIMIT_MODE,
      nudgeText: DEFAULT_NUDGE_TEXT,
      graceMs: DEFAULT_GRACE_MS,
      updatedAtEpochMs: 0,
    }
  }
}

export function createLimitWatcher(deps: LimitWatcherDeps): LimitWatcher {
  return new LimitWatcherImpl(deps)
}
