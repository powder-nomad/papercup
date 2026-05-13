import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "discord.js";

const ROSTER_HEADER = "papercup-roster v1";
const DEFAULT_CACHE_PATH = path.join(process.cwd(), "data", "roster-cache.json");

export interface RosterEntry {
  botId: string;
  owner: string;
  workdir: string;
  reactivity: string;
  budget: string;
  publicKey: string;
  fingerprint: string;
  rawMessageId?: string;
  scrapedAt: number;
}

interface CacheFile {
  scrapedAt: number;
  entries: RosterEntry[];
}

let entries = new Map<string, RosterEntry>();
let lastScrapeAt = 0;
let cacheFile = DEFAULT_CACHE_PATH;

export function setCacheFile(file: string): void {
  cacheFile = file;
}

export function list(): RosterEntry[] {
  return [...entries.values()].sort((a, b) => a.botId.localeCompare(b.botId));
}

export function findByBotId(botId: string): RosterEntry | undefined {
  return entries.get(botId);
}

export async function loadCache(file: string = cacheFile): Promise<void> {
  cacheFile = file;
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    entries = new Map();
    for (const e of parsed.entries ?? []) {
      if (e.botId) entries.set(e.botId, e);
    }
    lastScrapeAt = parsed.scrapedAt ?? 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[roster] cache load failed: ${(err as Error).message}`);
    }
  }
}

async function saveCache(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    const data: CacheFile = { scrapedAt: lastScrapeAt, entries: list() };
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, cacheFile);
  } catch (err) {
    console.warn(`[roster] cache save failed: ${(err as Error).message}`);
  }
}

/**
 * Build the announcement text the operator posts (via `/announce`) into the
 * designated #roster channel. The format is plain text in a code block so
 * it's both human-readable and easy to parse on scrape.
 */
export function buildAnnouncement(input: {
  botId: string;
  owner: string;
  workdir: string;
  reactivity: string;
  budget: string;
  publicKey: string;
  fingerprint: string;
}): string {
  return [
    "```",
    ROSTER_HEADER,
    `bot_id: ${input.botId}`,
    `owner: ${input.owner}`,
    `workdir: ${input.workdir}`,
    `reactivity: ${input.reactivity}`,
    `budget: ${input.budget}`,
    `fingerprint: ${input.fingerprint}`,
    `public_key: ${input.publicKey}`,
    "```",
  ].join("\n");
}

function parseAnnouncement(content: string, messageId: string): RosterEntry | undefined {
  if (!content.includes(ROSTER_HEADER)) return undefined;
  const blockMatch = content.match(/```[\s\S]*?```/);
  if (!blockMatch) return undefined;
  const inner = blockMatch[0].replace(/^```\n?/, "").replace(/```$/, "");
  const lines = inner.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.includes(ROSTER_HEADER)) return undefined;

  const pick = (key: string): string | undefined => {
    const ln = lines.find((l) => l.startsWith(`${key}:`));
    if (!ln) return undefined;
    return ln.slice(key.length + 1).trim();
  };
  const botId = pick("bot_id");
  if (!botId) return undefined;
  return {
    botId,
    owner: pick("owner") ?? "(unknown)",
    workdir: pick("workdir") ?? "",
    reactivity: pick("reactivity") ?? "strict",
    budget: pick("budget") ?? "(unset)",
    fingerprint: pick("fingerprint") ?? "",
    publicKey: pick("public_key") ?? "",
    rawMessageId: messageId,
    scrapedAt: Date.now(),
  };
}

export interface ScrapeResult {
  scanned: number;
  parsed: number;
  newOrUpdated: number;
}

/**
 * Re-fetch the designated #roster channel's recent history, parse any
 * papercup-roster v1 announcements, replace the in-memory roster with the
 * latest entry per bot_id.
 */
export async function scrapeChannel(
  client: Client,
  channelId: string,
  limit: number = 100,
): Promise<ScrapeResult> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`channel ${channelId} is not a text-based channel`);
  }
  if (!("messages" in channel)) {
    throw new Error(`channel ${channelId} doesn't expose messages history`);
  }
  const msgs = await (channel as { messages: { fetch: (o: { limit: number }) => Promise<Map<string, { id: string; content: string }>> } })
    .messages.fetch({ limit });
  let scanned = 0;
  let parsed = 0;
  let newOrUpdated = 0;
  const seen = new Map<string, RosterEntry>();
  for (const [, m] of msgs) {
    scanned++;
    const entry = parseAnnouncement(m.content, m.id);
    if (!entry) continue;
    parsed++;
    if (!seen.has(entry.botId)) seen.set(entry.botId, entry);
  }
  for (const [botId, entry] of seen) {
    const old = entries.get(botId);
    if (!old || old.rawMessageId !== entry.rawMessageId) newOrUpdated++;
    entries.set(botId, entry);
  }
  lastScrapeAt = Date.now();
  await saveCache();
  return { scanned, parsed, newOrUpdated };
}

export interface OverlapWarning {
  ourWorkdir: string;
  otherBotId: string;
  otherWorkdir: string;
  reason: "exact" | "we-inside-them" | "they-inside-us";
}

/**
 * Check our declared workdir against every other roster entry. Returns
 * warnings for any overlap (subdirectory in either direction or exact
 * match). Empty array if clean. Per the design note: log warnings only,
 * don't fail boot.
 */
export function checkWorkdirOverlap(ourBotId: string, ourWorkdir: string): OverlapWarning[] {
  if (!ourWorkdir) return [];
  const normalize = (p: string) => path.resolve(p).replace(/\/+$/, "");
  const ours = normalize(ourWorkdir);
  const out: OverlapWarning[] = [];
  for (const entry of entries.values()) {
    if (entry.botId === ourBotId) continue;
    if (!entry.workdir) continue;
    const theirs = normalize(entry.workdir);
    if (theirs === ours) {
      out.push({ ourWorkdir: ours, otherBotId: entry.botId, otherWorkdir: theirs, reason: "exact" });
    } else if (ours.startsWith(theirs + "/")) {
      out.push({ ourWorkdir: ours, otherBotId: entry.botId, otherWorkdir: theirs, reason: "we-inside-them" });
    } else if (theirs.startsWith(ours + "/")) {
      out.push({ ourWorkdir: ours, otherBotId: entry.botId, otherWorkdir: theirs, reason: "they-inside-us" });
    }
  }
  return out;
}

export function getLastScrapeAt(): number { return lastScrapeAt; }
