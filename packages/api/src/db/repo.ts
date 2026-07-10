import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { batchAll } from '../lib/d1'
import { RESERVED_SLUGS, slugifyHandle } from '../lib/slug'
import type { SessionUser } from '../types'
import {
  type Site,
  type SpaceType,
  type User,
  siteGroupShares,
  siteUserShares,
  spaceMembers,
  spaces,
  users,
} from './schema'

export function toSessionUser(u: Pick<User, 'id' | 'email' | 'name' | 'role'>): SessionUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role }
}

/** Single indexed (PK) row read of a user's identity fields — null if the row is gone. Lets
 *  requireAuth re-check the live role each request rather than trusting a stale session copy. */
export async function getUserById(
  db: DrizzleD1Database,
  id: string,
): Promise<Pick<User, 'id' | 'email' | 'name' | 'role'> | null> {
  const row = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
  return row[0] ?? null
}

/** True iff at least one user row has role='superadmin'. Drives bootstrap availability. */
export async function superadminExists(db: DrizzleD1Database): Promise<boolean> {
  const row = await db.select({ id: users.id }).from(users).where(eq(users.role, 'superadmin')).limit(1)
  return row.length > 0
}

/** Facts the bootstrap decision needs: whether any superadmin exists, and whether the
 *  configured email is currently a superadmin (idempotent re-mint vs. takeover lockout). */
export async function superadminStatus(
  db: DrizzleD1Database,
  configuredEmail: string,
): Promise<{ hasSuperadmin: boolean; superadminIsConfiguredEmail: boolean }> {
  const admins = await db.select({ email: users.email }).from(users).where(eq(users.role, 'superadmin'))
  const configured = configuredEmail.toLowerCase()
  return {
    hasSuperadmin: admins.length > 0,
    superadminIsConfiguredEmail: admins.some((a) => a.email === configured),
  }
}

/** True for a SQLite/D1 UNIQUE-constraint violation (message carries "UNIQUE constraint failed"
 *  in both the bun:sqlite harness and D1's wrapped `D1_ERROR`). */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unique constraint failed/i.test(msg)
}

/**
 * Create the user's personal space + membership, deriving a free slug from the email handle.
 * Attempts each candidate slug DIRECTLY (no check-then-create TOCTOU): on the unique(spaces.slug)
 * conflict a concurrent same-handle signup would otherwise trigger, it falls through to the next
 * candidate instead of 500ing — so the caller (findOrCreateUser / bootstrapSuperadminByEmail),
 * which has already inserted the user row, never strands a user with no personal space.
 */
export async function createPersonalSpace(db: DrizzleD1Database, userId: string, email: string): Promise<void> {
  let base = slugifyHandle(email)
  if (RESERVED_SLUGS.has(base)) base = `${base}-1`
  const candidates = [base, ...Array.from({ length: 25 }, (_, i) => `${base}-${i + 1}`)]
  for (let i = 0; i < candidates.length; i++) {
    const slug = candidates[i]
    try {
      await createSpace(db, { slug, name: email.split('@')[0] ?? slug, type: 'personal', createdBy: userId })
      return
    } catch (err) {
      // Slug taken by a racing signup → try the next candidate; anything else (or exhausting the
      // bounded list) is a real failure the caller must see.
      if (isUniqueConstraintError(err) && i < candidates.length - 1) continue
      throw err
    }
  }
}

/**
 * Establish `email` as superadmin without Google: promote an existing row to superadmin
 * (leaving its googleId untouched so a later Google login can backfill onto it), or insert
 * a fresh googleId:null superadmin with a personal space. Idempotent for an existing
 * superadmin. Separate from the OAuth `findOrCreateUser` path, which never promotes.
 */
