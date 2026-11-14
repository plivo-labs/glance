import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { users } from '../db/schema'
import type { Bindings, SessionUser } from '../types'

/** True when an identity-provider sign-in is what decides access, so the other sign-in methods must
 *  not stand in for it (see the Google callback in routes/auth.ts). */
export function isOidcSyncEnabled(env: Bindings): boolean {
  return Boolean(env.OIDC_ADMIN_GROUP)
}

/** Applies the provider's view of a user on every OIDC sign-in: with OIDC_ADMIN_GROUP set, the role
 *  follows that group (SUPERADMIN_EMAIL always stays superadmin). `groups` is null when the token
 *  did not say (lib/oidc.ts oidcGroups), in which case nothing changes — a gap in the token must not
 *  demote anyone. */
export async function syncOidcAccess(
  db: DrizzleD1Database,
  env: Bindings,
  user: SessionUser,
  groups: string[] | null,
): Promise<SessionUser> {
  if (groups === null || !env.OIDC_ADMIN_GROUP) return user

  const admin = groups.includes(env.OIDC_ADMIN_GROUP) || user.email === env.SUPERADMIN_EMAIL.toLowerCase()
  const role = admin ? 'superadmin' : 'member'
  if (role === user.role) return user
  await db.update(users).set({ role }).where(eq(users.id, user.id))
  return { ...user, role }
}
