import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  claudeCodeMatcher,
  createLimitWatcher,
  DEFAULT_GRACE_MS,
  DEFAULT_NUDGE_TEXT,
  type LimitMatcher,
} from '../src/scheduler/limit-watcher.ts'
import { createSchedulerStore, type SchedulerStore } from '../src/scheduler/store.ts'
import type { Scheduler, Job } from '../src/scheduler/index.ts'
import type { Session, SessionStore } from '../src/state/sessions.ts'
import type { ReplyEvent } from '../src/transports/types.ts'

/* ------------------------------- matcher -------------------------------- */

test('claudeCodeMatcher returns null for empty / missing input', () => {
  assert.equal(claudeCodeMatcher.match(''), null)
  assert.equal(claudeCodeMatcher.match('hello world'), null)
  assert.equal(claudeCodeMatcher.match(undefined as unknown as string), null)
})

test('claudeCodeMatcher returns null when phrase present but no timestamp', () => {
  assert.equal(
    claudeCodeMatcher.match('Claude AI usage limit reached'),
    null,
  )
})

test('claudeCodeMatcher returns null when phrase missing', () => {
  assert.equal(
    claudeCodeMatcher.match('Random reply|1700000000'),
    null,
  )
})

test('claudeCodeMatcher parses pipe-separated unix-seconds', () => {
  const hit = claudeCodeMatcher.match('Claude AI usage limit reached|1748358000')
  assert.deepEqual(hit, { resetAtEpochMs: 1748358000 * 1000 })
})

test('claudeCodeMatcher tolerates colon separator', () => {
  const hit = claudeCodeMatcher.match('Claude usage limit reached: 1748358000 (resets then)')
  assert.deepEqual(hit, { resetAtEpochMs: 1748358000 * 1000 })
})

test('claudeCodeMatcher is case-insensitive on phrase', () => {
  const hit = claudeCodeMatcher.match('claude USAGE Limit Reached|1748358000')
  assert.deepEqual(hit, { resetAtEpochMs: 1748358000 * 1000 })
})

test('claudeCodeMatcher rejects implausibly small timestamps', () => {
  assert.equal(claudeCodeMatcher.match('usage limit reached|123456'), null)
})

/* ------------------------------- watcher -------------------------------- */

type Harness = {
  store: SchedulerStore
  cleanup: () => void
  enqueued: { fireAtEpochMs: number; prompt: string; sessionId: string; ownerId: string }[]
  notices: { channelId: string; text: string }[]
  scheduler: Scheduler
  sessions: SessionStore
  watcher: ReturnType<typeof createLimitWatcher>
}

function setup(opts: { backend?: string; matchers?: LimitMatcher[] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sched-lw-'))
  const store = createSchedulerStore({ dbPath: join(dir, 'scheduler.db') })
  store.init()

  const enqueued: Harness['enqueued'] = []
  const notices: Harness['notices'] = []

  const session: Session = {
    id: 'sess-X',
    name: 'x',
    createdAt: 1,
    lastActiveAt: 1,
    channelId: 'chan-9',
    transport: 'channels',
    backend: opts.backend ?? 'claude-code',
  }
  const sessions = {
    findById: (id: string) => (id === session.id ? session : undefined),
  } as unknown as SessionStore

  const fakeJob = (input: {
    sessionId: string
    ownerId: string
    prompt: string
    fireAtEpochMs: number
  }): Job => ({
    id: 'job-' + Math.random().toString(36).slice(2, 10),
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
    createdAtEpochMs: Date.now(),
    updatedAtEpochMs: Date.now(),
    notes: null,
  })

  const scheduler = {
    start: () => {},
    stop: () => {},
    addCron: () => { throw new Error('unused') },
    addQueue: (input: { sessionId: string; ownerId: string; prompt: string; fireAtEpochMs: number }) => {
      enqueued.push({ ...input })
      return fakeJob(input)
    },
    listJobs: () => [],
    getJob: () => null,
    deleteJob: () => false,
    setEnabled: () => false,
  } as unknown as Scheduler

  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log, log: () => {} }

  const watcher = createLimitWatcher({
    scheduler,
    store,
    sessions,
    log: log as unknown as Parameters<typeof createLimitWatcher>[0]['log'],
    botOwnerId: 'owner-1',
    matchers: opts.matchers,
    notify: (channelId, text) => notices.push({ channelId, text }),
  })

  return {
    store,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) },
    enqueued,
    notices,
    scheduler,
    sessions,
    watcher,
  }
}

function reply(text: string, over: Partial<ReplyEvent> = {}): ReplyEvent {
  return {
    sessionId: 'sess-X',
    channelId: 'chan-9',
    msgId: 'm1',
    text,
    ...over,
  }
}

