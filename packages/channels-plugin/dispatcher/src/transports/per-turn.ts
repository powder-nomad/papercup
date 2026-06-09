/**
 * PerTurnTransport — `<binary> -p` per turn, with mid-turn injection.
 *
 * The transport owns the queue + cancel-and-respawn pattern that gives
 * papercup the "phone-call interrupt" UX. The actual spawn (binary,
 * args, output parsing) is delegated to a per-session AgentBackend
 * driver — one of claude-code, codex, gemini-cli, aider, opencode,
 * crush, amp (see ./backends/).
 *
 * Mid-turn event injection:
 *
 *   While a turn is in-flight, any pushEvent() call:
 *     1. Appends the new event to a per-session pendingPrompts queue
 *     2. SIGTERMs the in-flight backend via backend.cancel()
 *     3. After the cancelled respond() rejects with "cancelled", a fresh
 *        respond() is invoked with the merged prompt (prior un-replied
 *        utterances + the new one, tagged so the agent knows the user
 *        interrupted)
 *
 * Permission relay isn't supported in per-turn mode — the driver runs with
 * whatever bypass flag is appropriate for the CLI.
 */

import { EventEmitter } from 'node:events'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { makeLogger, type Logger } from '../log.ts'
import type {
  SessionTransport,
  SessionTransportEvents,
  SessionEvent,
  SessionRuntimeConfig,
  TransportInit,
  TransportName,
} from './types.ts'
import './backends/registry.ts'
import type { AgentBackend, AgentBackendOpts } from './backends/registry.ts'
import { createAgentBackend, listBackends } from './backends/registry.ts'

type PerSessionState = {
  /** Pending events to flush into the next turn. Cleared when the merged
   *  prompt is built. */
  queue: SessionEvent[]
  /** Backend driver for this session. Instantiated lazily on first event. */
  backend?: AgentBackend
  /** Backend name currently in use; if session.backend changes we must
   *  rebuild. */
  backendName?: string
  /** Currently-running respond() promise, if any. */
  inFlight?: Promise<void>
  /** Currently-applied runtime config; refreshed on every ensureRunning(). */
  cfg?: SessionRuntimeConfig
  /** Discord channel currently bound. */
  channelId?: string
}

export class PerTurnTransport extends EventEmitter implements SessionTransport {
  readonly name: TransportName = 'per-turn'
  private states = new Map<string, PerSessionState>()
  private log: Logger
  /** `<papercupHome>/outbox/<channelId>/<turnId>/` — per-turn drop folder.
   *  Agent writes files here with its native tools; we scan after the backend
   *  exits and ship whatever survives the Discord size/count caps. */
  private outboxRoot: string

  constructor(init: TransportInit) {
    super()
    this.log = makeLogger('transport:per-turn')
    this.outboxRoot = join(init.papercupHome, 'outbox')
  }

  bindChannel(sessionId: string, channelId: string): void {
    const s = this.getOrCreate(sessionId)
    s.channelId = channelId
  }

  unbindChannel(sessionId: string): void {
    const s = this.states.get(sessionId)
    if (s) s.channelId = undefined
  }

  ensureRunning(cfg: SessionRuntimeConfig): void {
    // Per-turn has no long-lived process to "ensure"; just stash the cfg
    // for the next spawn. If the backend changed, drop the old driver so
    // we instantiate the new one on the next event.
    const s = this.getOrCreate(cfg.sessionId)
    if (s.backendName && s.backendName !== cfg.backend) {
      try { s.backend?.stop() } catch { /* best-effort */ }
      s.backend = undefined
      s.backendName = undefined
    }
    s.cfg = cfg
  }

  pushEvent(event: SessionEvent): boolean {
    const s = this.getOrCreate(event.sessionId)
    if (!s.channelId) s.channelId = event.channelId
    s.queue.push(event)
    if (s.inFlight && s.backend) {
      // Mid-turn interrupt. Cancel the in-flight backend; the awaiting
      // spawnTurn() will see the rejection, drain the queue, and respawn.
      this.log.info(
        `mid-turn interrupt: session=${event.sessionId} backend=${s.backendName} (queue=${s.queue.length})`,
      )
      try { s.backend.cancel?.() } catch { /* best-effort */ }
      return true
    }
    // No turn running — spawn now.
    void this.spawnTurn(event.sessionId).catch(err => {
      this.log.error(`spawn failed (session=${event.sessionId}):`, err)
    })
    return true
  }

  resolvePermission(): boolean {
    return false
  }

  cancel(sessionId: string): boolean {
    const s = this.states.get(sessionId)
    if (!s?.backend) return false
    s.queue.length = 0
    return s.backend.cancel?.() ?? false
  }

  stopSession(sessionId: string): void {
    const s = this.states.get(sessionId)
    if (!s) return
    try { s.backend?.stop() } catch { /* best-effort */ }
    this.states.delete(sessionId)
  }

