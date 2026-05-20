/**
 * PerTurnTransport — `claude -p` per turn, with --session-id / --resume.
 *
 * The CLI's local session store holds the transcript. This transport spawns
 * one `claude -p` child per user turn, parses the stream-json output for
 * the final reply text + token usage, and emits a `reply` event back to the
 * dispatcher. No long-lived plugin process; no channels protocol.
 *
 * Mid-turn event injection (papercup's "phone-call" UX):
 *
 *   While a turn is in-flight, any pushEvent() call:
 *     1. Appends the new event's content to a per-session pendingPrompts queue
 *     2. SIGTERMs the in-flight child (process group)
 *     3. After exit, a fresh `claude -p` is spawned with a merged prompt
 *        containing the prior un-replied utterances followed by the new one
 *
 *   This means the user's interrupting utterance reaches the agent as part of
 *   the next prompt, with prior context that "the user interrupted while you
 *   were responding to:" + their previous utterance(s). The first turn always
 *   uses --session-id; subsequent turns use --resume.
 *
 * Permission relay isn't supported in per-turn mode — the CLI runs with
 * --dangerously-skip-permissions so it never asks.
 */

import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { makeLogger, type Logger } from '../log.ts'
import type {
  SessionTransport,
  SessionTransportEvents,
  SessionEvent,
  SessionRuntimeConfig,
  TransportInit,
  TransportName,
} from './types.ts'

type PerSessionState = {
  /** Pending events to flush into the next turn. Cleared when the merged
   *  prompt is built. */
  queue: SessionEvent[]
  /** Currently-spawned `claude -p` child for this session, if any. */
  inFlight?: ChildProcess
  /** Resolves when the in-flight turn finishes. Used to serialize
   *  "interrupt + restart" without races. */
  inFlightPromise?: Promise<void>
  /** Has this session been issued --session-id yet? If yes, future spawns
   *  use --resume <id>. */
  hasResumed: boolean
  /** Currently-applied runtime config; refreshed on every ensureRunning(). */
  cfg?: SessionRuntimeConfig
  /** Discord channel currently bound — used to attach channelId to replies. */
  channelId?: string
  stdoutBuf: string
  stderrBuf: string
}

export class PerTurnTransport extends EventEmitter implements SessionTransport {
  readonly name: TransportName = 'per-turn'
  private states = new Map<string, PerSessionState>()
  private log: Logger

  constructor(private init: TransportInit) {
    super()
    this.log = makeLogger('transport:per-turn')
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
    // for the next spawn.
    const s = this.getOrCreate(cfg.sessionId)
    s.cfg = cfg
    if (cfg.resume) s.hasResumed = true
  }

  pushEvent(event: SessionEvent): boolean {
    const s = this.getOrCreate(event.sessionId)
    if (!s.channelId) s.channelId = event.channelId
    s.queue.push(event)
    if (s.inFlight) {
      // Mid-turn interrupt. Cancel the running child; the exit handler
      // will pick up the queued event(s) and respawn.
      this.log.info(`mid-turn interrupt: session=${event.sessionId} (queue=${s.queue.length})`)
      this.killProcessGroup(s.inFlight)
      return true
    }
    // No turn running — spawn now.
    void this.spawnTurn(event.sessionId).catch(err => {
      this.log.error(`spawn failed (session=${event.sessionId}):`, err)
    })
    return true
  }

  resolvePermission(): boolean {
    // No permission relay in per-turn mode.
    return false
  }

  cancel(sessionId: string): boolean {
    const s = this.states.get(sessionId)
    if (!s?.inFlight) return false
    this.killProcessGroup(s.inFlight)
    s.queue.length = 0
    return true
  }

  stopSession(sessionId: string): void {
    const s = this.states.get(sessionId)
    if (!s) return
    if (s.inFlight) this.killProcessGroup(s.inFlight)
    this.states.delete(sessionId)
  }

  isAlive(sessionId: string): boolean {
    const s = this.states.get(sessionId)
    return !!s?.inFlight && s.inFlight.exitCode === null && !s.inFlight.killed
  }

  isPluginOnline(_sessionId: string): boolean {
    // No plugin — surface as always-ready so the dispatcher doesn't gate
    // inbound messages on a non-existent handshake.
    return true
  }

  async shutdown(): Promise<void> {
    for (const [, s] of this.states) {
      if (s.inFlight) this.killProcessGroup(s.inFlight)
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
      s = { queue: [], hasResumed: false, stdoutBuf: '', stderrBuf: '' }
      this.states.set(sessionId, s)
    }
    return s
  }

