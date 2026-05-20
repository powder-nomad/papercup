/**
 * Per-guild runtime settings. Verbatim port of
 * `packages/bot/src/config/guild-config.ts` with the legacy
 * `boundTextChannelId` migration removed (no legacy data for channels-plugin).
 *
 * Persistence: $PAPERCUP_HOME/guild-config.json.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

export type GuildSettings = {
  boundChannels?: string[]
}

type Persisted = {
  guilds: Record<string, GuildSettings>
}

export class GuildConfigStore {
  private guilds: Record<string, GuildSettings> = {}
  private loaded = false
  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const data = JSON.parse(raw) as Persisted
      this.guilds = data.guilds ?? {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.guilds = {}
      } else {
        console.error('[guild-config] load failed; starting fresh:', err)
        this.guilds = {}
      }
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ guilds: this.guilds }, null, 2), { mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  get(guildId: string): GuildSettings {
    return this.guilds[guildId] ?? {}
  }

  getBoundChannels(guildId: string): string[] {
    return this.guilds[guildId]?.boundChannels ?? []
  }

  isBound(guildId: string, channelId: string): boolean {
    return this.getBoundChannels(guildId).includes(channelId)
  }

  /** Channel-only lookup, no guildId needed — covers DMs and bot-restart cases. */
  isBoundAnyGuild(channelId: string): boolean {
    for (const g of Object.values(this.guilds)) {
      if (g.boundChannels?.includes(channelId)) return true
    }
    return false
  }

  async addBoundChannel(guildId: string, channelId: string): Promise<void> {
    const existing = this.guilds[guildId] ?? {}
    const list = new Set(existing.boundChannels ?? [])
    if (list.has(channelId)) return
    list.add(channelId)
    this.guilds[guildId] = { ...existing, boundChannels: [...list] }
    await this.save()
  }

  async removeBoundChannel(guildId: string, channelId: string): Promise<void> {
    const existing = this.guilds[guildId]
    if (!existing?.boundChannels) return
    const next = existing.boundChannels.filter(id => id !== channelId)
    if (next.length === existing.boundChannels.length) return
    this.guilds[guildId] = { ...existing, boundChannels: next }
    await this.save()
  }
}
