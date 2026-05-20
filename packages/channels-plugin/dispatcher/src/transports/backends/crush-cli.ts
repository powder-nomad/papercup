import { BaseCliBackend } from "./base-cli.ts";
import type { AgentReply, RespondOptions } from "./registry.ts";

/**
 * Charm's crush CLI backend. Flags verified against
 * https://github.com/charmbracelet/crush and deepwiki/charmbracelet/crush
 * (May 2026). Uses `crush run` for non-interactive single-prompt execution.
 *
 * Env config:
 *   CRUSH_BINARY         — override binary path (default: "crush")
 *   CRUSH_WORKDIR        — working directory
 *   CRUSH_DEFAULT_MODEL  — fallback model name (e.g. "openai/gpt-5.2-codex")
 *   CRUSH_YOLO           — set to "true" to add --yolo (skip permission prompts)
 *   CRUSH_EXTRA_ARGS     — extra CLI flags appended to every invocation
 *
 * Limitations (v1):
 *   - Output is plain text (crush's run subcommand prints to stdout). No JSON
 *     mode documented in the version I verified.
 *   - Token usage not extracted (no structured output yet).
 *   - Session management is internal to crush (subcommands exist but the
 *     papercup session id is not yet plumbed through). Each turn is
 *     effectively stateless w.r.t. crush's own session store.
 *   - TurnEvent streaming not emitted.
 */
export class CrushCliBackend extends BaseCliBackend {
  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = process.env.CRUSH_BINARY ?? "crush";
    const cwd = process.env.CRUSH_WORKDIR ?? process.cwd();
    const model = this.opts.model ?? process.env.CRUSH_DEFAULT_MODEL;
    const yolo = process.env.CRUSH_YOLO === "true";
    const extra = (process.env.CRUSH_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    const args = [
      "run",
      ...(model ? ["--model", model] : []),
      ...(yolo ? ["--yolo"] : []),
      ...extra,
      userText,
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
registerBackend("crush-cli", () => new CrushCliBackend());