  /**
   * Drain the queue into one merged prompt and run claude -p. After exit
   * (clean or interrupted), if the queue has refilled during the run, loop
   * and respawn.
   */
  private async spawnTurn(sessionId: string): Promise<void> {
    const s = this.states.get(sessionId)
    if (!s) return
    if (s.queue.length === 0) return
    if (s.inFlight) return

    const events = s.queue.splice(0, s.queue.length)
    const prompt = buildPrompt(events)
    const channelId = events[events.length - 1]?.channelId ?? s.channelId
    if (!channelId) {
      this.log.warn(`spawnTurn: no channelId for session ${sessionId}; dropping turn`)
      return
    }

    const cfg = s.cfg
    const args: string[] = [
      '-p', prompt,
      '--input-format', 'text',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
    ]
    if (cfg?.permissionMode && cfg.permissionMode !== 'bypassPermissions') {
      const i = args.indexOf('--dangerously-skip-permissions')
      if (i >= 0) args.splice(i, 1)
      args.push('--permission-mode', cfg.permissionMode)
    }
    if (s.hasResumed) {
      args.push('--resume', sessionId)
    } else {
      args.push('--session-id', sessionId)
    }
    if (cfg?.model) args.push('--model', cfg.model)
    if (cfg?.effort) args.push('--effort', cfg.effort)
    if (this.init.projectDir) args.push('--add-dir', this.init.projectDir)

    this.log.info(
      `spawn claude -p (session=${sessionId}, ${s.hasResumed ? 'resume' : 'first'}, model=${cfg?.model ?? 'default'}, prompt_len=${prompt.length})`,
    )

    const proc = spawn('claude', args, {
      cwd: '/tmp',
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: process.env,
    })
    s.inFlight = proc
    s.stdoutBuf = ''
    s.stderrBuf = ''

    let lineBuf = ''
    let usage: { inputTokens: number; outputTokens: number } | undefined
    let replyText = ''

    proc.stdout?.on('data', (c: Buffer) => {
      const chunk = c.toString('utf8')
      s.stdoutBuf += chunk
      lineBuf += chunk
      let nl: number
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl)
        lineBuf = lineBuf.slice(nl + 1)
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as {
            type?: string
            message?: { content?: Array<{ type?: string; text?: string }> }
            result?: string
            usage?: { input_tokens?: number; output_tokens?: number }
          }
          if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
            for (const block of ev.message.content) {
              if (block?.type === 'text' && typeof block.text === 'string') {
                replyText += block.text
              }
            }
          }
          if (ev.type === 'result') {
            if (typeof ev.result === 'string') replyText = ev.result
            if (ev.usage) {
              usage = {
                inputTokens: Number(ev.usage.input_tokens ?? 0),
                outputTokens: Number(ev.usage.output_tokens ?? 0),
              }
            }
          }
        } catch {
          // best-effort parse
        }
      }
    })
    proc.stderr?.on('data', (c: Buffer) => {
      s.stderrBuf += c.toString('utf8')
    })

    s.inFlightPromise = new Promise<void>(resolve => {
      proc.on('exit', (code, signal) => {
        const interrupted = code === null || signal === 'SIGTERM' || signal === 'SIGKILL'
        s.inFlight = undefined
        s.inFlightPromise = undefined
        // First-spawn handshake: future spawns must use --resume.
        s.hasResumed = true

        if (interrupted) {
          this.log.info(
            `per-turn: claude interrupted (session=${sessionId}, signal=${signal}); ` +
            `queue=${s.queue.length}`,
          )
        } else if (code !== 0) {
          this.log.warn(
            `per-turn: claude exited code=${code} (session=${sessionId}). stderr: ` +
            s.stderrBuf.slice(0, 500),
          )
        }

        if (!interrupted && code === 0 && replyText.trim().length > 0) {
          this.emit('reply', {
            sessionId,
            channelId,
            msgId: `pt-${Date.now()}`,
            text: replyText.trim(),
          })
          if (usage) this.emit('turnComplete', { sessionId, usage })
        }
        this.emit('sessionExited', sessionId, code, signal)

        // If new events queued during the run, spawn again with the merged prompt.
        if (s.queue.length > 0) {
          void this.spawnTurn(sessionId).catch(err =>
            this.log.error(`respawn failed (session=${sessionId}):`, err),
          )
        }
        resolve()
      })
      proc.on('error', err => {
        this.log.error(`per-turn spawn error (session=${sessionId}):`, err)
        s.inFlight = undefined
        s.inFlightPromise = undefined
        resolve()
      })
    })

    await s.inFlightPromise
  }

  private killProcessGroup(proc: ChildProcess): void {
    if (!proc.pid) return
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
    }
  }
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
