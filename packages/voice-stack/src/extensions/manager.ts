import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

export type ExtensionStatus = "running" | "completed" | "failed" | "interrupted";

export type Extension = {
  id: string;
  name: string;             // friendly slug
  task: string;             // the user's request as given
  status: ExtensionStatus;
  dir: string;              // sandbox cwd
  pid?: number;
  startedAt: number;
  finishedAt?: number;
  summary?: string;         // final assistant text
  error?: string;
  costUsd?: number;
  durationMs?: number;
};

type Persisted = { extensions: Extension[] };

const BASE_DIR = path.join(process.cwd(), "data", "extensions");
const STORE_PATH = path.join(process.cwd(), "data", "extensions.json");

/**
 * Spawns and tracks background Claude Code processes. Each extension lives in
 * its own sandbox dir under data/extensions/<id>/. Bot-process-bound: if the
 * bot dies, in-flight extensions die too (marked "interrupted" on next boot).
 *
 * Events:
 *  - "settled" → (ext: Extension) — fired when an extension exits the
 *    "running" state (status becomes completed | failed | interrupted).
 *    Used by the bot to optionally TTS-announce completion to the user.
 */
export class ExtensionManager extends EventEmitter {
  private extensions = new Map<string, Extension>();
  private procs = new Map<string, ChildProcess>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(STORE_PATH, "utf8");
      const data = JSON.parse(raw) as Persisted;
      for (const e of data.extensions ?? []) {
        // Anything still marked "running" from a prior bot run is dead.
        if (e.status === "running") {
          e.status = "interrupted";
          e.finishedAt = e.finishedAt ?? Date.now();
        }
        this.extensions.set(e.id, e);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[extensions] load failed; starting fresh:", err);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    const tmp = STORE_PATH + ".tmp";
    const data: Persisted = { extensions: [...this.extensions.values()] };
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, STORE_PATH);
  }

  async spawn(opts: { task: string; name?: string }): Promise<Extension> {
    await this.load();
    const id = randomUUID().slice(0, 8);
    const name = opts.name ? slugify(opts.name) : `ext-${id}`;
    const dir = path.join(BASE_DIR, id);
    await fs.mkdir(dir, { recursive: true });

    const ext: Extension = {
      id,
      name,
      task: opts.task,
      status: "running",
      dir,
      startedAt: Date.now(),
    };
    this.extensions.set(id, ext);
    await this.persist();

    // Extension permission policy. Env-driven so deployments can lock down
    // without code changes. Default stays bypassPermissions (extensions run
    // unattended; default/acceptEdits would hang on dangerous tools), but
    // users can flip to default/acceptEdits and combine with hand-picked
    // ALLOWED/DISALLOWED tool lists for tighter control.
    const permMode = process.env.EXTENSION_PERMISSION_MODE ?? "bypassPermissions";
    const allowedTools = process.env.EXTENSION_ALLOWED_TOOLS?.trim() || "default";
    const disallowedTools = process.env.EXTENSION_DISALLOWED_TOOLS?.trim();

    const args: string[] = [
      "-p", opts.task,
      "--output-format", "json",
      "--permission-mode", permMode,
      // Scope: extension's own sandbox dir. Useful when permMode != bypass —
      // claude rejects writes outside the dir + cwd unless --add-dir is set.
      "--add-dir", dir,
      "--allowedTools", allowedTools,
    ];
    if (disallowedTools) {
      args.push("--disallowedTools", disallowedTools);
    }

    console.log(`[ext ${id}] spawning in ${dir}: "${opts.task.slice(0, 60)}${opts.task.length > 60 ? "…" : ""}"`);
    const proc = spawn("claude", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.procs.set(id, proc);
    ext.pid = proc.pid;

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    proc.on("error", (err) => {
      console.error(`[ext ${id}] spawn error:`, err);
      ext.status = "failed";
      ext.error = err.message;
      ext.finishedAt = Date.now();
      this.procs.delete(id);
      void this.persist();
      this.emit("settled", ext);
    });

    proc.on("exit", (code) => {
      ext.finishedAt = Date.now();
      ext.durationMs = ext.finishedAt - ext.startedAt;
      this.procs.delete(id);

      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          ext.summary = String(parsed.result ?? "").trim();
          ext.costUsd = parsed.total_cost_usd;
          ext.status = "completed";
        } catch {
          ext.summary = stdout.trim().slice(0, 4000);
          ext.status = "completed";
        }
      } else {
        ext.status = "failed";
        ext.error = (stderr || stdout).slice(-2000);
      }
      console.log(`[ext ${id}] ${ext.status} in ${ext.durationMs}ms`);
      void this.persist();
      this.emit("settled", ext);
    });

    return ext;
  }

  get(id: string): Extension | undefined {
    return this.extensions.get(id);
  }

  /** Tolerant lookup — accepts either id or name. */
  find(idOrName: string): Extension | undefined {
    if (this.extensions.has(idOrName)) return this.extensions.get(idOrName);
    const slug = slugify(idOrName);
    return [...this.extensions.values()].find((e) => e.name === slug);
  }

  list(opts: { limit?: number } = {}): Extension[] {
    const arr = [...this.extensions.values()].sort((a, b) => b.startedAt - a.startedAt);
    return opts.limit ? arr.slice(0, opts.limit) : arr;
  }

  killAll(): void {
    for (const proc of this.procs.values()) {
      try { proc.kill(); } catch { /* already dead */ }
    }
  }
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