export async function bootstrapSuperadminByEmail(
  db: DrizzleD1Database,
  rawEmail: string,
  name: string | null,
): Promise<SessionUser> {
  const email = rawEmail.toLowerCase()
  const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]

  if (existing) {
    if (existing.role !== 'superadmin') {
      await db.update(users).set({ role: 'superadmin' }).where(eq(users.id, existing.id))
    }
    return toSessionUser({ ...existing, role: 'superadmin' })
  }

  const id = crypto.randomUUID()
  await db.insert(users).values({ id, email, name, googleId: null, role: 'superadmin' })
  await createPersonalSpace(db, id, email)
  return { id, email, name, role: 'superadmin' }
}

/** Insert a space and add its creator as a member, atomically (D1 batch). Returns the new id. */
export async function createSpace(
  db: DrizzleD1Database,
  input: { slug: string; name: string; type: SpaceType; createdBy: string },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.batch([
    db.insert(spaces).values({ id, slug: input.slug, name: input.name, type: input.type, createdBy: input.createdBy }),
    db.insert(spaceMembers).values({ spaceId: id, userId: input.createdBy }),
  ])
  return id
}

export async function isSpaceMember(db: DrizzleD1Database, spaceId: string, userId: string): Promise<boolean> {
  const row = await db
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    .limit(1)
  return row.length > 0
}

// --- Share reach, defined ONCE per branch: a direct `site_user_shares` row (carries the role)
// and group reach (`site_group_shares` joined through the user's space memberships). Optionally
// scoped to one site; callers that need at most one row apply `.limit(1)` themselves. Every
// ID-KEYED share-reach read below is built from these two. MIRROR: lib/site-access.ts
// accessFactsStatements re-expresses both branches SLUG-KEYED (the site id is unknown before
// its batch runs) — a change to share-reach semantics must land in BOTH files. ------------------

/** Direct-share rows for a user — `{siteId, role}` per grant, optionally scoped to one site. */
function directShareStmt(db: DrizzleD1Database, userId: string, siteId?: string) {
  return db
    .select({ siteId: siteUserShares.siteId, role: siteUserShares.role })
    .from(siteUserShares)
    .where(and(eq(siteUserShares.userId, userId), siteId === undefined ? undefined : eq(siteUserShares.siteId, siteId)))
}

/** Group-reach rows for a user — `{siteId}` per site reachable via a group share on a space
 *  they belong to, optionally scoped to one site. Group reach never carries a role. */
function groupReachStmt(db: DrizzleD1Database, userId: string, siteId?: string) {
  return db
    .select({ siteId: siteGroupShares.siteId })
    .from(siteGroupShares)
    .innerJoin(spaceMembers, eq(spaceMembers.spaceId, siteGroupShares.spaceId))
    .where(and(eq(spaceMembers.userId, userId), siteId === undefined ? undefined : eq(siteGroupShares.siteId, siteId)))
}

/**
 * ONE role-aware share resolve for a (site, user): the direct-share role AND group reach in a
 * single db.batch round trip. `isShared` (checkAccess's input) is any reach — a direct share of
 * either role OR a group share; a group-only reacher is viewer-grade for ACCESS purposes only,
 * so `directRole` stays null for them. The edit oracle (`canReplace`) must consume `directRole`,
 * never `isShared` — group shares are never an editor grant.
 */
export async function resolveShareAccess(
  db: DrizzleD1Database,
  siteId: string,
  userId: string,
): Promise<{ isShared: boolean; directRole: 'viewer' | 'editor' | null }> {
  const [direct, viaGroup] = await batchAll(db, [
    directShareStmt(db, userId, siteId).limit(1),
    groupReachStmt(db, userId, siteId).limit(1),
  ])
  const directRole = direct[0]?.role ?? null
  return { isShared: directRole !== null || viaGroup.length > 0, directRole }
}

/** True if a site is explicitly shared with the user — directly, or via a group they're in. */
export async function resolveIsShared(db: DrizzleD1Database, siteId: string, userId: string): Promise<boolean> {
  return (await resolveShareAccess(db, siteId, userId)).isShared
}

