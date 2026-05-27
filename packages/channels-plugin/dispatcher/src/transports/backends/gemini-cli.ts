import { BaseCliBackend } from "./base-cli.ts";
import type { AgentReply, RespondOptions } from "./registry.ts";
import { runWithResumeRecovery } from "./_recovery.ts";

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
  async respond(userText: string, respondOpts: RespondOptions = {}): Promise<AgentReply> {
    if (!this.sessionId) throw new Error("GeminiCliBackend: start() not called");

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
      // Widen the workspace sandbox so write_file accepts paths in the
      // per-turn outbox directory. Without this, gemini rejects writes
      // outside its cwd + ~/.gemini/tmp/<project>/ and the outbox stays
      // empty even though the prompt told the agent to use it.
      ...(respondOpts.outboxDir ? ["--include-directories", respondOpts.outboxDir] : []),
      ...extra,
    ];

    if (this.opts.permissionMode === "plan") {
      args.push("--approval-mode", "plan");
    } else if (this.opts.permissionMode === "bypassPermissions") {
      args.push("--yolo");
    } else if (this.opts.permissionMode === "auto" || this.opts.permissionMode === "acceptEdits") {
      args.push("--approval-mode", "auto_edit");
    } else {
      // Default for headless is usually YOLO/bypass in these bots, but
      // we'll follow the opt-in permissionMode if provided.
      if (!this.opts.permissionMode) args.push("--yolo");
    }

    const wasFirstTurn = this.firstTurn;
    if (wasFirstTurn) {
      args.push("--session-id", this.sessionId);
    } else {
      args.push("--resume", this.sessionId);
    }

    // Capture sessionId early so the recovery closure stays correct even
    // if `this` is reassigned (it isn't today, but defensive).
    const sessionId = this.sessionId;
    const { stdout, elapsedMs } = await runWithResumeRecovery({
      backendName: "gemini-cli",
      isFirstTurn: wasFirstTurn,
      sessionId,
      errorPattern: /Invalid session identifier|Error resuming session/i,
      runChild: () => this.runChild({ binary, args, cwd, userText }),
      buildRecoveryRunChild: () => {
        // `--resume <uuid>` → `--session-id <uuid>`
        const recovered = [...args];
        const i = recovered.indexOf("--resume");
        if (i >= 0) recovered.splice(i, 2, "--session-id", sessionId);
        return () => this.runChild({ binary, args: recovered, cwd, userText });
      },
      onRecover: () => { this.firstTurn = true; },
    });

    let text = stdout.trim();
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const parsed = JSON.parse(stdout) as {
        response?: string;
        text?: string;
        stats?: {
          models?: Record<string, {
            tokens?: {
              input?: number;
              prompt?: number;
              candidates?: number;
              total?: number;
            }
          }>
        };
      };
      text = String(parsed.response ?? parsed.text ?? stdout).trim();

      // Extract tokens from stats.models. Sum all models if multiple were used
      // (e.g. utility_router + main).
      if (parsed.stats?.models) {
        for (const m of Object.values(parsed.stats.models)) {
          inputTokens += Number(m.tokens?.input ?? m.tokens?.prompt ?? 0);
          outputTokens += Number(m.tokens?.candidates ?? 0);
        }
      }
    } catch {
      // Fall back to raw stdout as text; gemini may have returned plain text
      // if the json flag wasn't recognized by an older version.
    }

    this.firstTurn = false;
    return { text, inputTokens, outputTokens, elapsedMs };
  }
}

import { registerBackend } from "./registry.ts";
registerBackend("gemini-cli", () => new GeminiCliBackend());
