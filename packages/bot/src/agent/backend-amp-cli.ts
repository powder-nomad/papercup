import { BaseCliBackend } from "./base-cli-backend.js";
import type { AgentReply, RespondOptions } from "./backend.js";

/**
 * Sourcegraph amp CLI backend. Flags verified against
 * https://ampcode.com/manual (May 2026).
 *
 * Uses `amp -x` (execute) mode. Prompt is piped via stdin so we don't have to
 * worry about shell quoting for long/multi-line prompts.
 *
 * Env config:
 *   AMP_BINARY         — override binary path (default: "amp")
 *   AMP_WORKDIR        — working directory
 *   AMP_DEFAULT_MODEL  — fallback model name
 *   AMP_THREAD         — thread id; if set, prepended to the prompt as
 *                          `@T-<thread> <userText>` so amp resumes that thread
 *   AMP_EXTRA_ARGS     — extra CLI flags appended to every invocation
 *
 * Limitations (v1):
 *   - Token usage not extracted (would need --stream-json parsing).
 *   - Session resume is via the `@T-<thread-id>` in-prompt syntax (amp's own
 *     convention). Not as clean as session-id flags; treated as opt-in via env.
 *   - TurnEvent streaming not emitted; just the final stdout text.
 */
export class AmpCliBackend extends BaseCliBackend {
  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = process.env.AMP_BINARY ?? "amp";
    const cwd = process.env.AMP_WORKDIR ?? process.cwd();
    const model = this.opts.model ?? process.env.AMP_DEFAULT_MODEL;
    const thread = process.env.AMP_THREAD;
    const extra = (process.env.AMP_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    const args = [
      "-x",
      ...(model ? ["--model", model] : []),
      ...extra,
    ];

    const promptText = thread ? `@T-${thread} ${userText}` : userText;

    const { stdout, elapsedMs } = await this.runChild({
      binary,
      args,
      cwd,
      userText,
      stdinText: promptText,
    });

    return {
      text: stdout.trim(),
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs,
    };
  }
}

import { registerBackend } from "./backend.js";
registerBackend("amp-cli", () => new AmpCliBackend());
