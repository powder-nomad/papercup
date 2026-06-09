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

/**
 * Real-time events emitted by a backend during a single respond() call.
 * Lets the UI render a live progress view ("now reading X", "now editing Y",
 * etc.) instead of waiting for the full reply. Only the claude-code backend
 * emits these today; other backends silently no-op.
 */
export type TurnEvent =
  | { kind: "thinking" }
  | { kind: "text"; deltaChars: number }
  | { kind: "tool_use"; name: string; preview?: string }
  | { kind: "tool_result"; name: string; ok: boolean }
  | { kind: "error"; message: string };

export type RespondOptions = {
  /**
   * Streaming progress callback. If provided AND the backend supports it,
   * fires for each intermediate event during the turn. Backends that don't
   * support streaming ignore this and just produce the final AgentReply.
   */
  onEvent?: (event: TurnEvent) => void;
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
  /**
   * Tool permission policy. Maps to claude-code's `--permission-mode`
   * flag. Other backends ignore today.
   */
  permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan";
  /**
   * Extra MCP server names whose tools the agent should be allowed to call.
   * Expanded to `mcp__<name>__*` in --allowedTools. Other backends ignore.
   */
  allowedMcps?: string[];
  /**
   * Drives the default toolset in claude-code:
   * - "voice" → "Read Glob Grep" (lean; speaker delegates to extensions)
   * - "text"  → "default" (full Claude Code toolset; vibecoding flow needs
   *             Write/Edit/Bash to do real work itself)
   * Override either via SPEAKER_TOOLS env.
   */
  mode?: "voice" | "text";
};

export interface AgentBackend {
  /** Boot any persistent resources (session id, SDK client, …). */
  start(opts: AgentBackendOpts): Promise<void>;
  /** Respond to one user turn. Backend manages its own conversation history. */
  respond(userText: string, opts?: RespondOptions): Promise<AgentReply>;
  /** Clear conversation history; next respond() starts fresh. */
  reset(): void;
  /** Tear down. */
  stop(): void;
  /**
   * Abort the current in-flight respond() if one is running. Returns true
   * if a turn was actually cancelled, false if nothing was in flight.
   * Backends without a way to cancel return false silently.
   */
  cancel?(): boolean;
  /**
   * Return whatever id the backend would use to resume this conversation
   * later. For claude-code this is the --session-id UUID; for codex it's the
   * thread_id assigned by the CLI on first turn. Undefined for stateless
   * backends (like anthropic-api).
   */
  getBackendId?(): string | undefined;
}

/**
 * Plug-in registry of agent backends.
 *
 * Built-ins register themselves at module load time (see side-effect imports
 * below). External code can register additional backends:
 *
 *   import { registerBackend } from "@papercup/bot/agent/backend";
 *   registerBackend("my-thing", () => new MyBackend());
 *
 * Then AGENT_BACKEND and /pickup will see it.
 */
// Lazy: ESM hoists side-effect imports above any `let`/`const` declarations,
// so a `let` registry would be in TDZ when backend files self-register on
// load. `var` hoists with `undefined` initialization, side-stepping TDZ
// entirely. Yes, `var` at module scope is unfashionable; the alternative is
// extracting the registry to a separate file, which is more churn.
// eslint-disable-next-line no-var
var _registry: Map<string, () => AgentBackend> | undefined;
function getRegistry(): Map<string, () => AgentBackend> {
  if (!_registry) _registry = new Map();
  return _registry;
}

export function registerBackend(name: string, factory: () => AgentBackend): void {
  const r = getRegistry();
  if (r.has(name)) {
    console.warn(`[backend] re-registering "${name}" — earlier registration overwritten`);
  }
  r.set(name, factory);
}

export function listBackends(): string[] {
  return [...getRegistry().keys()].sort();
}

export function createAgentBackend(name: string): AgentBackend {
  const factory = getRegistry().get(name);
  if (!factory) {
    throw new Error(
      `Unknown agent backend: "${name}". Available: ${listBackends().join(", ") || "(none registered)"}`,
    );
  }
  return factory();
}

// Side-effect imports — each backend file calls registerBackend() on load.
import "./backend-claude-code.js";
import "./backend-anthropic-api.js";
import "./backend-codex.js";
import "./backend-openai-compat.js";
import "./backend-aider-cli.js";
import "./backend-gemini-cli.js";
import "./backend-opencode-cli.js";
import "./backend-crush-cli.js";
import "./backend-amp-cli.js";
import "./backend-gemini-api.js";
import "./backend-antigravity-cli.js";
