/**
 * Papercup channels dispatcher — main entry.
 *
 * Two transports under one roof. Sessions stamped `transport: "channels"`
 * route through the long-lived `claude --channels` driver; sessions stamped
 * `transport: "per-turn"` route through a per-turn `claude -p` driver that
 * supports mid-turn injection (phone-call interrupt UX).
 *
 * Wiring:
 *   discord.messageCreate     ─► sessions.findLatestForChannel(channelId)
 *                              ─► transport.pushEvent(...)
 *   transport.on("reply")      ─► discord.sendReply + voice.speak(if line)
 *   transport.on("permission") ─► discord.postPermissionPrompt
 *   transport.on("turnComplete")─► context-pressure indicator (warns at 150k/180k)
 *   discord.interactionCreate ─► commands.dispatchInteraction
 *   timer (60s)               ─► reap sessions idle > IDLE_TIMEOUT_MS
 */

import 'dotenv/config'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DiscordChannelClient, type InboundMessage } from './discord.ts'
import { SessionStore, type Session } from './state/sessions.ts'
import { GuildConfigStore } from './state/guild-config.ts'
import { dispatchInteraction } from './commands/router.ts'
import type { CommandContext } from './commands/types.ts'
import { makeLogger } from './log.ts'
import { bootWhisperSidecar } from './voice/sidecar.ts'
import { VoiceService, type VoiceUtterance } from './voice/voice-line.ts'
import { createTts, type TtsEngine } from '@papercup/voice-stack/tts'
import { TransportRegistry } from './transports/registry.ts'
import { ChannelsTransport } from './transports/channels.ts'
import type { SessionTransport, ReplyEvent, PermissionRequestEvent, TurnCompleteEvent } from './transports/types.ts'
import { defaultLocale, t } from './i18n.ts'
import { createSchedulerStore } from './scheduler/store.ts'
import { createScheduler } from './scheduler/index.ts'
import { createAcl } from './scheduler/acl.ts'
import { createLimitWatcher, DEFAULT_LIMIT_MODE, DEFAULT_NUDGE_TEXT, DEFAULT_GRACE_MS, type LimitWatcher } from './scheduler/limit-watcher.ts'
import type { LimitConfig } from './scheduler/store.ts'
import type { SchedulerAllowlistApi, SchedulerLimitApi } from './commands/types.ts'
import { compactSession } from './compact.ts'
import {
  classifyUsage,
  computeThresholds,
  estimateTokensFromBytes,
  loadPolicyFromEnv,
  resolvePolicyMode,
  usagePercent,
  type CompactPolicyMode,
} from './state/context-policy.ts'

const log = makeLogger('dispatcher')

// Kill agent children after this much idle time. Next inbound message
// respawns via --resume. 30min mirrors DESIGN.md's default.
const IDLE_TIMEOUT_MS = Number(process.env.PAPERCUP_IDLE_TIMEOUT_MS ?? 30 * 60_000)
const REAPER_INTERVAL_MS = 60_000
// Context-pressure + auto-compact policy. Percentages of the model window
// (200k / 1M) — see state/context-policy.ts for the defaults and env knobs.
const COMPACT_POLICY_MODE: CompactPolicyMode = resolvePolicyMode()
const COMPACT_POLICY_CONFIG = loadPolicyFromEnv()
// Audio-frame heartbeat: a session whose voice line received audio inside this
// window is treated as not-idle by the reaper.
const VOICE_HEARTBEAT_MS = Number(process.env.PAPERCUP_VOICE_HEARTBEAT_MS ?? 60_000)
const TTS_ENGINE = process.env.PAPERCUP_TTS_ENGINE ?? 'auto'

// Structural type for transports that support per-channel binding (channels
// today; per-turn also exposes it for consistency). Kept internal so the
// SessionTransport contract stays minimal.
type ChannelsTransportLike = {
  bindChannel?: (sessionId: string, channelId: string) => void
  unbindChannel?: (sessionId: string) => void
}

