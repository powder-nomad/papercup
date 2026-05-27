/**
 * Tick loop + dispatch. Owned by createScheduler (index.ts); split out so the
 * public API surface stays narrow.
 *
 * Algorithm (one tick):
 *   1. SELECT jobs WHERE enabled=1 AND next_fire_at <= now
 *   2. For each due job: ensureRunning(session) → pushEvent(prompt)
 *   3. cron      → recompute next_fire_at off the cron iterator
 *      queue     → set enabled=false (one-shot)
 *      limit-resume → set enabled=false (one-shot)
 *   4. On failure: increment failure_count; disable + alert at >=5.
 */

import type { SchedulerDeps } from './index.ts'
import type { Job } from './store.ts'

export const TICK_MS = 1000
export const MAX_CONSECUTIVE_FAILURES = 5

export type TickContext = SchedulerDeps & {
  nowEpochMs: number
}

export async function tickOnce(_ctx: TickContext): Promise<void> {
  // TODO(task #6): load dueJobs(now), fire each via fireOne, swallow per-job
  // errors so one bad job can't stall the tick.
}

export async function fireOne(_job: Job, _ctx: TickContext): Promise<void> {
  // TODO(task #6):
  //   1. Resolve session via sessions.get(job.sessionId).
  //   2. If missing → disable job + alert via bound guild channel; return.
  //   3. If !transport.isAlive(sessionId) → ensureRunning(cfg).
  //   4. transport.pushEvent({ sessionId, channelId, source: 'system', content: job.prompt, meta: { scheduler_job_id: job.id }})
  //   5. store.updateJob: last_fired_at=now, recompute next_fire_at, failure_count=0.
  //   6. On throw: store.recordFailure(job.id, err); if failureCount>=MAX → setEnabled(id,false) + alert.
}

export function computeNextFireAt(_job: Job, _afterEpochMs: number): number | null {
  // TODO(task #4/#6): for cron jobs, use parser.nextAfter(expr, tz, after).
  // For queue / limit-resume returns null (one-shot — disable instead).
  return null
}
