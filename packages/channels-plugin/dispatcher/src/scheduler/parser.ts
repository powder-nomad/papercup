/**
 * Input parsers for the scheduler slash commands.
 *
 *   parseCron(expr, tz)              → iterator that yields next fire instants
 *   parseAtTime(spec, tz, nowEpochMs) → epoch ms for `/queue add at:"..."`
 *
 * `at:` syntax accepted (DESIGN-scheduler.md §Slash command surface):
 *   - ISO 8601:        "2026-05-27T03:00:00"   (assumes host TZ if no offset)
 *   - 24h clock today: "03:00"                 (next occurrence host-local)
 *   - Relative delta:  "+2h", "+30m", "+1d"
 *
 * DST caveat: cron-parser with `{ tz }` is DST-aware but skips fires in the
 * spring-forward gap. Accepted for F1 — documented in README.
 */

import { CronExpressionParser } from 'cron-parser'

export type ParsedCron = {
  expr: string
  tz: string
  /** Next fire instant strictly after `afterEpochMs`, in UTC epoch ms. */
  nextAfter(afterEpochMs: number): number
}

export type ParseError = { error: string }

export function isParseError(v: unknown): v is ParseError {
  return typeof v === 'object' && v !== null && 'error' in v
}

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000 // 30d

/** Returns ParsedCron or a ParseError describing why the expression is bad. */
export function parseCron(expr: string, tz: string): ParsedCron | ParseError {
  const trimmed = expr.trim()
  if (!trimmed) return { error: 'cron expression is empty' }
  try {
    // Validation: throws if the expression is malformed.
    CronExpressionParser.parse(trimmed, { tz })
  } catch (e) {
    return { error: `invalid cron expression: ${(e as Error).message}` }
  }
  return {
    expr: trimmed,
    tz,
    nextAfter(afterEpochMs: number): number {
      const it = CronExpressionParser.parse(trimmed, {
        tz,
        currentDate: new Date(afterEpochMs),
      })
      return it.next().getTime()
    },
  }
}

/** Resolves an `at:` spec to a UTC epoch ms instant strictly in the future. */
export function parseAtTime(
  spec: string,
  tz: string,
  nowEpochMs: number,
): number | ParseError {
  const trimmed = spec.trim()
  if (!trimmed) return { error: 'time spec is empty' }

  // Branch 1: relative duration ("+2h", "+30m", "+1d")
  if (trimmed.startsWith('+')) {
    const dur = parseDuration(trimmed)
    if (isParseError(dur)) return dur
    return nowEpochMs + dur
  }

  // Branch 2: 24h clock ("03:00", "23:45") — next occurrence in target tz.
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (hhmm) {
    const hour = Number(hhmm[1])
    const minute = Number(hhmm[2])
    if (hour < 0 || hour > 23) return { error: `hour out of range: ${hour}` }
    if (minute < 0 || minute > 59) return { error: `minute out of range: ${minute}` }
    // Use cron-parser with a one-shot expression "M H * * *" and tz so we get
    // the next occurrence strictly after `nowEpochMs` in the requested zone.
    const it = CronExpressionParser.parse(`${minute} ${hour} * * *`, {
      tz,
      currentDate: new Date(nowEpochMs),
    })
    return it.next().getTime()
  }

  // Branch 3: ISO 8601 (with or without offset). If no offset present, JS
  // interprets the string as host-local, which matches the design intent.
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    return { error: `unrecognized time format: "${trimmed}" (expected +<n><m|h|d>, HH:mm, or ISO 8601)` }
  }
  if (parsed <= nowEpochMs) {
    return { error: `time is in the past: ${trimmed}` }
  }
  return parsed
}

/** "+2h" / "+30m" / "+1d" → milliseconds. Returns ParseError on bad input. */
export function parseDuration(spec: string): number | ParseError {
  const m = /^\+(\d+)(m|h|d)$/.exec(spec.trim())
  if (!m) {
    return { error: `invalid duration: "${spec}" (expected +<n><m|h|d>)` }
  }
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `duration must be positive: ${spec}` }
  }
  const unit = m[2]
  const ms =
    unit === 'm' ? n * 60_000 :
    unit === 'h' ? n * 60 * 60_000 :
                   n * 24 * 60 * 60_000
  if (ms > MAX_DURATION_MS) {
    return { error: `duration exceeds 30d cap: ${spec}` }
  }
  return ms
}

/** Host IANA TZ via Intl.DateTimeFormat. Pure helper, safe to call now. */
export function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * Display label per design preference: `KST(UTC+9)` style, never IANA in UI.
 * Falls back to `UTC±H` if the locale doesn't expose a usable short abbrev.
 *
 * `atEpochMs` lets the caller anchor the offset to a specific instant (matters
 * for zones with DST — the offset varies across the year). Defaults to now.
 */
export function formatTimezoneLabel(tz: string, atEpochMs: number = Date.now()): string {
  const at = new Date(atEpochMs)
  const offsetLabel = `UTC${formatOffset(tz, at)}`
  const abbrev = shortName(tz, at)
  return abbrev && abbrev !== tz ? `${abbrev}(${offsetLabel})` : offsetLabel
}

function shortName(tz: string, at: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    }).formatToParts(at)
    const token = parts.find(p => p.type === 'timeZoneName')?.value ?? null
    if (!token) return null
    // Reject GMT±H / UTC±H — those duplicate offsetLabel.
    if (/^(GMT|UTC)([+-]\d|$)/i.test(token)) return null
    return token
  } catch {
    return null
  }
}

function formatOffset(tz: string, at: Date): string {
  // Get tz-local wall-clock time as parts, reconstruct a UTC date with those
  // values, and diff against the actual UTC instant to derive the offset.
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts = Object.fromEntries(
      dtf.formatToParts(at).map(p => [p.type, p.value]),
    ) as Record<string, string>
    const wall = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour === '24' ? '0' : parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    const offsetMin = Math.round((wall - at.getTime()) / 60_000)
    const sign = offsetMin >= 0 ? '+' : '-'
    const abs = Math.abs(offsetMin)
    const h = Math.floor(abs / 60)
    const m = abs % 60
    return m === 0 ? `${sign}${h}` : `${sign}${h}:${String(m).padStart(2, '0')}`
  } catch {
    return '+0'
  }
}
