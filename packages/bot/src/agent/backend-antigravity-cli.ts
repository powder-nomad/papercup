import { BaseCliBackend } from "./base-cli-backend.js";
import type { AgentReply, RespondOptions } from "./backend.js";

/**
 * Antigravity CLI backend.
 */
export class AntigravityCliBackend extends BaseCliBackend {
  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    if (!this.sessionId) throw new Error("AntigravityCliBackend: start() not called");

    const binary = process.env.ANTIGRAVITY_BINARY ?? "agy";
    const cwd = process.env.ANTIGRAVITY_WORKDIR ?? process.cwd();
    const model = this.opts.model ?? process.env.ANTIGRAVITY_DEFAULT_MODEL;
    const extra = (process.env.ANTIGRAVITY_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    const args = [
      "-p", userText,
      ...extra,
    ];

    if (this.opts.permissionMode === "bypassPermissions" || !this.opts.permissionMode) {
      args.push("--dangerously-skip-permissions");
    }

    args.push("--conversation", this.sessionId);

    const { stdout, elapsedMs } = await this.runChild({
      binary,
      args,
      cwd,
      userText,
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

import { registerBackend } from "./backend.js";
registerBackend("antigravity-cli", () => new AntigravityCliBackend());
