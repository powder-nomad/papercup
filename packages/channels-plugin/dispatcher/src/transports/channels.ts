/**
 * ChannelsTransport — long-lived `claude --channels` child per session.
 *
 * Wraps the existing ClaudeChildManager + UdsServer plumbing into the
 * SessionTransport contract. Behavior is unchanged from before this refactor:
 *   - One `claude --channels plugin:papercup-channels` per bound session
 *   - Inbound events pushed via UDS to the plugin, which forwards as a
 *     channels notification
 *   - Replies arrive on the plugin's `reply` MCP tool over UDS
 *   - Permission requests fan out to Discord buttons; verdicts ride UDS back
 *   - Mid-turn injection is native: the plugin happily delivers a second
 *     event while claude is mid-reply
 *
 * The transport OWNS the UDS server. Constructing one starts it; shutting
 * down stops it.
 */

import { EventEmitter } from 'node:events'
import { ClaudeChildManager } from '../claude-children.ts'
import { UdsServer } from '../uds-server.ts'
import { makeLogger, type Logger } from '../log.ts'
import type { DispatcherToPlugin } from '../ipc.ts'
import type {
  SessionTransport,
  SessionTransportEvents,
  SessionEvent,
  SessionRuntimeConfig,
  TransportInit,
  TransportName,
} from './types.ts'

type PendingPermission = {
  sessionId: string
  channelId: string
  messageId?: string
}

/**
 * Allowlist gate for permission button clicks. The dispatcher owns the user
 * allowlist (PAPERCUP_ALLOWED_USERS) and hands a check function down so the
 * transport can refuse verdicts from non-allowlisted clickers without owning
 * the allowlist itself.
 */
export type AllowlistCheck = (userId: string) => boolean

export class ChannelsTransport extends EventEmitter implements SessionTransport {
  readonly name: TransportName = 'channels'
  private claude = new ClaudeChildManager()
  private uds: UdsServer
  private log: Logger
  private pendingPermissions = new Map<string, PendingPermission>()
  private sessionChannelIds = new Map<string, string>()
  private allowlistCheck: AllowlistCheck = () => true
  private udsStarted = false
  private readonly tmuxAvailable: boolean
  /**
   * Per-session FIFO of inbound events that arrived before the plugin's UDS
   * handshake completed. Cold spawn under tmux takes ~2-3s (claude boot +
   * dialog auto-accept + bun plugin connect); without this queue, the first
   * message after every reaper-driven respawn gets dropped at the "transport
   * not yet ready" check. Drained on the next `helloReceived` for the
   * session. Capped at MAX_QUEUED_EVENTS — overflow drops the oldest frame.
   */
  private pendingEvents = new Map<string, DispatcherToPlugin[]>()
  private static readonly MAX_QUEUED_EVENTS = 20
  /**
   * Marks sessions whose bootstrap dialogs have been answered (claude is
   * ready to consume channel notifications). Set by onChannelReady, cleared
   * on plugin disconnect. Lets helloReceived drain a queue when the plugin
   * connects AFTER bootstrap-done — without it, late-connecting plugins
   * left events stuck forever because onChannelReady had already fired and
   * skipped the drain (plugin wasn't connected yet).
   */
  private channelReady = new Set<string>()

  constructor(private init: TransportInit) {
    super()
    this.log = makeLogger('transport:channels')
    this.uds = new UdsServer(init.dispatcherSock)
    this.wireUds()
    this.tmuxAvailable = ClaudeChildManager.probeTmuxAvailable()
    if (this.tmuxAvailable) {
      this.log.info('tmux available — channels transport ready')
    } else {
      this.log.warn(
        'tmux NOT installed — channels transport DISABLED. ' +
        'Install tmux (e.g. `apt install tmux`) to enable, or use transport:per-turn. ' +
        'Existing transport:channels bindings will refuse to spawn.',
      )
    }
  }

  /** True when the host has tmux installed. Slash-command handlers check
   *  this before allowing /bind transport:channels or /transport mode:channels. */
  isAvailable(): boolean {
    return this.tmuxAvailable
  }

  /** Dispatcher calls this once at boot before any pushEvent. Idempotent. */
  async start(): Promise<void> {
    if (this.udsStarted) return
    await this.uds.start()
    this.udsStarted = true
    if (this.tmuxAvailable) {
      // Pick up any papercup-* tmux sessions left running by a previous
      // dispatcher (graceful restart, crash, manual kill). Without this the
      // new process sees an empty `tracked` map and can't manage the live
      // sessions — native /compact, reaper, kill all silently no-op.
      const adopted = this.claude.adoptExisting()
      if (adopted.length > 0) {
        this.log.info(`adopted ${adopted.length} orphan tmux session(s): ${adopted.join(', ')}`)
      }
    }
  }

