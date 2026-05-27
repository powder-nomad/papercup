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

export type ParsedCron = {
  expr: string
  tz: string
  /** Next fire instant strictly after `afterEpochMs`, in UTC epoch ms. */
  nextAfter(afterEpochMs: number): number
}

export type ParseError = { error: string }

/** Returns ParsedCron or a ParseError describing why the expression is bad. */
export function parseCron(_expr: string, _tz: string): ParsedCron | ParseError {
  // TODO(task #4): wrap cron-parser CronExpressionParser.parse with { tz },
  // exposing nextAfter() via iterator reset semantics.
  return { error: 'parseCron: not implemented yet — see task #4' }
}

/** Resolves an `at:` spec to a UTC epoch ms instant strictly in the future. */
export function parseAtTime(
  _spec: string,
  _tz: string,
  _nowEpochMs: number,
): number | ParseError {
  // TODO(task #4): three branches:
  //   - starts with '+' → parseDuration → now + delta
  //   - matches /^\d{1,2}:\d{2}$/ → next occurrence of HH:mm in tz
  //   - else → Date.parse + tz fallback
  return { error: 'parseAtTime: not implemented yet — see task #4' }
}

/** "+2h" / "+30m" / "+1d" → milliseconds. Returns ParseError on bad input. */
export function parseDuration(_spec: string): number | ParseError {
  // TODO(task #4): allowed units = m | h | d. Reject negatives, fractional,
  // and 0. Cap at 30d to avoid pathological queues (configurable later).
  return { error: 'parseDuration: not implemented yet — see task #4' }
}

/** Host IANA TZ via Intl.DateTimeFormat. Pure helper, safe to call now. */
export function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * Display label per design preference: `KST(UTC+9)` style, never IANA in UI.
 * Falls back to `UTC±H` if the locale doesn't expose a short abbrev.
 */
export function formatTimezoneLabel(_tz: string, _atEpochMs?: number): string {
  // TODO(task #4): use Intl.DateTimeFormat(undefined, {timeZone, timeZoneName:'short'})
  // + offset arithmetic. Pure formatting — no I/O.
  return 'UTC+0'
}
