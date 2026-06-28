import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseCliBackend } from "./base-cli.ts";
import type { AgentBackendOpts, AgentReply, RespondOptions } from "./registry.ts";
import { runWithResumeRecovery } from "./_recovery.ts";

/**
 * Antigravity CLI backend (`agy`).
 *
 * Resume model (verified Jun 2026): agy generates its OWN conversation id and
 * keys it by working directory — `~/.gemini/antigravity-cli/cache/last_conversations.json`
 * maps cwd → conversation id. There is NO flag to create a conversation with a
 * caller-chosen id, so the old `--conversation <papercupSessionId>` approach
 * always missed (papercup's UUID ≠ agy's id) and agy silently started fresh
 * every turn ("Warning: conversation … not found", stripped from output) —
 * i.e. total context loss on every follow-up.
 *
 * Fix: each papercup session gets a unique cwd (opts.cwd = /tmp/papercup/<id>),
 * and we resume with `--continue`, which agy scopes to the cwd. Unique cwd ⇒
 * `--continue` always resumes that session's conversation with no cross-session
 * bleed. First turn omits `--continue` so agy creates the conversation.
 */
export class AntigravityCliBackend extends BaseCliBackend {
  override async start(opts: AgentBackendOpts): Promise<void> {
    await super.start(opts);
    // Restart survival: per-turn sessions never report resume=true (no claude
    // transcript, everSpawned cleared on bot restart), but agy's conversation
    // for this cwd persists in ~/.gemini. If one exists, treat this as a
    // resume so the first post-restart turn uses --continue instead of
    // starting a fresh conversation.
    if (this.firstTurn && antigravityHasConversationForCwd(this.cwdFor())) {
      this.firstTurn = false;
    }
  }

  private cwdFor(): string {
    return this.resolveCwd(process.env.ANTIGRAVITY_WORKDIR);
  }

  async respond(userText: string, respondOpts: RespondOptions = {}): Promise<AgentReply> {
    if (!this.sessionId) throw new Error("AntigravityCliBackend: start() not called");

    const binary = process.env.ANTIGRAVITY_BINARY ?? "agy";
    const cwd = this.cwdFor();
    const extra = (process.env.ANTIGRAVITY_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .filter(Boolean);
    // Override agy's built-in 5m print-timeout (default 5m0s).
    // Papercup manages long-turn visibility via per-turn.ts heartbeats;
    // the hard kill here would race with those and abort legitimate work.
    // Uses Go duration syntax — "0" means 0 seconds (immediate), not disabled.
    const printTimeout = process.env.ANTIGRAVITY_PRINT_TIMEOUT ?? "24h";
    const bypass =
      this.opts.permissionMode === "bypassPermissions" || !this.opts.permissionMode;

    const wasFirstTurn = this.firstTurn;
    const buildArgs = (resume: boolean): string[] =>
      buildAntigravityArgs({
        userText,
        printTimeout,
        outboxDir: respondOpts.outboxDir,
        extra,
        bypass,
        resume,
      });

    const sessionId = this.sessionId;
    const { stdout, elapsedMs } = await runWithResumeRecovery({
      backendName: "antigravity-cli",
      isFirstTurn: wasFirstTurn,
      sessionId,
      // agy's "--continue with no conversation" / stale-store failures.
      errorPattern: /Invalid session identifier|Error resuming session|no .{0,20}conversation|conversation .{0,20}not found/i,
      runChild: () => this.runChild({ binary, args: buildArgs(!wasFirstTurn), cwd, userText }),
      buildRecoveryRunChild: () => {
        // Drop --continue and let agy create a fresh conversation in this cwd.
        return () => this.runChild({ binary, args: buildArgs(false), cwd, userText });
      },
      onRecover: () => { this.firstTurn = true; },
    });

    let text = stdout.trim().replace(/^Warning: conversation ".*?" not found\.\s*/mi, '');
    let inputTokens = 0;
    let outputTokens = 0;
    // agy -p emits plain text by default; if a future/flagged build emits JSON
    // we opportunistically parse it for the response + token stats.
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
      // Plain-text stdout — already captured above.
    }

    this.firstTurn = false;
    return { text, inputTokens, outputTokens, elapsedMs };
  }
}

/** Build agy's `-p` argument list. Pure + exported for unit testing the
 *  resume-flag behavior. `resume: true` adds `--continue` (resumes the cwd's
 *  conversation); first turns pass `resume: false`. */
export function buildAntigravityArgs(p: {
  userText: string;
  printTimeout: string;
  outboxDir?: string;
  extra: string[];
  bypass: boolean;
  resume: boolean;
}): string[] {
  const args = [
    "-p", p.userText,
    "--print-timeout", p.printTimeout,
    ...(p.outboxDir ? ["--add-dir", p.outboxDir] : []),
    ...p.extra,
  ];
  if (p.bypass) args.push("--dangerously-skip-permissions");
  if (p.resume) args.push("--continue");
  return args;
}

/** Best-effort check of agy's cwd→conversation map. Used so a bot restart
 *  resumes (via --continue) instead of orphaning the prior conversation. */
export function antigravityHasConversationForCwd(cwd: string): boolean {
  try {
    const mapPath = join(
      homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json",
    );
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, string>;
    return typeof map[cwd] === "string" && map[cwd].length > 0;
  } catch {
    return false;
  }
}

import { registerBackend } from "./registry.ts";
registerBackend("antigravity-cli", () => new AntigravityCliBackend());
