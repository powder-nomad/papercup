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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeLogger, type Logger } from './log.ts'

/** How long to let claude flush its transcript after SIGTERM before the idle
 *  reaper tears down the tmux session. */
const GRACEFUL_FLUSH_MS = 1500

export type ClaudeChildOpts = {
  sessionId: string
  pluginDir: string
  dispatcherSock: string
  papercupHome: string
  projectDir?: string
  /** Working directory for the claude child. Defaults to /tmp. Per-session
   *  dirs isolate each session's claude project memory + scratch files. */
  cwd?: string
  resume?: boolean
  model?: string
  effort?: string
  /** When set, takes precedence over the default `--dangerously-skip-permissions`. */
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'
  /** Kept for API stability but never invoked in tmux-supervised channels mode —
   *  claude doesn't emit stream-json `result` events without --print mode. */
  onTurnComplete?: (usage: { inputTokens: number; outputTokens: number }) => void
  /**
   * Called when bootstrap dialogs (trust + dev-channels) have all been
   * answered and claude is ready to consume MCP channel notifications.
   * ChannelsTransport hooks this to drain any inbound events that were
   * queued during the spawn-to-handshake gap — draining earlier (on plugin
   * hello) lands events while claude is still on the dev-channels modal,
   * and claude silently drops them. The callback fires exactly once per
   * spawn, even if no dialogs needed answering.
   */
  onChannelReady?: () => void
  /**
   * Called when the bootstrap poller detects that a `--resume` spawn failed
   * (claude printed "No conversation found with session ID" and exited). The
   * transport responds by respawning the session FRESH with --session-id.
   * Only meaningful when opts.resume is true.
   */
  onResumeFailed?: () => void
}

