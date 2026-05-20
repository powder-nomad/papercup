/**
 * Spawns and tracks claude children for the dispatcher.
 *
 * MVP: one child per bound channel, hardcoded session id. Phase 2 introduces
 * /bind, lazy spawn, and the idle reaper.
 *
 * Flags chosen per PROTOCOL.md § "Phase 1 actions":
 *   --strict-mcp-config + --mcp-config <runtime>   bypass project .mcp.json approval
 *   --dangerously-load-development-channels server:papercup-channels
 *   --input-format stream-json + --output-format stream-json + --verbose + --print
 *       keeps the session long-lived (stream-json stdin doesn't EOF after one turn)
 *   --session-id / --resume                        first turn vs subsequent
 *   --dangerously-skip-permissions                 no terminal for permission dialogs
 *   --bare                                         skip hooks/LSP/plugin-sync/CLAUDE.md
 *   --disable-slash-commands                       token economy: skip ~30KB skill_listing
 *   --add-dir                                      grant access to project dirs
 *
 * Cwd is set to /tmp so the bot's own CLAUDE.md / project memory doesn't leak in.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeLogger, type Logger } from './log.ts'

export type ClaudeChildOpts = {
  sessionId: string
  pluginDir: string
  dispatcherSock: string
  papercupHome: string
  projectDir?: string
  resume?: boolean
  model?: string
  effort?: string
  /** When set, takes precedence over the default `--dangerously-skip-permissions`. */
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'
  /** Fires per claude `result` stream-json event with final token counts for the turn. */
  onTurnComplete?: (usage: { inputTokens: number; outputTokens: number }) => void
}

export class ClaudeChildManager {
  private children = new Map<string, ChildProcess>()
  private log: Logger
  constructor() {
    this.log = makeLogger('claude')
  }

  isAlive(sessionId: string): boolean {
    const child = this.children.get(sessionId)
    return !!child && child.exitCode === null && !child.killed
  }

  spawn(opts: ClaudeChildOpts): ChildProcess {
    if (this.isAlive(opts.sessionId)) {
      return this.children.get(opts.sessionId)!
    }
    const mcpConfigPath = this.writeRuntimeMcpConfig(opts)

    const args: string[] = [
      '--strict-mcp-config',
      '--mcp-config', mcpConfigPath,
      '--dangerously-load-development-channels', 'server:papercup-channels',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--print',
      '--bare',
      '--disable-slash-commands',
    ]
    // Permission policy: explicit --permission-mode wins. With no override,
    // fall back to bypass because there's no TTY for the interactive dialog.
    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode)
    } else {
      args.push('--dangerously-skip-permissions')
    }
    if (opts.resume) {
      args.push('--resume', opts.sessionId)
    } else {
      args.push('--session-id', opts.sessionId)
    }
    if (opts.model) args.push('--model', opts.model)
    if (opts.effort) args.push('--effort', opts.effort)
    if (opts.projectDir) args.push('--add-dir', opts.projectDir)

    this.log.info(
      `spawning claude (session=${opts.sessionId}, model=${opts.model ?? 'default'}, ${opts.resume ? 'resume' : 'first'})`,
    )
    const child = spawn('claude', args, {
      cwd: '/tmp',
      env: {
        ...process.env,
        PAPERCUP_SESSION_ID: opts.sessionId,
        PAPERCUP_DISPATCHER_SOCK: opts.dispatcherSock,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    this.children.set(opts.sessionId, child)

    // Line-buffered stream-json parse. Each `result` event triggers
    // onTurnComplete for context-pressure tracking. Everything else just logs.
    let lineBuf = ''
    child.stdout?.on('data', (c: Buffer) => {
      lineBuf += c.toString('utf8')
      let nl: number
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl)
        lineBuf = lineBuf.slice(nl + 1)
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as { type?: string; usage?: { input_tokens?: number; output_tokens?: number } }
          if (ev.type === 'result' && ev.usage && opts.onTurnComplete) {
            opts.onTurnComplete({
              inputTokens: Number(ev.usage.input_tokens ?? 0),
              outputTokens: Number(ev.usage.output_tokens ?? 0),
            })
          }
        } catch {
          // Malformed line — best-effort, skip.
        }
        this.log.info(`stdout(${opts.sessionId}): ${truncate(line, 500)}`)
      }
    })
    child.stderr?.on('data', (c: Buffer) => {
      const txt = c.toString('utf8').trimEnd()
      if (txt) this.log.warn(`stderr(${opts.sessionId}): ${truncate(txt, 500)}`)
    })
    child.on('exit', (code, signal) => {
      this.children.delete(opts.sessionId)
      this.log.info(`claude exited (session=${opts.sessionId}, code=${code}, signal=${signal})`)
    })
    child.on('error', err => {
      this.log.error(`claude spawn error (session=${opts.sessionId}):`, err)
    })

    return child
  }

  kill(sessionId: string): boolean {
    const child = this.children.get(sessionId)
    if (!child || !child.pid) return false
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try { child.kill('SIGTERM') } catch { /* already dead */ }
    }
    return true
  }

  killAll(): void {
    for (const session of [...this.children.keys()]) {
      this.kill(session)
    }
  }

  private writeRuntimeMcpConfig(opts: ClaudeChildOpts): string {
    if (!existsSync(opts.papercupHome)) mkdirSync(opts.papercupHome, { recursive: true, mode: 0o700 })
    const path = join(opts.papercupHome, 'runtime-mcp.json')
    const config = {
      mcpServers: {
        'papercup-channels': {
          command: 'bun',
          args: [join(opts.pluginDir, 'server.ts')],
        },
      },
    }
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 })
    return path
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
