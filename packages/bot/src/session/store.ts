import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Session = {
  id: string;            // our internal stable handle (UUID)
  name: string;          // human-friendly name (slug)
  createdAt: number;
  lastActiveAt: number;
  /**
   * What the agent backend uses to resume this conversation. For claude-code
   * it's identical to `id`. For codex it's the thread UUID assigned on first
   * turn. Undefined for stateless backends.
   */
  backendId?: string;
  /** Which backend created this session. Used to refuse cross-backend resume. */
  backend?: string;
};

type Persisted = { sessions: Session[] };

const DEFAULT_PATH = path.join(process.cwd(), "data", "sessions.json");

/**
 * On-disk session metadata. Single source of truth for friendly names →
 * backend session IDs. Backend-agnostic: a Session.id can be a Claude Code
 * UUID, an Anthropic-API local-history file, etc. — the backend interprets it.
 */
export class SessionStore {
  private sessions: Session[] = [];
  private readonly file: string;
  private loaded = false;

  constructor(file: string = DEFAULT_PATH) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const data = JSON.parse(raw) as Persisted;
      this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.sessions = [];
      } else {
        console.error("[sessions] load failed; starting fresh:", err);
        this.sessions = [];
      }
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify({ sessions: this.sessions }, null, 2));
    await fs.rename(tmp, this.file);
  }

  list(): Session[] {
    // Most recently active first.
    return [...this.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  findByName(name: string): Session | undefined {
    const slug = slugify(name);
    return this.sessions.find((s) => s.name === slug);
  }

  async create(opts: { name?: string }): Promise<Session> {
    await this.load();
    const id = randomUUID();
    const baseName = opts.name ? slugify(opts.name) : autoName();
    const name = this.uniqueName(baseName);
    const now = Date.now();
    const session: Session = { id, name, createdAt: now, lastActiveAt: now };
    this.sessions.push(session);
    await this.save();
    return session;
  }

  async touch(id: string): Promise<void> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return;
    s.lastActiveAt = Date.now();
    await this.save();
  }

  async setBackendId(id: string, backendId: string, backend?: string): Promise<void> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return;
    if (s.backendId === backendId && s.backend === backend) return;
    s.backendId = backendId;
    if (backend) s.backend = backend;
    await this.save();
  }

  async rename(id: string, newName: string): Promise<Session> {
    await this.load();
    const s = this.sessions.find((s) => s.id === id);
    if (!s) throw new Error(`session ${id} not found`);
    const slug = slugify(newName);
    if (slug.length === 0) throw new Error("name cannot be empty");
    const taken = this.sessions.find((other) => other.id !== id && other.name === slug);
    if (taken) throw new Error(`name "${slug}" is already taken`);
    s.name = slug;
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  private uniqueName(base: string): string {
    if (!this.sessions.find((s) => s.name === base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!this.sessions.find((s) => s.name === candidate)) return candidate;
    }
    // Shouldn't happen; bail with a guaranteed-unique suffix.
    return `${base}-${Date.now()}`;
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

function autoName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  return `call-${yyyy}-${mm}-${dd}-${hh}${mn}`;
}
