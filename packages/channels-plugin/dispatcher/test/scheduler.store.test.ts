import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSchedulerStore, type Job, type SchedulerStore } from '../src/scheduler/store.ts'

function freshStore(): { store: SchedulerStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sched-store-'))
  const store = createSchedulerStore({ dbPath: join(dir, 'scheduler.db') })
  store.init()
  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function sampleCronJob(over: Partial<Job> = {}): Job {
  const now = 1_700_000_000_000
  return {
    id: 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa',
    kind: 'cron',
    sessionId: 'sess-A',
    ownerId: 'owner1',
    prompt: 'hello',
    cronExpr: '0 9 * * *',
    tz: 'Asia/Seoul',
    fireAtEpochMs: null,
    enabled: true,
    lastFiredAtEpochMs: null,
    nextFireAtEpochMs: now + 60_000,
    failureCount: 0,
    createdAtEpochMs: now,
    updatedAtEpochMs: now,
    notes: null,
    ...over,
  }
}

test('insert + getJob roundtrip preserves all fields', () => {
  const { store, cleanup } = freshStore()
  try {
    const job = sampleCronJob()
    store.insertJob(job)
    const round = store.getJob(job.id)
    assert.deepEqual(round, job)
  } finally {
    cleanup()
  }
})

test('findJobByPrefix matches 8-char prefix; null when ambiguous', () => {
  const { store, cleanup } = freshStore()
  try {
    store.insertJob(sampleCronJob({ id: 'aaaaaaaa-id1' }))
    store.insertJob(sampleCronJob({ id: 'bbbbbbbb-id2' }))
    const a = store.findJobByPrefix('aaaaaaaa')
    assert.equal(a?.id, 'aaaaaaaa-id1')
    const none = store.findJobByPrefix('zzzzzzzz')
    assert.equal(none, null)
    store.insertJob(sampleCronJob({ id: 'aaaaaaaa-id3' }))
    const ambig = store.findJobByPrefix('aaaaaaaa')
    assert.equal(ambig, null)
  } finally {
    cleanup()
  }
})

test('listJobs filters by sessionId / ownerId / kind', () => {
  const { store, cleanup } = freshStore()
  try {
    store.insertJob(sampleCronJob({ id: 'aaaaaaaa-1', sessionId: 'sess-A', ownerId: 'u1', kind: 'cron' }))
    store.insertJob(sampleCronJob({ id: 'bbbbbbbb-2', sessionId: 'sess-A', ownerId: 'u2', kind: 'queue', cronExpr: null }))
    store.insertJob(sampleCronJob({ id: 'cccccccc-3', sessionId: 'sess-B', ownerId: 'u1', kind: 'cron' }))
    assert.equal(store.listJobs({ sessionId: 'sess-A' }).length, 2)
    assert.equal(store.listJobs({ ownerId: 'u1' }).length, 2)
    assert.equal(store.listJobs({ kind: 'queue' }).length, 1)
    assert.equal(store.listJobs({ sessionId: 'sess-A', ownerId: 'u1' }).length, 1)
    assert.equal(store.listJobs().length, 3)
  } finally {
    cleanup()
  }
})

test('dueJobs returns past + enabled, skips future or disabled', () => {
  const { store, cleanup } = freshStore()
  try {
    const t = 1_700_000_000_000
    store.insertJob(sampleCronJob({ id: 'past-enable', nextFireAtEpochMs: t - 1000, enabled: true }))
    store.insertJob(sampleCronJob({ id: 'past-disabl', nextFireAtEpochMs: t - 1000, enabled: false }))
    store.insertJob(sampleCronJob({ id: 'future-enbl', nextFireAtEpochMs: t + 1000, enabled: true }))
    const due = store.dueJobs(t)
    assert.equal(due.length, 1)
    assert.equal(due[0].id, 'past-enable')
  } finally {
    cleanup()
  }
})

test('updateJob applies patch + stamps updated_at when omitted', () => {
  const { store, cleanup } = freshStore()
  try {
    const orig = sampleCronJob({ updatedAtEpochMs: 1 })
    store.insertJob(orig)
    const before = Date.now()
    const ok = store.updateJob(orig.id, { prompt: 'new prompt', enabled: false })
    assert.equal(ok, true)
    const round = store.getJob(orig.id)
    assert.equal(round?.prompt, 'new prompt')
    assert.equal(round?.enabled, false)
    assert.ok((round?.updatedAtEpochMs ?? 0) >= before, 'updated_at auto-stamped')
  } finally {
    cleanup()
  }
})

test('updateJob returns false for unknown id', () => {
  const { store, cleanup } = freshStore()
  try {
    assert.equal(store.updateJob('nope', { prompt: 'x' }), false)
  } finally {
    cleanup()
  }
})

test('deleteJob removes + returns true; subsequent get returns null', () => {
  const { store, cleanup } = freshStore()
  try {
    const job = sampleCronJob()
    store.insertJob(job)
    assert.equal(store.deleteJob(job.id), true)
    assert.equal(store.getJob(job.id), null)
    assert.equal(store.deleteJob(job.id), false)
  } finally {
    cleanup()
  }
})

test('recordFailure increments failure_count', () => {
  const { store, cleanup } = freshStore()
  try {
    const job = sampleCronJob()
    store.insertJob(job)
    store.recordFailure(job.id, new Error('boom'))
    store.recordFailure(job.id, new Error('boom2'))
    assert.equal(store.getJob(job.id)?.failureCount, 2)
  } finally {
    cleanup()
  }
})

test('purgeSession removes jobs + limit_config for that session only', () => {
  const { store, cleanup } = freshStore()
  try {
    store.insertJob(sampleCronJob({ id: 'aaaaaaaa-A', sessionId: 'sess-A' }))
    store.insertJob(sampleCronJob({ id: 'bbbbbbbb-B', sessionId: 'sess-B' }))
    store.upsertLimitConfig({
      sessionId: 'sess-A', mode: 'auto-nudge', nudgeText: 'go', graceMs: 30000, updatedAtEpochMs: 1,
    })
    store.upsertLimitConfig({
      sessionId: 'sess-B', mode: 'off', nudgeText: null, graceMs: 30000, updatedAtEpochMs: 1,
    })

    store.purgeSession('sess-A')

    assert.equal(store.listJobs({ sessionId: 'sess-A' }).length, 0)
    assert.equal(store.listJobs({ sessionId: 'sess-B' }).length, 1)
    assert.equal(store.getLimitConfig('sess-A'), null)
    assert.ok(store.getLimitConfig('sess-B'))
  } finally {
    cleanup()
  }
})

test('upsertLimitConfig replaces on second write', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertLimitConfig({
      sessionId: 'sess-A', mode: 'off', nudgeText: null, graceMs: 1000, updatedAtEpochMs: 1,
    })
    store.upsertLimitConfig({
      sessionId: 'sess-A', mode: 'auto-nudge', nudgeText: 'resume', graceMs: 2000, updatedAtEpochMs: 2,
    })
    const cfg = store.getLimitConfig('sess-A')
    assert.equal(cfg?.mode, 'auto-nudge')
    assert.equal(cfg?.nudgeText, 'resume')
    assert.equal(cfg?.graceMs, 2000)
  } finally {
    cleanup()
  }
})

test('allowlist add / remove / list / check', () => {
  const { store, cleanup } = freshStore()
  try {
    store.addAllowlist({ userId: 'u1', addedBy: 'owner', addedAtEpochMs: 1 })
    store.addAllowlist({ userId: 'u2', addedBy: 'owner', addedAtEpochMs: 2 })
    assert.equal(store.isAllowlisted('u1'), true)
    assert.equal(store.isAllowlisted('u3'), false)
    assert.equal(store.listAllowlist().length, 2)
    assert.equal(store.removeAllowlist('u1'), true)
    assert.equal(store.removeAllowlist('u1'), false)
    assert.equal(store.isAllowlisted('u1'), false)
  } finally {
    cleanup()
  }
})
