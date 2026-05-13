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
  /**
   * Per-session model override (e.g. claude-opus-4-7). Falls back to
   * AGENT_MODEL env if undefined. Lets you flip a single session into
   * vibecoding mode without changing global config.
   */
  model?: string;
  /**
   * Speak a short notification through TTS when a spawned extension
   * completes. Default is undefined → off; explicit true/false persists.
   */
  notify?: boolean;
  /**
   * Reasoning-effort hint for the backend. Maps to `--effort` on the
   * Claude Code CLI and to `thinking.budget_tokens` for the direct API
   * backend. minimal | low | medium | high | xhigh | max (Opus only for
   * the top tiers; CLI accepts all).
   */
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * "voice" if the session was created via /pickup mode:voice (default),
   * "text" if mode:text. Stored only for display/resume hints — the actual
   * routing is decided by which container (voice line vs text chat) is
   * active when a message arrives.
   */
  mode?: "voice" | "text";
  /**
   * Tool permission policy for the underlying agent. Maps to claude's
   * `--permission-mode` flag. Default behavior is mode-specific —
   * see resolvePermissionMode() in index.ts.
   */
  permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan";
  /**
   * MCP server names whose tools the agent is allowed to call. Each entry
   * expands to `mcp__<name>__*` in the agent's --allowedTools list. The
   * MCP server itself must be configured in claude's settings or plugins
   * — papercup doesn't register new servers, it just gates tool access.
   */
  allowedMcps?: string[];
  /**
   * Streaming progress UI in Discord during this session's text turns.
   * - "off"     : no progress message, just the final reply (default)
   * - "summary" : single sticky message edited in place; latest activity
   * - "full"    : sticky message + rolling log of last ~8 tool/thinking
   *               events with adjacent-duplicate collapse ("Read ×5")
   * Voice mode ignores this (no Discord channel to post into).
   */
  streaming?: "off" | "summary" | "full";
  /**
   * Multi-bot reactivity (Track 2 Phase 1). Controls whether this bot
   * responds to messages from *other* bots in the same channel.
   * - "strict" (default): ignore other bots unless directly @-mentioned
   * - "loose"           : respond to other bots without @-mention
   * - "chatty"          : same as loose; reserved for future "proactive
   *                       intervention" semantics
   * Human messages are unaffected by this field (existing bound-channel /
   * @-mention rules still apply).
   */
  reactivity?: "strict" | "loose" | "chatty";
  /**
   * Discord channel id this text session is bound to. Set when a session is
   * auto-spawned for a text channel; used to find-and-resume the same session
   * across bot restarts so context survives. Voice sessions don't set this.
   */
  channelId?: string;
};

export type SessionEffort = NonNullable<Session["effort"]>;
export type SessionStreaming = NonNullable<Session["streaming"]>;
export type SessionReactivity = NonNullable<Session["reactivity"]>;

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

  async setModel(id: string, model: string | undefined): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    if (model === undefined || model.trim() === "") {
      delete s.model;
    } else {
      s.model = model.trim();
    }
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  async setNotify(id: string, on: boolean): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    s.notify = on;
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  async setEffort(id: string, effort: SessionEffort | undefined): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    if (effort === undefined) {
      delete s.effort;
    } else {
      s.effort = effort;
    }
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  async setMode(id: string, mode: "voice" | "text"): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    s.mode = mode;
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  async setPermissionMode(
    id: string,
    pm: NonNullable<Session["permissionMode"]> | undefined,
  ): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    if (pm === undefined) {
      delete s.permissionMode;
    } else {
      s.permissionMode = pm;
    }
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  async setBackend(id: string, backend: string | undefined): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    if (backend === undefined) {
      delete s.backend;
    } else {
      s.backend = backend;
    }
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  async setStreaming(
    id: string,
    streaming: SessionStreaming | undefined,
  ): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    if (streaming === undefined) {
      delete s.streaming;
    } else {
      s.streaming = streaming;
    }
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  async setChannelId(id: string, channelId: string | undefined): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    if (channelId === undefined) {
      delete s.channelId;
    } else {
      s.channelId = channelId;
    }
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  /**
   * Return the most-recently-active session bound to `channelId`. Used to
   * resume a text-mode chat across bot restarts so context isn't dropped.
   */
  findLatestForChannel(channelId: string, mode?: "voice" | "text"): Session | undefined {
    return this.sessions
      .filter((s) => s.channelId === channelId && (mode === undefined || s.mode === mode))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  }

  async setReactivity(
    id: string,
    reactivity: SessionReactivity | undefined,
  ): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    if (reactivity === undefined) {
      delete s.reactivity;
    } else {
      s.reactivity = reactivity;
    }
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
  }

  async setAllowedMcps(id: string, mcps: string[]): Promise<Session | undefined> {
    const s = this.sessions.find((s) => s.id === id);
    if (!s) return undefined;
    if (mcps.length === 0) {
      delete s.allowedMcps;
    } else {
      s.allowedMcps = [...new Set(mcps)].sort();
    }
    s.lastActiveAt = Date.now();
    await this.save();
    return s;
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
