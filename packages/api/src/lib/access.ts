import type { Site } from '../db/schema'
import type { SessionUser } from '../types'

export type AccessResult = { ok: true } | { ok: false; status: 401 | 403 | 410 }

const ALLOW: AccessResult = { ok: true }

/**
 * Pure permission logic — the single source of truth for visibility, used by both
 * the API and the content worker. `isMember` (space membership for `group` sites)
 * is resolved by the caller via DB lookup so this stays pure and unit-testable.
 *
 *   private → owner only
 *   group   → space member (or owner)
 *   team    → any authenticated user in the allowed domain
 *   public  → anyone
 *   shared  → any user/group explicitly granted access (additive, any tier)
 *   archived→ 410 for everyone except superadmin
 *   superadmin → bypasses all visibility + archive rules
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
    case 'public':
      return ALLOW
    case 'team':
      return user ? ALLOW : { ok: false, status: 401 }
    case 'group':
      if (!user) return { ok: false, status: 401 }
      return isMember || site.ownerId === user.id ? ALLOW : { ok: false, status: 403 }
    case 'private':
      if (!user) return { ok: false, status: 401 }
      return site.ownerId === user.id ? ALLOW : { ok: false, status: 403 }
    default:
      return { ok: false, status: 403 }
  }
}
