import { BaseCliBackend } from "./base-cli.ts";
import type { AgentReply, RespondOptions } from "./registry.ts";

/**
 * OpenCode CLI backend (`opencode run`).
 *
 * Env config:
 *   OPENCODE_BINARY        — override binary path. REQUIRED if opencode isn't on
 *                            PATH (the installer drops it at ~/.opencode/bin/opencode,
 *                            which is NOT on PATH by default).
 *   OPENCODE_WORKDIR       — working directory override (else opts.cwd)
 *   OPENCODE_DEFAULT_MODEL — fallback model name (provider/model)
 *   OPENCODE_EXTRA_ARGS    — extra CLI flags appended to every invocation
 *
 * Resume model (verified Jun 2026): opencode generates its OWN `ses_…` session
 * ids and scopes sessions to the project (= cwd). `--session <id>` means
 * "continue an EXISTING id" — it does not adopt a caller-supplied UUID, so the
 * old `--session <papercupSessionId>` was a no-op/miss. Instead each papercup
 * session gets a unique cwd (opts.cwd = /tmp/papercup/<id>) and we resume with
 * `-c/--continue` (continues the cwd's last session). First turn omits it so
 * opencode creates the session.
 *
 * Output: `--format json` emits one JSON event per line; we concatenate
 * text/message deltas into the final reply. Token usage is not yet extracted.
 */
export class OpencodeCliBackend extends BaseCliBackend {
  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = process.env.OPENCODE_BINARY ?? "opencode";
    const cwd = this.opts.cwd ?? process.env.OPENCODE_WORKDIR ?? process.cwd();
    const model = this.opts.model ?? process.env.OPENCODE_DEFAULT_MODEL;
    const extra = (process.env.OPENCODE_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    const args = buildOpencodeArgs({
      userText,
      model,
      extra,
      resume: !this.firstTurn,
    });

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

    this.firstTurn = false;
    return {
      text,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs,
    };
  }
}

/** Build `opencode run` args. Pure + exported for unit testing the resume-flag
 *  behavior. `resume: true` adds `--continue` (resumes the cwd's last session);
 *  first turns pass `resume: false`. */
export function buildOpencodeArgs(p: {
  userText: string;
  model?: string;
  extra: string[];
  resume: boolean;
}): string[] {
  return [
    "run",
    ...(p.resume ? ["--continue"] : []),
    ...(p.model ? ["--model", p.model] : []),
    "--format", "json",
    ...p.extra,
    p.userText,
  ];
}

import { registerBackend } from "./registry.ts";
registerBackend("opencode-cli", () => new OpencodeCliBackend());
