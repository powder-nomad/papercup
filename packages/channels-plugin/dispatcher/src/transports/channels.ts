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

  constructor(private init: TransportInit) {
    super()
    this.log = makeLogger('transport:channels')
    this.uds = new UdsServer(init.dispatcherSock)
    this.wireUds()
  }

  /** Dispatcher calls this once at boot before any pushEvent. Idempotent. */
  async start(): Promise<void> {
    if (this.udsStarted) return
    await this.uds.start()
    this.udsStarted = true
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
    })
  }

  pushEvent(event: SessionEvent): boolean {
    return this.uds.sendTo(event.sessionId, {
      type: 'event',
      session: event.sessionId,
      chat_id: event.channelId,
      content: event.content,
      meta: event.meta,
    })
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
      })
    })

    this.uds.on('helloReceived', (session, pid) => {
      this.log.info(`plugin online: session=${session}, pid=${pid}`)
    })

    this.uds.on('pluginDisconnected', session => {
      this.log.warn(`plugin offline: session=${session}`)
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
