/**
 * Context-pressure policy: how full is a session and what should we do about it.
 *
 * Three tiers, all relative to the model's context window:
 *   - warn          (default 70%): Discord notice "session is filling up"
 *   - danger        (default 85%): louder notice + recommend /compact
 *   - auto-compact  (default 92%): fork-and-summarize fires automatically
 *
 * Pure functions only — no I/O, no Discord. The dispatcher wires this to
 * `onTurnComplete` and a boot-time transcript scan.
 *
 * Why percentages, not absolute token counts: 150k tokens on a 200k window is
 * 75% (sensible), but on a 1M window is 15% (useless noise). Absolute floors
 * still work via PAPERCUP_CONTEXT_WARN_TOKENS / PAPERCUP_CONTEXT_DANGER_TOKENS
 * (lower-of-the-two wins) for operators who want hard caps.
 */

const WINDOW_1M_TOKENS = 1_000_000
const WINDOW_200K_TOKENS = 200_000

export const DEFAULT_WARN_PCT = 70
export const DEFAULT_DANGER_PCT = 85
export const DEFAULT_AUTO_COMPACT_PCT = 92

/** What the dispatcher should do about a session at its current usage. */
export type CompactPolicyMode = 'off' | 'warn-only' | 'auto'

export const DEFAULT_POLICY_MODE: CompactPolicyMode = 'auto'

export type PolicyConfig = {
  warnPct: number
  dangerPct: number
  autoCompactPct: number
  /** If set, an absolute lower-bound: warn fires no later than this many
   *  input tokens regardless of percent. Useful when you want a hard cap
   *  on a 1M-window session. */
  legacyAbsWarn?: number
  legacyAbsDanger?: number
}

export const DEFAULT_POLICY: PolicyConfig = {
  warnPct: DEFAULT_WARN_PCT,
  dangerPct: DEFAULT_DANGER_PCT,
  autoCompactPct: DEFAULT_AUTO_COMPACT_PCT,
}

export type Thresholds = {
  windowTokens: number
  warnTokens: number
  dangerTokens: number
  autoCompactTokens: number
}

export type Tier = 'safe' | 'warn' | 'danger' | 'auto-compact'

/**
 * Detect the conversation's context window from the model string. Claude Code
 * model names are short-hand: "opus", "sonnet", "haiku", "claude-opus-4-7",
 * and the operator-tagged 1M variants like "claude-opus-4-7[1m]".
 *
 * Heuristic, in priority order:
 *   1. Explicit "[1m]" / "-1m" / "_1m" suffix -> 1M.
 *   2. Sonnet 4.x -> 1M (native window per Anthropic model card).
 *   3. Anything else -> 200k.
 */
export function resolveContextWindowTokens(model: string | undefined): number {
  if (!model) return WINDOW_200K_TOKENS
  if (/\[1m\]|[-_]1m\b/i.test(model)) return WINDOW_1M_TOKENS
  if (/sonnet[-_]?4/i.test(model)) return WINDOW_1M_TOKENS
  return WINDOW_200K_TOKENS
}

export function computeThresholds(
  model: string | undefined,
  config: PolicyConfig = DEFAULT_POLICY,
): Thresholds {
  const windowTokens = resolveContextWindowTokens(model)
  const pct = (p: number): number => Math.round((windowTokens * clampPct(p)) / 100)
  const warnFromPct = pct(config.warnPct)
  const dangerFromPct = pct(config.dangerPct)
  return {
    windowTokens,
    warnTokens: config.legacyAbsWarn !== undefined
      ? Math.min(warnFromPct, config.legacyAbsWarn)
      : warnFromPct,
    dangerTokens: config.legacyAbsDanger !== undefined
      ? Math.min(dangerFromPct, config.legacyAbsDanger)
      : dangerFromPct,
    autoCompactTokens: pct(config.autoCompactPct),
  }
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  return n
}

export function classifyUsage(inputTokens: number, t: Thresholds): Tier {
  if (inputTokens >= t.autoCompactTokens) return 'auto-compact'
  if (inputTokens >= t.dangerTokens) return 'danger'
  if (inputTokens >= t.warnTokens) return 'warn'
  return 'safe'
}

export function usagePercent(inputTokens: number, t: Thresholds): number {
  if (t.windowTokens <= 0) return 0
  return Math.round((inputTokens / t.windowTokens) * 1000) / 10
}

/**
 * Estimate token count from raw transcript byte size. Used at boot to detect
 * sessions that are already near-limit BEFORE the user sends their next
 * message. Conservative: 4 bytes/token is the rough Claude tokenizer ratio
 * for English JSON, so this slightly over-estimates (early-fires auto-compact
 * — fine).
 */
export function estimateTokensFromBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.round(bytes / 4)
}

/**
 * Read PAPERCUP_* env overrides. Anything missing or non-numeric falls back
 * to the default. Only the legacy absolute floors are opt-in (presence-checked
 * separately from numeric validity).
 */
export function loadPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const num = (key: string, fallback: number): number => {
    const v = env[key]
    if (v === undefined || v.trim() === '') return fallback
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  const config: PolicyConfig = {
    warnPct: num('PAPERCUP_CONTEXT_WARN_PCT', DEFAULT_WARN_PCT),
    dangerPct: num('PAPERCUP_CONTEXT_DANGER_PCT', DEFAULT_DANGER_PCT),
    autoCompactPct: num('PAPERCUP_AUTOCOMPACT_PCT', DEFAULT_AUTO_COMPACT_PCT),
  }
  const absWarn = env.PAPERCUP_CONTEXT_WARN_TOKENS
  if (absWarn !== undefined && absWarn.trim() !== '') {
    const n = Number(absWarn)
    if (Number.isFinite(n) && n > 0) config.legacyAbsWarn = n
  }
  const absDanger = env.PAPERCUP_CONTEXT_DANGER_TOKENS
  if (absDanger !== undefined && absDanger.trim() !== '') {
    const n = Number(absDanger)
    if (Number.isFinite(n) && n > 0) config.legacyAbsDanger = n
  }
  return config
}

export function resolvePolicyMode(env: NodeJS.ProcessEnv = process.env): CompactPolicyMode {
  const raw = (env.PAPERCUP_COMPACT_POLICY ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === 'warn-only' || raw === 'auto') return raw
  return DEFAULT_POLICY_MODE
}
