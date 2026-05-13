import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AgentBackend,
  AgentBackendOpts,
  AgentReply,
  RespondOptions,
  TurnEvent,
} from "./backend.js";
import { processRegistry, makeCommandPreview } from "./process-registry.js";

// Off by default — legitimate turns can take hours (install scripts, foreground
// cloudflared, long extension supervision). The registry + boot reaper already
// covers the *across-restart* orphan case, which was the original motivation.
// Set PAPERCUP_TURN_TIMEOUT_S to a positive integer (seconds) to enforce a cap.
const DEFAULT_TURN_TIMEOUT_S = 0;

/**
 * Claude Code CLI backend. Uses `claude -p` per turn with --session-id /
 * --resume to maintain the conversation in Claude Code's local store. No
 * Anthropic API key needed — uses the user's existing Claude Code auth.
 *
 * Tradeoff vs direct API: ~500-1000ms extra per turn from process startup.
 */
export class ClaudeCodeBackend implements AgentBackend {
  private sessionId?: string;
  private firstTurn = true;
  private opts!: AgentBackendOpts;
  /** Currently-running `claude -p` child, if any. Used by cancel(). */
  private inFlight?: ChildProcess;

  async start(opts: AgentBackendOpts): Promise<void> {
    this.opts = opts;
    this.sessionId = opts.sessionId ?? randomUUID();
    // resume=true means the session already exists in Claude Code's store;
    // first call must use --resume rather than --session-id.
    this.firstTurn = !opts.resume;
  }

  reset(): void {
    this.sessionId = randomUUID();
    this.firstTurn = true;
  }

  stop(): void {
    // Sessions live in Claude Code's local store; nothing to tear down here.
    // But if a turn is in flight when stop is called, kill it.
    this.cancel();
  }

  cancel(): boolean {
    if (!this.inFlight) return false;
    this.killProcessGroup(this.inFlight);
    return true;
  }

