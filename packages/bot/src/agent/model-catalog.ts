import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CACHE_PATH = path.join(process.cwd(), "data", "model-catalog-cache.json");
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelInfo {
  id: string;
  provider: "anthropic" | "openai" | "google" | "xai" | "meta" | "mistral" | "deepseek" | "other";
  family: string;
  backends: string[];
  notes?: string;
}

interface CacheFile {
  refreshedAt: number;
  byProvider: Record<string, ModelInfo[]>;
}

/**
 * Static defaults — well-known model→backend mappings the bot can answer with
 * even when no API keys are configured. Live `refreshLiveCatalog()` merges
 * additional entries fetched from each provider's models endpoint.
 *
 * Note on CLI vs API: when a model lists *both* a CLI agent and an API
 * backend (e.g. claude-opus-4-7 → ["claude-code","anthropic-api"]), the user
 * picks the surface via `/backend`. CLI-only models stay CLI-only; API-only
 * models stay API-only.
 */
export const STATIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-7",            provider: "anthropic", family: "claude-opus-4",   backends: ["claude-code", "anthropic-api"] },
  { id: "claude-sonnet-4-6",          provider: "anthropic", family: "claude-sonnet-4", backends: ["claude-code", "anthropic-api"] },
  { id: "claude-haiku-4-5-20251001",  provider: "anthropic", family: "claude-haiku-4",  backends: ["claude-code", "anthropic-api"] },
  { id: "gpt-5",                       provider: "openai",   family: "gpt-5",           backends: ["openai-compat", "codex"] },
  { id: "gpt-5-mini",                  provider: "openai",   family: "gpt-5",           backends: ["openai-compat"] },
  { id: "gpt-4.1",                     provider: "openai",   family: "gpt-4.1",         backends: ["openai-compat"] },
  { id: "gpt-4o",                      provider: "openai",   family: "gpt-4o",          backends: ["openai-compat"] },
  { id: "o3",                          provider: "openai",   family: "o3",              backends: ["openai-compat"] },
  { id: "gemini-2.5-pro",              provider: "google",   family: "gemini-2.5",      backends: ["gemini-api", "gemini-cli"] },
  { id: "gemini-2.5-flash",            provider: "google",   family: "gemini-2.5",      backends: ["gemini-api", "gemini-cli"] },
  { id: "gemini-2.0-flash",            provider: "google",   family: "gemini-2.0",      backends: ["gemini-api", "gemini-cli"] },
  { id: "grok-4",                      provider: "xai",      family: "grok-4",          backends: ["openai-compat"], notes: "set OPENAI_COMPAT_BASE_URL=https://api.x.ai/v1" },
  { id: "llama-3.3-70b",               provider: "meta",     family: "llama-3.3",       backends: ["openai-compat"], notes: "via Groq/Together/Ollama base URL" },
  { id: "deepseek-v3",                 provider: "deepseek", family: "deepseek-v3",     backends: ["openai-compat"] },
  { id: "mistral-large",               provider: "mistral",  family: "mistral-large",   backends: ["openai-compat"] },
];

let liveByProvider: Record<string, ModelInfo[]> = {};
let lastRefreshAt = 0;

export function list(): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const m of STATIC_MODELS) {
    if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
  }
  for (const arr of Object.values(liveByProvider)) {
    for (const m of arr) {
      if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
  }
  return out;
}

export function listByProvider(): Record<string, ModelInfo[]> {
  const by: Record<string, ModelInfo[]> = {};
  for (const m of list()) {
    (by[m.provider] ??= []).push(m);
  }
  return by;
}

export function findModel(id: string): ModelInfo | undefined {
  return list().find((m) => m.id === id);
}

export function suggestBackendForModel(id: string, currentBackend: string): string | undefined {
  const m = findModel(id);
  if (!m) return undefined;
  if (m.backends.includes(currentBackend)) return currentBackend;
  return m.backends[0];
}

