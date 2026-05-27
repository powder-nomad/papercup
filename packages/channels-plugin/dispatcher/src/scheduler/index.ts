/**
 * Scheduler subsystem — public API.
 *
 * Three features sit on this module (see DESIGN-scheduler.md):
 *   F1 — cron-driven recurring prompts (`addCron`)
 *   F2 — one-shot prompt queue (`addQueue`)
 *   F3 — auto-resume on backend rate-limit (separate `limit-watcher.ts`,
 *        not part of F1 scaffolding)
 *
 * The scheduler is a *producer* of `transport.pushEvent(...)` calls; it does
 * not know about Discord, voice, or backends. It only needs:
 *   - a way to look up sessions + drive transports (`Deps`)
 *   - storage (`SchedulerStore`)
 *
 * Boot order in dispatcher/src/index.ts (task #8):
 *   const sched = createScheduler({ store, transport, sessions, log })
 *   sched.start()
 *   ...
 *   process.on('SIGTERM', () => sched.stop())
 */

import type { SessionStore } from '../state/sessions.ts'
import type { SessionTransport } from '../transports/types.ts'
import type { Logger } from '../log.ts'
import type { SchedulerStore, Job } from './store.ts'

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
  transport: SessionTransport
  sessions: SessionStore
  log: Logger
}

export interface Scheduler {
  start(): void
  stop(): void
  addCron(input: CronJobInput): Promise<Job>
  addQueue(input: QueueJobInput): Promise<Job>
  listJobs(filter?: { sessionId?: string; ownerId?: string; kind?: JobKind }): Job[]
  getJob(idOrPrefix: string): Job | null
  deleteJob(idOrPrefix: string): boolean
  setEnabled(idOrPrefix: string, enabled: boolean): boolean
}

export function createScheduler(_deps: SchedulerDeps): Scheduler {
  // TODO(task #6): wire tick loop in scheduler.ts.
  throw new Error('createScheduler: not implemented yet — see task #6')
}

export type { Job } from './store.ts'
export type { Session } from '../state/sessions.ts'
