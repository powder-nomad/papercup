/**
 * Static model catalog — well-known model → backend mappings used by the
 * /models slash command so an operator can see what to pass to /model
 * without remembering exact ids.
 *
 * Slim port of packages/bot/src/agent/model-catalog.ts. We dropped the
 * live-refresh path (which hit each provider's models endpoint with a 24h
 * cache) — the static map covers the cases the operator actually needs in
 * channels/per-turn UX, and avoiding live calls keeps /models fast and
 * offline-friendly. If you find yourself wanting newer model ids before the
 * static table is updated, you can still /model name:<id> with any string
 * the underlying CLI accepts; this catalog is for discovery, not validation.
 *
 * opencode (opencode-cli / opencode-serve) has curated local-model entries
 * below (ollama ids in "provider/model" form). Backends still not represented
 * here (aider-cli, crush-cli, amp-cli) take whatever model string their CLI
 * accepts via the backend's own env var; /models for those returns a "no
 * curated list" message with a hint.
 */

export type ModelProvider =
  | 'anthropic' | 'openai' | 'google' | 'xai' | 'meta' | 'mistral' | 'deepseek' | 'ollama' | 'other'

export interface ModelInfo {
  id: string
  provider: ModelProvider
  family: string
  /** Which backend driver names accept this model id. */
  backends: string[]
  notes?: string
}

export const STATIC_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-7',            provider: 'anthropic', family: 'claude-opus-4',   backends: ['claude-code', 'anthropic-api'] },
  { id: 'claude-sonnet-4-6',          provider: 'anthropic', family: 'claude-sonnet-4', backends: ['claude-code', 'anthropic-api'] },
  { id: 'claude-haiku-4-5-20251001',  provider: 'anthropic', family: 'claude-haiku-4',  backends: ['claude-code', 'anthropic-api'] },
  { id: 'gpt-5',                       provider: 'openai',   family: 'gpt-5',           backends: ['openai-compat', 'codex'] },
  { id: 'gpt-5-mini',                  provider: 'openai',   family: 'gpt-5',           backends: ['openai-compat'] },
  { id: 'gpt-4.1',                     provider: 'openai',   family: 'gpt-4.1',         backends: ['openai-compat'] },
  { id: 'gpt-4o',                      provider: 'openai',   family: 'gpt-4o',          backends: ['openai-compat'] },
  { id: 'o3',                          provider: 'openai',   family: 'o3',              backends: ['openai-compat'] },
  { id: 'gemini-2.5-pro',              provider: 'google',   family: 'gemini-2.5',      backends: ['gemini-api', 'gemini-cli', 'antigravity-cli'] },
  { id: 'gemini-2.5-flash',            provider: 'google',   family: 'gemini-2.5',      backends: ['gemini-api', 'gemini-cli', 'antigravity-cli'] },
  { id: 'gemini-2.0-flash',            provider: 'google',   family: 'gemini-2.0',      backends: ['gemini-api', 'gemini-cli', 'antigravity-cli'] },
  { id: 'grok-4',                      provider: 'xai',      family: 'grok-4',          backends: ['openai-compat'], notes: 'set OPENAI_COMPAT_BASE_URL=https://api.x.ai/v1' },
  { id: 'llama-3.3-70b',               provider: 'meta',     family: 'llama-3.3',       backends: ['openai-compat'], notes: 'via Groq/Together/Ollama base URL' },
  { id: 'deepseek-v3',                 provider: 'deepseek', family: 'deepseek-v3',     backends: ['openai-compat'] },
  { id: 'mistral-large',               provider: 'mistral',  family: 'mistral-large',   backends: ['openai-compat'] },
  // opencode local models (via ollama). IDs are "providerID/modelID" — the
  // format opencode expects (see parseModel in opencode-serve-backend.ts).
  // These are the operator's local ollama models; edit to match `ollama list`.
  // opencode's agent loop is tool-heavy: e4b is the lightest that still works;
  // 12b/qwen3-14b are more reliable for complex tool orchestration.
  { id: 'ollama/gemma4-e4b',           provider: 'ollama',   family: 'gemma4',          backends: ['opencode-cli', 'opencode-serve'], notes: 'local; lightest, ~8s/turn' },
  { id: 'ollama/gemma4-12b',           provider: 'ollama',   family: 'gemma4',          backends: ['opencode-cli', 'opencode-serve'], notes: 'local; solid tool-use' },
  { id: 'ollama/gemma4-31b',           provider: 'ollama',   family: 'gemma4',          backends: ['opencode-cli', 'opencode-serve'], notes: 'local; largest' },
  { id: 'ollama/qwen3-14b',            provider: 'ollama',   family: 'qwen3',           backends: ['opencode-cli', 'opencode-serve'], notes: 'local; strong tool-caller' },
]

/** Backends covered by the static catalog. Operators using a different
 *  backend (aider-cli, opencode-cli, …) get the "no curated list" message. */
export const KNOWN_BACKENDS: ReadonlySet<string> = new Set(
  STATIC_MODELS.flatMap(m => m.backends),
)

export function listByBackend(backend: string): ModelInfo[] {
  return STATIC_MODELS.filter(m => m.backends.includes(backend))
}
