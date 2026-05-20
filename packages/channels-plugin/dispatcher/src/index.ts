/**
 * Papercup channels dispatcher — main entry.
 *
 * Phase 2 scope:
 *   - Multi-channel /bind / /unbind with persistent guildConfig + sessions
 *     stores (state/*).
 *   - Per-session claude children, lazy spawn, idle reaper.
 *   - Slash command dispatcher wired into Discord's interactionCreate.
 *
 * Wiring:
 *   discord.messageCreate     ─► sessions.findLatestForChannel(channelId) ─► uds.sendTo(session.id, event)
 *   uds.on('reply')           ─► validate frame.chat_id == session.channelId ─► discord.sendReply
 *   discord.interactionCreate ─► commands.dispatchInteraction(interaction, ctx)
 *   timer (60s)               ─► reap sessions idle > IDLE_TIMEOUT_MS
 */

import 'dotenv/config'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DiscordChannelClient, type InboundMessage } from './discord.ts'
import { ClaudeChildManager } from './claude-children.ts'
import { UdsServer } from './uds-server.ts'
import { SessionStore, type Session } from './state/sessions.ts'
import { GuildConfigStore } from './state/guild-config.ts'
import { dispatchInteraction } from './commands/router.ts'
import type { CommandContext } from './commands/types.ts'
import { makeLogger } from './log.ts'
import { bootWhisperSidecar } from './voice/sidecar.ts'
import { VoiceService, type VoiceUtterance } from './voice/voice-line.ts'
import { createTts, type TtsEngine } from '@papercup/voice-stack/tts'

const log = makeLogger('dispatcher')

