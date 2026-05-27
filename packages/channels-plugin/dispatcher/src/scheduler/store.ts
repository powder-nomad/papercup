/**
 * SQLite-backed persistence for scheduler jobs, allowlist, and per-session
 * limit-handler config.
 *
 * Backed by better-sqlite3 (sync). Schema and rationale in DESIGN-scheduler.md.
 *
 * Timestamps everywhere are UTC epoch milliseconds. Cron expressions and IANA
 * TZ are stored verbatim; the parser/scheduler is responsible for converting
 * to UTC `next_fire_at` before persisting.
 */

import type { JobKind } from './index.ts'

export type Job = {
  id: string
  kind: JobKind
  sessionId: string
  ownerId: string
  prompt: string
  cronExpr: string | null
  tz: string | null
  fireAtEpochMs: number | null
  enabled: boolean
  lastFiredAtEpochMs: number | null
  nextFireAtEpochMs: number
  failureCount: number
  createdAtEpochMs: number
  updatedAtEpochMs: number
  notes: string | null
}

export type LimitMode = 'auto-nudge' | 'ask-user' | 'off'

export type LimitConfig = {
  sessionId: string
  mode: LimitMode
  nudgeText: string | null
  graceMs: number
  updatedAtEpochMs: number
}

export type AllowlistEntry = {
  userId: string
  addedBy: string
  addedAtEpochMs: number
}

export type SchedulerStoreInit = {
  dbPath: string
}

export interface SchedulerStore {
  init(): void
  close(): void

  insertJob(job: Job): void
  updateJob(id: string, patch: Partial<Job>): boolean
  deleteJob(id: string): boolean
  getJob(id: string): Job | null
  findJobByPrefix(prefix: string): Job | null
  listJobs(filter?: { sessionId?: string; ownerId?: string; kind?: JobKind }): Job[]
  dueJobs(nowEpochMs: number): Job[]
  recordFailure(id: string, error: unknown): void

  getLimitConfig(sessionId: string): LimitConfig | null
  upsertLimitConfig(cfg: LimitConfig): void

  addAllowlist(entry: AllowlistEntry): void
  removeAllowlist(userId: string): boolean
  listAllowlist(): AllowlistEntry[]
  isAllowlisted(userId: string): boolean

  /** Cascade hook called from state/sessions.ts when a session is deleted. */
  purgeSession(sessionId: string): void
}

export function createSchedulerStore(_init: SchedulerStoreInit): SchedulerStore {
  // TODO(task #3): implement better-sqlite3-backed store with the schema in
  // DESIGN-scheduler.md (jobs / allowlist / limit_config tables + indexes).
  throw new Error('createSchedulerStore: not implemented yet — see task #3')
}
