/**
 * Discord gateway client for the dispatcher.
 *
 * Phase 2: multi-channel via GuildConfigStore. Inbound messages on any
 * channel the bot has bound for that guild get forwarded via `onMessage`.
 * Slash commands route through `onInteraction`. Outbound replies via `sendReply`.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
  type Message,
  type Attachment,
} from 'discord.js'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { makeLogger, type Logger } from './log.ts'
import type { GuildConfigStore } from './state/guild-config.ts'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Discord allows up to 10 attachments per message. */
const MAX_REPLY_FILES = 10
/** Per-file cap when posting back — 24 MB leaves headroom under the 25 MB
 *  non-boost server limit (boosted servers go higher but we don't probe). */
const MAX_REPLY_FILE_BYTES = 24 * 1024 * 1024

export type AttachmentRef = {
  name: string
  type: string
  size: number
  localPath: string
}

export type InboundMessage = {
  guildId: string | null
  channelId: string
  messageId: string
  userId: string
  username: string
  ts: string
  content: string
  attachments: AttachmentRef[]
}

export type DiscordClientOpts = {
  token: string
  guildConfig: GuildConfigStore
  /** Discord user-id allowlist. Empty set = allow everyone (default). */
  allowedUserIds?: Set<string>
  /** Absolute path to the attachment-download directory. */
  inboxDir: string
  onMessage: (msg: InboundMessage) => void
  onInteraction: (i: Interaction) => void
}

