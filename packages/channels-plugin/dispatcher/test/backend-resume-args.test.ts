import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAntigravityArgs } from '../src/transports/backends/antigravity-cli.ts'
import { buildOpencodeArgs, resolveOpencodeBinary, parseOpencodeStream, writePapercupMcpConfig } from '../src/transports/backends/opencode-cli.ts'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('opencode follow-up turn passes --continue when no real session id captured yet', () => {
  const args = buildOpencodeArgs({ userText: 'more', extra: [], resume: true })
  assert.ok(args.includes('--continue'))
  assert.ok(!args.includes('--session'))
})

test('opencode prefers a captured real --session id over --continue', () => {
  const args = buildOpencodeArgs({ userText: 'more', extra: [], resume: true, sessionId: 'ses_ABC' })
  const i = args.indexOf('--session')
  assert.notEqual(i, -1)
  assert.equal(args[i + 1], 'ses_ABC')
  assert.ok(!args.includes('--continue'), 'real session id supersedes --continue')
})

/* --------------------- opencode --format json parsing --------------------- */

test('parseOpencodeStream extracts text, session id, and tokens (real event shape)', () => {
  const stream = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_X', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', sessionID: 'ses_X', part: { type: 'text', text: 'PROBE-OK' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_X', part: { reason: 'stop', tokens: { input: 7093, output: 134 } } }),
  ].join('\n')
  const r = parseOpencodeStream(stream)
  assert.equal(r.text, 'PROBE-OK')
  assert.equal(r.sessionId, 'ses_X')
  assert.equal(r.inputTokens, 7093)
  assert.equal(r.outputTokens, 134)
})

test('parseOpencodeStream concatenates multiple text parts and sums step tokens', () => {
  const stream = [
    JSON.stringify({ type: 'text', sessionID: 'ses_Y', part: { text: 'Hello ' } }),
    JSON.stringify({ type: 'text', sessionID: 'ses_Y', part: { text: 'world' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_Y', part: { tokens: { input: 10, output: 2 } } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_Y', part: { tokens: { input: 5, output: 3 } } }),
  ].join('\n')
  const r = parseOpencodeStream(stream)
  assert.equal(r.text, 'Hello world')
  assert.equal(r.inputTokens, 15)
  assert.equal(r.outputTokens, 5)
})

test('parseOpencodeStream tolerates non-json/blank lines', () => {
  const r = parseOpencodeStream('\nnot json\n' + JSON.stringify({ type: 'text', sessionID: 's', part: { text: 'ok' } }) + '\n')
  assert.equal(r.text, 'ok')
  assert.equal(r.sessionId, 's')
})

/* ----------------------- opencode papercup MCP config ----------------------- */

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) saved[k] = process.env[k]
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  try { return fn() } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
}

test('writePapercupMcpConfig is opt-out: returns undefined only when PAPERCUP_OPENCODE_MCP=0', () => {
  withEnv({ PAPERCUP_OPENCODE_MCP: '0' }, () => {
    assert.equal(writePapercupMcpConfig('sess-1'), undefined)
  })
})

test('writePapercupMcpConfig returns undefined when plugin server.ts is missing', () => {
  withEnv({ PAPERCUP_OPENCODE_MCP: undefined, PAPERCUP_PLUGIN_DIR: '/nonexistent/plugin' }, () => {
    assert.equal(writePapercupMcpConfig('sess-1'), undefined)
  })
})

test('writePapercupMcpConfig writes a valid per-session local MCP config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-mcp-'))
  const pluginDir = join(dir, 'plugin')
  mkdirSync(pluginDir)
  writeFileSync(join(pluginDir, 'server.ts'), '// stub')
  try {
    withEnv({
      PAPERCUP_OPENCODE_MCP: '1',
      PAPERCUP_HOME: dir,
      PAPERCUP_PLUGIN_DIR: pluginDir,
      PAPERCUP_DISPATCHER_SOCK: '/tmp/test.sock',
    }, () => {
      const p = writePapercupMcpConfig('sess-XYZ')
      assert.ok(p, 'returns a config path')
      const srv = JSON.parse(readFileSync(p!, 'utf8')).mcp.papercup
      assert.equal(srv.type, 'local')
      assert.equal(srv.enabled, true)
      assert.equal(srv.command[1], join(pluginDir, 'server.ts'))
      assert.equal(srv.environment.PAPERCUP_SESSION_ID, 'sess-XYZ')
      assert.equal(srv.environment.PAPERCUP_DISPATCHER_SOCK, '/tmp/test.sock')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
