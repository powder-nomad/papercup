/**
 * Scheduler subsystem — public API.
 *
 * Three features sit on this module (see DESIGN-scheduler.md):
 *   F1 — cron-driven recurring prompts (`addCron`)
 *   F2 — one-shot prompt queue (`addQueue`)
 *   F3 — auto-resume on backend rate-limit (separate `limit-watcher.ts`,
 *        not part of F1)
 *
 * The scheduler is a *producer* of `pushEvent(...)` calls; it does not know
 * about Discord, voice, or which transport is wired underneath. The dispatcher
 * supplies routing helpers (`ensureSessionRunning`, `pushEvent`, `isAlive`)
 * so the scheduler can target a session without binding to the transports
 * registry.
 *
 * Boot order in dispatcher/src/index.ts (task #8):
 *   const sched = createScheduler({ store, sessions, log, ensureSessionRunning, pushEvent, isAlive })
 *   sched.start()
 *   ...
 *   process.on('SIGTERM', () => sched.stop())
 */

import { v7 as uuidv7 } from 'uuid'

import type { Session, SessionStore } from '../state/sessions.ts'
import type { SessionEvent } from '../transports/types.ts'
import type { Logger } from '../log.ts'
import type { SchedulerStore, Job } from './store.ts'
import { parseCron, hostTimezone, isParseError } from './parser.ts'
import { TICK_MS, tickOnce } from './scheduler.ts'

export type JobKind = 'cron' | 'queue' | 'limit-resume'

export type JobOwnerInput = {
  sessionId: string
  ownerId: string
  prompt: string
  notes?: string
}

export type CronJobInput = JobOwnerInput & {
  cronExpr: string
  /** IANA TZ. Defaults to host TZ when omitted. */
  tz?: string
}

export type QueueJobInput = JobOwnerInput & {
  /** Epoch ms (UTC). */
  fireAtEpochMs: number
}

export type SchedulerDeps = {
  store: SchedulerStore
  sessions: SessionStore
  log: Logger
  /** Spawn the session's transport if not already alive. */
  ensureSessionRunning(session: Session): void
  /** Hand a SessionEvent to whichever transport owns the session. */
  pushEvent(event: SessionEvent): boolean
  isAlive(sessionId: string): boolean
}

export interface Scheduler {
  start(): void
  stop(): void
  addCron(input: CronJobInput): Job
  addQueue(input: QueueJobInput): Job
  listJobs(filter?: { sessionId?: string; ownerId?: string; kind?: JobKind }): Job[]
  getJob(idOrPrefix: string): Job | null
  deleteJob(idOrPrefix: string): boolean
  setEnabled(idOrPrefix: string, enabled: boolean): boolean
}

class SchedulerImpl implements Scheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void tickOnce({ ...this.deps, nowEpochMs: Date.now() }).catch(err =>
        this.deps.log.error('scheduler tick failed:', err),
      )
    }, TICK_MS)
    this.deps.log.info('scheduler started')
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.deps.log.info('scheduler stopped')
  }

  addCron(input: CronJobInput): Job {
    const tz = input.tz ?? hostTimezone()
    const parsed = parseCron(input.cronExpr, tz)
    if (isParseError(parsed)) {
      throw new Error(`addCron: ${parsed.error}`)
    }
    if (!this.deps.sessions.findById(input.sessionId)) {
      throw new Error(`addCron: session not found: ${input.sessionId}`)
    }
    const now = Date.now()
    const job: Job = {
      id: uuidv7(),
      kind: 'cron',
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      prompt: input.prompt,
      cronExpr: parsed.expr,
      tz,
      fireAtEpochMs: null,
      enabled: true,
      lastFiredAtEpochMs: null,
      nextFireAtEpochMs: parsed.nextAfter(now),
      failureCount: 0,
      createdAtEpochMs: now,
      updatedAtEpochMs: now,
      notes: input.notes ?? null,
    }
    this.deps.store.insertJob(job)
    return job
  }

  addQueue(input: QueueJobInput): Job {
    if (!this.deps.sessions.findById(input.sessionId)) {
      throw new Error(`addQueue: session not found: ${input.sessionId}`)
    }
    if (input.fireAtEpochMs <= Date.now()) {
      throw new Error('addQueue: fireAtEpochMs must be in the future')
    }
    const now = Date.now()
    const job: Job = {
      id: uuidv7(),
      kind: 'queue',
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      prompt: input.prompt,
      cronExpr: null,
      tz: null,
      fireAtEpochMs: input.fireAtEpochMs,
      enabled: true,
      lastFiredAtEpochMs: null,
      nextFireAtEpochMs: input.fireAtEpochMs,
      failureCount: 0,
      createdAtEpochMs: now,
      updatedAtEpochMs: now,
      notes: input.notes ?? null,
    }
    this.deps.store.insertJob(job)
    return job
  }

  listJobs(filter: { sessionId?: string; ownerId?: string; kind?: JobKind } = {}): Job[] {
    return this.deps.store.listJobs(filter)
  }

  getJob(idOrPrefix: string): Job | null {
    return this.deps.store.getJob(idOrPrefix) ?? this.deps.store.findJobByPrefix(idOrPrefix)
  }

  deleteJob(idOrPrefix: string): boolean {
    const job = this.getJob(idOrPrefix)
    if (!job) return false
    return this.deps.store.deleteJob(job.id)
  }

  setEnabled(idOrPrefix: string, enabled: boolean): boolean {
    const job = this.getJob(idOrPrefix)
    if (!job) return false
    return this.deps.store.updateJob(job.id, { enabled })
  }
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  return new SchedulerImpl(deps)
}

export type { Job } from './store.ts'
export type { Session } from '../state/sessions.ts'