  isAlive(sessionId: string): boolean {
    const s = this.states.get(sessionId)
    return !!s?.inFlight
  }

  isPluginOnline(_sessionId: string): boolean {
    // No plugin — surface as always-ready so the dispatcher doesn't gate
    // inbound messages on a non-existent handshake.
    return true
  }

  async shutdown(): Promise<void> {
    for (const [, s] of this.states) {
      try { s.backend?.stop() } catch { /* best-effort */ }
    }
    this.states.clear()
  }

  override on<E extends keyof SessionTransportEvents>(
    event: E,
    listener: SessionTransportEvents[E],
  ): this {
    return super.on(event, listener)
  }

  override off<E extends keyof SessionTransportEvents>(
    event: E,
    listener: SessionTransportEvents[E],
  ): this {
    return super.off(event, listener)
  }

  override emit<E extends keyof SessionTransportEvents>(
    event: E,
    ...args: Parameters<SessionTransportEvents[E]>
  ): boolean {
    return super.emit(event, ...args)
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private getOrCreate(sessionId: string): PerSessionState {
    let s = this.states.get(sessionId)
    if (!s) {
      s = { queue: [] }
      this.states.set(sessionId, s)
    }
    return s
  }

  private async ensureBackend(sessionId: string, s: PerSessionState): Promise<AgentBackend | undefined> {
    const cfg = s.cfg
    if (!cfg) {
      this.log.warn(`ensureBackend: no cfg for session ${sessionId}`)
      return undefined
    }
    if (s.backend && s.backendName === cfg.backend) {
      return s.backend
    }
    let backend: AgentBackend
    try {
      backend = createAgentBackend(cfg.backend)
    } catch (err) {
      this.log.error(
        `unknown backend "${cfg.backend}" for session ${sessionId}. Known: ${listBackends().join(', ')}. err:`,
        err,
      )
      return undefined
    }
    const opts: AgentBackendOpts = {
      sessionId: cfg.sessionId,
      resume: cfg.resume,
      model: cfg.model,
      effort: cfg.effort as AgentBackendOpts['effort'],
      permissionMode: cfg.permissionMode,
      // Channels-plugin runs all sessions as "text" mode — voice is just a
      // meta tag now, not a separate toolset. The bot's voice-mode speaker
      // pattern doesn't apply here.
      mode: 'text',
    }
    await backend.start(opts)
    s.backend = backend
    s.backendName = cfg.backend
    return backend
  }

  /**
   * Drain the queue into one merged prompt and run the backend. On exit
   * (success or interrupt), if the queue has refilled, loop and respawn.
   */
  private async spawnTurn(sessionId: string): Promise<void> {
    const s = this.states.get(sessionId)
    if (!s) return
    if (s.queue.length === 0) return
    if (s.inFlight) return

    const backend = await this.ensureBackend(sessionId, s)
    if (!backend) return

    s.inFlight = (async () => {
      while (s.queue.length > 0) {
        const events = s.queue.splice(0, s.queue.length)
        const prompt = buildPrompt(events)
        const channelId = events[events.length - 1]?.channelId ?? s.channelId
        if (!channelId) {
          this.log.warn(`spawnTurn: no channelId for session ${sessionId}; dropping turn`)
          break
        }

        // Per-turn outbox: agent gets an absolute path it can Write to with its
        // native tools. After the backend exits we scan and attach. Dispatcher
        // rm's the dir once Discord acknowledges the upload.
        const turnId =
          events[events.length - 1]?.messageId ??
          `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const outboxDir = join(this.outboxRoot, channelId, turnId)
        await mkdir(outboxDir, { recursive: true })
        const promptWithOutbox = appendOutboxHint(prompt, outboxDir)

        this.log.info(
          `respond start: session=${sessionId} backend=${s.backendName} prompt_len=${promptWithOutbox.length} outbox=${outboxDir}`,
        )
        const heartbeatStartMs = Date.now()
        const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000
        const HEARTBEAT_CEILING_MS = 60 * 60 * 1000
        let heartbeatHandle: ReturnType<typeof setInterval> | undefined = setInterval(() => {
          const elapsedMin = Math.round((Date.now() - heartbeatStartMs) / 60_000)
          const atCeiling = (Date.now() - heartbeatStartMs) >= HEARTBEAT_CEILING_MS
          const text = atCeiling
            ? `⚠️ Still working after ${elapsedMin}m — use /cancel if stuck.`
            : `⏳ Still working... (${elapsedMin}m elapsed)`
          this.emit('reply', {
            sessionId,
            channelId,
            msgId: `pt-hb-${Date.now()}`,
            text,
          })
          if (atCeiling) {
            clearInterval(heartbeatHandle)
            heartbeatHandle = undefined
          }
        }, HEARTBEAT_INTERVAL_MS)
        try {
          const reply = await backend.respond(promptWithOutbox, { outboxDir })
          if (s.cfg) s.cfg = { ...s.cfg, resume: true }

          const files = await scanOutbox(outboxDir, this.log)
          const baseEmit = {
            sessionId,
            channelId,
            outboxDir,
            ...(files.length > 0 ? { files } : {}),
          }

          if (reply.text.trim().length > 0) {
            this.emit('reply', {
              ...baseEmit,
              msgId: `pt-${Date.now()}`,
              text: reply.text.trim(),
            })
          } else if (files.length > 0) {
            // No text but files were dropped — treat the files themselves as
            // the reply. Discord requires non-empty content OR attachments,
            // so an attachments-only message is valid.
            this.emit('reply', {
              ...baseEmit,
              msgId: `pt-files-${Date.now()}`,
              text: '',
            })
          } else {
            // Backend exited cleanly but produced no user-facing text — common
            // with gemini-cli when the turn ends on a tool call (e.g.
            // update_topic, write_file) instead of a closing message. Silent
            // drop is the worst UX: heartbeat times out with no signal. Emit
            // a placeholder so the user knows the turn completed.
            this.log.warn(
              `respond returned empty text (session=${sessionId} backend=${s.backendName}); ` +
              `emitting placeholder so the user isn't left hanging`,
            )
            this.emit('reply', {
              ...baseEmit,
              msgId: `pt-empty-${Date.now()}`,
              text: '_(no reply text — agent finished on a tool call instead of a message; ask again if you expected one)_',
            })
          }
          if (reply.inputTokens > 0 || reply.outputTokens > 0) {
            this.emit('turnComplete', {
              sessionId,
              usage: { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens },
            })
          }
        } catch (err) {
          const msg = (err as Error).message
          if (msg === 'cancelled') {
            this.log.info(`respond cancelled (session=${sessionId}); queue=${s.queue.length}`)
            // User pre-empted before we replied — nothing will fire the
            // dispatcher's outbox cleanup, so rm here to avoid leak.
            await rm(outboxDir, { recursive: true, force: true }).catch(() => {})
            continue
          }
          this.log.warn(`respond failed (session=${sessionId} backend=${s.backendName}): ${msg}`)
          // Attach outboxDir so the dispatcher cleans it once the error
          // message is delivered. files=[] — even if the agent wrote
          // something partial, attaching scratch on a failed turn is noisy.
          this.emit('reply', {
            sessionId,
            channelId,
            outboxDir,
            msgId: `pt-err-${Date.now()}`,
            text: `❌ Backend error: ${msg}`,
          })
        } finally {
          clearInterval(heartbeatHandle)
          heartbeatHandle = undefined
        }
      }
    })().finally(() => {
      s.inFlight = undefined
    })

    await s.inFlight
  }
}

