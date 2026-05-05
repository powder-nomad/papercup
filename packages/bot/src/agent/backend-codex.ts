import { spawn, type ChildProcess } from "node:child_process";
import type { AgentBackend, AgentBackendOpts, AgentReply } from "./backend.js";

/**
 * OpenAI Codex CLI backend. Uses `codex exec` per turn — first turn boots a
 * thread and captures its UUID from the JSONL stream; subsequent turns use
 * `codex exec resume <thread-id>` to continue the conversation.
 *
 * Codex has no --system-prompt flag, so we prepend the system prompt to the
 * first user turn (out-of-band header). It's not as clean as Claude's flag but
 * it works.
 */
export class CodexBackend implements AgentBackend {
  private threadId?: string;
  private opts!: AgentBackendOpts;
  private firstTurn = true;
  private inFlight?: ChildProcess;

  async start(opts: AgentBackendOpts): Promise<void> {
    this.opts = opts;
    // Codex assigns its own thread id on first exec — we can't pre-allocate.
    // If sessionId/resume was passed, we'll honor resume by treating the
    // sessionId as the codex thread id.
    if (opts.sessionId && opts.resume) {
      this.threadId = opts.sessionId;
      this.firstTurn = false;
    } else {
      this.threadId = undefined;
      this.firstTurn = true;
    }
  }

  reset(): void {
    this.threadId = undefined;
    this.firstTurn = true;
  }

  stop(): void {
    // Codex stores threads in ~/.codex; nothing to tear down here.
    this.cancel();
  }

  cancel(): boolean {
    if (!this.inFlight) return false;
    try {
      this.inFlight.kill("SIGTERM");
    } catch { /* ignore */ }
    return true;
  }

  async respond(userText: string): Promise<AgentReply> {
    const projectDirs = process.env.PROJECT_DIRS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    const sandbox = process.env.CODEX_SANDBOX ?? "read-only";

    let args: string[];
    let prompt: string;

    if (this.firstTurn || !this.threadId) {
      // First turn: prefix system prompt to user text since codex has no --system flag.
      // Sandbox + add-dir only apply to the first turn (they're locked in for the thread).
      // Text mode passes no systemPrompt → just send the raw user text.
      prompt = this.opts.systemPrompt
        ? `<system>\n${this.opts.systemPrompt}\n</system>\n\n${userText}`
        : userText;
      args = [
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--sandbox", sandbox,
      ];
      for (const dir of projectDirs) args.push("--add-dir", dir);
    } else {
      // Resume: only basic flags. Sandbox + add-dir inherit from the original thread.
      prompt = userText;
      args = [
        "exec",
        "resume",
        this.threadId,
        "--skip-git-repo-check",
        "--json",
      ];
    }

    if (this.opts.model) args.push("--model", this.opts.model);
    args.push(prompt);

    const t0 = Date.now();
    const proc = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"], cwd: "/tmp" });
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
      if (code === 143 || proc.killed) {
        throw new Error("cancelled");
      }
      throw new Error(`codex exited ${code}: ${stderr.slice(-500)}`);
    }

    const parsed = parseCodexJsonl(stdout);
    if (parsed.threadId) this.threadId = parsed.threadId;
    this.firstTurn = false;

    return {
      text: parsed.text,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      elapsedMs,
    };
  }

  getBackendId(): string | undefined {
    return this.threadId;
  }
}


type CodexParseResult = {
  text: string;
  threadId?: string;
  inputTokens: number;
  outputTokens: number;
};

function parseCodexJsonl(stdout: string): CodexParseResult {
  let text = "";
  let threadId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t || !t.startsWith("{")) continue;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(t); } catch { continue; }

    switch (evt.type) {
      case "thread.started":
        if (typeof evt.thread_id === "string") threadId = evt.thread_id;
        break;
      case "item.completed": {
        const item = evt.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          text = item.text; // last agent_message wins
        }
        break;
      }
      case "turn.completed": {
        const usage = evt.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage?.input_tokens) inputTokens = usage.input_tokens;
        if (usage?.output_tokens) outputTokens = usage.output_tokens;
        break;
      }
    }
  }

  return { text: text.trim(), threadId, inputTokens, outputTokens };
}
