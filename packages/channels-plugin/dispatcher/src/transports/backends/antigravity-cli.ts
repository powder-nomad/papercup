import { BaseCliBackend } from "./base-cli.ts";
import type { AgentReply, RespondOptions } from "./registry.ts";
import { runWithResumeRecovery } from "./_recovery.ts";

/**
 * Antigravity CLI backend.
 */
export class AntigravityCliBackend extends BaseCliBackend {
  async respond(userText: string, respondOpts: RespondOptions = {}): Promise<AgentReply> {
    if (!this.sessionId) throw new Error("AntigravityCliBackend: start() not called");

    const binary = process.env.ANTIGRAVITY_BINARY ?? "agy";
    const cwd = process.env.ANTIGRAVITY_WORKDIR ?? process.cwd();
    const model = this.opts.model ?? process.env.ANTIGRAVITY_DEFAULT_MODEL;
    const extra = (process.env.ANTIGRAVITY_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    // Override agy's built-in 5m print-timeout (default 5m0s).
    // Papercup manages long-turn visibility via per-turn.ts heartbeats;
    // the hard kill here would race with those and abort legitimate work.
    // Uses Go duration syntax — "0" means 0 seconds (immediate), not disabled.
    const printTimeout = process.env.ANTIGRAVITY_PRINT_TIMEOUT ?? "24h";
    const args = [
      "-p", userText,
      "--print-timeout", printTimeout,
      ...(respondOpts.outboxDir ? ["--add-dir", respondOpts.outboxDir] : []),
      ...extra,
    ];

    if (this.opts.permissionMode === "bypassPermissions" || !this.opts.permissionMode) {
      args.push("--dangerously-skip-permissions");
    }

    const wasFirstTurn = this.firstTurn;
    // --conversation <id> resumes an existing conversation by ID.
    // Only pass on non-first turns; first turn lets agy create a fresh
    // conversation. On subsequent turns, the conversation exists and we
    // resume it by our session UUID.
    if (!wasFirstTurn) {
      args.push("--conversation", this.sessionId);
    }

    const sessionId = this.sessionId;
    const { stdout, elapsedMs } = await runWithResumeRecovery({
      backendName: "antigravity-cli",
      isFirstTurn: wasFirstTurn,
      sessionId,
      errorPattern: /Invalid session identifier|Error resuming session/i,
      runChild: () => this.runChild({ binary, args, cwd, userText }),
      buildRecoveryRunChild: () => {
        return () => this.runChild({ binary, args, cwd, userText });
      },
      onRecover: () => { this.firstTurn = true; },
    });

    let text = stdout.trim().replace(/^Warning: conversation ".*?" not found\.\s*/mi, '');
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const parsed = JSON.parse(stdout) as any;
      text = String(parsed.response ?? parsed.text ?? text).trim();

      if (parsed.stats?.models) {
        for (const m of Object.values(parsed.stats.models) as any) {
          inputTokens += Number(m.tokens?.input ?? m.tokens?.prompt ?? 0);
          outputTokens += Number(m.tokens?.candidates ?? 0);
        }
      }
    } catch {
      // Fall back to raw stdout
    }

    this.firstTurn = false;
    return { text, inputTokens, outputTokens, elapsedMs };
  }
}

import { registerBackend } from "./registry.ts";
registerBackend("antigravity-cli", () => new AntigravityCliBackend());