  setAllowlistCheck(check: AllowlistCheck): void {
    this.allowlistCheck = check
  }

  setPermissionMessageId(requestId: string, messageId: string): void {
    const p = this.pendingPermissions.get(requestId)
    if (p) p.messageId = messageId
  }

  /**
   * Remember which Discord channel this session is bound to. The transport
   * needs it to (a) reject reply frames whose chat_id doesn't match the
   * session, and (b) attach channelId to outbound ReplyEvents.
   */
  bindChannel(sessionId: string, channelId: string): void {
    this.sessionChannelIds.set(sessionId, channelId)
  }

  unbindChannel(sessionId: string): void {
    this.sessionChannelIds.delete(sessionId)
  }

  ensureRunning(cfg: SessionRuntimeConfig): void {
    if (this.claude.isAlive(cfg.sessionId)) return
    if (!this.tmuxAvailable) {
      this.log.warn(
        `channels transport requires tmux (not installed). ` +
        `Session ${cfg.sessionId} will not be spawned. Install tmux or run ` +
        `/transport mode:per-turn to switch this session.`,
      )
      return
    }
    if (cfg.backend !== 'claude-code') {
      this.log.warn(
        `channels transport only supports backend=claude-code (got ${cfg.backend}). ` +
        `Session ${cfg.sessionId} will not be spawned. Switch transport to per-turn or change backend.`,
      )
      return
    }
    this.claude.spawn({
      sessionId: cfg.sessionId,
      pluginDir: this.init.pluginDir,
      dispatcherSock: this.init.dispatcherSock,
      papercupHome: this.init.papercupHome,
      projectDir: this.init.projectDir,
      resume: cfg.resume,
      model: cfg.model,
      effort: cfg.effort,
      permissionMode: cfg.permissionMode,
      onTurnComplete: usage => {
        this.emit('turnComplete', { sessionId: cfg.sessionId, usage })
      },
      onChannelReady: () => this.drainQueuedEvents(cfg.sessionId),
    })
  }

  pushEvent(event: SessionEvent): boolean {
    const frame: DispatcherToPlugin = {
      type: 'event',
      session: event.sessionId,
      chat_id: event.channelId,
      content: event.content,
      meta: event.meta,
    }
    if (this.uds.isConnected(event.sessionId)) {
      return this.uds.sendTo(event.sessionId, frame)
    }
    // Plugin not connected yet (cold respawn). Queue and drain on hello.
    const queue = this.pendingEvents.get(event.sessionId) ?? []
    queue.push(frame)
    while (queue.length > ChannelsTransport.MAX_QUEUED_EVENTS) {
      queue.shift()
      this.log.warn(
        `event queue overflow (session=${event.sessionId}); dropping oldest frame ` +
        `(cap=${ChannelsTransport.MAX_QUEUED_EVENTS})`,
      )
    }
    this.pendingEvents.set(event.sessionId, queue)
    this.log.info(
      `queued event (session=${event.sessionId}, queue=${queue.length}) — ` +
      `plugin not yet connected, will flush on hello`,
    )
    return true
  }

  resolvePermission(
    requestId: string,
    behavior: 'allow' | 'deny',
    clickerUserId: string,
  ): boolean {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return false
    if (!this.allowlistCheck(clickerUserId)) return false
    this.pendingPermissions.delete(requestId)
    const ok = this.uds.sendTo(pending.sessionId, {
      type: 'permission_verdict',
      session: pending.sessionId,
      request_id: requestId,
      behavior,
    })
    if (!ok) {
      this.log.warn(`verdict send failed: plugin not connected for session ${pending.sessionId}`)
      return false
    }
    this.log.info(
      `permission ${behavior}: session=${pending.sessionId}, request_id=${requestId}, by=${clickerUserId}`,
    )
    return true
  }

  cancel(sessionId: string): boolean {
    // For channels, "cancel" means kill the long-lived child; next event
    // respawns it via --resume.
    return this.claude.kill(sessionId)
  }

