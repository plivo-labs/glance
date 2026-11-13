import type { Site } from '../db/schema'
import type { SessionUser } from '../types'

// `reason` is set only on a 410, to tell an owner-set expiry apart from an admin archive.
export type AccessResult = { ok: true } | { ok: false; status: 401 | 403 | 410; reason?: 'expired' }

const ALLOW: AccessResult = { ok: true }

/**
 * Pure permission logic — the single source of truth for visibility, used by both
 * the API and the content worker. `isMember` (space membership for `members` sites)
 * is resolved by the caller via DB lookup so this stays pure and unit-testable.
 *
 *   private → owner only
 *   members → space member (or owner)
 *   team    → any authenticated user in the allowed domain
 *   shared  → any user/group explicitly granted access (additive, any tier)
 *   archived→ 410 for everyone (an admin's call)
 *   expired → 410 for everyone (the owner's `expiresAt` came due; checked here against the clock too,
 *             so the hourly cron's lag never serves a page late — callers that don't select
 *             `expiresAt` fall back to the cron flip)
 *
 * There is no public/anonymous tier: every tier requires an authenticated user.
 *
 * ROLE IS DELIBERATELY NOT CONSULTED. A superadmin reads a site only by the same tiers as
 * anyone else: their custodial powers (see every site's metadata, archive/restore, delete) are
 * the admin routes, and STOP at the content. Do not reintroduce a role bypass here — every read
 * surface (content worker, search, stars, spaces, comment feed, notifications) funnels through
 * this function, so one bypass line hands back the whole corpus.
 */
export function checkAccess(
  site: Pick<Site, 'visibility' | 'status' | 'ownerId'> & { expiresAt?: string | null },
  user: Pick<SessionUser, 'id' | 'role'> | null,
  isMember: boolean,
  isShared = false,
  now: Date = new Date(),
): AccessResult {
  if (site.status === 'expired' || (site.status === 'active' && !!site.expiresAt && site.expiresAt <= now.toISOString())) {
    return { ok: false, status: 410, reason: 'expired' }
  }
  if (site.status !== 'active') return { ok: false, status: 410 }
  // Explicit per-user / per-group grant — additive on top of the visibility tier.
  if (isShared && user) return ALLOW

  switch (site.visibility) {
    case 'team':
      return user ? ALLOW : { ok: false, status: 401 }
    case 'members':
      if (!user) return { ok: false, status: 401 }
      return isMember || site.ownerId === user.id ? ALLOW : { ok: false, status: 403 }
    case 'private':
      if (!user) return { ok: false, status: 401 }
      return site.ownerId === user.id ? ALLOW : { ok: false, status: 403 }
    default:
      return { ok: false, status: 403 }
  }
}

/**
 * Whether a user may CONTENT-REPLACE (redeploy) a site — a strictly narrower capability than
 * `checkAccess` (which is read/view). Owner always; a direct EDITOR share otherwise (a plain
 * viewer / group share / tier-only reacher may NOT). `shareRole` is the caller's DIRECT
 * share role (`resolveShareRole`), null when they have none. Single source of truth for the upload
 * gate, `/exists` canReplace, and the meta-route manifest gate — do NOT re-inline the predicate.
 *
 * Role is not consulted (same rule as `checkAccess`): the manifest this gates lists the site's
 * files, and replace lets the actor plant content the owner will open — neither is a custodial
 * power, so a superadmin gets them only by owning the site or holding an editor share.
 */
export function canReplace(
  user: Pick<SessionUser, 'id'>,
  site: Pick<Site, 'ownerId'>,
  shareRole: 'viewer' | 'editor' | null,
): boolean {
  return site.ownerId === user.id || shareRole === 'editor'
}
