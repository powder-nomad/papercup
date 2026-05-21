/**
 * Spawns and tracks claude children for the dispatcher — via tmux.
 *
 * WHY TMUX
 *
 * Channels mode in claude 2.1.145 only works when claude has a real TTY.
 * Spawned with `stdio: 'pipe'`, claude auto-enters `-p` (print) mode and
 * exits after the first turn completes — channel notifications never get
 * processed. We previously chased this with stream-json input, bootstrap
 * prompts, and `--bare`, all of which failed in different ways. The
 * verified-working setup is `claude --dangerously-load-development-channels
 * server:papercup-channels` inside an interactive terminal (verified by
 * running it in tmux manually — claude stays alive, channels deliver, the
 * reply tool fires).
 *
 * So this manager wraps every spawn in `tmux new-session -d` to give claude
 * the TTY it needs. Each session lives in a uniquely-named tmux session
 * (`papercup-<sid>`); kill/isAlive/killAll map to `tmux kill-session` /
 * `tmux has-session` / iterating tracked names.
 *
 * tmux is a soft dependency. If `tmux -V` fails at boot, ChannelsTransport
 * refuses to spawn anything and slash-command handlers reject
 * `transport:channels` with an install hint. The dispatcher keeps running
 * for `transport:per-turn` sessions.
 *
 * FLAGS
 *   --strict-mcp-config + --mcp-config <runtime>   bypass project .mcp.json approval
 *   --dangerously-load-development-channels server:papercup-channels
 *   --session-id / --resume                        first turn vs subsequent
 *   --dangerously-skip-permissions (or --permission-mode)
 *                                                  no human to approve tools
 *   --disable-slash-commands                       token economy: skip ~30KB skill_listing
 *   --add-dir                                      grant access to project dirs
 *
 * Notably NOT passed (and why):
 *   --bare              : refuses OAuth / keychain auth — breaks subscription users
 *   --print             : auto-applied by claude when stdout isn't a TTY; under
 *                         tmux stdout IS a TTY, so claude stays interactive
 *   --input-format / --output-format / --verbose
 *                       : only meaningful in --print mode
 *
 * Cwd is set to /tmp so the bot's own CLAUDE.md / project memory doesn't leak in.
 *
 * KNOWN LIMITATIONS
 *
 * onTurnComplete is dead. Without `--output-format stream-json --verbose`,
 * claude doesn't emit `result` events with token usage, so the context-
 * pressure indicator (warn at 150k / 180k input tokens) is silent for
 * channels sessions. Per-turn sessions still get it via their backend's
 * own parser. Restoring it for channels would require either a separate
 * MCP probe tool or scraping `tmux capture-pane` output.
 *
 * stdout/stderr from claude are NOT captured by the dispatcher — they live
 * in the tmux scrollback. For debugging a stuck session, run
 * `tmux attach -t papercup-<sid>`.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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
  /** Kept for API stability but never invoked in tmux-supervised channels mode —
   *  claude doesn't emit stream-json `result` events without --print mode. */
  onTurnComplete?: (usage: { inputTokens: number; outputTokens: number }) => void
}

type Tracked = {
  sessionName: string
  spawnedAt: number
}

export class ClaudeChildManager {
  private tracked = new Map<string, Tracked>()
  private log: Logger
  constructor() {
    this.log = makeLogger('claude')
  }

  /**
   * Synchronous probe at dispatcher boot. Returns true if `tmux -V` succeeds.
   * ChannelsTransport calls this once and gates all spawn attempts on the
   * result.
   */
  static probeTmuxAvailable(): boolean {
    try {
      const r = spawnSync('tmux', ['-V'], { stdio: 'ignore', timeout: 2000 })
      return r.status === 0
    } catch {
      return false
    }
  }

  isAlive(sessionId: string): boolean {
    const t = this.tracked.get(sessionId)
    if (!t) return false
    const r = spawnSync('tmux', ['has-session', '-t', t.sessionName], { stdio: 'ignore' })
    if (r.status !== 0) {
      // Session died out-of-band (user killed it, tmux server restarted, etc.).
      // Drop our tracking entry so the next spawn() actually creates a new one.
      this.tracked.delete(sessionId)
      return false
    }
    return true
  }

