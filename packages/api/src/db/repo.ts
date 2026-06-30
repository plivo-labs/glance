import { and, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { RESERVED_SLUGS, slugifyHandle } from '../lib/slug'
import type { SessionUser } from '../types'
import {
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

/** Pick a free personal-space slug from the email handle, then create the space + membership. */
export async function createPersonalSpace(db: DrizzleD1Database, userId: string, email: string): Promise<void> {
  let base = slugifyHandle(email)
  if (RESERVED_SLUGS.has(base)) base = `${base}-1`
  let slug = base
  for (let i = 1; i <= 25; i++) {
    const taken = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.slug, slug)).limit(1)
    if (taken.length === 0) break
    slug = `${base}-${i}`
  }
  await createSpace(db, { slug, name: email.split('@')[0] ?? slug, type: 'personal', createdBy: userId })
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

/** Current explicit share lists for a site. */
export async function listSiteShares(
  db: DrizzleD1Database,
  siteId: string,
): Promise<{ userIds: string[]; groupIds: string[] }> {
  const u = await db.select({ id: siteUserShares.userId }).from(siteUserShares).where(eq(siteUserShares.siteId, siteId))
  const g = await db
    .select({ id: siteGroupShares.spaceId })
    .from(siteGroupShares)
    .where(eq(siteGroupShares.siteId, siteId))
  return { userIds: u.map((r) => r.id), groupIds: g.map((r) => r.id) }
}

/** Replace a site's entire share set atomically (clear both tables, then re-insert). */
export async function replaceSiteShares(
  db: DrizzleD1Database,
  siteId: string,
  userIds: string[],
  groupIds: string[],
): Promise<void> {
  const ops = [
    db.delete(siteUserShares).where(eq(siteUserShares.siteId, siteId)),
    db.delete(siteGroupShares).where(eq(siteGroupShares.siteId, siteId)),
    ...userIds.map((userId) => db.insert(siteUserShares).values({ siteId, userId })),
    ...groupIds.map((spaceId) => db.insert(siteGroupShares).values({ siteId, spaceId })),
  ]
  // D1 runs the batch in a single atomic transaction.
  await db.batch(ops as [(typeof ops)[number], ...(typeof ops)[number][]])
}
