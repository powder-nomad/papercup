import fs from "node:fs/promises";
import path from "node:path";

export type GuildSettings = {
  /** Channel ID the bot is bound to. Every message there is a prompt. */
  boundTextChannelId?: string;
};

type Persisted = {
  guilds: Record<string, GuildSettings>;
};

const DEFAULT_PATH = path.join(process.cwd(), "data", "guild-config.json");

/**
 * Per-guild runtime settings — bound channel, etc. Edited via slash commands
 * (admin-only). Persists to disk so settings survive bot restarts.
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
    this.loaded = true;
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

  async setBoundChannel(guildId: string, channelId: string): Promise<void> {
    this.guilds[guildId] = { ...this.guilds[guildId], boundTextChannelId: channelId };
    await this.save();
  }

  async clearBoundChannel(guildId: string): Promise<void> {
    if (!this.guilds[guildId]) return;
    delete this.guilds[guildId].boundTextChannelId;
    await this.save();
  }
}
