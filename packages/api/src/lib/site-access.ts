import { and, eq } from 'drizzle-orm'
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { isSpaceMember, resolveIsShared, toSessionUser } from '../db/repo'
import { batchAll } from './d1'
import { siteGroupShares, siteUserShares, sites as sitesTable, spaceMembers, spaces, users } from '../db/schema'
import type { User, Visibility } from '../db/schema'
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
  contentVersion: number
  createdAt: string
}

const RESOLVED_SITE_COLUMNS = {
  id: sitesTable.id,
  spaceId: sitesTable.spaceId,
  slug: sitesTable.slug,
  title: sitesTable.title,
  visibility: sitesTable.visibility,
  status: sitesTable.status,
  ownerId: sitesTable.ownerId,
  contentVersion: sitesTable.contentVersion,
  createdAt: sitesTable.createdAt,
}

/** Resolve a site by (spaceSlug, siteSlug), joined to its space. Null if missing. */
export async function resolveSite(
  db: DrizzleD1Database,
  spaceSlug: string,
  siteSlug: string,
): Promise<ResolvedSite | null> {
  const rows = await db
    .select(RESOLVED_SITE_COLUMNS)
    .from(sitesTable)
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .where(and(eq(spaces.slug, spaceSlug), eq(sitesTable.slug, siteSlug)))
    .limit(1)
  return rows[0] ?? null
}

// --- Slug-keyed access facts: everything an access decision needs about
// (spaceSlug, siteSlug, userId), resolvable in ONE db.batch round trip. -----------------------
//
// Design constraints (binding — see the S1 perf plan):
//   * Every statement is an individually NON-FAILING SELECT: an absent site/user/share yields
//     an empty result, never a throw — a rejected inner statement would reject the whole batch
//     and destroy the caller's 404/403/410 precedence.
//   * Every site-scoped statement is keyed by BOTH slugs (sites ⨝ spaces on the pair), because
//     the site id is unknown before the batch runs and site slugs are only unique per space —
//     identical slugs in two spaces must never bleed into each other.
// Callers may append extra slug-keyed statements to the same batch (content serve() fuses its
// file-row statement; the comments routes adopt this in S9a).

export type AccessFacts = {
  site: ResolvedSite | null
  user: SessionUser | null
  isMember: boolean
  directRole: 'viewer' | 'editor' | null
  groupShared: boolean
}

/** `checkAccess`'s `isShared` input derived from facts: any direct share (either role) or a
 *  group share reaches the site. */
export function isSharedFromFacts(facts: Pick<AccessFacts, 'directRole' | 'groupShared'>): boolean {
  return facts.directRole !== null || facts.groupShared
}

/** The batch statements behind `AccessFacts`, in `assembleAccessFacts` order:
 *  [site, user, membership, direct share, group share] for an authed viewer, or just [site]
 *  when `userId` is null (no user → the other four facts are vacuously false/null).
 *  MIRROR: the direct-share/group-reach branches re-express db/repo.ts's canonical
 *  directShareStmt/groupReachStmt SLUG-KEYED (no site id exists before this batch runs) —
 *  a change to share-reach semantics must land in BOTH files. */
function accessFactsStatements(
  db: DrizzleD1Database,
  spaceSlug: string,
  siteSlug: string,
  userId: string | null,
): BatchItem<'sqlite'>[] {
  // Fresh condition per statement — drizzle builders own their SQL chunks.
  const slugKey = () => and(eq(spaces.slug, spaceSlug), eq(sitesTable.slug, siteSlug))
  const site = db
    .select(RESOLVED_SITE_COLUMNS)
    .from(sitesTable)
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .where(slugKey())
    .limit(1)
  if (userId === null) return [site]
  const user = db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const membership = db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .innerJoin(sitesTable, eq(sitesTable.spaceId, spaces.id))
    .where(and(slugKey(), eq(spaceMembers.userId, userId)))
    .limit(1)
  const directShare = db
    .select({ role: siteUserShares.role })
    .from(siteUserShares)
    .innerJoin(sitesTable, eq(siteUserShares.siteId, sitesTable.id))
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .where(and(slugKey(), eq(siteUserShares.userId, userId)))
    .limit(1)
  const groupShare = db
    .select({ siteId: siteGroupShares.siteId })
    .from(siteGroupShares)
    .innerJoin(sitesTable, eq(siteGroupShares.siteId, sitesTable.id))
    .innerJoin(spaces, eq(sitesTable.spaceId, spaces.id))
    .innerJoin(spaceMembers, eq(spaceMembers.spaceId, siteGroupShares.spaceId))
    .where(and(slugKey(), eq(spaceMembers.userId, userId)))
    .limit(1)
  return [site, user, membership, directShare, groupShare]
}

/** Pure assembly of the batch results back into facts. `rows` must be the results of
 *  `accessFactsStatements` (same order, same `userId`). All-empty rows assemble cleanly — a
 *  missing site or user is a fact, not an error. */
function assembleAccessFacts(userId: string | null, rows: unknown[]): AccessFacts {
  const [siteRows, userRows, memberRows, directRows, groupRows] = rows as [
    ResolvedSite[],
    Pick<User, 'id' | 'email' | 'name' | 'role'>[] | undefined,
    { userId: string }[] | undefined,
    { role: 'viewer' | 'editor' }[] | undefined,
    { siteId: string }[] | undefined,
  ]
  const userRow = userId === null ? undefined : userRows?.[0]
  return {
    site: siteRows[0] ?? null,
    user: userRow ? toSessionUser(userRow) : null,
    isMember: (memberRows?.length ?? 0) > 0,
    directRole: directRows?.[0]?.role ?? null,
    groupShared: (groupRows?.length ?? 0) > 0,
  }
}

/** Resolve the access facts PLUS any caller-fused slug-keyed statements in ONE db.batch round
 *  trip. `extras` run after the facts statements; their row-arrays come back in `extras`, same
 *  order AND same per-statement row types (generic over the extras tuple, like batchAll) — the
 *  batching, the slice-off index math, and the row typing live HERE, never at call sites. */
export async function fetchAccessFacts<T extends readonly BatchItem<'sqlite'>[]>(
  db: DrizzleD1Database,
  spaceSlug: string,
  siteSlug: string,
  userId: string | null,
  ...extras: [...T]
): Promise<{ facts: AccessFacts; extras: BatchResponse<T> }> {
  const factsStmts = accessFactsStatements(db, spaceSlug, siteSlug, userId)
  const rows = await batchAll(db, [...factsStmts, ...extras])
  return {
    facts: assembleAccessFacts(userId, rows.slice(0, factsStmts.length)),
    // The ONE cast at this boundary: `rows` lost the tuple split when the facts statements and
    // `extras` were flattened into a single batch array, so the tail slice is re-asserted back
    // to the extras tuple's per-statement row types. Sound because batchAll returns results in
    // statement order and the first factsStmts.length rows were consumed by the facts above.
    extras: rows.slice(factsStmts.length) as unknown as BatchResponse<T>,
  }
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
 *  membership → explicit share → `checkAccess`, resolved in one round trip. Used by the data
 *  plane (routes/data.ts) — the content worker re-auths through the facts batch instead — so a
 *  revoked share, tightened visibility, or deleted user blocks access immediately. */
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