type Tracked = {
  sessionName: string
  spawnedAt: number
  papercupHome: string
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

  /**
   * Adopt every `papercup-*` tmux session that exists on the host into the
   * tracked map. Called once at boot (or after a dispatcher restart) so the
   * new process picks up management of sessions that the previous dispatcher
   * spawned — without this, `isAlive`/`kill`/`sendNativeCompact` all see an
   * empty map and miss the running children, plus the boot-loop respawn
   * would re-attempt `tmux new-session` with a colliding name on every
   * bound session.
   *
   * The MCP plugin inside each adopted session reconnects to the new UDS
   * server on its own (250ms→5s backoff per `plugin/server.ts`), so this
   * adoption only needs to handle the dispatcher-side bookkeeping.
   *
   * Returns the list of adopted session ids — useful for logging at boot.
   */
  adoptExisting(): string[] {
    const adopted: string[] = []
    try {
      const r = spawnSync('tmux', ['ls', '-F', '#{session_name}'], {
        encoding: 'utf8',
        timeout: 2000,
      })
      // tmux ls exits 1 with "no server running" / "no sessions" on a clean
      // host — both are non-failures from our perspective.
      if (r.status !== 0) return adopted
      const lines = r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      for (const name of lines) {
        if (!name.startsWith('papercup-')) continue
        const sessionId = name.slice('papercup-'.length)
        if (this.tracked.has(sessionId)) continue
        // papercupHome unknown for adopted sessions; kill() cleanup is best-effort.
        this.tracked.set(sessionId, { sessionName: name, spawnedAt: Date.now(), papercupHome: join(homedir(), '.papercup-channels') })
        adopted.push(sessionId)
        this.log.info(`adopted existing tmux session: ${name}`)
      }
    } catch (err) {
      this.log.warn(`adoptExisting failed: ${(err as Error).message}`)
    }
    return adopted
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
      // Slash commands ARE enabled for channels (unlike per-turn, where each
      // call pays the ~30KB skill_listing cost). Channels spawns once and
      // resumes; the blob attaches once per process lifetime, so the cache
      // economy doesn't apply. Users can /skill-name normally inside the
      // session.
      //
      // Block AskUserQuestion specifically: it renders an arrow-key picker
      // in claude's TUI. Inside our headless tmux session there's no human
      // at the keyboard, so claude would wait forever. (Bridging the picker
      // to Discord with a structured payload is doable but not worth the
      // complexity right now.) Same rationale for plan mode below.
      '--disallowedTools', 'AskUserQuestion',
    ]
    if (opts.permissionMode === 'plan') {
      // Plan mode opens an interactive "Approve plan? [y/N]" prompt at the
      // TTY that has the same no-human-at-keyboard problem as
      // AskUserQuestion. Refuse it loudly here so we don't ship a session
      // that silently hangs — /permissions also gates this at request time
      // for channels sessions.
      this.log.warn(
        `channels transport ignoring permissionMode=plan for session=${opts.sessionId} ` +
        `(plan-approval prompt requires interactive TTY). Falling back to ` +
        `--dangerously-skip-permissions.`,
      )
      claudeArgs.push('--dangerously-skip-permissions')
    } else if (opts.permissionMode) {
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
    // Per-session cwd: isolates each session's claude project memory
    // (~/.claude/projects/<encoded-cwd>/) and scratch files so sessions can't
    // see each other's work. Defaults to /tmp for legacy sessions. Create it
    // up front — tmux new-session -c fails if the dir doesn't exist.
    const cwd = opts.cwd ?? '/tmp'
    try {
      if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true, mode: 0o700 })
    } catch (err) {
      this.log.warn(`failed to create session cwd ${cwd}, falling back to /tmp: ${(err as Error).message}`)
    }
    const effectiveCwd = existsSync(cwd) ? cwd : '/tmp'
    // tmux 3.0+ `-e KEY=VAL` sets env for the new session. Plugin reads
    // PAPERCUP_SESSION_ID / PAPERCUP_DISPATCHER_SOCK at startup.
    const tmuxArgs: string[] = [
      'new-session', '-d',
      '-s', sessionName,
      '-x', '200', '-y', '50', // PTY dimensions; some claude UI needs sane defaults
      '-e', `PAPERCUP_SESSION_ID=${opts.sessionId}`,
      '-e', `PAPERCUP_DISPATCHER_SOCK=${opts.dispatcherSock}`,
      '-c', effectiveCwd,
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
        this.tracked.set(opts.sessionId, { sessionName, spawnedAt: Date.now(), papercupHome: opts.papercupHome })
        this.log.info(`tmux session created (session=${opts.sessionId}, tmux=${sessionName})`)
        // Interactive claude shows a one-time workspace-trust dialog the first
        // time it sees a given cwd ("Is this a project you created or one you
        // trust?"). With `cwd: /tmp` that dialog fires on every fresh spawn
        // and blocks the MCP plugin from booting until answered. Auto-accept
        // by sending `1` + Enter ONLY if we detect the dialog text — guards
        // against accidentally injecting "1" as a user prompt for resumed
        // sessions where the dialog doesn't appear.
        setTimeout(() => this.maybeAcceptTrustDialog(opts.sessionId, sessionName, opts.onChannelReady, opts.resume ? opts.onResumeFailed : undefined), 1500)
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
    this.deleteRuntimeMcpConfig(sessionId, t.papercupHome)
    if (r.status === 0) {
      this.log.info(`tmux session killed (session=${sessionId}, tmux=${t.sessionName})`)
      return true
    }
    // Non-zero usually means the session already didn't exist (out-of-band kill).
    return false
  }

  /**
   * Graceful variant of kill() for the idle reaper. SIGTERMs claude directly
   * (so it flushes its transcript and exits cleanly) and tears the tmux
   * session down after a short flush window, instead of the abrupt
   * `tmux kill-session` SIGHUP. Untracks immediately so isAlive() reports dead
   * during the flush window (no events get pushed to a session we're reaping).
   * Fire-and-forget; returns at once.
   */
  gracefulKill(sessionId: string): void {
    const t = this.tracked.get(sessionId)
    if (!t) return
    const { sessionName, papercupHome } = t
    // Untrack now: a reaped session is idle, and we don't want isAlive() to
    // report it alive while we wait for the flush.
    this.tracked.delete(sessionId)
    // The pane's process IS claude (tmux spawns `-- claude …` directly), so
    // pane_pid is claude's pid. SIGTERM it to trigger a clean flush+exit.
    const pidProbe = spawnSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], {
      encoding: 'utf8',
      timeout: 2000,
    })
    const pid = pidProbe.status === 0
      ? Number.parseInt((pidProbe.stdout.trim().split('\n')[0] ?? '').trim(), 10)
      : NaN
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      this.log.info(`graceful reap: SIGTERM claude pid=${pid} (session=${sessionId}); kill-session in ${GRACEFUL_FLUSH_MS}ms`)
    } else {
      this.log.warn(`graceful reap: no pane pid for ${sessionName}; falling back to delayed kill-session`)
    }
    setTimeout(() => {
      spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
      this.log.info(`tmux session killed after flush (session=${sessionId}, tmux=${sessionName})`)
    }, GRACEFUL_FLUSH_MS)
    this.deleteRuntimeMcpConfig(sessionId, papercupHome)
  }

  killAll(): void {
    for (const session of [...this.tracked.keys()]) {
      this.kill(session)
    }
  }

  /**
   * Send claude's own `/compact` slash command into the running session's
   * tmux pane. Channels-mode only — per-turn sessions spawn with
   * `--disable-slash-commands` for token-economy and need the external
   * compactSession() fallback.
   *
   * Returns true if the tmux session is alive and the keystrokes were
   * delivered. False means the session is dead and the caller should fall
   * back to compactSession().
   *
   * UX: claude renders the compaction inline in its TUI and replaces the
   * conversation prefix with a summary. The MCP `reply` tool fires for the
   * "compaction complete" turn just like any other, so Discord sees the
   * summary land as a normal reply. No new session id; the binding stays.
   *
   * `Ctrl+U` is sent first to clear any half-typed prompt sitting on the
   * input line — without it, a partial draft would prefix the `/compact`
   * string and claude would treat the whole thing as a regular user message.
   */
  sendNativeCompact(sessionId: string): boolean {
    const t = this.tracked.get(sessionId)
    if (!t) {
      this.log.warn(`sendNativeCompact: no tracked tmux session for ${sessionId}`)
      return false
    }
    const has = spawnSync('tmux', ['has-session', '-t', t.sessionName], { stdio: 'ignore' })
    if (has.status !== 0) {
      this.tracked.delete(sessionId)
      this.log.warn(`sendNativeCompact: tmux session ${t.sessionName} disappeared`)
      return false
    }
    spawnSync('tmux', ['send-keys', '-t', t.sessionName, 'C-u'], { timeout: 2000 })
    const r = spawnSync('tmux', ['send-keys', '-t', t.sessionName, '/compact', 'Enter'], {
      timeout: 2000,
    })
    if (r.status !== 0) {
      this.log.error(
        `sendNativeCompact: tmux send-keys failed for ${t.sessionName} (status=${r.status})`,
      )
      return false
    }
    this.log.info(`sendNativeCompact: /compact dispatched to ${t.sessionName}`)
    return true
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
  private maybeAcceptTrustDialog(
    sessionId: string,
    sessionName: string,
    onChannelReady?: () => void,
    onResumeFailed?: () => void,
  ): void {
    // Deadline raised from 10s to 15s and post-dialog grace from 1.5s to 5s
    // because the resume-from-summary picker (only fires on long-session
    // --resume) appears AFTER claude finishes loading the session jsonl.
    // For a 13MB session that load takes ~1-2s, so a 1.5s grace exits
    // before the picker surfaces — the poller would declare done and leave
    // claude wedged at the picker forever. 5s comfortably catches it.
    const TRUST_POLL_MS = 15_000
    const INTERVAL_MS = 500
    const POST_DIALOG_GRACE_MS = 5_000
    const deadline = Date.now() + TRUST_POLL_MS
    let seenDialogAt = 0
    let acceptedCount = 0
    const lastAccepted = new Map<string, number>()
    let readyFired = false
    const fireReady = (): void => {
      if (readyFired) return
      readyFired = true
      try { onChannelReady?.() } catch (err) {
        this.log.warn(`onChannelReady callback threw (session=${sessionId}):`, err)
      }
    }

    const tick = (): void => {
      if (Date.now() > deadline) {
        if (acceptedCount > 0) {
          this.log.info(
            `bootstrap dialogs done (session=${sessionId}, accepted=${acceptedCount})`,
          )
        }
        // Even if we never saw a dialog, claude has had 10s to boot. Signal
        // ready so ChannelsTransport can drain any queued events.
        fireReady()
        return
      }
      // If we saw a dialog ≥POST_DIALOG_GRACE_MS ago and nothing new, assume
      // bootstrap is done. Long grace catches late-appearing pickers like
      // resume-from-summary (only fires after claude finishes loading the
      // session jsonl, which can take a couple seconds for large sessions).
      if (seenDialogAt > 0 && Date.now() - seenDialogAt > POST_DIALOG_GRACE_MS) {
        this.log.info(
          `bootstrap dialogs done (session=${sessionId}, accepted=${acceptedCount})`,
        )
        fireReady()
        return
      }
      // NOTE: the old 2s early-exit ("no dialogs seen") has been removed.
      // --dangerously-load-development-channels always shows its warning dialog,
      // but on --resume with a large session claude can take several seconds to
      // load the transcript before displaying it. Firing onChannelReady early
      // left the dialog unaccepted forever. The 15s deadline (TRUST_POLL_MS)
      // is the correct safety net for sessions that genuinely show no dialogs.
      const cap = spawnSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf8',
        timeout: 2000,
      })
      if (cap.status === 0) {
        const out = cap.stdout
        // Resume-failure detection: claude prints this and exits when
        // --resume points at a session it can't load. Respawn fresh instead
        // of leaving the channel wedged (plugin never connects, events queue
        // forever). Only armed for resume spawns (onResumeFailed set).
        if (onResumeFailed && /No conversation found with session ID/i.test(out)) {
          this.log.warn(
            `resume failed (session=${sessionId}): claude can't load the stored session — respawning fresh`,
          )
          try { onResumeFailed() } catch (err) {
            this.log.warn(`onResumeFailed callback threw (session=${sessionId}):`, err)
          }
          return // stop polling; the fresh respawn starts its own poller
        }
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
    // Per-session file: the config embeds session-specific env vars
    // (PAPERCUP_SESSION_ID, PAPERCUP_DISPATCHER_SOCK) so each session's bun
    // subprocess gets the right identity. A single shared runtime-mcp.json
    // would be overwritten on concurrent spawns, causing one session to
    // steal the other's identity.
    const path = join(opts.papercupHome, `runtime-mcp-${opts.sessionId}.json`)
    // Merge order (later wins on collision): ECC bundle → papercup-channels.
    // papercup-channels MUST come last so a stray ECC server with the same
    // name can never displace our own plugin.
    //
    // FIX (claude 2.1.158+): claude no longer inherits the parent tmux
    // environment into MCP subprocess spawns, AND silently drops stdio
    // servers whose `command` can't be resolved in its own PATH at startup.
    // Both issues are fixed here:
    //   1. Use the absolute bun path so the command is always resolvable.
    //   2. Pass PAPERCUP_SESSION_ID + PAPERCUP_DISPATCHER_SOCK explicitly
    //      via the MCP server's `env` field.
    const mcpServers: Record<string, unknown> = {
      ...loadEccMcpServers(this.log),
      'papercup-channels': {
        command: resolveBunPath(),
        args: [join(opts.pluginDir, 'server.ts')],
        env: {
          PAPERCUP_SESSION_ID: opts.sessionId,
          PAPERCUP_DISPATCHER_SOCK: opts.dispatcherSock,
        },
      },
    }
    const config = { mcpServers }
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 })
    return path
  }

  deleteRuntimeMcpConfig(sessionId: string, papercupHome: string): void {
    const path = join(papercupHome, `runtime-mcp-${sessionId}.json`)
    try { rmSync(path, { force: true }) } catch { /* best-effort */ }
  }
}

