import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ChannelsTransport } from '../src/transports/channels.ts'
import { PerTurnTransport } from '../src/transports/per-turn.ts'
import type { SessionEvent, TransportInit } from '../src/transports/types.ts'

const init: TransportInit = {
  papercupHome: '/tmp/pc-test',
  dispatcherSock: '/tmp/pc-test/none.sock',
  pluginDir: '/tmp/pc-test/plugin',
}

function evt(sessionId: string): SessionEvent {
  return { sessionId, channelId: 'chan-1', source: 'text', content: 'do a big task', meta: {} }
}

/* --- channels: busy from pushEvent until cleared (drives the reaper skip) --- */

test('channels: a fresh session is not busy', () => {
  const t = new ChannelsTransport(init)
  assert.equal(t.isBusy('s1'), false)
})

test('channels: pushEvent marks the session busy (turn in-flight, even before any reply)', () => {
  const t = new ChannelsTransport(init)
  t.pushEvent(evt('s1'))
  assert.equal(t.isBusy('s1'), true, 'must stay busy through a silent turn (e.g. subagents running)')
})

test('channels: cancel clears busy', () => {
  const t = new ChannelsTransport(init)
  t.pushEvent(evt('s1'))
  assert.equal(t.isBusy('s1'), true)
  t.cancel('s1')
  assert.equal(t.isBusy('s1'), false)
})

test('channels: stopSession clears busy', () => {
  const t = new ChannelsTransport(init)
  t.pushEvent(evt('s2'))
  t.stopSession('s2')
  assert.equal(t.isBusy('s2'), false)
})

/* --- per-turn: busy tracks the in-flight turn (no turn → not busy) --- */

test('per-turn: an untouched session is not busy', () => {
  const t = new PerTurnTransport(init)
  assert.equal(t.isBusy('s1'), false)
})