  stopSession(sessionId: string): void {
    this.claude.kill(sessionId)
    this.sessionChannelIds.delete(sessionId)
    this.pendingEvents.delete(sessionId)
    this.channelReady.delete(sessionId)
    for (const [rid, p] of this.pendingPermissions) {
      if (p.sessionId === sessionId) this.pendingPermissions.delete(rid)
    }
  }

  isAlive(sessionId: string): boolean {
    return this.claude.isAlive(sessionId)
  }

  isPluginOnline(sessionId: string): boolean {
    return this.uds.isConnected(sessionId)
  }

  /**
   * Send claude's native `/compact` slash command into the live tmux session.
   * Channels-mode only; per-turn sessions disable slash commands and must
   * use the external compactSession() fallback.
   *
   * Returns true on successful keystroke delivery, false when the underlying
   * tmux session is dead (caller should fall back).
   */
  sendNativeCompact(sessionId: string): boolean {
    return this.claude.sendNativeCompact(sessionId)
  }

  async shutdown(): Promise<void> {
    this.claude.killAll()
    try {
      await this.uds.stop()
    } catch (err) {
      this.log.warn('uds stop err:', err)
    }
    this.udsStarted = false
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

  /**
   * Called by ClaudeChildManager when bootstrap dialogs have all been
   * answered and claude is ready to consume channel notifications. Drains
   * any events queued in pushEvent() during the spawn boot window into the
   * (now-ready) plugin in FIFO order.
   */
  private drainQueuedEvents(sessionId: string): void {
    // Mark this session ready so a late-arriving helloReceived can drain
    // even if onChannelReady fired before the plugin connected.
    this.channelReady.add(sessionId)
    const queue = this.pendingEvents.get(sessionId)
    if (!queue || queue.length === 0) return
    if (!this.uds.isConnected(sessionId)) {
      this.log.warn(
        `onChannelReady fired but plugin not connected (session=${sessionId}); ` +
        `keeping ${queue.length} queued event(s) for the next handshake`,
      )
      return
    }
    this.pendingEvents.delete(sessionId)
    this.log.info(`draining ${queue.length} queued event(s) for session=${sessionId}`)
    for (let i = 0; i < queue.length; i++) {
      const ok = this.uds.sendTo(sessionId, queue[i]!)
      if (!ok) {
        this.log.warn(
          `drain failed (session=${sessionId}); plugin connection gone mid-flush. ` +
          `${i} of ${queue.length} delivered before stop.`,
        )
        break
      }
    }
  }

  private wireUds(): void {
    this.uds.on('reply', frame => {
      const expected = this.sessionChannelIds.get(frame.session)
      if (!expected || frame.chat_id !== expected) {
        this.log.warn(
          `reply chat_id mismatch (session=${frame.session}: expected=${expected}, got=${frame.chat_id}) — dropping`,
        )
        return
      }
      this.emit('reply', {
        sessionId: frame.session,
        channelId: frame.chat_id,
        msgId: frame.msgId,
        text: frame.text,
        replyTo: frame.reply_to,
        ...(frame.files && frame.files.length > 0 ? { files: frame.files } : {}),
      })
    })

    this.uds.on('helloReceived', (session, pid) => {
      this.log.info(`plugin online: session=${session}, pid=${pid}`)
      // We deliberately do NOT drain when bootstrap dialogs are still
      // unanswered — claude silently drops channel notifications during
      // that window. But if onChannelReady has ALREADY fired (channelReady
      // set), the plugin just connected late, and we need to drain now
      // because helloReceived is the last chance — nothing else will trigger.
      if (this.channelReady.has(session)) {
        this.drainQueuedEvents(session)
      }
    })

    this.uds.on('pluginDisconnected', session => {
      this.log.warn(`plugin offline: session=${session}`)
      // Next respawn will fire onChannelReady again — clear so the late-
      // drain path in helloReceived doesn't fire prematurely on reconnect.
      this.channelReady.delete(session)
    })

    this.uds.on('permissionRequest', frame => {
      const channelId = this.sessionChannelIds.get(frame.session)
      if (!channelId) {
        this.log.warn(
          `permission_request for unbound/unknown session ${frame.session} — dropping`,
        )
        return
      }
      this.pendingPermissions.set(frame.request_id, {
        sessionId: frame.session,
        channelId,
      })
      this.emit('permissionRequest', {
        sessionId: frame.session,
        requestId: frame.request_id,
        toolName: frame.tool_name,
        description: frame.description,
        inputPreview: frame.input_preview,
      })
    })
  }
}
