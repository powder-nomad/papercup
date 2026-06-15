import type { SessionStore, Session } from '../state/sessions.ts'
import type { GuildConfigStore } from '../state/guild-config.ts'
import type { VoiceService } from '../voice/voice-line.ts'
import type { Scheduler } from '../scheduler/index.ts'
import type { SchedulerAcl } from '../scheduler/acl.ts'
import type { AllowlistEntry, LimitConfig, LimitMode } from '../scheduler/store.ts'

/**
 * Narrow API the /scheduler allow|deny|allowlist handler needs from the
 * dispatcher. The dispatcher wires this on top of `SchedulerStore` directly
 * so the acl interface itself stays read-only.
 */
export type SchedulerAllowlistApi = {
  add(userId: string, addedBy: string): void
  remove(userId: string): boolean
  list(): AllowlistEntry[]
}

/**
 * Narrow API for /limit-handler. Reads + writes the `limit_config` row for a
 * session via `SchedulerStore`. `show` returns the effective config (defaults
 * applied) so the slash handler doesn't duplicate the watcher's resolution
 * logic.
 */
export type SchedulerLimitApi = {
  show(sessionId: string): LimitConfig
  setMode(sessionId: string, mode: LimitMode): LimitConfig
  setNudge(sessionId: string, text: string): LimitConfig
  setGraceMs(sessionId: string, graceMs: number): LimitConfig
}

/**
 * Dependencies that slash-command handlers need. The dispatcher's main
 * (`index.ts`) constructs this once and passes it to every interaction.
 *
 * spawnFor / killFor / isPluginOnline are deliberately function-shaped
 * (rather than `transport: SessionTransport`) because index.ts owns the
 * mapping from Session → transport. Handlers don't care which transport a
 * session uses — they just ask "spawn the agent for this session" and the
 * dispatcher picks the right one.
 */
export type CommandContext = {
  sessions: SessionStore
  guildConfig: GuildConfigStore
  /** Resolved $PAPERCUP_HOME — used by /compact to persist handoff docs. */
  papercupHome: string
  /** --add-dir target for spawned claude children (default + one-shot summarizer). */
  projectDir?: string
  /** Ensure the agent for the given session is running (idempotent), applying
   *  its model/effort/permissionMode. Picks the right transport internally. */
  spawnFor: (session: Session) => void
  /** SIGTERM the agent for this session (if running). No-op otherwise. */
  killFor: (sessionId: string) => boolean
  /** True when the underlying agent's IPC handshake is alive. Per-turn
   *  transport reports always-true (no handshake); channels reports the
   *  UDS plugin handshake status. */
  isPluginOnline: (sessionId: string) => boolean
  /**
   * Apply a permission-button click. Channels-only; per-turn sessions return
   * false (no permission relay in per-turn mode).
   */
  resolvePermission: (
    requestId: string,
    behavior: 'allow' | 'deny',
    clickerUserId: string,
  ) => boolean
  /**
   * Whether transport:channels is currently supported on this host. Today this
   * means tmux is installed (channels-mode claude requires a TTY; we spawn
   * inside a detached tmux session to provide one). Handlers should reject
   * /bind transport:channels and /transport mode:channels when this is false.
   */
  channelsAvailable: () => boolean
  /**
   * Channels-mode shortcut: dispatch claude's native `/compact` slash command
   * into the live tmux session. Returns true when the keystrokes landed,
   * false when the tmux session is dead — caller should fall back to the
   * external compactSession() path. Always returns false for per-turn
   * sessions (their backend spawns with --disable-slash-commands).
   */
  nativeCompactForChannelsSession: (sessionId: string) => boolean
  /**
   * Voice subsystem. Undefined until lazily booted (see ensureVoice) or if the
   * Whisper sidecar failed to boot — voice slash commands return a "voice
   * unavailable" error in that case.
   */
  voice?: VoiceService
  /**
   * Lazily boot the voice subsystem (Whisper STT + TTS sidecars, ~640 MB) and
   * return it. Voice is NOT started at dispatcher boot to save memory; the
   * voice-channel-join handlers (/voice-join, /pickup) call this first, then
   * read `voice`. Memoized — repeat calls return the running instance. Resolves
   * undefined if the sidecars can't start.
   */
  ensureVoice?: () => Promise<VoiceService | undefined>
  /**
   * Scheduler subsystem (F1 — cron + queue). Undefined when scheduler init
   * fails or is intentionally disabled. /cron, /queue, /scheduler handlers
   * reject with "not initialized" if absent.
   */
  scheduler?: Scheduler
  schedulerAcl?: SchedulerAcl
  schedulerAllowlist?: SchedulerAllowlistApi
  /**
   * Limit-handler API (F2). Undefined when scheduler init fails.
   */
  schedulerLimit?: SchedulerLimitApi
  /**
   * Background process manager — lists and kills agent-spawned processes.
   * Always present after boot; /procs handlers use this directly.
   */
  processManager?: import('../process-manager.ts').ProcessManager
}