  /**
   * SIGTERM the whole process group, not just the leader. The spawned
   * `claude -p` may have spawned its own descendants (cloudflared, uvicorn,
   * etc.); without group-kill those become orphans even after the user
   * cancels.
   */
  private killProcessGroup(proc: ChildProcess): void {
    if (!proc.pid) return;
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    }
  }

  getBackendId(): string | undefined {
    return this.sessionId;
  }

  async respond(userText: string, respondOpts: RespondOptions = {}): Promise<AgentReply> {
    if (!this.sessionId) throw new Error("ClaudeCodeBackend: start() not called");
    const streaming = Boolean(respondOpts.onEvent);

    // Speaker tools: in voice mode, read-only built-ins for inline lookups +
    // MCP tools for delegating real work. No Bash/Edit/Write — those run
    // inside extensions, never on the voice hot path.
    // In text mode (vibecoding), full Claude Code toolset by default — the
    // agent IS doing real work and needs Write/Edit/Bash. Override either
    // via SPEAKER_TOOLS env.
    const defaultBase = this.opts.mode === "text" ? "default" : "Read Glob Grep";
    const baseTools = process.env.SPEAKER_TOOLS ?? defaultBase;
    const mcpUrl = process.env.PAPERCUP_MCP_URL;
    const papercupTools = mcpUrl
      ? "mcp__papercup__spawn_extension mcp__papercup__check_extension mcp__papercup__list_extensions"
      : "";
    // present_options: interactive multiple-choice interview via Discord
    // buttons. Available in any text-mode turn so the model can ask the user
    // without falling back to Claude Code's built-in AskUserQuestion (which
    // doesn't work in `claude -p` print mode — it hangs / errors out, leaving
    // the user with a "(empty)" reply). Gated on text mode because voice mode
    // can't render buttons.
    const askTools =
      mcpUrl && this.opts.mode === "text"
        ? "mcp__papercup__present_options"
        : "";
    // /mcp enable adds these per-session — turns into mcp__<name>__* glob.
    const extraMcpTools = (this.opts.allowedMcps ?? [])
      .map((name) => `mcp__${name}__*`)
      .join(" ");
    const allowedTools = [baseTools, papercupTools, askTools, extraMcpTools]
      .filter(Boolean)
      .join(" ");

    const args: string[] = [
      "-p", userText,
      "--allowedTools", allowedTools,
    ];
    // Block the built-in AskUserQuestion in text mode — it requires the
    // interactive TUI to render its prompt UI, and `claude -p` (print mode,
    // which is what papercup uses) can't service it. Without this, the
    // model occasionally picks AskUserQuestion → errors out → returns empty.
    // present_options is the working replacement.
    if (this.opts.mode === "text") {
      args.push("--disallowedTools", "AskUserQuestion");
    }
    if (streaming) {
      // stream-json + verbose: emits one NDJSON event per intermediate step
      // (assistant message blocks, tool_use/tool_result) plus a final `result`
      // event we extract the answer + usage from.
      args.push("--output-format", "stream-json", "--verbose");
    } else {
      args.push("--output-format", "json");
    }
    // Only override the CLI's default system prompt in voice mode (where it's
    // set). Text mode passes no system prompt so claude -p behaves as a
    // normal Claude Code session.
    if (this.opts.systemPrompt) {
      args.push("--system-prompt", this.opts.systemPrompt);
    }
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.effort) args.push("--effort", this.opts.effort);
    if (this.opts.permissionMode) args.push("--permission-mode", this.opts.permissionMode);

    if (mcpUrl) {
      const mcpConfig = {
        mcpServers: {
          papercup: {
            type: "http",
            url: mcpUrl,
          },
        },
      };
      args.push("--mcp-config", JSON.stringify(mcpConfig));
    }

    // Grant the speaker access to project dirs for file lookups. Comma-separated.
    const projectDirs = process.env.PROJECT_DIRS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    for (const dir of projectDirs) {
      args.push("--add-dir", dir);
    }

    if (this.firstTurn) {
      args.push("--session-id", this.sessionId);
    } else {
      args.push("--resume", this.sessionId);
    }

    // Log the knobs we're actually passing so it's visible in bot.log
    // whether per-session model/effort/permission-mode/mcps landed correctly.
    console.log(
      `[agent:claude-code] respond model=${this.opts.model ?? "(default)"} ` +
      `effort=${this.opts.effort ?? "(default)"} ` +
      `permission-mode=${this.opts.permissionMode ?? "(default)"} ` +
      `mcps=[${(this.opts.allowedMcps ?? []).join(",")}] ` +
      `${this.firstTurn ? "first-turn" : "resume"}`,
    );

    const t0 = Date.now();
    // detached: true makes the spawned process the leader of its own process
    // group. We need that so cancel/timeout can SIGTERM the whole tree via
    // process.kill(-pid, …) instead of leaving descendants behind.
    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: "/tmp",
      detached: true,
    });
    this.inFlight = proc;
    const childPid = proc.pid;
    if (childPid) {
      await processRegistry.register({
        pid: childPid,
        startedAt: t0,
        sessionId: this.sessionId,
        botPid: process.pid,
        commandPreview: makeCommandPreview(userText),
      });
    }

    let stdout = "";
    let stderr = "";
    let streamLineBuffer = "";
    // Last `type: "result"` event seen in stream-json mode — used as source of
    // truth for final text + token usage.
    let streamLastResult: unknown;
    // Map tool_use.id → tool name, so subsequent tool_result events can
    // report which tool finished (the result event doesn't repeat the name).
    const streamToolNames = new Map<string, string>();

    proc.stdout?.on("data", (c: Buffer) => {
      const chunk = c.toString();
      if (!streaming) {
        stdout += chunk;
        return;
      }
      streamLineBuffer += chunk;
      let nl: number;
      while ((nl = streamLineBuffer.indexOf("\n")) !== -1) {
        const line = streamLineBuffer.slice(0, nl);
        streamLineBuffer = streamLineBuffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const out = translateStreamEvent(ev, streamToolNames);
          if (out.kind === "result") {
            streamLastResult = ev;
          } else if (out.events.length && respondOpts.onEvent) {
            for (const turnEvent of out.events) {
              try { respondOpts.onEvent(turnEvent); } catch { /* swallow */ }
            }
          }
        } catch {
          // Best-effort: malformed line is ignored. We still have the registry
          // for cleanup and the result event (if any) for final extraction.
        }
      }
    });
    proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

    const timeoutSec = Number(process.env.PAPERCUP_TURN_TIMEOUT_S ?? DEFAULT_TURN_TIMEOUT_S);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 0;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const code = await new Promise<number>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("exit", (c) => resolve(c ?? -1));
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          console.warn(
            `[agent:claude-code] turn timeout after ${timeoutSec}s — killing pid=${childPid}`,
          );
          this.killProcessGroup(proc);
        }, timeoutMs);
      }
    }).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.inFlight = undefined;
      if (childPid) void processRegistry.unregister(childPid);
    });
    const elapsedMs = Date.now() - t0;

    if (timedOut) {
      throw new Error(`turn timed out after ${timeoutSec}s (env PAPERCUP_TURN_TIMEOUT_S)`);
    }

    if (code !== 0) {
      // SIGTERM → exit code 143 (or signal-set; node maps to negative). Surface
      // a clear "cancelled" so callers can distinguish from real failures.
      if (code === 143 || proc.killed) {
        throw new Error("cancelled");
      }
      throw new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`);
    }

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    if (streaming) {
      if (streamLastResult && typeof streamLastResult === "object") {
        const r = streamLastResult as Record<string, unknown>;
        text = String(r.result ?? "").trim();
        const usage = r.usage as Record<string, unknown> | undefined;
        inputTokens = Number(usage?.input_tokens ?? 0);
        outputTokens = Number(usage?.output_tokens ?? 0);
      } else {
        // Stream ended without a final result event (cancellation, crash).
        // Fall back to whatever was buffered in the line buffer.
        text = streamLineBuffer.trim();
      }
    } else {
      try {
        const parsed = JSON.parse(stdout);
        text = String(parsed.result ?? "").trim();
        inputTokens = Number(parsed.usage?.input_tokens ?? 0);
        outputTokens = Number(parsed.usage?.output_tokens ?? 0);
      } catch {
        text = stdout.trim();
      }
    }

    this.firstTurn = false;
    return { text, inputTokens, outputTokens, elapsedMs };
  }
}

/**
 * Translate one parsed stream-json event into TurnEvents for the UI.
 *
 * Returns `{kind: "result"}` for the final summary event (so the caller can
 * stash the raw event for text/usage extraction); otherwise returns a list of
 * TurnEvents (possibly empty) to forward to the progress renderer.
 */
function translateStreamEvent(
  ev: unknown,
  toolNames: Map<string, string>,
): { kind: "result" } | { kind: "events"; events: TurnEvent[] } {
  if (!ev || typeof ev !== "object") return { kind: "events", events: [] };
  const e = ev as Record<string, unknown>;
  const type = String(e.type ?? "");

  if (type === "result") return { kind: "result" };

  if (type === "assistant") {
    const msg = e.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    const events: TurnEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const btype = String(b.type ?? "");
      if (btype === "thinking") {
        events.push({ kind: "thinking" });
      } else if (btype === "text") {
        const t = String(b.text ?? "");
        if (t.length > 0) events.push({ kind: "text", deltaChars: t.length });
      } else if (btype === "tool_use") {
        const name = String(b.name ?? "tool");
        const id = String(b.id ?? "");
        if (id) toolNames.set(id, name);
        events.push({ kind: "tool_use", name, preview: previewToolInput(name, b.input) });
      }
    }
    return { kind: "events", events };
  }

  if (type === "user") {
    const msg = e.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    const events: TurnEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (String(b.type ?? "") !== "tool_result") continue;
      const id = String(b.tool_use_id ?? "");
      const name = toolNames.get(id) ?? "tool";
      const isError = Boolean(b.is_error);
      events.push({ kind: "tool_result", name, ok: !isError });
    }
    return { kind: "events", events };
  }

  return { kind: "events", events: [] };
}

function previewToolInput(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const pick = (k: string): string | undefined => {
    const v = i[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  // Common conventions across Claude Code's built-in tools and most MCPs.
  const file = pick("file_path") ?? pick("filePath") ?? pick("path");
  if (file) return basename(file);
  const command = pick("command");
  if (command) return command.length > 60 ? command.slice(0, 59) + "…" : command;
  const pattern = pick("pattern") ?? pick("query");
  if (pattern) return pattern.length > 60 ? pattern.slice(0, 59) + "…" : pattern;
  const url = pick("url");
  if (url) return url;
  return undefined;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// Note: spawn() above runs from cwd: "/tmp" so the speaker agent doesn't pick
// up the bot's own CLAUDE.md, project memory, or git context. (User-level
// CLAUDE.md at ~/.claude/CLAUDE.md still loads.)

import { registerBackend } from "./backend.js";
registerBackend("claude-code", () => new ClaudeCodeBackend());
