import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAntigravityArgs } from '../src/transports/backends/antigravity-cli.ts'
import { buildOpencodeArgs, resolveOpencodeBinary } from '../src/transports/backends/opencode-cli.ts'
import { resolveBackendCwd } from '../src/transports/backends/base-cli.ts'

/* ----------------------------- cwd precedence ----------------------------- */

test('resolveBackendCwd prefers per-session opts.cwd over env and process.cwd', () => {
  assert.equal(resolveBackendCwd('/tmp/papercup/abc', '/work'), '/tmp/papercup/abc')
})

test('resolveBackendCwd falls back to *_WORKDIR env when no opts.cwd', () => {
  assert.equal(resolveBackendCwd(undefined, '/work'), '/work')
})

test('resolveBackendCwd falls back to process.cwd() when nothing set', () => {
  assert.equal(resolveBackendCwd(undefined, undefined), process.cwd())
})

/* --------------------------- antigravity (agy) --------------------------- */

test('antigravity first turn does NOT pass --continue (creates a fresh conversation)', () => {
  const args = buildAntigravityArgs({
    userText: 'hello',
    printTimeout: '24h',
    extra: [],
    bypass: true,
    resume: false,
  })
  assert.ok(!args.includes('--continue'), 'first turn must omit --continue')
  // and must never resurrect the broken --conversation <id> approach
  assert.ok(!args.includes('--conversation'), 'must not use --conversation')
  assert.deepEqual(args.slice(0, 2), ['-p', 'hello'])
})

test('antigravity follow-up turn passes --continue (resumes the cwd conversation)', () => {
  const args = buildAntigravityArgs({
    userText: 'and again',
    printTimeout: '24h',
    extra: [],
    bypass: true,
    resume: true,
  })
  assert.ok(args.includes('--continue'), 'follow-up turn must pass --continue')
  assert.ok(!args.includes('--conversation'))
})

test('antigravity wires outbox via --add-dir and bypass flag', () => {
  const args = buildAntigravityArgs({
    userText: 'x',
    printTimeout: '5m',
    outboxDir: '/tmp/outbox/c/t',
    extra: ['--foo'],
    bypass: true,
    resume: false,
  })
  const i = args.indexOf('--add-dir')
  assert.notEqual(i, -1, '--add-dir present when outboxDir given')
  assert.equal(args[i + 1], '/tmp/outbox/c/t')
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.ok(args.includes('--foo'))
})

test('antigravity omits bypass flag when bypass=false', () => {
  const args = buildAntigravityArgs({
    userText: 'x', printTimeout: '24h', extra: [], bypass: false, resume: true,
  })
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})

/* ------------------------------- opencode ------------------------------- */

test('opencode first turn does NOT pass --continue and never a caller --session', () => {
  const args = buildOpencodeArgs({ userText: 'hi', extra: [], resume: false })
  assert.equal(args[0], 'run')
  assert.ok(!args.includes('--continue'), 'first turn must omit --continue')
  assert.ok(!args.includes('--session'), 'must not pass a caller-supplied --session id')
  assert.equal(args[args.length - 1], 'hi', 'prompt is the trailing positional')
})

test('opencode follow-up turn passes --continue', () => {
  const args = buildOpencodeArgs({ userText: 'more', extra: [], resume: true })
  assert.ok(args.includes('--continue'))
  assert.ok(!args.includes('--session'))
})

test('resolveOpencodeBinary honors OPENCODE_BINARY env first', () => {
  assert.equal(resolveOpencodeBinary('/custom/opencode', '/home/x', () => true), '/custom/opencode')
})

test('resolveOpencodeBinary falls back to ~/.opencode/bin/opencode when it exists', () => {
  assert.equal(
    resolveOpencodeBinary(undefined, '/home/x', (p) => p === '/home/x/.opencode/bin/opencode'),
    '/home/x/.opencode/bin/opencode',
  )
})

test('resolveOpencodeBinary falls back to bare "opencode" (PATH) when install path absent', () => {
  assert.equal(resolveOpencodeBinary(undefined, '/home/x', () => false), 'opencode')
})

test('opencode passes model and json format', () => {
  const args = buildOpencodeArgs({
    userText: 'q', model: 'ollama/gemma4', extra: ['--variant', 'high'], resume: false,
  })
  const mi = args.indexOf('--model')
  assert.equal(args[mi + 1], 'ollama/gemma4')
  const fi = args.indexOf('--format')
  assert.equal(args[fi + 1], 'json')
  assert.ok(args.includes('--variant'))
})
