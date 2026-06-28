import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { AgentBackend, AgentBackendOpts, AgentReply, RespondOptions } from "./registry.ts";
import { runWithResumeRecovery } from "./_recovery.ts";

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

  async respond(userText: string, respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = process.env.CODEX_BINARY ?? "codex";
    const cwd = this.opts.cwd ?? "/tmp";
    try { mkdirSync(cwd, { recursive: true }); } catch { /* surfaced by spawn */ }
    const projectDirs = process.env.PROJECT_DIRS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    // Default to workspace-write so codex can actually edit files (read-only
    // blocks all writes → it can't do real work). Override via CODEX_SANDBOX
    // (read-only | workspace-write | danger-full-access). Flag values verified
    // against the codex CLI reference (Jun 2026); NOT runtime-tested here —
    // codex isn't installed on this host.
    const sandbox = process.env.CODEX_SANDBOX ?? "workspace-write";
    // Writable sandbox roots: the per-turn outbox (so codex can drop reply
    // attachments) + any configured project dirs. --add-dir paths must already
    // exist (per-turn.ts pre-creates the outbox). Applied on the first turn;
    // codex exec resume doesn't document --add-dir, so outbox writes are
    // first-turn only there.
    const writableDirs = [
      ...(respondOpts.outboxDir ? [respondOpts.outboxDir] : []),
      ...projectDirs,
    ];

    // Build either first-turn args (with sandbox + add-dir + system prompt
    // prefix) or resume args (positional `resume <thread-id>`). Both shapes
    // live in this helper so the resume-recovery wrapper can ask for a fresh
    // first-turn build when codex says the thread is gone.
    const buildArgs = (mode: "first" | "resume"): { args: string[]; prompt: string } => {
      let args: string[];
      let prompt: string;
      if (mode === "first" || !this.threadId) {
        prompt = this.opts.systemPrompt
          ? `<system>\n${this.opts.systemPrompt}\n</system>\n\n${userText}`
          : userText;
        args = [
          "exec",
          "--skip-git-repo-check",
          "--json",
          "--sandbox", sandbox,
        ];
        for (const dir of writableDirs) args.push("--add-dir", dir);
      } else {
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
      return { args, prompt };
    };

    // Spawn-and-parse closure factored out so the recovery helper can call
    // it twice if the first attempt errors with "thread not found".
    const runOnce = async (effectiveArgs: string[]): Promise<AgentReply> => {
      const t0 = Date.now();
      const proc = spawn(binary, effectiveArgs, { stdio: ["ignore", "pipe", "pipe"], cwd });
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
        if (code === 143 || proc.killed) throw new Error("cancelled");
        throw new Error(`Failed to resume Codex session. The thread may not exist - starting a new session instead. Original error: ${code}: ${stderr.slice(-500)}`);
      }

      const parsed = parseCodexJsonl(stdout);
      if (parsed.threadId) this.threadId = parsed.threadId;
      return {
        text: parsed.text,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        elapsedMs,
      };
    };

    const wasFirstTurn = this.firstTurn || !this.threadId;
    const { args } = buildArgs(wasFirstTurn ? "first" : "resume");
    // Resume-recovery: if codex's resume errors with "thread not found"-style
    // text, drop the resume positionals and retry as a first-turn spawn with
    // the same papercup session backed by a NEW codex thread. Prior turns
    // are lost (codex never persisted them or already dropped them) but the
    // session functionally recovers. See _recovery.ts.
    const result = await runWithResumeRecovery({
      backendName: "codex",
      isFirstTurn: wasFirstTurn,
      sessionId: this.threadId ?? "(no-thread)",
      errorPattern: /thread.{0,40}(?:not found|invalid|does not exist|no such)/i,
      runChild: () => runOnce(args),
      buildRecoveryRunChild: () => {
        // Drop the dead threadId so buildArgs produces first-turn shape; the
        // CLI assigns a new thread on success.
        this.threadId = undefined;
        const { args: freshArgs } = buildArgs("first");
        return () => runOnce(freshArgs);
      },
      onRecover: () => { this.firstTurn = true; },
    });
    this.firstTurn = false;
    return result;
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

import { registerBackend } from "./registry.ts";
registerBackend("codex", () => new CodexBackend());
