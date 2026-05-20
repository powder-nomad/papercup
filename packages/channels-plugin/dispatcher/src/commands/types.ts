import type { SessionStore, Session } from '../state/sessions.ts'
import type { GuildConfigStore } from '../state/guild-config.ts'
import type { VoiceService } from '../voice/voice-line.ts'

/**
 * Dependencies that slash-command handlers need. The dispatcher's main
 * (`index.ts`) constructs this once and passes it to every interaction.
 */
export type CommandContext = {
  sessions: SessionStore
  guildConfig: GuildConfigStore
  /** Resolved $PAPERCUP_HOME — used by /compact to persist handoff docs. */
  papercupHome: string
  /** --add-dir target for spawned claude children (default + one-shot summarizer). */
  projectDir?: string
  /** Spawn-or-noop a claude child for the given session, applying its model/effort/permissionMode. */
  spawnFor: (session: Session) => void
  /** Send SIGTERM to a session's claude child (if alive). No-op otherwise. */
  killFor: (sessionId: string) => boolean
  /** True when the plugin's UDS connection for this session is currently online. */
  isPluginOnline: (sessionId: string) => boolean
  /**
   * Apply a permission-button click. Validates the clicker (allowlist),
   * sends the verdict to the plugin, returns true if applied or false if
   * the request is unknown/expired/unauthorized.
   */
  resolvePermission: (
    requestId: string,
    behavior: 'allow' | 'deny',
    clickerUserId: string,
  ) => boolean
  /**
   * Voice subsystem. Undefined if the Whisper sidecar failed to boot — voice
   * slash commands return a "voice unavailable" error in that case.
   */
  voice?: VoiceService
}