export async function loadCache(file: string = DEFAULT_CACHE_PATH): Promise<void> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (typeof parsed?.refreshedAt === "number" && parsed.byProvider) {
      lastRefreshAt = parsed.refreshedAt;
      liveByProvider = parsed.byProvider;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[model-catalog] cache load failed: ${(err as Error).message}`);
    }
  }
}

export function cacheAge(): number {
  return Date.now() - lastRefreshAt;
}

export function isCacheFresh(): boolean {
  return lastRefreshAt > 0 && cacheAge() < REFRESH_TTL_MS;
}

/**
 * Fetch each provider's models endpoint (using available API keys). Best-effort:
 * each provider succeeds or fails independently. Updates the in-memory catalog
 * and persists the cache. Returns per-provider {ok, count, error}.
 */
export async function refreshLiveCatalog(
  file: string = DEFAULT_CACHE_PATH,
): Promise<Record<string, { ok: boolean; count: number; error?: string }>> {
  const next: Record<string, ModelInfo[]> = {};
  const status: Record<string, { ok: boolean; count: number; error?: string }> = {};

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const models = await fetchAnthropic();
      next.anthropic = models;
      status.anthropic = { ok: true, count: models.length };
    } catch (err) {
      status.anthropic = { ok: false, count: 0, error: (err as Error).message };
    }
  } else {
    status.anthropic = { ok: false, count: 0, error: "ANTHROPIC_API_KEY not set" };
  }

  const oaiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_COMPAT_API_KEY;
  const oaiBase = process.env.OPENAI_COMPAT_BASE_URL ?? "https://api.openai.com/v1";
  if (oaiKey) {
    try {
      const models = await fetchOpenAiCompat(oaiBase, oaiKey);
      next.openai = models;
      status.openai = { ok: true, count: models.length };
    } catch (err) {
      status.openai = { ok: false, count: 0, error: (err as Error).message };
    }
  } else {
    status.openai = { ok: false, count: 0, error: "OPENAI_API_KEY / OPENAI_COMPAT_API_KEY not set" };
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const models = await fetchGemini();
      next.google = models;
      status.google = { ok: true, count: models.length };
    } catch (err) {
      status.google = { ok: false, count: 0, error: (err as Error).message };
    }
  } else {
    status.google = { ok: false, count: 0, error: "GEMINI_API_KEY not set" };
  }

  liveByProvider = next;
  lastRefreshAt = Date.now();

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const payload: CacheFile = { refreshedAt: lastRefreshAt, byProvider: liveByProvider };
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, file);
  } catch (err) {
    console.warn(`[model-catalog] cache save failed: ${(err as Error).message}`);
  }

  return status;
}

async function fetchAnthropic(): Promise<ModelInfo[]> {
  const resp = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const json = (await resp.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => ({
    id: m.id,
    provider: "anthropic" as const,
    family: familyFromAnthropic(m.id),
    backends: ["claude-code", "anthropic-api"],
  }));
}

async function fetchOpenAiCompat(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) throw new Error(`openai ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const json = (await resp.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => ({
    id: m.id,
    provider: "openai" as const,
    family: familyFromOpenAi(m.id),
    backends: ["openai-compat"],
  }));
}

async function fetchGemini(): Promise<ModelInfo[]> {
  const key = process.env.GEMINI_API_KEY ?? "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const json = (await resp.json()) as { models?: Array<{ name: string }> };
  return (json.models ?? [])
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((id) => id.startsWith("gemini-"))
    .map((id) => ({
      id,
      provider: "google" as const,
      family: id.split("-").slice(0, 2).join("-"),
      backends: ["gemini-api", "gemini-cli"],
    }));
}

function familyFromAnthropic(id: string): string {
  if (id.startsWith("claude-opus")) return "claude-opus";
  if (id.startsWith("claude-sonnet")) return "claude-sonnet";
  if (id.startsWith("claude-haiku")) return "claude-haiku";
  return id;
}

function familyFromOpenAi(id: string): string {
  if (id.startsWith("gpt-5")) return "gpt-5";
  if (id.startsWith("gpt-4.1")) return "gpt-4.1";
  if (id.startsWith("gpt-4o")) return "gpt-4o";
  if (id.startsWith("gpt-4")) return "gpt-4";
  if (id.startsWith("o3")) return "o3";
  if (id.startsWith("o1")) return "o1";
  return id;
}
