import { BaseCliBackend } from "./base-cli-backend.js";
import type { AgentReply, RespondOptions } from "./backend.js";

/**
 * Google Gemini CLI backend. Flags verified against
 * https://github.com/google-gemini/gemini-cli (May 2026).
 *
 * Env config:
 *   GEMINI_BINARY          — override binary path (default: "gemini")
 *   GEMINI_WORKDIR         — working directory
 *   GEMINI_DEFAULT_MODEL   — fallback model name (e.g. "gemini-2.5-flash")
 *   GEMINI_EXTRA_ARGS      — extra CLI flags appended to every invocation
 *
 * Output: parses `--output-format json` for structured `text` + `usage`. If
 * gemini ever returns an unparseable stdout, falls back to treating the whole
 * blob as the reply text.
 *
 * Limitations (v1):
 *   - Session resume not implemented (gemini CLI is largely stateless;
 *     conversation persistence varies by setup).
 *   - TurnEvent streaming not emitted; stream-json output mode reserved for
 *     a follow-up that mirrors what claude-code does.
 */
export class GeminiCliBackend extends BaseCliBackend {
  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = process.env.GEMINI_BINARY ?? "gemini";
    const cwd = process.env.GEMINI_WORKDIR ?? process.cwd();
    const model = this.opts.model ?? process.env.GEMINI_DEFAULT_MODEL;
    const extra = (process.env.GEMINI_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    const args = [
      "-p", userText,
      "--output-format", "json",
      ...(model ? ["-m", model] : []),
      ...extra,
    ];

    const { stdout, elapsedMs } = await this.runChild({
      binary,
      args,
      cwd,
      userText,
    });

    let text = stdout.trim();
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const parsed = JSON.parse(stdout) as {
        response?: string;
        text?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          prompt_token_count?: number;
          candidates_token_count?: number;
        };
      };
      text = String(parsed.response ?? parsed.text ?? stdout).trim();
      inputTokens = Number(parsed.usage?.input_tokens ?? parsed.usage?.prompt_token_count ?? 0);
      outputTokens = Number(parsed.usage?.output_tokens ?? parsed.usage?.candidates_token_count ?? 0);
    } catch {
      // Fall back to raw stdout as text; gemini may have returned plain text
      // if the json flag wasn't recognized by an older version.
    }

    return { text, inputTokens, outputTokens, elapsedMs };
  }
}

import { registerBackend } from "./backend.js";
registerBackend("gemini-cli", () => new GeminiCliBackend());
