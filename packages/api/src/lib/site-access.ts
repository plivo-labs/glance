import { and, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { isSpaceMember, resolveIsShared, toSessionUser } from '../db/repo'
import { sites as sitesTable, spaces, users } from '../db/schema'
import type { Visibility } from '../db/schema'
import type { SessionUser } from '../types'
import { type AccessResult, checkAccess } from './access'

// Shared site resolution + access check. Extracted from the formerly-private `resolveSite` in
// routes/sites.ts so both the site routes and the comments routes resolve a (space, site) and
// authorize it through the SAME path — `checkAccess` stays the single source of truth.

export type ResolvedSite = {
  id: string
  spaceId: string
  slug: string
  title: string | null
  visibility: Visibility
  status: 'active' | 'archived'
  ownerId: string
  createdAt: string
}

/** Resolve a site by (spaceSlug, siteSlug), joined to its space. Null if missing. */
export async function resolveSite(
  db: DrizzleD1Database,
  spaceSlug: string,
  siteSlug: string,
): Promise<ResolvedSite | null> {
  const rows = await db
    .select({
      id: sitesTable.id,
      spaceId: sitesTable.spaceId,
      slug: sitesTable.slug,
      title: sitesTable.title,
      visibility: sitesTable.visibility,
      status: sitesTable.status,
      ownerId: sitesTable.ownerId,
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .where(and(eq(spaces.slug, spaceSlug), eq(sitesTable.slug, siteSlug)))
    .limit(1)
  return rows[0] ?? null
}

export type SiteAccess = {
  site: ResolvedSite | null
  isMember: boolean
  isShared: boolean
  access: AccessResult
}

/** Resolve a site and run the full access check for `user` in one shot: row → membership →
 *  explicit share → `checkAccess`. When the site is missing, `site` is null (caller returns
 *  404); `access` then carries a forbidden result so a caller that ignores `site` still fails
 *  closed. */
export async function resolveSiteForAccess(
  db: DrizzleD1Database,
  spaceSlug: string,
  siteSlug: string,
  user: SessionUser | null,
): Promise<SiteAccess> {
  const site = await resolveSite(db, spaceSlug, siteSlug)
  if (!site) return { site: null, isMember: false, isShared: false, access: { ok: false, status: 403 } }
  const [isMember, isShared] = user
    ? await Promise.all([isSpaceMember(db, site.spaceId, user.id), resolveIsShared(db, site.id, user.id)])
    : [false, false]
  const access = checkAccess(site, user, isMember, isShared)
  return { site, isMember, isShared, access }
}

export type ViewerAuth = { user: SessionUser | null; access: AccessResult }

/** Reconstruct a token-bound viewer by id and re-authorize against LIVE DB state: user row →
 *  membership → explicit share → `checkAccess`, resolved in one round trip. Shared by the
 *  content worker and the data plane so every token-holder re-auth runs through the SAME path —
 *  a revoked share, tightened visibility, or deleted user blocks access immediately. */
export async function authorizeViewerById(
  db: DrizzleD1Database,
  site: Pick<ResolvedSite, 'id' | 'spaceId' | 'visibility' | 'status' | 'ownerId'>,
  userId: string,
): Promise<ViewerAuth> {
  const [userRow, isMember, isShared] = await Promise.all([
    db
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .then((rows) => rows[0]),
    isSpaceMember(db, site.spaceId, userId),
    resolveIsShared(db, site.id, userId),
  ])
  if (!userRow) return { user: null, access: { ok: false, status: 403 } }
  const user = toSessionUser(userRow)
  return { user, access: checkAccess(site, user, isMember, isShared) }
}