test('watcher enqueues nudge at reset+grace when claude-code session hits limit (defaults)', () => {
  const h = setup()
  try {
    const futureSec = Math.floor((Date.now() + 60_000) / 1000)
    h.watcher.handleReply(reply(`Claude AI usage limit reached|${futureSec}`))
    assert.equal(h.enqueued.length, 1)
    const job = h.enqueued[0]
    assert.equal(job.sessionId, 'sess-X')
    assert.equal(job.ownerId, 'owner-1')
    assert.equal(job.prompt, DEFAULT_NUDGE_TEXT)
    assert.equal(job.fireAtEpochMs, futureSec * 1000 + DEFAULT_GRACE_MS)
    assert.equal(h.notices.length, 1)
    assert.match(h.notices[0].text, /Auto-resume scheduled/)
  } finally {
    h.cleanup()
  }
})

test('watcher applies custom config (mode=auto-nudge, custom nudge, custom grace)', () => {
  const h = setup()
  try {
    h.store.upsertLimitConfig({
      sessionId: 'sess-X',
      mode: 'auto-nudge',
      nudgeText: 'pick up where I left off please',
      graceMs: 5_000,
      updatedAtEpochMs: Date.now(),
    })
    const futureSec = Math.floor((Date.now() + 60_000) / 1000)
    h.watcher.handleReply(reply(`usage limit reached|${futureSec}`))
    assert.equal(h.enqueued.length, 1)
    assert.equal(h.enqueued[0].prompt, 'pick up where I left off please')
    assert.equal(h.enqueued[0].fireAtEpochMs, futureSec * 1000 + 5_000)
  } finally {
    h.cleanup()
  }
})

test('watcher does not enqueue when mode=off; still posts a notice', () => {
  const h = setup()
  try {
    h.store.upsertLimitConfig({
      sessionId: 'sess-X',
      mode: 'off',
      nudgeText: null,
      graceMs: DEFAULT_GRACE_MS,
      updatedAtEpochMs: Date.now(),
    })
    const futureSec = Math.floor((Date.now() + 60_000) / 1000)
    h.watcher.handleReply(reply(`usage limit reached|${futureSec}`))
    assert.equal(h.enqueued.length, 0)
    assert.equal(h.notices.length, 1)
    assert.match(h.notices[0].text, /Auto-resume is off/)
  } finally {
    h.cleanup()
  }
})

test('watcher does not enqueue when mode=ask-user (deferred)', () => {
  const h = setup()
  try {
    h.store.upsertLimitConfig({
      sessionId: 'sess-X',
      mode: 'ask-user',
      nudgeText: null,
      graceMs: DEFAULT_GRACE_MS,
      updatedAtEpochMs: Date.now(),
    })
    const futureSec = Math.floor((Date.now() + 60_000) / 1000)
    h.watcher.handleReply(reply(`usage limit reached|${futureSec}`))
    assert.equal(h.enqueued.length, 0)
    assert.match(h.notices[0].text, /ask-user mode is not yet shipped/)
  } finally {
    h.cleanup()
  }
})

test('watcher ignores reply when session does not exist', () => {
  const h = setup()
  try {
    const futureSec = Math.floor((Date.now() + 60_000) / 1000)
    h.watcher.handleReply(reply(`usage limit reached|${futureSec}`, { sessionId: 'unknown' }))
    assert.equal(h.enqueued.length, 0)
    assert.equal(h.notices.length, 0)
  } finally {
    h.cleanup()
  }
})

test('watcher ignores reply for backend with no registered matcher', () => {
  const h = setup({ backend: 'codex' })
  try {
    const futureSec = Math.floor((Date.now() + 60_000) / 1000)
    h.watcher.handleReply(reply(`usage limit reached|${futureSec}`))
    assert.equal(h.enqueued.length, 0)
  } finally {
    h.cleanup()
  }
})

test('watcher ignores reply text that does not match the matcher', () => {
  const h = setup()
  try {
    h.watcher.handleReply(reply('Here is your answer: 42'))
    assert.equal(h.enqueued.length, 0)
    assert.equal(h.notices.length, 0)
  } finally {
    h.cleanup()
  }
})

test('watcher floor-clamps fireAt to now+1s when reset is already in the past', () => {
  const h = setup()
  try {
    const pastSec = Math.floor((Date.now() - 5 * 60_000) / 1000)
    const before = Date.now()
    h.watcher.handleReply(reply(`usage limit reached|${pastSec}`))
    assert.equal(h.enqueued.length, 1)
    assert.ok(h.enqueued[0].fireAtEpochMs >= before + 1000 - 50)
  } finally {
    h.cleanup()
  }
})

test('watcher accepts injected custom matcher', () => {
  const customMatcher: LimitMatcher = {
    backend: 'claude-code',
    match: text => text === 'BOOM' ? { resetAtEpochMs: Date.now() + 10_000 } : null,
  }
  const h = setup({ matchers: [customMatcher] })
  try {
    h.watcher.handleReply(reply('Claude AI usage limit reached|1748358000'))
    assert.equal(h.enqueued.length, 0, 'default matcher should not fire when overridden')
    h.watcher.handleReply(reply('BOOM'))
    assert.equal(h.enqueued.length, 1)
  } finally {
    h.cleanup()
  }
})