// Cwd we always spawn claude with (see claude-children.ts `-c /tmp`).
// Claude maps cwd → ~/.claude/projects/<encoded-cwd>/, replacing "/" with "-".
const CLAUDE_PROJECT_CWD = '/tmp'
const CLAUDE_PROJECT_DIR_NAME = '-' + CLAUDE_PROJECT_CWD.replace(/^\/+/, '').replace(/\//g, '-')

function claudeSessionPersisted(sessionId: string): boolean {
  const path = join(homedir(), '.claude', 'projects', CLAUDE_PROJECT_DIR_NAME, `${sessionId}.jsonl`)
  return existsSync(path)
}

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

  // -------------------------------------------------------------------------
  // Scheduler subsystem (F1: cron + queue). See DESIGN-scheduler.md.
  // BOT_OWNER_ID gates write commands; empty ⇒ no one is owner (read-only).
  // -------------------------------------------------------------------------
  const botOwnerId = process.env.BOT_OWNER_ID ?? ''
  const schedulerStore = createSchedulerStore({ dbPath: join(papercupHome, 'scheduler.db') })
  let scheduler: ReturnType<typeof createScheduler> | undefined
  let schedulerAcl: ReturnType<typeof createAcl> | undefined
  let schedulerAllowlist: SchedulerAllowlistApi | undefined
  let schedulerLimit: SchedulerLimitApi | undefined
  let limitWatcher: LimitWatcher | undefined
  try {
    schedulerStore.init()
    schedulerAcl = createAcl({ store: schedulerStore, ownerId: botOwnerId })
    schedulerAllowlist = {
      add: (userId, addedBy) =>
        schedulerStore.addAllowlist({ userId, addedBy, addedAtEpochMs: Date.now() }),
      remove: userId => schedulerStore.removeAllowlist(userId),
      list: () => schedulerStore.listAllowlist(),
    }
    const resolveLimitConfig = (sessionId: string): LimitConfig => {
      const row = schedulerStore.getLimitConfig(sessionId)
      if (row) return row
      return {
        sessionId,
        mode: DEFAULT_LIMIT_MODE,
        nudgeText: DEFAULT_NUDGE_TEXT,
        graceMs: DEFAULT_GRACE_MS,
        updatedAtEpochMs: 0,
      }
    }
    schedulerLimit = {
      show: sessionId => resolveLimitConfig(sessionId),
      setMode: (sessionId, mode) => {
        const next: LimitConfig = { ...resolveLimitConfig(sessionId), mode, updatedAtEpochMs: Date.now() }
        schedulerStore.upsertLimitConfig(next)
        return next
      },
      setNudge: (sessionId, text) => {
        const next: LimitConfig = { ...resolveLimitConfig(sessionId), nudgeText: text, updatedAtEpochMs: Date.now() }
        schedulerStore.upsertLimitConfig(next)
        return next
      },
      setGraceMs: (sessionId, graceMs) => {
        const next: LimitConfig = { ...resolveLimitConfig(sessionId), graceMs, updatedAtEpochMs: Date.now() }
        schedulerStore.upsertLimitConfig(next)
        return next
      },
    }
    log.info(
      `scheduler store initialized: ${join(papercupHome, 'scheduler.db')}, owner=${botOwnerId || '(none)'}`,
    )
  } catch (err) {
    log.error('scheduler init failed; /cron, /queue, /scheduler will reject:', err)
  }

  // ---------------------------------------------------------------------------
  // Transports
  // ---------------------------------------------------------------------------
  const transports = new TransportRegistry({ papercupHome, dispatcherSock, pluginDir, projectDir })
  const channelsTransport = transports.get('channels') as ChannelsTransport
  // Channels transport owns the UDS server; start it once before any spawn.
  await channelsTransport.start()
  channelsTransport.setAllowlistCheck(userId =>
    allowedUserIds.size === 0 || allowedUserIds.has(userId),
  )

  // -------------------------------------------------------------------------
  // Voice subsystem. Best-effort: if the Whisper sidecar fails to start (no
  // venv / model files), voice stays unavailable but text + permission relay
  // keep working. /voice-join surfaces the error.
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
  // process lifetime; subsequent respawns use `--resume`. Starts empty —
  // we re-derive `resume` per spawn by also checking whether claude has
  // actually persisted the session to disk (see spawnFor). A session that
  // exists in sessions.json but was reaped before any prompt was sent will
  // NOT be in claude's project store, so `--resume` would die silently
  // (claude exits when --resume can't find the session, killing tmux).
  const everSpawned = new Set<string>()

  log.info(
    `boot: home=${papercupHome}, sessions=${sessions.list().length}, plugin=${pluginDir}, allowlist=${allowedUserIds.size > 0 ? `${allowedUserIds.size} users` : 'open'}`,
  )

  // ---------------------------------------------------------------------------
  // Per-session transport resolver. Sessions stamped transport: "per-turn"
  // route through PerTurnTransport; everything else uses ChannelsTransport.
  // ---------------------------------------------------------------------------
  function transportFor(session: Session): SessionTransport {
    return transports.get(session.transport)
  }

  // Track which warning tier we've already posted per session this turn-stream.
  // Cleared when the agent exits (session might be reaped and restarted fresh).
  const contextWarnTier = new Map<string, 'warn' | 'danger'>()
  // Auto-compact dedupe: while a compact is in flight (async) for a session,
  // no further turn-complete events should retrigger it. Cleared either when
  // compact resolves (success or fail) OR when the channel re-binds to the
  // forked session.
  const autoCompactInFlight = new Set<string>()

  function spawnFor(session: Session): void {
    const transport = transportFor(session)
    if (transport.isAlive(session.id)) return
    if (session.channelId) {
      ;(transport as unknown as ChannelsTransportLike).bindChannel?.(session.id, session.channelId)
    }
    contextWarnTier.delete(session.id)
    // Resume when EITHER (a) we've spawned this session before in this
    // process (so a re-spawn with --session-id would collide with the
    // in-memory session), OR (b) claude has actually persisted the
    // session to disk (--session-id on an existing on-disk UUID also
    // exits silently). The first condition catches mid-process respawns
    // before disk flush; the second catches first-spawns after dispatcher
    // restart. AND-ing them was wrong — first-spawn of a persisted
    // session always failed, because everSpawned starts empty.
    const resume = everSpawned.has(session.id) || claudeSessionPersisted(session.id)
    transport.ensureRunning({
      sessionId: session.id,
      backend: session.backend,
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      resume,
    })
    everSpawned.add(session.id)
  }

  function killFor(sessionId: string): boolean {
    contextWarnTier.delete(sessionId)
    const session = sessions.findById(sessionId)
    if (!session) {
      let killed = false
      for (const t of transports.all()) killed = t.cancel(sessionId) || killed
      return killed
    }
    return transportFor(session).cancel(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Scheduler factory — needs spawnFor + transportFor closures in scope.
  // Skipped if scheduler store failed to init.
  // ---------------------------------------------------------------------------
  if (schedulerAcl) {
    scheduler = createScheduler({
      store: schedulerStore,
      sessions,
      log: log.child('scheduler'),
      ensureSessionRunning: spawnFor,
      pushEvent: event => {
        const s = sessions.findById(event.sessionId)
        if (!s) return false
        return transportFor(s).pushEvent(event)
      },
      isAlive: id => {
        const s = sessions.findById(id)
        if (!s) return false
        return transportFor(s).isAlive(id)
      },
    })
    // `discord` is declared later in this function but `notify` is only invoked
    // when a reply arrives — by then DiscordChannelClient is constructed and
    // started. Mirrors the same forward-reference used by onTurnComplete.
    limitWatcher = createLimitWatcher({
      scheduler,
      store: schedulerStore,
      sessions,
      log: log.child('limit-watcher'),
      botOwnerId,
      notify: (channelId, text) => { void discord.postNotice(channelId, text) },
    })
  }

  // ---------------------------------------------------------------------------
  // Reply / permission / turn-complete wiring (applies to ALL transports)
  // ---------------------------------------------------------------------------

  type PendingPermission = { sessionId: string; channelId: string; messageId?: string }
  const pendingPermissions = new Map<string, PendingPermission>()

  // Discord "Papercup is typing…" heartbeat per bound channel. Started in
  // handleDiscordInbound / handleVoiceUtterance after an event is pushed to
  // the transport; cleared in onReply when the matching reply arrives.
  // Idempotent on start: if a heartbeat is already running for the channel
  // (e.g. user sent two messages back-to-back) the second start is a no-op.
  const typingStops = new Map<string, () => void>()
  const startTyping = (channelId: string): void => {
    if (typingStops.has(channelId)) return
    typingStops.set(channelId, discord.beginTypingHeartbeat(channelId))
  }
  const stopTyping = (channelId: string): void => {
    const stop = typingStops.get(channelId)
    if (!stop) return
    typingStops.delete(channelId)
    stop()
  }

  const onReply = (e: ReplyEvent): void => {
    void (async () => {
      const session = sessions.findById(e.sessionId)
      if (!session) {
        log.warn(`reply for unknown session ${e.sessionId} — dropping`)
        return
      }
      if (!session.channelId || e.channelId !== session.channelId) {
        log.warn(
          `reply chat_id mismatch (session=${e.sessionId}: session.channelId=${session.channelId}, frame.chat_id=${e.channelId}) — dropping`,
        )
        return
      }
      try {
        const ids = await discord.sendReply(e.channelId, e.text, e.replyTo, e.files)
        log.info(
          `reply sent: session=${e.sessionId}, msgId=${e.msgId}, transport=${session.transport}, discord_ids=${ids.join(',')}${e.files?.length ? `, files=${e.files.length}` : ''}`,
        )
        void sessions.touch(e.sessionId)
        // Cleanup the per-turn outbox only after Discord acknowledged the
        // upload — on failure we leave the dir so the user can inspect or
        // resend. Channels-mode replies never set outboxDir (claude passes
        // paths from arbitrary locations and owns their lifetime).
        if (e.outboxDir) {
          rm(e.outboxDir, { recursive: true, force: true }).catch(err =>
            log.warn(`outbox cleanup failed (${e.outboxDir}):`, err),
          )
        }
      } catch (err) {
        log.error(`reply failed (session=${e.sessionId}, msgId=${e.msgId}):`, err)
      } finally {
        stopTyping(e.channelId)
      }
      if (voice) {
        const line = voice.getBySession(e.sessionId)
        if (line) {
          void voice.speak(line.guildId, e.text).catch(err =>
            log.warn(`voice.speak threw (session=${e.sessionId}):`, err),
          )
        }
      }
    })()
  }

  const onPermissionRequest = (e: PermissionRequestEvent): void => {
    void (async () => {
      const session = sessions.findById(e.sessionId)
      if (!session?.channelId) {
        log.warn(`permission_request for unbound/unknown session ${e.sessionId} — dropping`)
        return
      }
      pendingPermissions.set(e.requestId, {
        sessionId: e.sessionId,
        channelId: session.channelId,
      })
      const messageId = await discord.postPermissionPrompt(
        session.channelId,
        e.requestId,
        e.toolName,
        e.description || e.inputPreview || '(no details)',
      )
      const pending = pendingPermissions.get(e.requestId)
      if (pending && messageId) {
        pending.messageId = messageId
        if (session.transport === 'channels') {
          channelsTransport.setPermissionMessageId(e.requestId, messageId)
        }
      }
      log.info(
        `permission_request: session=${e.sessionId}, tool=${e.toolName}, request_id=${e.requestId}`,
      )
    })()
  }

  /**
   * Core evaluator shared by the per-turn event (`onTurnComplete`) and the
   * periodic transcript scanner. Classifies usage, posts deduped warn/danger
   * notices, and (when policy=auto) kicks off auto-compact for sessions past
   * the auto-compact threshold.
   *
   * `source` is just a log tag — "turn" for stream-json events, "scan" for
   * periodic transcript-byte estimates. Channels-mode sessions always come
   * through "scan" because their long-lived child doesn't emit usage events.
   */
  function evaluateContextPressure(
    session: Session,
    inputTokens: number,
    source: 'turn' | 'scan',
  ): void {
    if (!session.channelId) return
    const channelId = session.channelId
    const thresholds = computeThresholds(session.model, COMPACT_POLICY_CONFIG)
    const tier = classifyUsage(inputTokens, thresholds)
    if (tier === 'safe') return
    const fmt = {
      pct: String(usagePercent(inputTokens, thresholds)),
      kTokens: (inputTokens / 1000).toFixed(0),
      kWindow: (thresholds.windowTokens / 1000).toFixed(0),
      autoPct: String(COMPACT_POLICY_CONFIG.autoCompactPct),
    }
    if (tier === 'auto-compact') {
      if (contextWarnTier.get(session.id) !== 'danger') {
        contextWarnTier.set(session.id, 'danger')
        void discord.postNotice(channelId, t(defaultLocale(), 'notice.contextDanger', fmt))
      }
      if (COMPACT_POLICY_MODE === 'auto') {
        log.info(`auto-compact trigger (source=${source}, session=${session.name}, pct=${fmt.pct})`)
        triggerAutoCompact(session, channelId, fmt.pct).catch(err =>
          log.error(`auto-compact wrapper threw for ${session.id}:`, err),
        )
      }
      return
    }
    if (tier === 'danger' && contextWarnTier.get(session.id) !== 'danger') {
      contextWarnTier.set(session.id, 'danger')
      void discord.postNotice(channelId, t(defaultLocale(), 'notice.contextDanger', fmt))
      return
    }
    if (tier === 'warn' && !contextWarnTier.has(session.id)) {
      contextWarnTier.set(session.id, 'warn')
      void discord.postNotice(channelId, t(defaultLocale(), 'notice.contextWarn', fmt))
    }
  }

  const onTurnComplete = (e: TurnCompleteEvent): void => {
    const session = sessions.findById(e.sessionId)
    if (!session) return
    evaluateContextPressure(session, e.usage.inputTokens, 'turn')
  }

  /**
   * Fire-and-forget auto-compact. Dedup'd by sessionId. Channels-mode
   * sessions use claude's native `/compact` slash command via tmux
   * send-keys — same session id, no fork, claude renders the compaction
   * inline. Per-turn sessions fall back to compactSession() (external
   * fork+summarize) because they spawn with slash commands disabled for
   * token economy. Failures are loud — the user must know if auto-compact
   * ditched mid-way so they can /compact manually.
   */
  async function triggerAutoCompact(
    session: Session,
    channelId: string,
    pct: string,
  ): Promise<void> {
    if (autoCompactInFlight.has(session.id)) return
    autoCompactInFlight.add(session.id)
    try {
      if (session.transport === 'channels') {
        await discord.postNotice(
          channelId,
          t(defaultLocale(), 'notice.autoCompactStartNative', { name: session.name, pct }),
        )
        const ok = channelsTransport.sendNativeCompact(session.id)
        if (!ok) {
          // tmux session is dead — fall back to external fork+summarize.
          log.warn(`native /compact unavailable for ${session.id}; falling back to compactSession`)
          await runFallbackCompact(session, channelId)
        } else {
          // Native compact runs in-session; reset our warn-tier dedupe so the
          // next-turn evaluator can re-arm. claude itself will emit the
          // post-compaction summary via the MCP `reply` tool.
          contextWarnTier.delete(session.id)
          log.info(`auto-compact (native): /compact dispatched to ${session.name}`)
        }
      } else {
        await discord.postNotice(
          channelId,
          t(defaultLocale(), 'notice.autoCompactStart', { name: session.name, pct }),
        )
        await runFallbackCompact(session, channelId)
      }
    } catch (err) {
      log.error(`auto-compact failed for ${session.id} (${session.name}):`, err)
      await discord
        .postNotice(
          channelId,
          t(defaultLocale(), 'notice.autoCompactFailed', { error: (err as Error).message }),
        )
        .catch(postErr => log.warn('postNotice for autoCompactFailed threw:', postErr))
    } finally {
      autoCompactInFlight.delete(session.id)
    }
  }

  async function runFallbackCompact(session: Session, channelId: string): Promise<void> {
    const result = await compactSession(session, {
      sessions,
      papercupHome,
      projectDir,
      killFor,
    })
    contextWarnTier.delete(session.id)
    contextWarnTier.delete(result.newSession.id)
    await discord.postNotice(
      channelId,
      t(defaultLocale(), 'notice.autoCompactDone', {
        newName: result.newSession.name,
        turns: String(result.turns),
      }),
    )
    log.info(
      `auto-compact (fallback) ok: ${session.name} → ${result.newSession.name} ` +
      `(${result.turns} turns, ${result.digestChars}c digest → ${result.summaryChars}c summary)`,
    )
  }

  for (const t of transports.all()) {
    t.on('reply', onReply)
    t.on('permissionRequest', onPermissionRequest)
    t.on('turnComplete', onTurnComplete)
    if (limitWatcher) t.on('reply', e => limitWatcher!.handleReply(e))
  }

  function resolvePermission(
    requestId: string,
    behavior: 'allow' | 'deny',
    clickerUserId: string,
  ): boolean {
    const pending = pendingPermissions.get(requestId)
    if (!pending) return false
    const session = sessions.findById(pending.sessionId)
    if (!session) return false
    const transport = transportFor(session)
    const ok = transport.resolvePermission(requestId, behavior, clickerUserId)
    if (ok) pendingPermissions.delete(requestId)
    return ok
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
    isPluginOnline: id => {
      const s = sessions.findById(id)
      if (!s) return false
      return transportFor(s).isPluginOnline(id)
    },
    resolvePermission,
    channelsAvailable: () => channelsTransport.isAvailable(),
    nativeCompactForChannelsSession: id => {
      const s = sessions.findById(id)
      if (!s || s.transport !== 'channels') return false
      return channelsTransport.sendNativeCompact(id)
    },
    voice,
    scheduler,
    schedulerAcl,
    schedulerAllowlist,
    schedulerLimit,
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

  // Start the scheduler tick loop after Discord is online so any guild-channel
  // alerts (failure warnings, disabled-job notices) have a place to land.
  scheduler?.start()

  // Re-spawn previously-bound sessions so they're warm before any inbound.
  // Best-effort; failures don't block boot.
  for (const s of sessions.list()) {
    if (s.channelId) {
      try { spawnFor(s) } catch (err) { log.warn(`boot respawn failed for ${s.id}:`, err) }
    }
  }

  // Periodic context-pressure scanner. The channels transport's claude child
  // doesn't emit stream-json `usage` events (see claude-children.ts:46-52),
  // so `onTurnComplete` is dead for channels sessions — the only way to track
  // their size is to stat the transcript file. Per-turn sessions get this
  // as a between-turn safety net.
  //
  // Default cadence: 5 min. Runs once at boot too, so channels sessions that
  // were already heavy when the dispatcher started get caught before the
  // user types anything. Auto-compact (when policy=auto) fires inside the
  // shared evaluator with the existing dedupe set.
  const CONTEXT_SCAN_INTERVAL_MS = Number(process.env.PAPERCUP_CONTEXT_SCAN_MS ?? 5 * 60_000)

  function scanOneSessionTranscript(s: Session): void {
    if (!s.channelId) return
    const tpath = join(homedir(), '.claude', 'projects', CLAUDE_PROJECT_DIR_NAME, `${s.id}.jsonl`)
    let bytes = 0
    try { bytes = statSync(tpath).size } catch { return }
    const estTokens = estimateTokensFromBytes(bytes)
    evaluateContextPressure(s, estTokens, 'scan')
  }

  function scanAllSessions(): void {
    for (const s of sessions.list()) {
      try { scanOneSessionTranscript(s) } catch (err) {
        log.warn(`context scan failed for ${s.id}:`, err)
      }
    }
  }

  // Boot scan: catch sessions that grew past the threshold while the
  // dispatcher was down. Runs after Discord is online so postNotice works.
  scanAllSessions()

  const contextScanTimer = setInterval(scanAllSessions, CONTEXT_SCAN_INTERVAL_MS)
  contextScanTimer.unref()
  log.info(
    `context scanner: interval=${CONTEXT_SCAN_INTERVAL_MS}ms, policy=${COMPACT_POLICY_MODE}, ` +
    `pcts=warn${COMPACT_POLICY_CONFIG.warnPct}/danger${COMPACT_POLICY_CONFIG.dangerPct}/auto${COMPACT_POLICY_CONFIG.autoCompactPct}`,
  )

  /**
   * Voice utterance → transport event. Voice and text share the same session,
   * so the agent sees voice as just another channel source. meta.source="voice"
   * lets the channels plugin's instructions tell claude to keep replies short
   * for TTS playback; the per-turn transport surfaces the same meta in the
   * prompt.
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
    const ok = transportFor(session).pushEvent({
      sessionId: u.sessionId,
      channelId: u.textChannelId,
      source: 'voice',
      content: u.text,
      meta,
    })
    if (!ok) {
      log.warn(`voice utterance: transport offline for session=${u.sessionId}; dropping transcript`)
      return
    }
    startTyping(u.textChannelId)
    void discord.postNotice(u.textChannelId, t(defaultLocale(), 'notice.voiceTranscript', { text: u.text }))
  }

  function handleDiscordInbound(msg: InboundMessage): void {
    void (async () => {
      if (!msg.guildId) return
      if (!guildConfig.isBound(msg.guildId, msg.channelId)) return

      let session = sessions.findLatestForChannel(msg.channelId)
      if (!session) {
        session = await sessions.create({ channelId: msg.channelId })
        log.info(`auto-created session ${session.name} for channel ${msg.channelId}`)
      }

      spawnFor(session)
      void sessions.touch(session.id)

      const attMeta: Record<string, string> = {}
      if (msg.attachments.length > 0) {
        attMeta.attachment_count = String(msg.attachments.length)
        attMeta.attachments = msg.attachments
          .map(a => `${a.name}|${a.type}|${a.size}|${a.localPath}`)
          .join('; ')
      }

      const ok = transportFor(session).pushEvent({
        sessionId: session.id,
        channelId: msg.channelId,
        source: 'text',
        content: msg.content,
        meta: {
          message_id: msg.messageId,
          user: msg.username,
          user_id: msg.userId,
          ts: msg.ts,
          ...attMeta,
        },
        messageId: msg.messageId,
      })
      if (!ok) {
        log.warn(
          `transport not yet ready for session=${session.id}; dropping message ${msg.messageId}. ` +
          `(Channels plugin handshake takes ~1-2s after spawn — ask the user to resend.)`,
        )
        return
      }
      startTyping(msg.channelId)
    })().catch(err => log.error('inbound handler:', err))
  }

  // ---------------------------------------------------------------------------
  // Idle reaper
  // ---------------------------------------------------------------------------
  const reaperHandle = setInterval(() => {
    const now = Date.now()
    for (const s of sessions.list()) {
      const transport = transportFor(s)
      if (!transport.isAlive(s.id)) continue
      const idle = now - s.lastActiveAt
      if (idle <= IDLE_TIMEOUT_MS) continue
      // A session with an active voice connection (or recent audio frames)
      // is not idle from the user's perspective — they may have been
      // listening, or the line may be paused while we synthesise.
      if (voice?.isSessionConnected(s.id)) {
        const audioAge = voice.lastAudioAgeMs(s.id)
        if (audioAge !== undefined && audioAge <= VOICE_HEARTBEAT_MS) continue
        continue
      }
      log.info(`reaper: killing idle session ${s.name} (${Math.floor(idle / 60_000)}m, transport=${s.transport})`)
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
    for (const stop of typingStops.values()) {
      try { stop() } catch { /* ignore */ }
    }
    typingStops.clear()
    try { scheduler?.stop() } catch (err) { log.warn('scheduler stop err:', err) }
    try { schedulerStore.close() } catch (err) { log.warn('scheduler store close err:', err) }
    try { voice?.shutdown() } catch (err) { log.warn('voice shutdown err:', err) }
    try { tts?.stop() } catch (err) { log.warn('tts stop err:', err) }
    try { stt?.stop() } catch (err) { log.warn('stt stop err:', err) }
    try { await discord.stop() } catch (err) { log.warn('discord stop err:', err) }
    try { await transports.shutdown() } catch (err) { log.warn('transports shutdown err:', err) }
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