/** Append a short instruction telling the agent where it can drop files to
 *  attach them to the Discord reply. The path is absolute so it works
 *  regardless of the agent's $*_WORKDIR. */
function appendOutboxHint(prompt: string, outboxDir: string): string {
  const hint =
    `\n\n[Outbox: any file you Write to \`${outboxDir}\` will be attached to ` +
    `your reply on Discord (max 10 files, ≤24 MB each). Use this for ` +
    `screenshots, generated charts, code files, audio renders, etc. The ` +
    `directory already exists. Don't mention it in your reply text — the ` +
    `user just sees the attachments.]`
  return prompt + hint
}

/** List regular files in the outbox dir. Returns absolute paths. Missing or
 *  unreadable dir → empty list. Subdirectories are ignored (Discord doesn't
 *  understand them). Sorted for determinism. */
async function scanOutbox(dir: string, log: Logger): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`scanOutbox readdir failed (${dir}):`, err)
    }
    return []
  }
  const files: string[] = []
  for (const ent of entries) {
    if (!ent.isFile()) continue
    const p = join(dir, ent.name)
    try {
      const st = await stat(p)
      if (st.isFile()) files.push(p)
    } catch {
      // file vanished between readdir and stat — skip
    }
  }
  files.sort()
  return files
}

/**
 * Compose one prompt string from the queued events. Single-event turns send
 * just the content; multi-event turns (mid-turn interrupts) get explicit
 * "user interrupted mid-reply" markers so the agent treats later events as
 * direction changes.
 */
function buildPrompt(events: SessionEvent[]): string {
  if (events.length === 1) {
    const e = events[0]!
    return e.content
  }
  const parts: string[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    const tag = i === 0
      ? `[Discord ${e.source}]`
      : `[Discord ${e.source} — user interrupted mid-reply]`
    parts.push(`${tag}\n${e.content}`)
  }
  return parts.join('\n\n')
}