  spawn(opts: ClaudeChildOpts): void {
    if (this.isAlive(opts.sessionId)) {
      this.log.info(`spawn no-op (session=${opts.sessionId}, already alive in tmux)`)
      return
    }
    const mcpConfigPath = this.writeRuntimeMcpConfig(opts)

    const claudeArgs: string[] = [
      '--strict-mcp-config',
      '--mcp-config', mcpConfigPath,
      '--dangerously-load-development-channels', 'server:papercup-channels',
      '--disable-slash-commands',
    ]
    if (opts.permissionMode) {
      claudeArgs.push('--permission-mode', opts.permissionMode)
    } else {
      claudeArgs.push('--dangerously-skip-permissions')
    }
    if (opts.resume) {
      claudeArgs.push('--resume', opts.sessionId)
    } else {
      claudeArgs.push('--session-id', opts.sessionId)
    }
    if (opts.model) claudeArgs.push('--model', opts.model)
    if (opts.effort) claudeArgs.push('--effort', opts.effort)
    // TEMP: --add-dir disabled because passing --add-dir /home/.../packages/papercup
    // appears to trigger discovery of packages/channels-plugin/plugin/.mcp.json,
    // which double-registers `papercup-channels` and confuses
    // --dangerously-load-development-channels (logs "no MCP server configured
    // with that name" twice and channel notifications are dropped). Re-enable
    // once root-caused.
    // if (opts.projectDir) claudeArgs.push('--add-dir', opts.projectDir)

    const sessionName = tmuxSessionNameFor(opts.sessionId)
    // tmux 3.0+ `-e KEY=VAL` sets env for the new session. Plugin reads
    // PAPERCUP_SESSION_ID / PAPERCUP_DISPATCHER_SOCK at startup.
    const tmuxArgs: string[] = [
      'new-session', '-d',
      '-s', sessionName,
      '-x', '200', '-y', '50', // PTY dimensions; some claude UI needs sane defaults
      '-e', `PAPERCUP_SESSION_ID=${opts.sessionId}`,
      '-e', `PAPERCUP_DISPATCHER_SOCK=${opts.dispatcherSock}`,
      '-c', '/tmp',
      '--',
      'claude', ...claudeArgs,
    ]

    this.log.info(
      `spawning claude via tmux (session=${opts.sessionId}, model=${opts.model ?? 'default'}, ${opts.resume ? 'resume' : 'first'}, tmux=${sessionName})`,
    )

    // The tmux client process exits ~immediately after creating the detached
    // session. We capture stderr so spawn failures surface in the dispatcher log.
    const client = spawn('tmux', tmuxArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrBuf = ''
    client.stderr?.on('data', (c: Buffer) => { stderrBuf += c.toString('utf8') })
    client.on('exit', (code) => {
      if (code === 0) {
        this.tracked.set(opts.sessionId, { sessionName, spawnedAt: Date.now() })
        this.log.info(`tmux session created (session=${opts.sessionId}, tmux=${sessionName})`)
        // Interactive claude shows a one-time workspace-trust dialog the first
        // time it sees a given cwd ("Is this a project you created or one you
        // trust?"). With `cwd: /tmp` that dialog fires on every fresh spawn
        // and blocks the MCP plugin from booting until answered. Auto-accept
        // by sending `1` + Enter ONLY if we detect the dialog text — guards
        // against accidentally injecting "1" as a user prompt for resumed
        // sessions where the dialog doesn't appear.
        setTimeout(() => this.maybeAcceptTrustDialog(opts.sessionId, sessionName), 1500)
      } else {
        this.log.error(
          `tmux new-session failed (session=${opts.sessionId}, exit=${code}). stderr: ${stderrBuf.trim().slice(0, 500)}`,
        )
      }
    })
    client.on('error', err => {
      this.log.error(`tmux spawn error (session=${opts.sessionId}):`, err)
    })
  }

  kill(sessionId: string): boolean {
    const t = this.tracked.get(sessionId)
    if (!t) return false
    const r = spawnSync('tmux', ['kill-session', '-t', t.sessionName], { stdio: 'ignore' })
    this.tracked.delete(sessionId)
    if (r.status === 0) {
      this.log.info(`tmux session killed (session=${sessionId}, tmux=${t.sessionName})`)
      return true
    }
    // Non-zero usually means the session already didn't exist (out-of-band kill).
    return false
  }

  killAll(): void {
    for (const session of [...this.tracked.keys()]) {
      this.kill(session)
    }
  }

  /**
   * Detects known interactive bootstrap dialogs that claude shows BEFORE it
   * boots the MCP plugin (trust workspace, dev-channels warning, …) and
   * answers each with `1` + Enter. Polls every 500ms for up to TRUST_POLL_MS
   * because dialogs can appear sequentially: claude shows the trust dialog,
   * we accept, then claude renders the dev-channels warning, we accept that
   * too, then the plugin finally spawns.
   *
   * Each known pattern is matched by TWO distinctive substrings to avoid
   * accidentally injecting `1` into a real user prompt. Once we stop seeing
   * a dialog in two consecutive polls, we exit early — claude has moved past
   * the bootstrap dialogs.
   */
  private maybeAcceptTrustDialog(sessionId: string, sessionName: string): void {
    const TRUST_POLL_MS = 10_000
    const INTERVAL_MS = 500
    const deadline = Date.now() + TRUST_POLL_MS
    let seenDialogAt = 0
    let acceptedCount = 0
    const lastAccepted = new Map<string, number>()

    const tick = (): void => {
      if (Date.now() > deadline) {
        if (acceptedCount > 0) {
          this.log.info(
            `bootstrap dialogs done (session=${sessionId}, accepted=${acceptedCount})`,
          )
        }
        return
      }
      // If we saw a dialog ≥1.5s ago and nothing new, assume bootstrap is done.
      if (seenDialogAt > 0 && Date.now() - seenDialogAt > 1500) {
        this.log.info(
          `bootstrap dialogs done (session=${sessionId}, accepted=${acceptedCount})`,
        )
        return
      }
      const cap = spawnSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf8',
        timeout: 2000,
      })
      if (cap.status === 0) {
        const out = cap.stdout
        for (const dialog of CLAUDE_BOOTSTRAP_DIALOGS) {
          if (dialog.match.every(s => out.includes(s))) {
            // De-dup: don't re-accept the same dialog within 2s — sometimes
            // claude redraws the screen and we'd otherwise hammer it.
            const last = lastAccepted.get(dialog.name) ?? 0
            if (Date.now() - last < 2000) break
            lastAccepted.set(dialog.name, Date.now())
            seenDialogAt = Date.now()
            acceptedCount += 1
            this.log.info(
              `auto-accepting ${dialog.name} (session=${sessionId}, tmux=${sessionName})`,
            )
            spawnSync('tmux', ['send-keys', '-t', sessionName, '1', 'Enter'], { timeout: 2000 })
            break // only accept one per tick — let claude redraw
          }
        }
      }
      setTimeout(tick, INTERVAL_MS)
    }
    setTimeout(tick, INTERVAL_MS)
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

/**
 * Bootstrap dialogs claude shows interactively before the MCP plugin spawns.
 * Each entry needs TWO distinctive substrings — both must match — to avoid
 * accidentally injecting "1" into a user message that happens to mention
 * one of them. Add new entries here if claude introduces more dialogs.
 */
const CLAUDE_BOOTSTRAP_DIALOGS: Array<{ name: string; match: [string, string] }> = [
  {
    name: 'workspace-trust dialog',
    match: ['trust this folder', 'Yes, I trust'],
  },
  {
    name: 'dev-channels warning',
    match: ['Loading development channels', 'local development'],
  },
]

function tmuxSessionNameFor(sessionId: string): string {
  // tmux session names can be arbitrary strings but dots break -t selectors,
  // and we want them grep-able. UUIDs are dash-only, so a `papercup-` prefix
  // is safe and lets `tmux ls | grep papercup-` find our sessions.
  return `papercup-${sessionId}`
}

// Re-exported for callers that still import ChildProcess from this file. Not
// used by the tmux spawn path but kept to avoid breaking import sites mid-
// refactor.
export type { ChildProcess }