export class DiscordChannelClient {
  private client: Client
  private log: Logger
  constructor(private opts: DiscordClientOpts) {
    this.log = makeLogger('discord')
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        // Required so member.voice.channel is populated when /voice-join,
        // /pickup, or /say need to read the caller's current voice state.
        // Without it, discord.js doesn't cache voice states and every voice
        // command bails with "Join a voice channel first." The intent isn't
        // privileged — no dev-portal toggle needed.
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel],
    })
    this.client.on('messageCreate', m => this.handleInbound(m).catch(err => {
      this.log.error('handleInbound:', err)
    }))
    this.client.on('interactionCreate', i => this.opts.onInteraction(i))
    this.client.on('error', err => this.log.error('client error:', err))
  }

  async start(): Promise<void> {
    this.client.once('ready', c => {
      this.log.info(`gateway connected as ${c.user.tag}`)
    })
    await this.client.login(this.opts.token)
  }

  async stop(): Promise<void> {
    await this.client.destroy()
  }

  /**
   * Send a Discord message. Outbound channel-allowlist enforcement is in the
   * dispatcher's reply handler (it checks that `chat_id` matches the session's
   * stored channelId), so this method only does the send + chunk.
   *
   * `files` (absolute paths) are validated, oversized/missing entries are
   * skipped with a warning, and the surviving files are attached to the FIRST
   * Discord chunk only. Throws on transport failure as before — caller decides
   * whether to retry or cleanup the outbox.
   */
  async sendReply(
    chatId: string,
    text: string,
    replyTo?: string,
    files?: string[],
  ): Promise<string[]> {
    const ch = await this.client.channels.fetch(chatId)
    if (!ch || !ch.isTextBased() || !('send' in ch)) {
      throw new Error(`channel ${chatId} not found or not sendable`)
    }
    const validFiles = await this.validateReplyFiles(files)
    const chunks = chunkText(text, 2000)
    const ids: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const sent = await ch.send({
        content: chunks[i],
        ...(i === 0 && replyTo
          ? { reply: { messageReference: replyTo, failIfNotExists: false } }
          : {}),
        ...(i === 0 && validFiles.length > 0 ? { files: validFiles } : {}),
      })
      ids.push(sent.id)
    }
    return ids
  }

  /** Stat each path, drop missing or oversized files with a warning, cap at
   *  Discord's 10-attachment limit. Non-absolute paths are rejected (callers
   *  should never produce them, but defensive against a misbehaving plugin). */
  private async validateReplyFiles(files?: string[]): Promise<{ attachment: string; name: string }[]> {
    if (!files || files.length === 0) return []
    const out: { attachment: string; name: string }[] = []
    for (const p of files) {
      if (out.length >= MAX_REPLY_FILES) {
        this.log.warn(`reply files truncated: more than ${MAX_REPLY_FILES} requested, skipping rest`)
        break
      }
      if (!isAbsolute(p)) {
        this.log.warn(`reply file rejected (not absolute): ${p}`)
        continue
      }
      try {
        const st = await stat(p)
        if (!st.isFile()) {
          this.log.warn(`reply file rejected (not a regular file): ${p}`)
          continue
        }
        if (st.size > MAX_REPLY_FILE_BYTES) {
          this.log.warn(`reply file rejected (${st.size} > ${MAX_REPLY_FILE_BYTES}): ${p}`)
          continue
        }
      } catch (err) {
        this.log.warn(`reply file rejected (stat failed): ${p} — ${(err as Error).message}`)
        continue
      }
      out.push({ attachment: p, name: basename(p) })
    }
    return out
  }

  /**
   * Start the "Papercup is typing…" indicator for a channel and keep it alive
   * by re-pinging every 8s (Discord's typing indicator expires after ~10s).
   * Returns a stop function to clear the interval. Self-clears after 5min as
   * a safety net so a missed reply doesn't leave the indicator running
   * forever. Failures (channel not sendable, permission denied) are
   * swallowed silently — this is a UX nicety, not load-bearing.
   */
  beginTypingHeartbeat(channelId: string): () => void {
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const ch = await this.client.channels.fetch(channelId)
        if (ch && ch.isTextBased() && 'sendTyping' in ch) {
          await ch.sendTyping().catch(() => undefined)
        }
      } catch {
        // ignore
      }
    }
    void tick()
    const interval = setInterval(tick, 8_000)
    const watchdog = setTimeout(() => stop(), 5 * 60_000)
    const stop = (): void => {
      if (stopped) return
      stopped = true
      clearInterval(interval)
      clearTimeout(watchdog)
    }
    return stop
  }

  /** Send a system / informational message to a channel without quote-replying. */
  async postNotice(channelId: string, text: string): Promise<string | undefined> {
    try {
      const ch = await this.client.channels.fetch(channelId)
      if (!ch || !ch.isTextBased() || !('send' in ch)) return undefined
      const sent = await ch.send({ content: text })
      return sent.id
    } catch (err) {
      this.log.warn(`postNotice failed for ${channelId}:`, err)
      return undefined
    }
  }

  /**
   * Post a permission-prompt message with Allow/Deny buttons. The customId
   * encodes the request_id; the dispatcher's button handler resolves it.
   * Returns the posted message ID, or undefined on failure.
   */
  async postPermissionPrompt(
    channelId: string,
    requestId: string,
    toolName: string,
    description: string,
  ): Promise<string | undefined> {
    try {
      const ch = await this.client.channels.fetch(channelId)
      if (!ch || !ch.isTextBased() || !('send' in ch)) return undefined
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`perm:allow:${requestId}`)
          .setLabel('Allow')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm:deny:${requestId}`)
          .setLabel('Deny')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger),
      )
      const body = `🔐 Permission requested: **${toolName}**\n${truncate(description, 1500)}`
      const sent = await ch.send({ content: body, components: [row] })
      return sent.id
    } catch (err) {
      this.log.warn(`postPermissionPrompt failed for ${channelId}:`, err)
      return undefined
    }
  }

  private async handleInbound(msg: Message): Promise<void> {
    if (msg.author.bot) return
    // Only listen to channels the guild has explicitly bound. DMs (guildId
    // === null) are out of scope for Phase 2.
    if (!msg.guildId) return
    if (!this.opts.guildConfig.isBound(msg.guildId, msg.channelId)) return
    // Allowlist (Phase 5): if PAPERCUP_ALLOWED_USERS is set, silently drop
    // anyone not on it. Empty allowlist = open.
    if (this.opts.allowedUserIds && this.opts.allowedUserIds.size > 0) {
      if (!this.opts.allowedUserIds.has(msg.author.id)) {
        this.log.warn(`drop: ${msg.author.username} (${msg.author.id}) not in PAPERCUP_ALLOWED_USERS`)
        return
      }
    }

    let content = msg.content
    if (this.client.user) {
      content = content
        .replace(new RegExp(`^<@!?${this.client.user.id}>\\s*`), '')
        .trim()
    }
    const attachments: AttachmentRef[] = []
    if (msg.attachments.size > 0) {
      for (const att of msg.attachments.values()) {
        if (att.size > MAX_ATTACHMENT_BYTES) {
          this.log.warn(`skip attachment ${att.name ?? att.id}: ${att.size} bytes > ${MAX_ATTACHMENT_BYTES}`)
          continue
        }
        try {
          const ref = await this.downloadAttachment(att, msg.channelId, msg.id)
          attachments.push(ref)
        } catch (err) {
          this.log.warn(`download failed for ${att.name ?? att.id}:`, err)
        }
      }
    }

    if (!content) {
      content = attachments.length > 0 ? '(attachment)' : ''
    }
    if (!content && attachments.length === 0) return

    const inbound: InboundMessage = {
      guildId: msg.guildId,
      channelId: msg.channelId,
      messageId: msg.id,
      userId: msg.author.id,
      username: msg.author.username,
      ts: msg.createdAt.toISOString(),
      content,
      attachments,
    }
    this.log.info(
      `inbound: ${msg.author.username}@${msg.channelId} (${msg.id}): ${truncate(content, 200)}` +
      (attachments.length ? ` [+${attachments.length} attachment${attachments.length > 1 ? 's' : ''}]` : ''),
    )
    this.opts.onMessage(inbound)
  }

  private async downloadAttachment(
    att: Attachment,
    channelId: string,
    messageId: string,
  ): Promise<AttachmentRef> {
    const dir = join(this.opts.inboxDir, channelId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const rawName = att.name ?? att.id
    const rawExt = extname(rawName).toLowerCase().replace(/[^a-z0-9.]/g, '')
    const ext = rawExt || '.bin'
    const localPath = join(dir, `${messageId}-${att.id}${ext}`)
    const res = await fetch(att.url)
    if (!res.ok) throw new Error(`fetch ${att.url}: ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(localPath, buf, { mode: 0o600 })
    return {
      // att.name comes from the user — sanitise so it can be safely embedded
      // inline in the meta `attachments` value (which uses '|' / ';' as delimiters).
      name: rawName.replace(/[|;\r\n]/g, '_'),
      type: att.contentType ?? 'application/octet-stream',
      size: att.size,
      localPath,
    }
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
