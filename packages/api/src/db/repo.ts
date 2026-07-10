import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
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
  // Caught-up watermark for a freshly-inserted superadmin. Passed IN (not imported) so this widely-
  // reached repo module never pulls whats-new/catalog into the content worker's bundle — the auth
  // path supplies NEWEST_RELEASE_DATE; default null keeps an existing promotion / tests catalog-free.
  lastSeenReleaseAt: string | null = null,
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
  // Caught-up default (watermark = newest, supplied by the auth path) so a freshly bootstrapped
  // superadmin isn't greeted by a backlog of "unread" release notes. Mirrors findOrCreateUser.
  await db.insert(users).values({ id, email, name, googleId: null, role: 'superadmin', lastSeenReleaseAt })
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

/** True if a site is explicitly shared with the user — directly, or via a group they're in. */
export async function resolveIsShared(db: DrizzleD1Database, siteId: string, userId: string): Promise<boolean> {
  // Direct and via-group grants are independent — resolve both in one round trip rather than
  // serially. Drops the direct-hit short-circuit (one extra cheap query) to save a round trip.
  const [direct, viaGroup] = await Promise.all([
    db
      .select({ siteId: siteUserShares.siteId })
      .from(siteUserShares)
      .where(and(eq(siteUserShares.siteId, siteId), eq(siteUserShares.userId, userId)))
      .limit(1),
    db
      .select({ siteId: siteGroupShares.siteId })
      .from(siteGroupShares)
      .innerJoin(spaceMembers, eq(spaceMembers.spaceId, siteGroupShares.spaceId))
      .where(and(eq(siteGroupShares.siteId, siteId), eq(spaceMembers.userId, userId)))
      .limit(1),
  ])
  return direct.length > 0 || viaGroup.length > 0
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
  const row = await db
    .select({ role: siteUserShares.role })
    .from(siteUserShares)
    .where(and(eq(siteUserShares.siteId, siteId), eq(siteUserShares.userId, userId)))
    .limit(1)
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

/** Set of site ids explicitly shared with the user (direct + via group membership). */
export async function sharedSiteIds(db: DrizzleD1Database, userId: string): Promise<Set<string>> {
  const [direct, viaGroup] = await Promise.all([
    db.select({ siteId: siteUserShares.siteId }).from(siteUserShares).where(eq(siteUserShares.userId, userId)),
    db
      .select({ siteId: siteGroupShares.siteId })
      .from(siteGroupShares)
      .innerJoin(spaceMembers, eq(spaceMembers.spaceId, siteGroupShares.spaceId))
      .where(eq(spaceMembers.userId, userId)),
  ])
  return new Set([...direct, ...viaGroup].map((r) => r.siteId))
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
  const ops = [
    db.delete(siteUserShares).where(eq(siteUserShares.siteId, siteId)),
    db.delete(siteGroupShares).where(eq(siteGroupShares.siteId, siteId)),
    ...users.map(({ userId, role }) => db.insert(siteUserShares).values({ siteId, userId, role })),
    ...groupIds.map((spaceId) => db.insert(siteGroupShares).values({ siteId, spaceId })),
  ]
  // D1 runs the batch in a single atomic transaction.
  await db.batch(ops as [(typeof ops)[number], ...(typeof ops)[number][]])
}
