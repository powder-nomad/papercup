import fs from "node:fs/promises";
import path from "node:path";

export type GuildSettings = {
  /**
   * Legacy singleton — kept for backward-compat on read. New code uses
   * `boundChannels`. Migrated into `boundChannels` on first load.
   */
  boundTextChannelId?: string;
  /**
   * Channels the bot listens to without requiring @-mention. Each channel
   * is paired with a session via Session.channelId — see SessionStore.
   */
  boundChannels?: string[];
};

type Persisted = {
  guilds: Record<string, GuildSettings>;
};

const DEFAULT_PATH = path.join(process.cwd(), "data", "guild-config.json");

/**
 * Per-guild runtime settings — bound channels, etc. Edited via slash
 * commands (admin-only). Persists to disk so settings survive bot
 * restarts.
 */
export class GuildConfigStore {
  private guilds: Record<string, GuildSettings> = {};
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
      this.guilds = data.guilds ?? {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.guilds = {};
      } else {
        console.error("[guild-config] load failed; starting fresh:", err);
        this.guilds = {};
      }
    }
    // Migrate legacy boundTextChannelId → boundChannels on first load.
    let mutated = false;
    for (const g of Object.values(this.guilds)) {
      if (g.boundTextChannelId && !g.boundChannels?.includes(g.boundTextChannelId)) {
        g.boundChannels = [...(g.boundChannels ?? []), g.boundTextChannelId];
        delete g.boundTextChannelId;
        mutated = true;
      }
    }
    this.loaded = true;
    if (mutated) await this.save();
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify({ guilds: this.guilds }, null, 2));
    await fs.rename(tmp, this.file);
  }

  get(guildId: string): GuildSettings {
    return this.guilds[guildId] ?? {};
  }

  getBoundChannels(guildId: string): string[] {
    return this.guilds[guildId]?.boundChannels ?? [];
  }

  isBound(guildId: string, channelId: string): boolean {
    return this.getBoundChannels(guildId).includes(channelId);
  }

  async addBoundChannel(guildId: string, channelId: string): Promise<void> {
    const existing = this.guilds[guildId] ?? {};
    const list = new Set(existing.boundChannels ?? []);
    if (list.has(channelId)) return;
    list.add(channelId);
    this.guilds[guildId] = { ...existing, boundChannels: [...list] };
    await this.save();
  }

  async removeBoundChannel(guildId: string, channelId: string): Promise<void> {
    const existing = this.guilds[guildId];
    if (!existing?.boundChannels) return;
    const next = existing.boundChannels.filter((id) => id !== channelId);
    if (next.length === existing.boundChannels.length) return;
    this.guilds[guildId] = { ...existing, boundChannels: next };
    await this.save();
  }
}