/**
 * The user's DIRECT-share role on a site, or null if they have no direct share.
 * Only direct `site_user_shares` rows carry a role — a group share (`site_group_shares`) is never
 * an editor grant, so a group-only reacher resolves to null even though `resolveIsShared` is true.
 * This is the edit-capability oracle: 'editor' → may content-replace; 'viewer'/null → may not.
 */
export async function resolveShareRole(
  db: DrizzleD1Database,
  siteId: string,
  userId: string,
): Promise<'viewer' | 'editor' | null> {
  const row = await directShareStmt(db, userId, siteId).limit(1)
  return row[0]?.role ?? null
}

/** Set of space ids the user is a member of (mirrors `sharedSiteIds` for the search candidate query). */
export async function memberSpaceIds(db: DrizzleD1Database, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, userId))
  return new Set(rows.map((r) => r.spaceId))
}

/**
 * Every site shared with the user (same reach as `sharedSiteIds`: direct OR group via space
 * membership) WITH the effective role, in ONE D1 request — both branch selects travel in a single
 * db.batch, and each is a join on userId (no id collection → no bind-cap exposure at any fan-out).
 * Group shares are always 'viewer'; a direct row's role OVERRIDES a group-derived viewer (direct
 * editor + group → editor). Feeds GET /sites/shared; the edit oracle stays `resolveShareRole`.
 */
export async function sharedSiteRoles(db: DrizzleD1Database, userId: string): Promise<Map<string, 'viewer' | 'editor'>> {
  const [direct, viaGroup] = await batchAll(db, sharedSiteRoleStmts(db, userId))
  return foldSharedSiteRoles(direct, viaGroup)
}

/** The two share-reach SELECTs behind `sharedSiteRoles` (direct rows with role, group reach),
 *  exposed so a route can ride them in its OWN db.batch alongside other statements — fusing the
 *  roles layer into an existing round trip. Fold the results with `foldSharedSiteRoles`. */
export function sharedSiteRoleStmts(db: DrizzleD1Database, userId: string) {
  return [directShareStmt(db, userId), groupReachStmt(db, userId)] as const
}

/** Fold the `sharedSiteRoleStmts` results: group shares are always 'viewer'; a direct row's role
 *  OVERRIDES a group-derived viewer (direct editor + group → editor). */
export function foldSharedSiteRoles(
  direct: { siteId: string; role: 'viewer' | 'editor' }[],
  viaGroup: { siteId: string }[],
): Map<string, 'viewer' | 'editor'> {
  const roles = new Map<string, 'viewer' | 'editor'>()
  for (const r of viaGroup) roles.set(r.siteId, 'viewer')
  for (const r of direct) roles.set(r.siteId, r.role) // direct wins over group-derived viewer
  return roles
}

/** Set of site ids explicitly shared with the user (direct + via group membership). Derived from
 *  `sharedSiteRoles` so the two can never drift on reach semantics (roles are simply dropped). */
export async function sharedSiteIds(db: DrizzleD1Database, userId: string): Promise<Set<string>> {
  return new Set((await sharedSiteRoles(db, userId)).keys())
}

/** A user reduced to what an @-mention autocomplete needs. */
export type UserLite = { id: string; name: string | null; email: string }

/**
 * The set of users who may be @-mentioned on a site — those the visibility tier would let in, so a
 * mention can never notify (or leak) someone who can't open the site. Branches on visibility,
 * MIRRORING the tier structure of `checkAccess` (not a naive union):
 *   every tier → owner + explicit user-shares + members of group-shared spaces (additive grants);
 *   `members`  → PLUS the site's own space members;
 *   `team`     → ALL users (any authenticated user can open a team site);
 *   `private`  → owner + shares only.
 * The caller is always excluded (you don't mention yourself). Returned sorted by display name for a
 * stable autocomplete. The route re-runs this on create as the authorization gate (defense in depth).
 *
 * Deliberate deviations from `checkAccess` (both fail-closed / safe):
 *   - archived → nobody is mentionable (matches checkAccess's 410-for-all), enforced here directly.
 *   - the superadmin universal-access bypass is NOT expanded here — an admin is mentionable only via
 *     the normal owner/member/share paths (don't spam every admin on every private site).
 * `team` returns the whole user table on the assumption of a single allowed login domain (domain
 * gating happens at auth, not in this row set).
 */
