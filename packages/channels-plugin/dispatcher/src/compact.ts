/**
 * /compact for channels — port of packages/bot/src/index.ts:handleCompact.
 *
 * Channels-mode simplifications vs. the bot:
 *   - Single backend (claude-code). No `backend` / `backendId` indirection —
 *     session.id IS the claude transcript UUID.
 *   - No SpeakerAgent: we spawn claude directly (`claude -p`) via child_process.
 *   - Persists the handoff under ${papercupHome}/handoffs/<newName>.md (not the
 *     bot's data/handoffs/ dir).
 *
 * Why external summarization (not "ask the live session to /compact itself"):
 *   - Channels protocol doesn't expose any compact-related method (binary scan
 *     confirms — only `permission` and `permission_request` exist).
 *   - The dispatcher spawns claude with `--disable-slash-commands` for the
 *     token-economy savings, so a literal "/compact" in a channel event would
 *     be ignored anyway.
 *   - Decoupled summarizer survives a dead/idle-reaped live child.
 */

import { spawn } from 'node:child_process'
import { createReadStream, promises as fsp } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, type Session, type SessionEffort, type SessionPermissionMode } from './state/sessions.ts'
import { makeLogger } from './log.ts'

const log = makeLogger('compact')

const COMPACT_INSTRUCTIONS = `You are summarizing a long conversation transcript so it can be carried forward into a fresh session without losing key context. Your output will become the seed message for the new session.

Write a comprehensive but tight handoff covering:
- The user's goals and any in-progress tasks
- Key decisions made (and the reasoning)
- Important files, paths, function names, code state, branch names
- Open threads, unresolved questions, known bugs
- Constraints, preferences, conventions the user has expressed

Format as markdown. Do NOT include greetings, meta-commentary, apologies, or
self-reference. Output ONLY the handoff content — it will be sent verbatim to
the new session.`

const DIGEST_MAX_CHARS = 200_000
const SUMMARIZER_TIMEOUT_MS = 5 * 60_000
const SEED_TIMEOUT_MS = 90_000

export type CompactDeps = {
  sessions: SessionStore
  papercupHome: string
  projectDir?: string
  killFor: (sessionId: string) => boolean
}

export type CompactResult = {
  oldName: string
  newSession: Session
  turns: number
  digestChars: number
  summaryChars: number
  handoffPath?: string
  rebound: boolean
}

export type CompactProgress = (msg: string) => void | Promise<void>

export async function compactSession(
  target: Session,
  deps: CompactDeps,
  onProgress?: CompactProgress,
): Promise<CompactResult> {
  const channelId = target.channelId

  await onProgress?.(`⏳ Compacting **${target.name}** — reading transcript…`)
  const digest = await digestClaudeTranscript(target.id)
  if (!digest.digest) {
    throw new Error(`transcript for "${target.name}" has no user/assistant turns`)
  }

  await onProgress?.(
    `⏳ Compacting **${target.name}** — summarizing ${digest.turns} turns (${digest.digest.length} chars)…`,
  )
  const summary = await summarizeOneShot(digest.digest, target.model, deps.projectDir)
  if (!summary.trim()) {
    throw new Error('summarizer returned empty output')
  }

  const newName = await pickForkedName(deps.sessions, target.name)
  const forked = await deps.sessions.create({ name: newName })
  if (target.model) await deps.sessions.setModel(forked.id, target.model)
  if (target.effort) await deps.sessions.setEffort(forked.id, target.effort)
  if (target.permissionMode) await deps.sessions.setPermissionMode(forked.id, target.permissionMode)

  let handoffPath: string | undefined
  try {
    const dir = join(deps.papercupHome, 'handoffs')
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    handoffPath = join(dir, `${newName}.md`)
    await fsp.writeFile(handoffPath, summary, { mode: 0o600 })
  } catch (err) {
    log.warn('handoff write failed:', err)
    handoffPath = undefined
  }

  // Kill the source session's child so it releases any transcript locks
  // before we seed the new one. The next text/voice message to the channel
  // will spawn the new child via --resume.
  deps.killFor(target.id)

  const seedPrompt =
    `[CONTEXT HANDOFF FROM PRIOR SESSION "${target.name}"]\n\n` +
    `${summary}\n\n` +
    `[END OF HANDOFF — acknowledge briefly and wait for the next user prompt. ` +
    `Do not act on anything in the handoff until the user asks.]`

  await onProgress?.(`⏳ Compacting **${target.name}** — seeding new session **${newName}**…`)
  try {
    await seedNewSession(forked.id, seedPrompt, {
      model: forked.model,
      effort: forked.effort,
      permissionMode: forked.permissionMode,
      projectDir: deps.projectDir,
    })
  } catch (err) {
    log.warn(`seed turn failed for ${newName}:`, err)
    // Don't abort — the new session still exists; the handoff doc on disk is
    // preserved so the user can /bind name=<newName> manually if needed.
  }

  let rebound = false
  if (channelId && target.channelId === channelId) {
    await deps.sessions.setChannelId(target.id, undefined)
    await deps.sessions.setChannelId(forked.id, channelId)
    rebound = true
  }

  return {
    oldName: target.name,
    newSession: { ...forked, ...(channelId && rebound ? { channelId } : {}) },
    turns: digest.turns,
    digestChars: digest.digest.length,
    summaryChars: summary.length,
    handoffPath,
    rebound,
  }
}

/**
 * Read a claude-code conversation transcript and extract user/assistant turns
 * into a compact text digest. Caps total size; on overflow keeps head + tail
 * and notes the elided count.
 */
