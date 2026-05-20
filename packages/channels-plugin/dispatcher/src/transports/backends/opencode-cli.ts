import { BaseCliBackend } from "./base-cli.ts";
import type { AgentReply, RespondOptions } from "./registry.ts";

/**
 * OpenCode CLI backend. Flags verified against https://opencode.ai/docs/cli
 * (May 2026). OpenCode has explicit session management — `--session ID`
 * resumes a specific conversation, `--continue` resumes the last.
 *
 * Env config:
 *   OPENCODE_BINARY        — override binary path (default: "opencode")
 *   OPENCODE_WORKDIR       — working directory
 *   OPENCODE_DEFAULT_MODEL — fallback model name
 *   OPENCODE_EXTRA_ARGS    — extra CLI flags appended to every invocation
 *
 * Output: parses `--format json` raw-event stream into final text. Each line
 * is one JSON event; the assistant's final reply is the concatenation of
 * "text"-typed deltas (best-effort, may need refinement after live testing).
 *
 * Session: uses `--session <papercup-session-id>` so the bot's UUID is the
 * opencode session id. opencode silently creates the session on first turn.
 *
 * Limitations (v1):
 *   - Token usage not extracted (opencode's event schema not fully verified).
 *   - TurnEvent streaming not emitted; just the final text.
 */
export class OpencodeCliBackend extends BaseCliBackend {
  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = process.env.OPENCODE_BINARY ?? "opencode";
    const cwd = process.env.OPENCODE_WORKDIR ?? process.cwd();
    const model = this.opts.model ?? process.env.OPENCODE_DEFAULT_MODEL;
    const extra = (process.env.OPENCODE_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    const args = [
      "run",
      ...(this.sessionId ? ["--session", this.sessionId] : []),
      ...(model ? ["--model", model] : []),
      "--format", "json",
      ...extra,
      userText,
    ];

    const { stdout, elapsedMs } = await this.runChild({
      binary,
      args,
      cwd,
      userText,
    });

    let text = stdout.trim();
    const lines = stdout.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      const textChunks: string[] = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { type?: string; text?: string; content?: string };
          if (ev.type === "text" || ev.type === "message") {
            if (typeof ev.text === "string") textChunks.push(ev.text);
            else if (typeof ev.content === "string") textChunks.push(ev.content);
          }
        } catch {
          // Malformed line; ignore.
        }
      }
      if (textChunks.length > 0) text = textChunks.join("").trim();
    }

    return {
      text,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs,
    };
  }
}

import { registerBackend } from "./registry.ts";
registerBackend("opencode-cli", () => new OpencodeCliBackend());
