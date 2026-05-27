/**
 * Tick loop + dispatch. Pulled out of index.ts so the public API surface
 * stays narrow.
 *
 * Algorithm (one tick):
 *   1. SELECT jobs WHERE enabled=1 AND next_fire_at <= now
 *   2. For each due job: ensureSessionRunning(session) → pushEvent(prompt)
 *   3. cron      → recompute next_fire_at off the cron iterator
 *      queue     → set enabled=false (one-shot)
 *      limit-resume → set enabled=false (one-shot)
 *   4. On failure: increment failure_count; disable at >= MAX_CONSECUTIVE_FAILURES.
 */

import type { SchedulerDeps } from './index.ts'
import type { Job } from './store.ts'
import { parseCron, isParseError } from './parser.ts'

export const TICK_MS = 1000
export const MAX_CONSECUTIVE_FAILURES = 5

export type TickContext = SchedulerDeps & {
  nowEpochMs: number
}

export async function tickOnce(ctx: TickContext): Promise<void> {
  const due = ctx.store.dueJobs(ctx.nowEpochMs)
  for (const job of due) {
    try {
      await fireOne(job, ctx)
    } catch (err) {
      handleFailure(job, err, ctx)
    }
  }
}

export async function fireOne(job: Job, ctx: TickContext): Promise<void> {
  const session = ctx.sessions.findById(job.sessionId)
  if (!session) {
    ctx.log.warn(
      `scheduler: job ${job.id.slice(0, 8)} → session ${job.sessionId} no longer exists, disabling`,
    )
    ctx.store.updateJob(job.id, { enabled: false })
    return
  }
  if (!session.channelId) {
    ctx.log.warn(
      `scheduler: job ${job.id.slice(0, 8)} → session ${job.sessionId} has no bound channel, skipping (will retry next tick if re-enabled)`,
    )
    ctx.store.updateJob(job.id, { enabled: false })
    return
  }
  if (!ctx.isAlive(job.sessionId)) {
    ctx.ensureSessionRunning(session)
  }
  ctx.pushEvent({
    sessionId: job.sessionId,
    channelId: session.channelId,
    source: 'system',
    content: job.prompt,
    meta: {
      scheduler_job_id: job.id,
      scheduler_kind: job.kind,
    },
  })

  const next = computeNextFireAt(job, ctx.nowEpochMs)
  if (next !== null) {
    ctx.store.updateJob(job.id, {
      lastFiredAtEpochMs: ctx.nowEpochMs,
      nextFireAtEpochMs: next,
      failureCount: 0,
    })
  } else {
    // one-shot: queue / limit-resume
    ctx.store.updateJob(job.id, {
      lastFiredAtEpochMs: ctx.nowEpochMs,
      enabled: false,
      failureCount: 0,
    })
  }
}

export function computeNextFireAt(job: Job, afterEpochMs: number): number | null {
  if (job.kind !== 'cron') return null
  if (!job.cronExpr || !job.tz) return null
  const parsed = parseCron(job.cronExpr, job.tz)
  if (isParseError(parsed)) return null
  return parsed.nextAfter(afterEpochMs)
}

function handleFailure(job: Job, err: unknown, ctx: TickContext): void {
  ctx.store.recordFailure(job.id, err)
  ctx.log.error(`scheduler: job ${job.id.slice(0, 8)} fire failed:`, err)
  const updated = ctx.store.getJob(job.id)
  if (updated && updated.failureCount >= MAX_CONSECUTIVE_FAILURES) {
    ctx.store.updateJob(job.id, { enabled: false })
    ctx.log.warn(
      `scheduler: job ${job.id.slice(0, 8)} hit ${MAX_CONSECUTIVE_FAILURES} consecutive failures, disabling`,
    )
  }
}
