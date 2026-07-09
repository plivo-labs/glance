import type { Site } from '../db/schema'
import type { SessionUser } from '../types'

export type AccessResult = { ok: true } | { ok: false; status: 401 | 403 | 410 }

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
 *   archived→ 410 for everyone except superadmin
 *   superadmin → bypasses all visibility + archive rules
 *
 * There is no public/anonymous tier: every tier requires an authenticated user.
 */
export function checkAccess(
  site: Pick<Site, 'visibility' | 'status' | 'ownerId'>,
  user: SessionUser | null,
  isMember: boolean,
  isShared = false,
): AccessResult {
  if (user?.role === 'superadmin') return ALLOW
  if (site.status === 'archived') return { ok: false, status: 410 }
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
 * `checkAccess` (which is read/view). Owner or superadmin always; a direct EDITOR share otherwise
 * (a plain viewer / group share / tier-only reacher may NOT). `shareRole` is the caller's DIRECT
 * share role (`resolveShareRole`), null when they have none. Single source of truth for the upload
 * gate, `/exists` canReplace, and the meta-route manifest gate — do NOT re-inline the predicate.
 */
export function canReplace(
  user: Pick<SessionUser, 'id' | 'role'>,
  site: Pick<Site, 'ownerId'>,
  shareRole: 'viewer' | 'editor' | null,
): boolean {
  return user.role === 'superadmin' || site.ownerId === user.id || shareRole === 'editor'
}
