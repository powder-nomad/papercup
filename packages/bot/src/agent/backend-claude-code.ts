import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentBackend, AgentBackendOpts, AgentReply } from "./backend.js";

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
    try {
      this.inFlight.kill("SIGTERM");
    } catch { /* ignore */ }
    return true;
  }

  getBackendId(): string | undefined {
    return this.sessionId;
  }

  async respond(userText: string): Promise<AgentReply> {
    if (!this.sessionId) throw new Error("ClaudeCodeBackend: start() not called");

    // Speaker tools: read-only built-ins for inline lookups + MCP tools for
    // delegating real work to extensions. No Bash/Edit/Write — those run
    // inside extensions, never on the speaker's hot path.
    const baseTools = process.env.SPEAKER_TOOLS ?? "Read Glob Grep";
    const mcpUrl = process.env.PAPERCUP_MCP_URL;
    const papercupTools = mcpUrl
      ? "mcp__papercup__spawn_extension mcp__papercup__check_extension mcp__papercup__list_extensions"
      : "";
    // /mcp enable adds these per-session — turns into mcp__<name>__* glob.
    const extraMcpTools = (this.opts.allowedMcps ?? [])
      .map((name) => `mcp__${name}__*`)
      .join(" ");
    const allowedTools = [baseTools, papercupTools, extraMcpTools].filter(Boolean).join(" ");

    const args: string[] = [
      "-p", userText,
      "--allowedTools", allowedTools,
      "--output-format", "json",
    ];
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

    const t0 = Date.now();
    const proc = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], cwd: "/tmp" });
    this.inFlight = proc;
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    const code = await new Promise<number>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("exit", (c) => resolve(c ?? -1));
    }).finally(() => {
      this.inFlight = undefined;
    });
    const elapsedMs = Date.now() - t0;

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
    try {
      const parsed = JSON.parse(stdout);
      text = String(parsed.result ?? "").trim();
      inputTokens = Number(parsed.usage?.input_tokens ?? 0);
      outputTokens = Number(parsed.usage?.output_tokens ?? 0);
    } catch {
      text = stdout.trim();
    }

    this.firstTurn = false;
    return { text, inputTokens, outputTokens, elapsedMs };
  }
}

// Note: spawn() above runs from cwd: "/tmp" so the speaker agent doesn't pick
// up the bot's own CLAUDE.md, project memory, or git context. (User-level
// CLAUDE.md at ~/.claude/CLAUDE.md still loads.)
