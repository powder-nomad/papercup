import { BaseCliBackend } from "./base-cli.ts";
import type { AgentReply, RespondOptions } from "./registry.ts";

/**
 * Aider CLI backend. Flags verified against https://aider.chat/docs/scripting.html
 * (May 2026). Conversation history is per-cwd (file `.aider.chat.history.md`
 * in the working directory); set AIDER_WORKDIR per session for isolation.
 *
 * Env config:
 *   AIDER_BINARY          — override binary path (default: "aider")
 *   AIDER_WORKDIR         — working directory; per-bot isolation
 *   AIDER_EXTRA_ARGS      — extra CLI flags appended to every invocation
 *                            (space-separated; e.g. "--no-git --map-tokens 0")
 *
 * Limitations (v1):
 *   - Token usage isn't extracted (aider's stdout doesn't surface it in a
 *     structured way). Reported as 0/0.
 *   - Streaming events (TurnEvent) not emitted; just the final text.
 *   - Model flag passed only if AgentBackendOpts.model is set; otherwise
 *     aider picks its own default per its config.
 */
export class AiderBackend extends BaseCliBackend {
  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = process.env.AIDER_BINARY ?? "aider";
    const cwd = this.resolveCwd(process.env.AIDER_WORKDIR);
    const extra = (process.env.AIDER_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    const args = [
      "--message", userText,
      "--no-stream",
      "--yes-always",
      "--no-pretty",
      ...(this.opts.model ? ["--model", this.opts.model] : []),
      ...extra,
    ];

    const { stdout, elapsedMs } = await this.runChild({
      binary,
      args,
      cwd,
      userText,
    });

    return {
      text: stdout.trim(),
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs,
    };
  }
}

import { registerBackend } from "./registry.ts";
registerBackend("aider-cli", () => new AiderBackend());
