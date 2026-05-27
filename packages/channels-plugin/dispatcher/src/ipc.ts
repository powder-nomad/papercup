/**
 * Wire frames for the dispatcher ↔ plugin UDS link.
 *
 * Source of truth — the plugin half (../plugin/server.ts) duplicates these
 * types verbatim because it lives in a separate package and runtime (Bun).
 * Keep them in sync.
 *
 * Framing: NDJSON. One JSON object per line, UTF-8. Lines must not contain
 * raw `\n` inside string values — JSON.stringify already escapes them.
 */

export type PluginHello = {
  type: 'hello'
  session: string
  pid: number
}

export type PluginReply = {
  type: 'reply'
  session: string
  msgId: string
  chat_id: string
  text: string
  reply_to?: string
  /** Absolute file paths to attach to the Discord reply. Validated and capped
   *  in DiscordSender.sendReply (≤10 files, ≤24 MB each). */
  files?: string[]
}

export type PluginLog = {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  msg: string
}

/** Plugin received a `notifications/claude/channel/permission_request` from
 *  claude; forwards to dispatcher so the dispatcher can show a Discord prompt. */
export type PluginPermissionRequest = {
  type: 'permission_request'
  session: string
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type PluginToDispatcher =
  | PluginHello
  | PluginReply
  | PluginLog
  | PluginPermissionRequest

export type DispatcherEvent = {
  type: 'event'
  session: string
  chat_id: string
  content: string
  meta?: Record<string, string>
}

export type DispatcherShutdown = {
  type: 'shutdown'
  session: string
}

/** Dispatcher forwards a user's button click back to the plugin, which then
 *  emits `notifications/claude/channel/permission` to claude. */
export type DispatcherPermissionVerdict = {
  type: 'permission_verdict'
  session: string
  request_id: string
  behavior: 'allow' | 'deny'
}

export type DispatcherToPlugin =
  | DispatcherEvent
  | DispatcherShutdown
  | DispatcherPermissionVerdict
