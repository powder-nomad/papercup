import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSchedulerStore, type Job, type SchedulerStore } from '../src/scheduler/store.ts'
import { tickOnce, MAX_CONSECUTIVE_FAILURES } from '../src/scheduler/scheduler.ts'
import type { TickContext } from '../src/scheduler/scheduler.ts'
import type { Session, SessionStore } from '../src/state/sessions.ts'
import type { SessionEvent } from '../src/transports/types.ts'

function setup(): {
  store: SchedulerStore
  cleanup: () => void
  pushed: SessionEvent[]
  ensured: string[]
  ctx: (over?: Partial<TickContext>) => TickContext
  setSession(s: Session | null): void
  setAlive(alive: boolean): void
} {
  const dir = mkdtempSync(join(tmpdir(), 'sched-tick-'))
  const store = createSchedulerStore({ dbPath: join(dir, 'scheduler.db') })
  store.init()

  const pushed: SessionEvent[] = []
  const ensured: string[] = []
  let aliveFlag = true
  let session: Session | null = makeSession()

  const sessions = {
    findById: (_id: string) => session ?? undefined,
  } as unknown as SessionStore

  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
    log: () => {},
  }

  const baseCtx: TickContext = {
    store,
    sessions,
    log: log as unknown as TickContext['log'],
    ensureSessionRunning: (s: Session) => { ensured.push(s.id) },
    pushEvent: (e: SessionEvent) => { pushed.push(e); return true },
    isAlive: () => aliveFlag,
    nowEpochMs: 1_700_000_000_000,
  }

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
    pushed,
    ensured,
    ctx: (over: Partial<TickContext> = {}) => ({ ...baseCtx, ...over }),
    setSession: (s: Session | null) => { session = s },
    setAlive: (a: boolean) => { aliveFlag = a },
  }
}

function makeSession(): Session {
  return {
    id: 'sess-A',
    name: 'test',
    createdAt: 1,
    lastActiveAt: 1,
    channelId: 'chan-1',
    transport: 'channels',
    backend: 'claude-code',
  }
}

function cronJob(now: number, over: Partial<Job> = {}): Job {
  return {
    id: 'aaaaaaaa-cron',
    kind: 'cron',
    sessionId: 'sess-A',
    ownerId: 'owner1',
    prompt: 'hi',
    cronExpr: '* * * * *',
    tz: 'UTC',
    fireAtEpochMs: null,
    enabled: true,
    lastFiredAtEpochMs: null,
    nextFireAtEpochMs: now - 1000,
    failureCount: 0,
    createdAtEpochMs: now,
    updatedAtEpochMs: now,
    notes: null,
    ...over,
  }
}

function queueJob(now: number, over: Partial<Job> = {}): Job {
  return {
    id: 'bbbbbbbb-queue',
    kind: 'queue',
    sessionId: 'sess-A',
    ownerId: 'owner1',
    prompt: 'one-shot',
    cronExpr: null,
    tz: null,
    fireAtEpochMs: now - 1000,
    enabled: true,
    lastFiredAtEpochMs: null,
    nextFireAtEpochMs: now - 1000,
    failureCount: 0,
    createdAtEpochMs: now,
    updatedAtEpochMs: now,
    notes: null,
    ...over,
  }
}

test('tickOnce fires a due cron job and recomputes next_fire_at', async () => {
  const env = setup()
  try {
    const ctx = env.ctx()
    env.store.insertJob(cronJob(ctx.nowEpochMs))
    await tickOnce(ctx)
    assert.equal(env.pushed.length, 1)
    assert.equal(env.pushed[0].sessionId, 'sess-A')
    assert.equal(env.pushed[0].content, 'hi')
    assert.equal(env.pushed[0].source, 'system')
    const after = env.store.getJob('aaaaaaaa-cron')!
    assert.ok(after.nextFireAtEpochMs > ctx.nowEpochMs, 'next fire moves into future')
    assert.equal(after.enabled, true, 'cron stays enabled')
    assert.equal(after.lastFiredAtEpochMs, ctx.nowEpochMs)
  } finally {
    env.cleanup()
  }
})

test('tickOnce ensureSessionRunning called only when not alive', async () => {
  const env = setup()
  try {
    env.setAlive(false)
    const ctx = env.ctx()
    env.store.insertJob(cronJob(ctx.nowEpochMs))
    await tickOnce(ctx)
    assert.deepEqual(env.ensured, ['sess-A'])

    env.setAlive(true)
    env.pushed.length = 0
    env.ensured.length = 0
    env.store.updateJob('aaaaaaaa-cron', { nextFireAtEpochMs: ctx.nowEpochMs - 500 })
    await tickOnce(ctx)
    assert.equal(env.ensured.length, 0, 'alive session does not re-ensure')
    assert.equal(env.pushed.length, 1)
  } finally {
    env.cleanup()
  }
})

test('tickOnce disables one-shot queue job after firing', async () => {
  const env = setup()
  try {
    const ctx = env.ctx()
    env.store.insertJob(queueJob(ctx.nowEpochMs))
    await tickOnce(ctx)
    const after = env.store.getJob('bbbbbbbb-queue')!
    assert.equal(after.enabled, false, 'queue job disabled after fire')
    assert.equal(env.pushed.length, 1)
  } finally {
    env.cleanup()
  }
})

test('tickOnce disables job whose session vanished', async () => {
  const env = setup()
  try {
    env.setSession(null)
    const ctx = env.ctx()
    env.store.insertJob(cronJob(ctx.nowEpochMs))
    await tickOnce(ctx)
    assert.equal(env.pushed.length, 0)
    assert.equal(env.store.getJob('aaaaaaaa-cron')?.enabled, false)
  } finally {
    env.cleanup()
  }
})

test('tickOnce disables job whose session has no bound channel', async () => {
  const env = setup()
  try {
    env.setSession({ ...makeSession(), channelId: undefined })
    const ctx = env.ctx()
    env.store.insertJob(cronJob(ctx.nowEpochMs))
    await tickOnce(ctx)
    assert.equal(env.pushed.length, 0)
    assert.equal(env.store.getJob('aaaaaaaa-cron')?.enabled, false)
  } finally {
    env.cleanup()
  }
})

test('tickOnce records failures + disables after MAX_CONSECUTIVE_FAILURES', async () => {
  const env = setup()
  try {
    const ctx = env.ctx({
      pushEvent: () => { throw new Error('synthetic boom') },
    })
    env.store.insertJob(cronJob(ctx.nowEpochMs))
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      env.store.updateJob('aaaaaaaa-cron', { nextFireAtEpochMs: ctx.nowEpochMs - 100 })
      await tickOnce(ctx)
    }
    const after = env.store.getJob('aaaaaaaa-cron')!
    assert.equal(after.failureCount, MAX_CONSECUTIVE_FAILURES)
    assert.equal(after.enabled, false)
  } finally {
    env.cleanup()
  }
})