/**
 * Load MCP servers declared by the everything-claude-code plugin so channels-
 * mode claude has the same MCP surface (github/context7/exa/memory/playwright/
 * sequential-thinking) the operator has in their normal claude sessions.
 *
 * Lookup order:
 *   1. ~/.claude/plugins/cache/everything-claude-code/everything-claude-code/<version>/.mcp.json
 *      — what claude itself loads; version-pinned. Picks the highest version
 *      directory by lexical sort if multiple are present.
 *   2. ~/.claude/plugins/marketplaces/everything-claude-code/.mcp.json
 *      — dev-mode source (not version-pinned). Used as fallback when no
 *      cache install is present.
 *
 * Returns an empty object when ECC isn't installed or the file is unreadable
 * — channels keeps working with just papercup-channels. All failures are
 * logged at warn but never thrown.
 */
function loadEccMcpServers(log: Logger): Record<string, unknown> {
  const home = homedir()
  const cacheRoot = join(home, '.claude', 'plugins', 'cache', 'everything-claude-code', 'everything-claude-code')
  const marketplacePath = join(home, '.claude', 'plugins', 'marketplaces', 'everything-claude-code', '.mcp.json')

  let configPath: string | undefined
  try {
    if (existsSync(cacheRoot)) {
      const versions = readdirSync(cacheRoot).sort()
      const latest = versions[versions.length - 1]
      if (latest) {
        const candidate = join(cacheRoot, latest, '.mcp.json')
        if (existsSync(candidate)) configPath = candidate
      }
    }
  } catch (err) {
    log.warn(`ecc cache lookup failed: ${(err as Error).message}`)
  }
  if (!configPath && existsSync(marketplacePath)) {
    configPath = marketplacePath
  }
  if (!configPath) {
    log.info('ecc plugin not installed; channels-mode claude will only have papercup-channels MCP')
    return {}
  }

  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    const servers = parsed.mcpServers ?? {}
    log.info(
      `merging ecc MCP bundle from ${configPath} (servers: ${Object.keys(servers).join(', ')})`,
    )
    return servers
  } catch (err) {
    log.warn(`failed to load ecc .mcp.json from ${configPath}: ${(err as Error).message}`)
    return {}
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
  {
    // Appears on --resume of a long-lived session (1d+, ~150k+ tokens):
    //   "Resuming the full session will consume a substantial portion of
    //    your usage limits. We recommend resuming from a summary."
    //   1. Resume from summary (recommended)
    //   2. Resume full session as-is
    //   3. Don't ask me again
    // Without auto-accept, claude sits forever waiting for arrow+Enter
    // in a headless tmux pane, and every new Discord message queues but
    // never reaches claude. Picking '1' (recommended summary resume) is
    // the safe default for a long-running bot — full-as-is would burn
    // ~180k tokens on every reaper-driven respawn.
    name: 'resume-from-summary picker',
    match: ['Resume from summary', 'Resume full session as-is'],
  },
]

