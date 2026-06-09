/**
 * Channel-mode session metadata store. Pruned port of
 * `packages/bot/src/session/store.ts` (the existing bot's per-turn-spawn flavor).
 *
 * Differences from the bot's SessionStore:
 *   - `id` IS the claude session UUID. No backend abstraction layer.
 *   - No `mode`, `notify`, `streaming`, `reactivity`, `allowedMcps`, `backend*` —
 *     those concepts don't apply to a single-backend channel-mode bot.
 *   - `channelId` is treated as a first-class field; Phase 2's whole point is
 *     binding sessions to channels.
 *
 * Persistence: $PAPERCUP_HOME/sessions.json. Atomic writes via tmp+rename.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type SessionEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type SessionPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'

/**
 * How this session is driven. See transports/types.ts for details.
 *   - "channels"  : long-lived `claude --channels` child + MCP plugin (default)
 *   - "per-turn"  : `claude -p` spawned per turn, mid-turn interrupt-and-merge
 *
 * Legacy sessions (pre-transport-refactor) get "channels" on load to preserve
 * existing behavior.
 */
export type SessionTransportName = 'channels' | 'per-turn'

export type Session = {
  id: string
  name: string
  createdAt: number
  lastActiveAt: number
  channelId?: string
  model?: string
  effort?: SessionEffort
  permissionMode?: SessionPermissionMode
  /** Drives which SessionTransport the dispatcher uses. */
  transport: SessionTransportName
  /** Underlying agent CLI/backend. "claude-code" is the only one shipped today;
   *  future per-turn backends (codex, gemini-cli, …) will register here. */
  backend: string
  /**
   * Working directory claude is spawned in for this session. New sessions get
   * an isolated per-session dir (/tmp/papercup/<id>) so each session has its
   * own claude project memory and can't see sibling sessions' scratch files.
   * Legacy sessions created before this field default to the shared /tmp (see
   * cwdFor) to preserve their existing on-disk transcript continuity.
   */
  cwd?: string
  /**
   * Set true once this session has produced at least one reply (so claude has
   * written a transcript worth resuming). Drives --resume detection
   * independently of claude's on-disk transcript path, which has changed
   * across versions. Informational backstop to claudeSessionPersisted.
   */
  resumable?: boolean
}

/** Default cwd for sessions that predate the per-session-cwd field. */
export const LEGACY_SHARED_CWD = '/tmp'

/** Resolve the working directory for a session, defaulting legacy records to
 *  the shared /tmp so their existing claude transcripts keep resolving. */
export function cwdFor(s: Session): string {
  return s.cwd ?? LEGACY_SHARED_CWD
}

const DEFAULT_TRANSPORT: SessionTransportName = 'channels'
const DEFAULT_BACKEND = 'claude-code'

type Persisted = { sessions: Session[] }

