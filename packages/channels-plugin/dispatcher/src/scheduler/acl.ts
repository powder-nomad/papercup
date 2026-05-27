/**
 * Authorization gate for scheduler slash commands.
 *
 *   bot owner (BOT_OWNER_ID env)  → can manage every job
 *   allowlisted user              → can manage only their own jobs
 *   everyone else                 → rejected
 *
 * F1 ships in "bot-owner only" effective mode — the allowlist table exists
 * (DESIGN §Storage) and these helpers honor it, but the slash commands that
 * mutate the allowlist (`/scheduler allow|deny`) are themselves owner-only.
 */

import type { SchedulerStore } from './store.ts'

export type AclDeps = {
  store: SchedulerStore
  /** BOT_OWNER_ID env value at boot time. Empty string ⇒ "no owner configured". */
  ownerId: string
}

export interface SchedulerAcl {
  isOwner(userId: string): boolean
  isAllowlisted(userId: string): boolean
  /**
   * True if `actorId` may create/edit/delete a job whose owner is `jobOwnerId`.
   * - Owner: yes, for any job.
   * - Allowlisted actor: yes iff actorId === jobOwnerId.
   * - Otherwise: no.
   * Pass `jobOwnerId = null` for creation checks (no owner yet).
   */
  canManage(actorId: string, jobOwnerId: string | null): boolean
}

export function createAcl(_deps: AclDeps): SchedulerAcl {
  // TODO(task #5): straightforward predicate impl on top of store.isAllowlisted.
  throw new Error('createAcl: not implemented yet — see task #5')
}
