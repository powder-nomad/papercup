/**
 * Shared resume-recovery for CLI backends.
 *
 * The same trap caught us in gemini-cli, claude-code, and codex:
 * the CLI persists a session to its local store only AFTER a turn
 * completes successfully. If the first `--session-id <uuid>` (or
 * equivalent) spawn crashed, got SIGTERM'd (mid-turn interrupt, reaper,
 * /cancel), network-blipped, or auth-failed before persistence, every
 * subsequent `--resume <uuid>` call returns "session not found" forever
 * and the papercup session is dead.
 *
 * runWithResumeRecovery wraps a runChild call: if it throws with a
 * pattern matching that backend's "session not found" error, the helper
 * flips firstTurn=true (via the onRecover callback) and retries once
 * with caller-rebuilt args that ask the CLI for a fresh session under
 * the same UUID. Prior-turn content is lost (the CLI never saved it)
 * but the papercup session functionally recovers.
 *
 * Backends declare their own:
 *   - errorPattern  — regex matching their specific resume-failure stderr
 *   - rebuildArgs() — callback that produces a fresh-session arg list,
 *                     because the resume → session-id rewrite shape
 *                     differs per CLI:
 *                       claude-code / gemini-cli: `--resume X` → `--session-id X`
 *                       codex:                   `exec resume X` → `exec`
 */

export interface ResumeRecoveryRequest<R> {
  /** Backend driver name for log lines. */
  backendName: string
  /** Whether this respond() is the FIRST turn (resume not attempted). If
   *  true, recovery is skipped — there's no prior --session-id to fall
   *  back from. */
  isFirstTurn: boolean
  /** Session UUID papercup uses for this session (for log lines). */
  sessionId: string
  /** Regex matching the CLI's "session not found" error stderr. Tested
   *  against `(err as Error).message`. */
  errorPattern: RegExp
  /** Backend-supplied callable that runs the child process once and
   *  returns the typed result (whatever the backend wants). */
  runChild: () => Promise<R>
  /** Backend-supplied callable that returns a NEW runChild closure for
   *  the recovery attempt. Should rewrite args from
   *  resume-mode → fresh-session mode. Called only after a recoverable
   *  error matches. */
  buildRecoveryRunChild: () => () => Promise<R>
  /** Called immediately after a recoverable error matches, BEFORE the
   *  retry. The backend uses this to flip its internal firstTurn=true
   *  flag so future calls in the same backend lifecycle know the resume
   *  context was reset. */
  onRecover: () => void
}

export async function runWithResumeRecovery<R>(req: ResumeRecoveryRequest<R>): Promise<R> {
  try {
    return await req.runChild()
  } catch (err) {
    const msg = (err as Error).message ?? ''
    // First-turn failures aren't recoverable here — there's no prior
    // session to fall back from. Let the original error propagate so
    // the caller surfaces a real backend error.
    if (req.isFirstTurn) throw err
    if (!req.errorPattern.test(msg)) throw err

    console.warn(
      `[backend:${req.backendName}] resume failed for session=${req.sessionId} — ` +
      `local store has no record (first turn likely never persisted). ` +
      `Retrying as a fresh session under the same UUID; prior turns lost.`,
    )
    req.onRecover()
    const retryRunChild = req.buildRecoveryRunChild()
    return await retryRunChild()
  }
}
