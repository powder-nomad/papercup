/**
 * SessionTransport — the contract every per-session agent driver implements.
 *
 * Two implementations ship today:
 *   - ChannelsTransport (transports/channels.ts) — long-lived `claude --channels`
 *     child per session. Events are pushed in via the channels MCP protocol;
 *     replies arrive on the MCP `reply` tool over UDS. Mid-turn injection is
 *     native: a new event arriving while claude is mid-reply just gets pushed
 *     and claude interleaves it as another channel turn.
 *   - PerTurnTransport (transports/per-turn.ts) — spawns the underlying CLI
 *     per turn with `--session-id <uuid>` / `--resume <uuid>`. The CLI's local
 *     session store holds the transcript. Mid-turn injection cancels the
 *     in-flight child and respawns with the merged prompt (phone-call
 *     interruption UX — what the user wanted for papercup).
 *
 * The dispatcher (index.ts) doesn't care which one is underneath. It calls:
 *     transport.pushEvent({ session, source: "text"|"voice", text, ... })
 * and listens for:
 *     transport.on("reply",            ({session, text, meta}) => …)
 *     transport.on("permissionRequest", ({session, requestId, ...}) => …)
 *     transport.on("turnComplete",     ({session, usage}) => …)
 *
 * Both transports manage their own child process lifecycle. The dispatcher
 * tells them when to forget about a session (stop) and they handle the rest.
 */

import type { EventEmitter } from 'node:events'

export type TransportName = 'channels' | 'per-turn'

/**
 * What the dispatcher hands to a transport when it boots up. Mirrors the
 * fields ClaudeChildOpts used to take, but also carries the source-of-truth
 * resolver functions so the per-turn transport can pull fresh session config
 * (model/effort/permission overrides change at runtime via slash commands).
 */
export type TransportInit = {
  /** Where ~/.papercup-channels lives (or override). */
  papercupHome: string
  /** Path to dispatcher.sock — channels transport needs it for MCP plugin
   *  handshake; per-turn transport uses it for the same plugin to deliver
   *  the `reply` tool back to the dispatcher. */
  dispatcherSock: string
  /** Path to the Bun plugin entry point (plugin/server.ts). */
  pluginDir: string
  /** --add-dir target for project access. Same value for every session. */
  projectDir?: string
}

/**
 * A single inbound event a transport must deliver into its session. Sources:
 *   - "text"  → discord.messageCreate
 *   - "voice" → STT-transcribed utterance
 *   - "system" → out-of-band, e.g. a /say synthetic prompt
 *
 * `meta` is forwarded as-is into the channels notification (or, for per-turn,
 * prefixed onto the user prompt as a deterministic header so the agent sees
 * the same context regardless of transport).
 */
export type SessionEvent = {
  sessionId: string
  channelId: string
  source: 'text' | 'voice' | 'system'
  /** The user's message body (text or transcript). */
  content: string
  /** Discord-side context propagated to the agent for both transports. */
  meta: Record<string, string>
  /** Originating Discord message id, if any — used to reply with `reply_to`. */
  messageId?: string
}

/** Final agent reply that should be posted back to Discord (and TTS-played). */
export type ReplyEvent = {
  sessionId: string
  channelId: string
  msgId: string
  text: string
  /** Optional Discord message id to reply-to (used for permission verdict pings). */
  replyTo?: string
}

/** Permission prompt forwarded from claude → UI button. Only used by
 *  channels transport today (per-turn runs with --dangerously-skip-permissions
 *  or whatever the CLI's bypass flag is). */
export type PermissionRequestEvent = {
  sessionId: string
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

/** Token usage emitted at the end of each turn — drives the context-pressure
 *  indicator that warns at 150k / 180k input tokens. */
export type TurnCompleteEvent = {
  sessionId: string
  usage: { inputTokens: number; outputTokens: number }
}

export type SessionTransportEvents = {
  reply: (e: ReplyEvent) => void
  permissionRequest: (e: PermissionRequestEvent) => void
  turnComplete: (e: TurnCompleteEvent) => void
  /** Process exited, expected or otherwise. Carries `code`/`signal` for logs. */
  sessionExited: (sessionId: string, code: number | null, signal: NodeJS.Signals | null) => void
}

/**
 * Per-session runtime config the transport reads on each spawn. Persisted on
 * the Session record so it survives dispatcher restart.
 */
export type SessionRuntimeConfig = {
  sessionId: string
  model?: string
  effort?: string
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'
  /** Has this sessionId been issued before? Drives --session-id vs --resume.
   *  Owned by the transport caller, not the transport. */
  resume: boolean
}

/**
 * The contract. EventEmitter-shaped so consumers can plug in straightforward
 * listeners and so the registry can hand back a strongly-typed handle.
 *
 * Lifecycle:
 *   constructor(init: TransportInit) — registers itself, doesn't spawn
 *   ensureRunning(cfg)               — idempotent; spawns if not alive
 *   pushEvent(event)                 — enqueues/forwards a user turn
 *   resolvePermission(rid, behavior) — channels-only; no-op for per-turn
 *   cancel(sessionId)                — abort in-flight turn (SIGTERM)
 *   stopSession(sessionId)           — terminate + forget the session
 *   isAlive(sessionId)               — for the idle reaper
 *   shutdown()                       — terminate every session, called on SIGTERM
 *
 * The transport does NOT own session persistence. The dispatcher owns
 * SessionStore; the transport is told what session to run.
 */
export interface SessionTransport {
  readonly name: TransportName

  on<E extends keyof SessionTransportEvents>(
    event: E,
    listener: SessionTransportEvents[E],
  ): this
  off<E extends keyof SessionTransportEvents>(
    event: E,
    listener: SessionTransportEvents[E],
  ): this

  ensureRunning(cfg: SessionRuntimeConfig): void
  pushEvent(event: SessionEvent): boolean
  resolvePermission(requestId: string, behavior: 'allow' | 'deny', clickerUserId: string): boolean
  cancel(sessionId: string): boolean
  stopSession(sessionId: string): void
  isAlive(sessionId: string): boolean
  isPluginOnline(sessionId: string): boolean
  shutdown(): Promise<void> | void
}

/** Helper for transports that wrap a Node EventEmitter — keeps the
 *  union-typed `on`/`emit` signatures in one place. */
export type AsTypedEmitter<T extends Record<string, (...args: never[]) => void>> = EventEmitter & {
  on<E extends keyof T>(event: E, listener: T[E]): EventEmitter
  emit<E extends keyof T>(event: E, ...args: Parameters<T[E]>): boolean
}