function tmuxSessionNameFor(sessionId: string): string {
  // tmux session names can be arbitrary strings but dots break -t selectors,
  // and we want them grep-able. UUIDs are dash-only, so a `papercup-` prefix
  // is safe and lets `tmux ls | grep papercup-` find our sessions.
  return `papercup-${sessionId}`
}

/**
 * Resolve the absolute path to the bun binary.
 *
 * Claude 2.1.158+ silently drops stdio MCP servers whose `command` can't be
 * found in its own (restricted) PATH at startup. Using the absolute path
 * avoids the drop even when bun isn't in the system PATH inherited by the
 * MCP spawner. Checks `~/.bun/bin/bun` (the canonical bun install location)
 * first, then falls back to `which bun` (for non-standard installs).
 */
function resolveBunPath(): string {
  const candidate = join(homedir(), '.bun', 'bin', 'bun')
  if (existsSync(candidate)) return candidate
  try {
    const r = spawnSync('which', ['bun'], { encoding: 'utf8', timeout: 2000 })
    if (r.status === 0) {
      const resolved = r.stdout.trim()
      if (resolved) return resolved
    }
  } catch { /* fall through to bare 'bun' */ }
  return 'bun'
}

// Re-exported for callers that still import ChildProcess from this file. Not
// used by the tmux spawn path but kept to avoid breaking import sites mid-
// refactor.
export type { ChildProcess }
