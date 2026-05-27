/**
 * SQLite-backed persistence for scheduler jobs, allowlist, and per-session
 * limit-handler config.
 *
 * Backed by better-sqlite3 (sync). Schema and rationale in DESIGN-scheduler.md.
 *
 * Timestamps everywhere are UTC epoch milliseconds. Cron expressions and IANA
 * TZ are stored verbatim; the parser/scheduler is responsible for converting
 * to UTC `next_fire_at` before persisting.
 *
 * Booleans are stored as 0/1 INTEGER (SQLite has no native boolean type) and
 * marshaled at the row boundary by `rowToJob`.
 */

import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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

export type JobFilter = { sessionId?: string; ownerId?: string; kind?: JobKind }

export interface SchedulerStore {
  init(): void
  close(): void

  insertJob(job: Job): void
  updateJob(id: string, patch: Partial<Job>): boolean
  deleteJob(id: string): boolean
  getJob(id: string): Job | null
  findJobByPrefix(prefix: string): Job | null
  listJobs(filter?: JobFilter): Job[]
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

const DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  cron_expr     TEXT,
  tz            TEXT,
  fire_at       INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER,
  next_fire_at  INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_next_fire ON jobs(next_fire_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_jobs_session   ON jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_owner     ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_prefix    ON jobs(substr(id, 1, 8));

CREATE TABLE IF NOT EXISTS allowlist (
  user_id   TEXT PRIMARY KEY,
  added_by  TEXT NOT NULL,
  added_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS limit_config (
  session_id  TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,
  nudge_text  TEXT,
  grace_ms    INTEGER NOT NULL DEFAULT 30000,
  updated_at  INTEGER NOT NULL
);
`

type JobRow = {
  id: string
  kind: string
  session_id: string
  owner_id: string
  prompt: string
  cron_expr: string | null
  tz: string | null
  fire_at: number | null
  enabled: number
  last_fired_at: number | null
  next_fire_at: number
  failure_count: number
  created_at: number
  updated_at: number
  notes: string | null
}

type LimitRow = {
  session_id: string
  mode: string
  nudge_text: string | null
  grace_ms: number
  updated_at: number
}

type AllowlistRow = {
  user_id: string
  added_by: string
  added_at: number
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind as JobKind,
    sessionId: r.session_id,
    ownerId: r.owner_id,
    prompt: r.prompt,
    cronExpr: r.cron_expr,
    tz: r.tz,
    fireAtEpochMs: r.fire_at,
    enabled: r.enabled === 1,
    lastFiredAtEpochMs: r.last_fired_at,
    nextFireAtEpochMs: r.next_fire_at,
    failureCount: r.failure_count,
    createdAtEpochMs: r.created_at,
    updatedAtEpochMs: r.updated_at,
    notes: r.notes,
  }
}

function rowToLimit(r: LimitRow): LimitConfig {
  return {
    sessionId: r.session_id,
    mode: r.mode as LimitMode,
    nudgeText: r.nudge_text,
    graceMs: r.grace_ms,
    updatedAtEpochMs: r.updated_at,
  }
}

function rowToAllowlist(r: AllowlistRow): AllowlistEntry {
  return {
    userId: r.user_id,
    addedBy: r.added_by,
    addedAtEpochMs: r.added_at,
  }
}

/** Columns updatable via updateJob's patch. */
const UPDATABLE_JOB_FIELDS: Record<keyof Omit<Job, 'id'>, string> = {
  kind: 'kind',
  sessionId: 'session_id',
  ownerId: 'owner_id',
  prompt: 'prompt',
  cronExpr: 'cron_expr',
  tz: 'tz',
  fireAtEpochMs: 'fire_at',
  enabled: 'enabled',
  lastFiredAtEpochMs: 'last_fired_at',
  nextFireAtEpochMs: 'next_fire_at',
  failureCount: 'failure_count',
  createdAtEpochMs: 'created_at',
  updatedAtEpochMs: 'updated_at',
  notes: 'notes',
}

class SqliteSchedulerStore implements SchedulerStore {
  private db: DB | null = null

  constructor(private readonly dbPath: string) {}

  init(): void {
    if (this.db) return
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(DDL)
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private requireDb(): DB {
    if (!this.db) throw new Error('SchedulerStore: not initialized — call init() first')
    return this.db
  }

  insertJob(job: Job): void {
    const db = this.requireDb()
    db.prepare(
      `INSERT INTO jobs (
        id, kind, session_id, owner_id, prompt,
        cron_expr, tz, fire_at,
        enabled, last_fired_at, next_fire_at, failure_count,
        created_at, updated_at, notes
      ) VALUES (
        @id, @kind, @sessionId, @ownerId, @prompt,
        @cronExpr, @tz, @fireAtEpochMs,
        @enabled, @lastFiredAtEpochMs, @nextFireAtEpochMs, @failureCount,
        @createdAtEpochMs, @updatedAtEpochMs, @notes
      )`,
    ).run({
      ...job,
      enabled: job.enabled ? 1 : 0,
    })
  }

  updateJob(id: string, patch: Partial<Job>): boolean {
    const db = this.requireDb()
    const assignments: string[] = []
    const params: Record<string, unknown> = { id }
    for (const [key, val] of Object.entries(patch)) {
      if (key === 'id') continue
      const col = UPDATABLE_JOB_FIELDS[key as keyof typeof UPDATABLE_JOB_FIELDS]
      if (!col) continue
      assignments.push(`${col} = @${key}`)
      params[key] = key === 'enabled' ? (val ? 1 : 0) : (val as unknown)
    }
    if (assignments.length === 0) return false
    if (patch.updatedAtEpochMs === undefined) {
      assignments.push('updated_at = @updatedAtEpochMs')
      params.updatedAtEpochMs = Date.now()
    }
    const sql = `UPDATE jobs SET ${assignments.join(', ')} WHERE id = @id`
    const info = db.prepare(sql).run(params)
    return info.changes > 0
  }

  deleteJob(id: string): boolean {
    const db = this.requireDb()
    const info = db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
    return info.changes > 0
  }

  getJob(id: string): Job | null {
    const db = this.requireDb()
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? rowToJob(row) : null
  }

  /**
   * Look up by the user-facing 8-char prefix (or any prefix length).
   * Returns null if zero matches OR more than one match (ambiguous).
   * The caller (slash command) should surface an "ambiguous id" error
   * for the multi-match case by re-checking with listJobs if needed.
   */
  findJobByPrefix(prefix: string): Job | null {
    const db = this.requireDb()
    const rows = db
      .prepare('SELECT * FROM jobs WHERE id LIKE ? LIMIT 2')
      .all(`${prefix}%`) as JobRow[]
    if (rows.length !== 1) return null
    return rowToJob(rows[0])
  }

  listJobs(filter: JobFilter = {}): Job[] {
    const db = this.requireDb()
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (filter.sessionId) {
      where.push('session_id = @sessionId')
      params.sessionId = filter.sessionId
    }
    if (filter.ownerId) {
      where.push('owner_id = @ownerId')
      params.ownerId = filter.ownerId
    }
    if (filter.kind) {
      where.push('kind = @kind')
      params.kind = filter.kind
    }
    const sql = `SELECT * FROM jobs ${
      where.length ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY next_fire_at ASC`
    return (db.prepare(sql).all(params) as JobRow[]).map(rowToJob)
  }

  dueJobs(nowEpochMs: number): Job[] {
    const db = this.requireDb()
    const rows = db
      .prepare('SELECT * FROM jobs WHERE enabled = 1 AND next_fire_at <= ? ORDER BY next_fire_at ASC')
      .all(nowEpochMs) as JobRow[]
    return rows.map(rowToJob)
  }

  recordFailure(id: string, _error: unknown): void {
    const db = this.requireDb()
    db.prepare(
      'UPDATE jobs SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?',
    ).run(Date.now(), id)
  }

  getLimitConfig(sessionId: string): LimitConfig | null {
    const db = this.requireDb()
    const row = db
      .prepare('SELECT * FROM limit_config WHERE session_id = ?')
      .get(sessionId) as LimitRow | undefined
    return row ? rowToLimit(row) : null
  }

  upsertLimitConfig(cfg: LimitConfig): void {
    const db = this.requireDb()
    db.prepare(
      `INSERT INTO limit_config (session_id, mode, nudge_text, grace_ms, updated_at)
       VALUES (@sessionId, @mode, @nudgeText, @graceMs, @updatedAtEpochMs)
       ON CONFLICT(session_id) DO UPDATE SET
         mode = excluded.mode,
         nudge_text = excluded.nudge_text,
         grace_ms = excluded.grace_ms,
         updated_at = excluded.updated_at`,
    ).run(cfg)
  }

  addAllowlist(entry: AllowlistEntry): void {
    const db = this.requireDb()
    db.prepare(
      `INSERT INTO allowlist (user_id, added_by, added_at)
       VALUES (@userId, @addedBy, @addedAtEpochMs)
       ON CONFLICT(user_id) DO UPDATE SET
         added_by = excluded.added_by,
         added_at = excluded.added_at`,
    ).run(entry)
  }

  removeAllowlist(userId: string): boolean {
    const db = this.requireDb()
    return db.prepare('DELETE FROM allowlist WHERE user_id = ?').run(userId).changes > 0
  }

  listAllowlist(): AllowlistEntry[] {
    const db = this.requireDb()
    return (db.prepare('SELECT * FROM allowlist ORDER BY added_at ASC').all() as AllowlistRow[])
      .map(rowToAllowlist)
  }

  isAllowlisted(userId: string): boolean {
    const db = this.requireDb()
    const row = db.prepare('SELECT 1 FROM allowlist WHERE user_id = ?').get(userId)
    return !!row
  }

  purgeSession(sessionId: string): void {
    const db = this.requireDb()
    const tx = db.transaction((sid: string) => {
      db.prepare('DELETE FROM jobs WHERE session_id = ?').run(sid)
      db.prepare('DELETE FROM limit_config WHERE session_id = ?').run(sid)
    })
    tx(sessionId)
  }
}

export function createSchedulerStore(init: SchedulerStoreInit): SchedulerStore {
  return new SqliteSchedulerStore(init.dbPath)
}