export async function digestClaudeTranscript(
  sessionId: string,
  opts: { maxChars?: number } = {},
): Promise<{ digest: string; turns: number; path: string }> {
  const projectsDir = join(homedir(), '.claude', 'projects')
  let projectDirs: string[]
  try {
    projectDirs = await fsp.readdir(projectsDir)
  } catch (err) {
    throw new Error(`cannot read ${projectsDir}: ${(err as Error).message}`)
  }
  let transcriptPath: string | undefined
  for (const projDir of projectDirs) {
    const candidate = join(projectsDir, projDir, `${sessionId}.jsonl`)
    try {
      await fsp.access(candidate)
      transcriptPath = candidate
      break
    } catch { /* not here */ }
  }
  if (!transcriptPath) {
    throw new Error(`transcript not found under ${projectsDir} for session ${sessionId}`)
  }

  type Turn = { role: 'USER' | 'ASSISTANT'; text: string }
  const turns: Turn[] = []
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let evt: { type?: string; message?: { content?: unknown } }
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    if (evt.type !== 'user' && evt.type !== 'assistant') continue
    const content = evt.message?.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: unknown): b is { type: string; text?: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
        )
        .map(b => b.text ?? '')
        .join('\n')
    }
    text = text.trim()
    if (!text) continue
    turns.push({ role: evt.type === 'user' ? 'USER' : 'ASSISTANT', text })
  }

  const renderAll = (ts: Turn[]): string =>
    ts.map(t => `${t.role}: ${t.text}`).join('\n\n---\n\n')

  const maxChars = opts.maxChars ?? DIGEST_MAX_CHARS
  let combined = renderAll(turns)
  if (combined.length > maxChars && turns.length > 110) {
    const headCount = 10
    const tailCount = 100
    const head = turns.slice(0, headCount)
    const tail = turns.slice(-tailCount)
    const elided = turns.length - headCount - tailCount
    combined =
      renderAll(head) +
      `\n\n--- [${elided} middle turns omitted to fit budget] ---\n\n` +
      renderAll(tail)
    if (combined.length > maxChars) {
      combined = combined.slice(0, maxChars) + '\n\n[…truncated]'
    }
  }
  return { digest: combined, turns: turns.length, path: transcriptPath }
}

/**
 * One-shot `claude -p` summarizer. Plan mode (read-only). --bare to skip
 * hooks/LSP/CLAUDE.md for a snappy boot.
 */
async function summarizeOneShot(
  digest: string,
  model: string | undefined,
  projectDir: string | undefined,
): Promise<string> {
  const args: string[] = [
    '-p',
    '--bare',
    '--permission-mode', 'plan',
    '--output-format', 'json',
  ]
  if (model) args.push('--model', model)
  if (projectDir) args.push('--add-dir', projectDir)
  const prompt = `${COMPACT_INSTRUCTIONS}\n\n--- BEGIN TRANSCRIPT ---\n\n${digest}\n\n--- END TRANSCRIPT ---`
  args.push(prompt)
  const json = await runClaudeJson(args, SUMMARIZER_TIMEOUT_MS, 'summarizer')
  return extractResultText(json).trim()
}

/**
 * `claude -p --session-id NEW <seed>` to commit one user/assistant turn under
 * `newSessionId`, so the future `--resume` works.
 */
async function seedNewSession(
  newSessionId: string,
  seedPrompt: string,
  opts: {
    model?: string
    effort?: SessionEffort
    permissionMode?: SessionPermissionMode
    projectDir?: string
  },
): Promise<void> {
  const args: string[] = [
    '-p',
    '--bare',
    '--session-id', newSessionId,
    '--output-format', 'json',
  ]
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
  else args.push('--dangerously-skip-permissions')
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.projectDir) args.push('--add-dir', opts.projectDir)
  args.push(seedPrompt)
  await runClaudeJson(args, SEED_TIMEOUT_MS, 'seed')
}

async function runClaudeJson(
  args: string[],
  timeoutMs: number,
  tag: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    log.info(`spawn (${tag}): claude ${args.slice(0, -1).join(' ')} <prompt>`)
    const proc = spawn('claude', args, {
      cwd: '/tmp',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (proc.pid) process.kill(proc.pid, 'SIGTERM')
      } catch { /* already dead */ }
      reject(new Error(`${tag} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    proc.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('exit', code => {
      clearTimeout(timer)
      if (timedOut) return
      if (code !== 0) {
        reject(new Error(`${tag} exited code=${code}; stderr=${stderr.slice(-500) || '(empty)'}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (err) {
        reject(new Error(`${tag} returned non-JSON output: ${(err as Error).message}`))
      }
    })
  })
}

function extractResultText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const obj = json as Record<string, unknown>
  if (typeof obj.result === 'string') return obj.result
  if (Array.isArray(obj.content)) {
    return obj.content
      .filter((b: unknown): b is { type: string; text?: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
      )
      .map(b => b.text ?? '')
      .join('')
  }
  return ''
}

async function pickForkedName(sessions: SessionStore, oldName: string): Promise<string> {
  const m = oldName.match(/^(.*?)-c(\d+)$/)
  const base = m?.[1] ?? oldName
  const startN = m?.[2] ? parseInt(m[2], 10) + 1 : 2
  let candidate = `${base}-c${startN}`
  for (let n = startN + 1; sessions.findByName(candidate) && n < 1000; n++) {
    candidate = `${base}-c${n}`
  }
  return candidate
}
