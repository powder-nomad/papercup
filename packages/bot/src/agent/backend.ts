/**
 * Pluggable speaker-agent backend.
 *
 * Each backend owns its own conversation state — some (Claude Code, Codex)
 * keep history in their own session store and only need the latest turn;
 * others (Anthropic API) rebuild the message list per call. The bot doesn't
 * care which.
 *
 * Add a backend by:
 *   1. writing a class that implements `AgentBackend`
 *   2. registering it in `createAgentBackend()`
 *   3. setting `AGENT_BACKEND=<name>` in `.env`
 */

export type AgentReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
};

export type AgentBackendOpts = {
  /**
   * Optional. When undefined, the backend should use its default behavior
   * (no `--system-prompt`, no `system:` field, etc.). Voice mode passes the
   * phone-call persona; text mode passes nothing so Claude Code behaves
   * normally.
   */
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  /**
   * Externally-managed session id. Backends use it as their session/history
   * key (e.g. Claude Code UUID for --session-id/--resume). If omitted, the
   * backend may generate one internally for ephemeral conversations.
   */
  sessionId?: string;
  /** True if the session already exists and we should resume it. */
  resume?: boolean;
  /**
   * Reasoning-effort hint. Each backend translates to its own knob:
   * - claude-code  → `--effort <level>` flag (xhigh, max = Opus only)
   * - anthropic-api → maps to thinking.budget_tokens (minimal=disabled,
   *   low≈1024, medium≈4096, high≈16384, xhigh≈32768, max≈64000)
   * - codex        → ignored (no native equivalent today)
   */
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

export interface AgentBackend {
  /** Boot any persistent resources (session id, SDK client, …). */
  start(opts: AgentBackendOpts): Promise<void>;
  /** Respond to one user turn. Backend manages its own conversation history. */
  respond(userText: string): Promise<AgentReply>;
  /** Clear conversation history; next respond() starts fresh. */
  reset(): void;
  /** Tear down. */
  stop(): void;
  /**
   * Return whatever id the backend would use to resume this conversation
   * later. For claude-code this is the --session-id UUID; for codex it's the
   * thread_id assigned by the CLI on first turn. Undefined for stateless
   * backends (like anthropic-api).
   */
  getBackendId?(): string | undefined;
}

import { ClaudeCodeBackend } from "./backend-claude-code.js";
import { AnthropicApiBackend } from "./backend-anthropic-api.js";
import { CodexBackend } from "./backend-codex.js";

export function createAgentBackend(name: string): AgentBackend {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeBackend();
    case "codex":
      return new CodexBackend();
    case "anthropic-api":
      return new AnthropicApiBackend();
    default:
      throw new Error(`Unknown agent backend: ${name}. Supported: claude-code, codex, anthropic-api`);
  }
}
