import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 *   OPENCODE_DEFAULT_MODEL — fallback model, "provider/model" (e.g. ollama/qwen3-14b).
 *                            NOTE: opencode's agent loop is tool-heavy; small models
 *                            (≤4B, e.g. gemma4-e4b) stall/loop and never complete a
 *                            turn. Use a capable tool-calling model (qwen3-14b worked).
 *   OPENCODE_EXTRA_ARGS    — extra CLI flags appended to every invocation
 *
 * Resume (verified Jun 2026): opencode generates its OWN `ses_…` ids and ignores
 * a caller-supplied UUID; `--session <id>` resumes an EXISTING id. So we capture
 * opencode's real session id from the first turn's event stream and pass it back
 * via `--session` on later turns (confirmed: turn 2 recalled turn-1 context).
 * First turn omits it so opencode creates the session. `--continue` (cwd-scoped)
 * is the fallback before we've captured an id.
 *
 * Output: `--format json` emits one JSON event per line, but BUFFERS the whole
 * turn and flushes at the end (no live streaming via this interface). Event shape:
 *   {type:"step_start"|"text"|"step_finish", sessionID, part:{…}}
 *   - reply text:  type "text"        → part.text
 *   - token usage: type "step_finish" → part.tokens.{input,output}
 */
export class OpencodeCliBackend extends BaseCliBackend {
  /** opencode's own `ses_…` id, captured from turn 1's event stream. */
  private opencodeSessionId?: string;

  override reset(): void {
    super.reset();
    this.opencodeSessionId = undefined;
  }

  override getBackendId(): string | undefined {
    return this.opencodeSessionId ?? this.sessionId;
  }

  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = resolveOpencodeBinary(process.env.OPENCODE_BINARY);
    const cwd = this.resolveCwd(process.env.OPENCODE_WORKDIR);
    const model = this.opts.model ?? process.env.OPENCODE_DEFAULT_MODEL;
    const extra = (process.env.OPENCODE_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);

    const args = buildOpencodeArgs({
      userText,
      model,
      extra,
      sessionId: this.opencodeSessionId,
      resume: !this.firstTurn,
    });

    const { stdout, elapsedMs } = await this.runChild({ binary, args, cwd, userText });

    const parsed = parseOpencodeStream(stdout);
    if (parsed.sessionId) this.opencodeSessionId = parsed.sessionId;
    this.firstTurn = false;

    return {
      // Fall back to raw stdout only if no text parts were found (older/unknown
      // event shape) so the user still sees *something*.
      text: parsed.text || stdout.trim(),
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      elapsedMs,
    };
  }
}

/** Resolve the opencode binary. The installer drops it at ~/.opencode/bin/opencode,
 *  which is NOT on PATH by default — so a bare "opencode" spawn ENOENTs in
 *  production. Precedence: OPENCODE_BINARY env > standard install path (if it
 *  exists) > bare "opencode" (rely on PATH). `homeDir`/`exists` are injectable
 *  for unit testing. */
export function resolveOpencodeBinary(
  envBinary?: string,
  homeDir: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): string {
  if (envBinary) return envBinary;
  const installed = join(homeDir, ".opencode", "bin", "opencode");
  if (exists(installed)) return installed;
  return "opencode";
}

/** Build `opencode run` args. Pure + exported for unit testing. Resume precedence:
 *  a captured real `--session <ses_id>` wins; otherwise `--continue` (cwd-scoped)
 *  on non-first turns; first turn passes neither so opencode creates a session. */
export function buildOpencodeArgs(p: {
  userText: string;
  model?: string;
  extra: string[];
  sessionId?: string;
  resume: boolean;
}): string[] {
  const resumeArgs = p.sessionId
    ? ["--session", p.sessionId]
    : p.resume
      ? ["--continue"]
      : [];
  return [
    "run",
    ...resumeArgs,
    ...(p.model ? ["--model", p.model] : []),
    "--format", "json",
    ...p.extra,
    p.userText,
  ];
}

export interface OpencodeParseResult {
  text: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
}

/** Parse opencode's `--format json` line-delimited event stream. Pure + exported
 *  for unit testing. Concatenates all `text` parts, captures the session id, and
 *  sums token usage across `step_finish` events. */
export function parseOpencodeStream(stdout: string): OpencodeParseResult {
  const textChunks: string[] = [];
  let sessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: {
      type?: string;
      sessionID?: string;
      part?: { text?: string; tokens?: { input?: number; output?: number } };
    };
    try { ev = JSON.parse(t); } catch { continue; }

    if (!sessionId && typeof ev.sessionID === "string") sessionId = ev.sessionID;

    const part = ev.part;
    if (ev.type === "text" && part && typeof part.text === "string") {
      textChunks.push(part.text);
    } else if (ev.type === "step_finish" && part?.tokens) {
      inputTokens += Number(part.tokens.input ?? 0);
      outputTokens += Number(part.tokens.output ?? 0);
    }
  }

  return { text: textChunks.join("").trim(), sessionId, inputTokens, outputTokens };
}

import { registerBackend } from "./registry.ts";
registerBackend("opencode-cli", () => new OpencodeCliBackend());
