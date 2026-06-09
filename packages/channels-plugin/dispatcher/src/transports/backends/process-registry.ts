import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_PATH = path.join(process.cwd(), "data", "process-registry.json");
const COMMAND_PREVIEW_MAX = 120;

export interface RegistryEntry {
  pid: number;
  startedAt: number;
  sessionId?: string;
  botPid: number;
  commandPreview: string;
}

interface RegistryFile {
  entries: RegistryEntry[];
}

/**
 * Persistent registry of `claude -p` child PIDs the bot has spawned.
 *
 * Used for two things:
 *   1. Showing the operator what's currently in flight (foreground turn
 *      processes, not the long-running background extensions).
 *   2. Reaping orphans on boot — children of a previous bot incarnation
 *      that survived a restart (e.g., process detached from the parent
 *      pipe loop, then the bot was restarted, leaving claude alive but
 *      orphaned).
 *
 * Crucial safety property: the reaper only ever touches PIDs that were
 * explicitly recorded in this file by an earlier bot run. It never scans
 * for `claude -p` processes globally — that would risk killing other
 * users' or unrelated agents' claude sessions on the same box.
 */
export class ProcessRegistry {
  private entries = new Map<number, RegistryEntry>();
  private file = DEFAULT_PATH;
  private writeChain: Promise<void> = Promise.resolve();

  async load(file: string = DEFAULT_PATH): Promise<void> {
    this.file = file;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as RegistryFile;
      this.entries.clear();
      for (const e of parsed.entries ?? []) {
        if (typeof e?.pid === "number") this.entries.set(e.pid, e);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[process-registry] load failed: ${(err as Error).message}`);
      }
    }
  }

  async register(entry: RegistryEntry): Promise<void> {
    this.entries.set(entry.pid, entry);
    await this.queueSave();
  }

  async unregister(pid: number): Promise<void> {
    if (!this.entries.has(pid)) return;
    this.entries.delete(pid);
    await this.queueSave();
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Find PIDs from previous bot incarnations and SIGTERM them.
   *
   * Safety: only entries whose `botPid !== currentBotPid` are considered.
   * For each survivor candidate, we additionally verify `/proc/<pid>/cmdline`
   * still names a `claude` invocation before sending a signal — this guards
   * against PID reuse where some unrelated process happens to occupy a
   * recycled PID.
   */
  async reapOrphans(currentBotPid: number): Promise<{
    killed: number[];
    alreadyDead: number[];
    skipped: { pid: number; reason: string }[];
  }> {
    const killed: number[] = [];
    const alreadyDead: number[] = [];
    const skipped: { pid: number; reason: string }[] = [];

    for (const entry of [...this.entries.values()]) {
      if (entry.botPid === currentBotPid) continue;
      if (!isAlive(entry.pid)) {
        alreadyDead.push(entry.pid);
        this.entries.delete(entry.pid);
        continue;
      }
      const verified = await verifyCmdline(entry.pid);
      if (!verified) {
        skipped.push({
          pid: entry.pid,
          reason: "cmdline does not look like claude — possible PID reuse",
        });
        this.entries.delete(entry.pid);
        continue;
      }
      try {
        process.kill(-entry.pid, "SIGTERM");
      } catch {
        try { process.kill(entry.pid, "SIGTERM"); } catch { /* gone */ }
      }
      killed.push(entry.pid);
      this.entries.delete(entry.pid);
    }

    if (killed.length || alreadyDead.length || skipped.length) {
      await this.queueSave();
    }
    return { killed, alreadyDead, skipped };
  }

  private async queueSave(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.save()).catch((err) => {
      console.error(`[process-registry] save failed: ${(err as Error).message}`);
    });
    return this.writeChain;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const data: RegistryFile = { entries: [...this.entries.values()] };
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, this.file);
  }
}

export function makeCommandPreview(userText: string): string {
  const collapsed = userText.replace(/\s+/g, " ").trim();
  if (collapsed.length <= COMMAND_PREVIEW_MAX) return collapsed;
  return collapsed.slice(0, COMMAND_PREVIEW_MAX - 1) + "…";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Binary names we might have spawned. The cmdline check guards against PID
 * reuse — if `/proc/<pid>/cmdline` no longer names one of these, the PID was
 * recycled and we must not signal it.
 */
const KNOWN_BINARIES = ["claude", "codex", "agy", "gemini", "aider", "opencode", "crush", "amp"];

async function verifyCmdline(pid: number): Promise<boolean> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return KNOWN_BINARIES.some(b => raw.includes(b));
  } catch {
    return false;
  }
}

export const processRegistry = new ProcessRegistry();