export async function listMentionableUsers(
  db: DrizzleD1Database,
  site: Pick<Site, 'id' | 'spaceId' | 'visibility' | 'ownerId' | 'status'>,
  callerId: string,
): Promise<UserLite[]> {
  // Archived sites are 410 for everyone (superadmin aside) — nobody is mentionable.
  if (site.status === 'archived') return []

  const project = { id: users.id, name: users.name, email: users.email }
  const byName = sql`coalesce(${users.name}, ${users.email})`

  // team: any authenticated user can open the site, so everyone (minus the caller) is mentionable.
  if (site.visibility === 'team') {
    return db.select(project).from(users).where(ne(users.id, callerId)).orderBy(byName)
  }

  // Additive grants shared by every non-team tier: owner + direct user-shares + group-share members.
  const userShareRows = db
    .select({ userId: siteUserShares.userId })
    .from(siteUserShares)
    .where(eq(siteUserShares.siteId, site.id))
  const groupShareRows = db
    .select({ userId: spaceMembers.userId })
    .from(siteGroupShares)
    .innerJoin(spaceMembers, eq(spaceMembers.spaceId, siteGroupShares.spaceId))
    .where(eq(siteGroupShares.siteId, site.id))
  // members: the site's own space members are mentionable on top of the grants.
  const spaceMemberRows = db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, site.spaceId))

  const grants =
    site.visibility === 'members'
      ? await Promise.all([userShareRows, groupShareRows, spaceMemberRows])
      : await Promise.all([userShareRows, groupShareRows])

  const ids = new Set<string>([site.ownerId])
  for (const rows of grants) for (const r of rows) ids.add(r.userId)
  ids.delete(callerId)
  if (ids.size === 0) return []
  return db.select(project).from(users).where(inArray(users.id, [...ids])).orderBy(byName)
}

/** A per-user share as stored: the user id plus their grant tier. */
export type ShareUser = { userId: string; role: 'viewer' | 'editor' }

/**
 * Current explicit share lists for a site. Returns BOTH the role-aware `users` list (new callers)
 * and the flat `userIds`/`groupIds` (the legacy shape the live web dialog still reads) — a superset,
 * so no existing consumer breaks. Groups are always view-only (no role column on site_group_shares).
 */
export async function listSiteShares(
  db: DrizzleD1Database,
  siteId: string,
): Promise<{ userIds: string[]; groupIds: string[]; users: ShareUser[] }> {
  const u = await db
    .select({ id: siteUserShares.userId, role: siteUserShares.role })
    .from(siteUserShares)
    .where(eq(siteUserShares.siteId, siteId))
  const g = await db
    .select({ id: siteGroupShares.spaceId })
    .from(siteGroupShares)
    .where(eq(siteGroupShares.siteId, siteId))
  return {
    userIds: u.map((r) => r.id),
    groupIds: g.map((r) => r.id),
    users: u.map((r) => ({ userId: r.id, role: r.role })),
  }
}

/** Replace a site's entire share set atomically (clear both tables, then re-insert with roles). */
export async function replaceSiteShares(
  db: DrizzleD1Database,
  siteId: string,
  users: ShareUser[],
  groupIds: string[],
): Promise<void> {
  // D1 runs the batch in a single atomic transaction.
  await batchAll(db, [
    db.delete(siteUserShares).where(eq(siteUserShares.siteId, siteId)),
    db.delete(siteGroupShares).where(eq(siteGroupShares.siteId, siteId)),
    ...users.map(({ userId, role }) => db.insert(siteUserShares).values({ siteId, userId, role })),
    ...groupIds.map((spaceId) => db.insert(siteGroupShares).values({ siteId, spaceId })),
  ])
}