// Kill the claude child after this much idle time. Next inbound message
// respawns it via --resume. 30min mirrors DESIGN.md's default.
const IDLE_TIMEOUT_MS = Number(process.env.PAPERCUP_IDLE_TIMEOUT_MS ?? 30 * 60_000)
const REAPER_INTERVAL_MS = 60_000
// Context-pressure warning thresholds. Posted at most once per (session, tier).
const CONTEXT_WARN_TOKENS = Number(process.env.PAPERCUP_CONTEXT_WARN_TOKENS ?? 150_000)
const CONTEXT_DANGER_TOKENS = Number(process.env.PAPERCUP_CONTEXT_DANGER_TOKENS ?? 180_000)
// Audio-frame heartbeat: a session whose voice line received audio inside this
// window is treated as not-idle by the reaper.
const VOICE_HEARTBEAT_MS = Number(process.env.PAPERCUP_VOICE_HEARTBEAT_MS ?? 60_000)
const TTS_ENGINE = process.env.PAPERCUP_TTS_ENGINE ?? 'auto'

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) throw new Error('DISCORD_BOT_TOKEN not set')

  const papercupHome = process.env.PAPERCUP_HOME ?? join(homedir(), '.papercup-channels')
  const dispatcherSock = process.env.PAPERCUP_DISPATCHER_SOCK ?? join(papercupHome, 'dispatcher.sock')
  const inboxDir = join(papercupHome, 'inbox')
  const here = fileURLToPath(new URL('.', import.meta.url))
  const pluginDir = process.env.PAPERCUP_PLUGIN_DIR ?? resolve(here, '..', '..', 'plugin')
  const projectDir = process.env.PAPERCUP_PROJECT_DIR ?? undefined
  const allowedUserIds = new Set(
    (process.env.PAPERCUP_ALLOWED_USERS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )

  if (!existsSync(papercupHome)) mkdirSync(papercupHome, { recursive: true, mode: 0o700 })
  if (!existsSync(join(pluginDir, 'server.ts'))) {
    throw new Error(`plugin not found at ${pluginDir}/server.ts (set PAPERCUP_PLUGIN_DIR)`)
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const sessions = new SessionStore(join(papercupHome, 'sessions.json'))
  const guildConfig = new GuildConfigStore(join(papercupHome, 'guild-config.json'))
  await Promise.all([sessions.load(), guildConfig.load()])

  const uds = new UdsServer(dispatcherSock)
  const claude = new ClaudeChildManager()

  // -------------------------------------------------------------------------
  // Voice subsystem (Phase 3). Best-effort: if the Whisper sidecar fails to
  // start (no Python venv, model files missing, …) voice stays unavailable
  // but text + permission relay keep working. /voice-join surfaces the error.
  // -------------------------------------------------------------------------
  const stt = await bootWhisperSidecar()
  let tts: TtsEngine | null = null
  let voice: VoiceService | undefined
  if (stt) {
    try {
      tts = createTts(TTS_ENGINE)
      await tts.start()
      log.info(`tts engine "${TTS_ENGINE}" online`)
    } catch (err) {
      log.warn(`tts engine "${TTS_ENGINE}" failed to start; voice replies will be text-only. err:`, err)
      tts = null
    }
  }
  if (stt && tts) {
    voice = new VoiceService({
      stt,
      tts,
      onUtterance: handleVoiceUtterance,
    })
  }

  // Sessions we've already issued `--session-id` for during this dispatcher
  // process lifetime; subsequent respawns use `--resume`. Persisted-on-disk
  // sessions also need this on first re-spawn after dispatcher restart.
  const everSpawned = new Set<string>(sessions.list().map(s => s.id))

  log.info(
    `boot: home=${papercupHome}, sessions=${sessions.list().length}, plugin=${pluginDir}, allowlist=${allowedUserIds.size > 0 ? `${allowedUserIds.size} users` : 'open'}`,
  )

  // ---------------------------------------------------------------------------
  // Spawn / kill closures
  // ---------------------------------------------------------------------------

  // Track which warning tier we've already posted per session this turn-stream.
  // Cleared when claude exits (session might be reaped and restarted fresh).
  const contextWarnTier = new Map<string, 'warn' | 'danger'>()

  function spawnFor(session: Session): void {
    if (claude.isAlive(session.id)) return
    const resume = everSpawned.has(session.id)
    contextWarnTier.delete(session.id)
    claude.spawn({
      sessionId: session.id,
      pluginDir,
      dispatcherSock,
      papercupHome,
      projectDir,
      resume,
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      onTurnComplete: usage => {
        const channelId = sessions.findById(session.id)?.channelId
        if (!channelId) return
        if (usage.inputTokens >= CONTEXT_DANGER_TOKENS && contextWarnTier.get(session.id) !== 'danger') {
          contextWarnTier.set(session.id, 'danger')
          void discord.postNotice(
            channelId,
            `🛑 **Context danger zone** — ${(usage.inputTokens / 1000).toFixed(0)}k input tokens used. Compact or start a fresh session soon. (Compact is coming in a later phase; for now /unbind and /bind to start fresh.)`,
          )
        } else if (
          usage.inputTokens >= CONTEXT_WARN_TOKENS &&
          !contextWarnTier.has(session.id)
        ) {
          contextWarnTier.set(session.id, 'warn')
          void discord.postNotice(
            channelId,
            `⚠️ **Context getting heavy** — ${(usage.inputTokens / 1000).toFixed(0)}k input tokens used. Consider /unbind + /bind for a fresh session if responses slow down.`,
          )
        }
      },
    })
    everSpawned.add(session.id)
  }

  function killFor(sessionId: string): boolean {
    contextWarnTier.delete(sessionId)
    return claude.kill(sessionId)
  }

  // ---------------------------------------------------------------------------
  // UDS server wiring
  // ---------------------------------------------------------------------------
  await uds.start()

  uds.on('reply', async frame => {
    // Outbound channel guard: the session's stored channelId is the only
    // sendable target. Prevents a forged chat_id in claude's tool call from
    // making the bot post to arbitrary channels.
    const session = sessions.findById(frame.session)
    if (!session) {
      log.warn(`reply for unknown session ${frame.session} — dropping`)
      return
    }
    if (!session.channelId || frame.chat_id !== session.channelId) {
      log.warn(
        `reply chat_id mismatch (session=${frame.session}: session.channelId=${session.channelId}, frame.chat_id=${frame.chat_id}) — dropping`,
      )
      return
    }
    try {
      const ids = await discord.sendReply(frame.chat_id, frame.text, frame.reply_to)
      log.info(
        `reply sent: session=${frame.session}, msgId=${frame.msgId}, discord_ids=${ids.join(',')}`,
      )
      void sessions.touch(frame.session)
    } catch (err) {
      log.error(`reply failed (session=${frame.session}, msgId=${frame.msgId}):`, err)
    }
    // Phase 3: if this session has an active voice line, also play the reply
    // back through the voice channel. Best-effort — TTS failure is logged in
    // voice.speak; the text post above already succeeded.
    if (voice) {
      const line = voice.getBySession(frame.session)
      if (line) {
        void voice.speak(line.guildId, frame.text).catch(err =>
          log.warn(`voice.speak threw (session=${frame.session}):`, err),
        )
      }
    }
  })

  uds.on('helloReceived', (session, pid) => {
    log.info(`plugin online: session=${session}, pid=${pid}`)
  })

  uds.on('pluginDisconnected', session => {
    log.warn(`plugin offline: session=${session}`)
  })

  // Permission relay: pending prompts keyed by request_id. Trimmed when the
  // button is clicked, or when the session is killed.
  type PendingPermission = { sessionId: string; channelId: string; messageId?: string }
  const pendingPermissions = new Map<string, PendingPermission>()

  uds.on('permissionRequest', async frame => {
    const session = sessions.findById(frame.session)
    if (!session?.channelId) {
      log.warn(`permission_request for unbound/unknown session ${frame.session} — dropping`)
      return
    }
    pendingPermissions.set(frame.request_id, {
      sessionId: frame.session,
      channelId: session.channelId,
    })
    const messageId = await discord.postPermissionPrompt(
      session.channelId,
      frame.request_id,
      frame.tool_name,
      frame.description || frame.input_preview || '(no details)',
    )
    const pending = pendingPermissions.get(frame.request_id)
    if (pending && messageId) {
      pending.messageId = messageId
    }
    log.info(
      `permission_request: session=${frame.session}, tool=${frame.tool_name}, request_id=${frame.request_id}`,
    )
  })

  function resolvePermission(
    requestId: string,
    behavior: 'allow' | 'deny',
    clickerUserId: string,
  ): boolean {
    const pending = pendingPermissions.get(requestId)
    if (!pending) return false
    // Allowlist check: if PAPERCUP_ALLOWED_USERS is set, only those users can
    // approve. Empty set = open (matches inbound-message behavior).
    if (allowedUserIds.size > 0 && !allowedUserIds.has(clickerUserId)) return false
    pendingPermissions.delete(requestId)
    const ok = uds.sendTo(pending.sessionId, {
      type: 'permission_verdict',
      session: pending.sessionId,
      request_id: requestId,
      behavior,
    })
    if (!ok) {
      log.warn(`verdict send failed: plugin not connected for session ${pending.sessionId}`)
      return false
    }
    log.info(
      `permission ${behavior}: session=${pending.sessionId}, request_id=${requestId}, by=${clickerUserId}`,
    )
    return true
  }

  // ---------------------------------------------------------------------------
  // Discord wiring
  // ---------------------------------------------------------------------------
  const cmdCtx: CommandContext = {
    sessions,
    guildConfig,
    papercupHome,
    projectDir,
    spawnFor,
    killFor,
    isPluginOnline: id => uds.isConnected(id),
    resolvePermission,
    voice,
  }

  const discord = new DiscordChannelClient({
    token,
    guildConfig,
    allowedUserIds,
    inboxDir,
    onMessage: handleDiscordInbound,
    onInteraction: i => {
      void dispatchInteraction(i, cmdCtx)
    },
  })

  await discord.start()

  // Re-spawn previously-bound sessions so they're warm before any inbound.
  // Best-effort; failures don't block boot.
  for (const s of sessions.list()) {
    if (s.channelId) {
      try { spawnFor(s) } catch (err) { log.warn(`boot respawn failed for ${s.id}:`, err) }
    }
  }

  /**
   * Voice utterance → UDS event. Mirrors the text-inbound path
   * (handleDiscordInbound) so claude sees voice as just another channel
   * source. meta.source="voice" lets the plugin's instructions tell claude
   * to keep replies short for TTS playback.
   */
  function handleVoiceUtterance(u: VoiceUtterance): void {
    const session = sessions.findById(u.sessionId)
    if (!session?.channelId) {
      log.warn(`voice utterance for unbound/unknown session ${u.sessionId} — dropping`)
      return
    }
    if (session.channelId !== u.textChannelId) {
      log.warn(
        `voice utterance: session ${u.sessionId} text channel changed (was=${u.textChannelId}, now=${session.channelId}); dropping`,
      )
      return
    }
    spawnFor(session)
    void sessions.touch(session.id)
    const meta: Record<string, string> = {
      user_id: u.userId,
      ts: u.ts,
      source: 'voice',
    }
    if (u.lang) meta.lang = u.lang
    const ok = uds.sendTo(u.sessionId, {
      type: 'event',
      session: u.sessionId,
      chat_id: u.textChannelId,
      content: u.text,
      meta,
    })
    if (!ok) {
      log.warn(`voice utterance: plugin offline for session=${u.sessionId}; dropping transcript`)
      return
    }
    // Echo the transcript into the bound text channel so the user can scroll back.
    void discord.postNotice(u.textChannelId, `🎙️ ${u.text}`)
  }

  function handleDiscordInbound(msg: InboundMessage): void {
    void (async () => {
      if (!msg.guildId) return
      // discord.ts already enforced isBound, but recheck in case of races.
      if (!guildConfig.isBound(msg.guildId, msg.channelId)) return

      let session = sessions.findLatestForChannel(msg.channelId)
      if (!session) {
        // /bind was used but somehow no session exists. Auto-create so the
        // user doesn't get stuck.
        session = await sessions.create({ channelId: msg.channelId })
        log.info(`auto-created session ${session.name} for channel ${msg.channelId}`)
      }

      spawnFor(session)
      void sessions.touch(session.id)

      // Encode attachments into meta. Format mirrors Anthropic's discord
      // plugin pattern but adds a `path` field since we pre-download:
      //   attachment_count: "N"
      //   attachments: "name|type|size|path; name2|type2|size2|path2"
      // The plugin's `instructions` block teaches claude this format.
      const attMeta: Record<string, string> = {}
      if (msg.attachments.length > 0) {
        attMeta.attachment_count = String(msg.attachments.length)
        attMeta.attachments = msg.attachments
          .map(a => `${a.name}|${a.type}|${a.size}|${a.localPath}`)
          .join('; ')
      }

      const ok = uds.sendTo(session.id, {
        type: 'event',
        session: session.id,
        chat_id: msg.channelId,
        content: msg.content,
        meta: {
          message_id: msg.messageId,
          user: msg.username,
          user_id: msg.userId,
          ts: msg.ts,
          ...attMeta,
        },
      })
      if (!ok) {
        log.warn(
          `plugin not yet connected for session=${session.id}; dropping message ${msg.messageId}. ` +
          `(Plugin handshake takes ~1-2s after spawn — ask the user to resend.)`,
        )
      }
    })().catch(err => log.error('inbound handler:', err))
  }

  // ---------------------------------------------------------------------------
  // Idle reaper
  // ---------------------------------------------------------------------------
  const reaperHandle = setInterval(() => {
    const now = Date.now()
    for (const s of sessions.list()) {
      if (!claude.isAlive(s.id)) continue
      const idle = now - s.lastActiveAt
      if (idle <= IDLE_TIMEOUT_MS) continue
      // Phase 3: a session with an active voice connection (or recent audio
      // frames) is not idle from the user's perspective — they may have been
      // listening, or the line may be paused while we synthesise.
      if (voice?.isSessionConnected(s.id)) {
        const audioAge = voice.lastAudioAgeMs(s.id)
        if (audioAge !== undefined && audioAge <= VOICE_HEARTBEAT_MS) continue
        // Voice still attached but no recent audio: keep alive anyway so
        // the user can speak without waiting for a respawn.
        continue
      }
      log.info(`reaper: killing idle session ${s.name} (${Math.floor(idle / 60_000)}m)`)
      killFor(s.id)
    }
  }, REAPER_INTERVAL_MS)
  reaperHandle.unref()

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------
  let shuttingDown = false
  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`shutdown: ${reason}`)
    clearInterval(reaperHandle)
    try { voice?.shutdown() } catch (err) { log.warn('voice shutdown err:', err) }
    try { tts?.stop() } catch (err) { log.warn('tts stop err:', err) }
    try { stt?.stop() } catch (err) { log.warn('stt stop err:', err) }
    try { await uds.stop() } catch (err) { log.warn('uds stop err:', err) }
    try { await discord.stop() } catch (err) { log.warn('discord stop err:', err) }
    claude.killAll()
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', err => log.error('unhandled rejection:', err))
  process.on('uncaughtException', err => log.error('uncaught exception:', err))
}

main().catch(err => {
  console.error('[dispatcher] fatal:', err)
  process.exit(1)
})
