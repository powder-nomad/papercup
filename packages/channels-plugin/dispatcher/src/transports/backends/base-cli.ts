import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  AgentBackend,
  AgentBackendOpts,
  AgentReply,
  RespondOptions,
} from "./registry.ts";
import { processRegistry, makeCommandPreview } from "./process-registry.ts";

const DEFAULT_TURN_TIMEOUT_S = 0;

/**
 * Shared lifecycle for agent CLI backends.
 *
 * Provides:
 *   - detached spawn (process-group leader, so we can group-kill descendants)
 *   - process-registry tracking (PID survives bot restart for cleanup)
 *   - per-turn timeout via PAPERCUP_TURN_TIMEOUT_S env (0 = disabled)
 *   - cancel() via SIGTERM to the whole process group
 *   - session id mgmt (sessionId from opts or fresh UUID; firstTurn tracking)
 *
 * Subclasses implement `respond(userText, opts)` by constructing CLI-specific
 * args and calling `this.runChild({ binary, args, userText, ... })`, then
 * parsing the returned stdout/stderr per their CLI's output format.
 *
 * NOTE: claude-code and codex were written before this base existed and
 * intentionally remain standalone — their feature surface (stream-json
 * parsing, MCP config, --add-dir, --include-partial-messages, etc.) is
 * deeper than what this base supports. Don't refactor those into this base
 * without a clear motivation.
 */
export abstract class BaseCliBackend implements AgentBackend {
  protected opts!: AgentBackendOpts;
  protected sessionId?: string;
  protected firstTurn = true;
  protected inFlight?: ChildProcess;

  async start(opts: AgentBackendOpts): Promise<void> {
    this.opts = opts;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.firstTurn = !opts.resume;
  }

  reset(): void {
    this.sessionId = randomUUID();
    this.firstTurn = true;
  }

  stop(): void {
    this.cancel();
  }

  cancel(): boolean {
    if (!this.inFlight) return false;
    this.killProcessGroup(this.inFlight);
    return true;
  }

  getBackendId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Resolve the working directory for a spawn. Prefers the dispatcher-assigned
   * per-session cwd (opts.cwd = /tmp/papercup/<id>), then the backend's own
   * `*_WORKDIR` env, then process.cwd() as a last resort. Spawning in the
   * isolated per-session cwd is what lets cwd-keyed CLIs (antigravity, opencode,
   * aider) resume the right conversation and keeps agents out of the
   * dispatcher's own source tree.
   */
  protected resolveCwd(envWorkdir?: string): string {
    return resolveBackendCwd(this.opts.cwd, envWorkdir);
  }

  abstract respond(userText: string, opts?: RespondOptions): Promise<AgentReply>;

  /**
   * Spawn a CLI child detached + tracked, await exit, kill on cancel/timeout.
   *
   * Returns the raw stdout/stderr + exit code; parsing is the subclass's job
   * (each CLI has its own output convention — text, JSON, NDJSON, etc.).
   *
   * Throws:
   *   - "cancelled" if SIGTERM landed (via cancel() or timeout)
   *   - "turn timed out after Ns ..." if PAPERCUP_TURN_TIMEOUT_S elapsed
   *   - "<binary> exited <code>: <stderr>" on non-zero exit
   *
   * Caller passes `userText` so we can store a meaningful command-preview in
   * the registry (helps debugging which prompt produced an orphan).
   */
  protected async runChild(params: {
    binary: string;
    args: string[];
    cwd?: string;
    userText: string;
    stdinText?: string;
    /** Extra env vars merged over process.env for the child (e.g. a backend
     *  injecting OPENCODE_CONFIG). Undefined → inherit process.env unchanged. */
    env?: Record<string, string>;
  }): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
    const { binary, args, cwd = "/tmp", userText, stdinText, env } = params;

    // Per-session cwds (e.g. /tmp/papercup/<id>) may not exist yet — the
    // dispatcher only pre-creates them for the channels/claude-code path.
    // Without this, spawn() throws ENOENT on the chdir. Best-effort: if the
    // dir can't be created we let spawn surface the real error.
    try { mkdirSync(cwd, { recursive: true }); } catch { /* surfaced by spawn */ }

    const t0 = Date.now();
    const proc = spawn(binary, args, {
      stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      cwd,
      detached: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    this.inFlight = proc;
    const childPid = proc.pid;
    if (childPid) {
      await processRegistry.register({
        pid: childPid,
        startedAt: t0,
        sessionId: this.sessionId,
        botPid: process.pid,
        commandPreview: `${binary}: ${makeCommandPreview(userText)}`,
      });
    }

    if (stdinText !== undefined) {
      try {
        proc.stdin?.write(stdinText);
        proc.stdin?.end();
      } catch { /* pipe might already be closed */ }
    }

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

    const timeoutSec = Number(process.env.PAPERCUP_TURN_TIMEOUT_S ?? DEFAULT_TURN_TIMEOUT_S);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 0;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const code = await new Promise<number>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("exit", (c) => resolve(c ?? -1));
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          console.warn(
            `[agent:cli] turn timeout after ${timeoutSec}s — killing pid=${childPid} (${binary})`,
          );
          this.killProcessGroup(proc);
        }, timeoutMs);
      }
    }).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Sweep stragglers the CLI left in its process group after it exits —
      // notably opencode's MCP plugin subprocess, which otherwise orphans and
      // leaks (multi-GB reconnect loop -> OOM on a no-swap host). `proc` is a
      // detached group leader; the leader is dead by now, so SIGTERMing the
      // group only hits leftover descendants. Background processes started via
      // the dispatcher's processManager are NOT in this group, so they survive.
      // Best-effort; ESRCH (empty group) is swallowed by killProcessGroup.
      this.killProcessGroup(proc);
      this.inFlight = undefined;
      if (childPid) void processRegistry.unregister(childPid);
    });

    const elapsedMs = Date.now() - t0;

    if (timedOut) {
      throw new Error(`turn timed out after ${timeoutSec}s (env PAPERCUP_TURN_TIMEOUT_S)`);
    }
    if (code !== 0) {
      if (code === 143 || proc.killed) throw new Error("cancelled");
      throw new Error(`${binary} exited ${code}: ${stderr.slice(0, 500)}`);
    }

    return { stdout, stderr, elapsedMs };
  }

  private killProcessGroup(proc: ChildProcess): void {
    if (!proc.pid) return;
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    }
  }
}

/** Cwd precedence for CLI backends: per-session opts.cwd > `*_WORKDIR` env >
 *  process.cwd(). Pure + exported for unit testing. */
export function resolveBackendCwd(
  optsCwd: string | undefined,
  envWorkdir: string | undefined,
): string {
  return optsCwd ?? envWorkdir ?? process.cwd();
}