export class SessionStore {
  private sessions: Session[] = []
  private loaded = false
  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const data = JSON.parse(raw) as Persisted
      const rows = Array.isArray(data.sessions) ? data.sessions : []
      // Migrate legacy records: pre-transport-refactor entries lack
      // transport/backend. Default them to channels + claude-code so
      // existing bindings keep working.
      this.sessions = rows.map(s => ({
        ...s,
        transport: (s.transport as SessionTransportName) ?? DEFAULT_TRANSPORT,
        backend: s.backend ?? DEFAULT_BACKEND,
      }))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sessions = []
      } else {
        console.error('[sessions] load failed; starting fresh:', err)
        this.sessions = []
      }
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ sessions: this.sessions }, null, 2), { mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  list(): Session[] {
    return [...this.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  findById(id: string): Session | undefined {
    return this.sessions.find(s => s.id === id)
  }

  findByName(name: string): Session | undefined {
    const slug = slugify(name)
    return this.sessions.find(s => s.name === slug)
  }

  findLatestForChannel(channelId: string): Session | undefined {
    return this.sessions
      .filter(s => s.channelId === channelId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  }

  async create(opts: {
    name?: string
    channelId?: string
    transport?: SessionTransportName
    backend?: string
  }): Promise<Session> {
    await this.load()
    const id = randomUUID()
    const baseName = opts.name ? slugify(opts.name) : autoName()
    const name = this.uniqueName(baseName)
    const now = Date.now()
    const session: Session = {
      id,
      name,
      createdAt: now,
      lastActiveAt: now,
      transport: opts.transport ?? DEFAULT_TRANSPORT,
      backend: opts.backend ?? DEFAULT_BACKEND,
      // Per-session isolated cwd: each session gets its own claude project dir
      // (~/.claude/projects/-tmp-papercup-<id>/) so transcripts and project
      // memory don't bleed across sessions sharing /tmp.
      cwd: `/tmp/papercup/${id}`,
      ...(opts.channelId ? { channelId: opts.channelId } : {}),
    }
    this.sessions.push(session)
    await this.save()
    return session
  }

  async setTransport(id: string, transport: SessionTransportName): Promise<Session | undefined> {
    const s = this.sessions.find(s => s.id === id)
    if (!s) return undefined
    s.transport = transport
    s.lastActiveAt = Date.now()
    await this.save()
    return s
  }

  async setBackend(id: string, backend: string): Promise<Session | undefined> {
    const s = this.sessions.find(s => s.id === id)
    if (!s) return undefined
    s.backend = backend
    s.lastActiveAt = Date.now()
    await this.save()
    return s
  }

  async touch(id: string): Promise<void> {
    const s = this.sessions.find(s => s.id === id)
    if (!s) return
    s.lastActiveAt = Date.now()
    await this.save()
  }

  async setChannelId(id: string, channelId: string | undefined): Promise<Session | undefined> {
    const s = this.sessions.find(s => s.id === id)
    if (!s) return undefined
    if (channelId === undefined) delete s.channelId
    else s.channelId = channelId
    s.lastActiveAt = Date.now()
    await this.save()
    return s
  }

  async setModel(id: string, model: string | undefined): Promise<Session | undefined> {
    const s = this.sessions.find(s => s.id === id)
    if (!s) return undefined
    if (!model || model.trim() === '') delete s.model
    else s.model = model.trim()
    s.lastActiveAt = Date.now()
    await this.save()
    return s
  }

  async setEffort(id: string, effort: SessionEffort | undefined): Promise<Session | undefined> {
    const s = this.sessions.find(s => s.id === id)
    if (!s) return undefined
    if (effort === undefined) delete s.effort
    else s.effort = effort
    s.lastActiveAt = Date.now()
    await this.save()
    return s
  }

  async setPermissionMode(id: string, pm: SessionPermissionMode | undefined): Promise<Session | undefined> {
    const s = this.sessions.find(s => s.id === id)
    if (!s) return undefined
    if (pm === undefined) delete s.permissionMode
    else s.permissionMode = pm
    s.lastActiveAt = Date.now()
    await this.save()
    return s
  }

  async rename(id: string, newName: string): Promise<Session> {
    await this.load()
    const s = this.sessions.find(s => s.id === id)
    if (!s) throw new Error(`session ${id} not found`)
    const slug = slugify(newName)
    if (slug.length === 0) throw new Error('name cannot be empty')
    const taken = this.sessions.find(other => other.id !== id && other.name === slug)
    if (taken) throw new Error(`name "${slug}" is already taken`)
    s.name = slug
    s.lastActiveAt = Date.now()
    await this.save()
    return s
  }

  /** Mark a session resumable (it has produced a reply → claude wrote a
   *  transcript). Idempotent; no-op if already set. */
  async markResumable(id: string): Promise<void> {
    const s = this.sessions.find(s => s.id === id)
    if (!s || s.resumable) return
    s.resumable = true
    await this.save()
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.sessions.findIndex(s => s.id === id)
    if (idx === -1) return false
    this.sessions.splice(idx, 1)
    await this.save()
    return true
  }

  private uniqueName(base: string): string {
    if (!this.sessions.find(s => s.name === base)) return base
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`
      if (!this.sessions.find(s => s.name === candidate)) return candidate
    }
    return `${base}-${Date.now()}`
  }
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function autoName(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mn = String(d.getMinutes()).padStart(2, '0')
  return `ch-${yyyy}-${mm}-${dd}-${hh}${mn}`
}
