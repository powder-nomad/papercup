import type { SessionStore, Session } from '../state/sessions.ts'
import type { GuildConfigStore } from '../state/guild-config.ts'
import type { VoiceService } from '../voice/voice-line.ts'

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
   * Voice subsystem. Undefined if the Whisper sidecar failed to boot — voice
   * slash commands return a "voice unavailable" error in that case.
   */
  voice?: VoiceService
}
