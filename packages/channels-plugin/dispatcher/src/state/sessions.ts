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

export type Session = {
  id: string
  name: string
  createdAt: number
  lastActiveAt: number
  channelId?: string
  model?: string
  effort?: SessionEffort
  permissionMode?: SessionPermissionMode
}

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
      this.sessions = Array.isArray(data.sessions) ? data.sessions : []
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

  async create(opts: { name?: string; channelId?: string }): Promise<Session> {
    await this.load()
    const id = randomUUID()
    const baseName = opts.name ? slugify(opts.name) : autoName()
    const name = this.uniqueName(baseName)
    const now = Date.now()
    const session: Session = {
      id, name, createdAt: now, lastActiveAt: now,
      ...(opts.channelId ? { channelId: opts.channelId } : {}),
    }
    this.sessions.push(session)
    await this.save()
    return session
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
