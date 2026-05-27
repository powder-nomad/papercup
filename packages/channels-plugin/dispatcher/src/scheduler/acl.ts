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
   * Pass `jobOwnerId = null` for creation checks (no existing owner yet — an
   * allowlisted actor is creating it under their own ID).
   */
  canManage(actorId: string, jobOwnerId: string | null): boolean
}

class AclImpl implements SchedulerAcl {
  constructor(
    private readonly store: SchedulerStore,
    private readonly ownerId: string,
  ) {}

  isOwner(userId: string): boolean {
    if (!this.ownerId) return false
    return userId === this.ownerId
  }

  isAllowlisted(userId: string): boolean {
    if (!userId) return false
    return this.store.isAllowlisted(userId)
  }

  canManage(actorId: string, jobOwnerId: string | null): boolean {
    if (!actorId) return false
    if (this.isOwner(actorId)) return true
    if (!this.isAllowlisted(actorId)) return false
    // Allowlisted users can only touch their own jobs. For creation
    // (jobOwnerId === null) the caller implicitly becomes the owner.
    return jobOwnerId === null || jobOwnerId === actorId
  }
}

export function createAcl(deps: AclDeps): SchedulerAcl {
  return new AclImpl(deps.store, deps.ownerId)
}
