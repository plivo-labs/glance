import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { createSpaceWithFreeSlug } from '../db/repo'
import { spaceMembers, spaces, users } from '../db/schema'
import type { Bindings, SessionUser } from '../types'
import { batchAll, chunk, D1_MAX_BOUND_PARAMETERS, D1_MAX_IN } from './d1'
import { slugCandidates, slugifyGroup, slugSuffix } from './slug'

/** True when an identity-provider sign-in decides access, so the other sign-in methods must not
 *  stand in for it (see the Google callback in routes/auth.ts). */
export function isOidcSyncEnabled(env: Bindings): boolean {
  return Boolean(env.OIDC_ADMIN_GROUP || env.OIDC_GROUP_PREFIX)
}

/** Applies the provider's view of a user on every OIDC sign-in: with OIDC_GROUP_PREFIX set, the
 *  matching groups (minus OIDC_ADMIN_GROUP) become managed group spaces the user is a member of,
 *  and of no other managed space; with OIDC_ADMIN_GROUP set, the role follows that group
 *  (SUPERADMIN_EMAIL always stays superadmin). `groups` is null when the token did not say
 *  (lib/oidc.ts oidcGroups), in which case nothing changes: a gap in the token must not strip
 *  memberships or demote anyone. */
export async function syncOidcAccess(
  db: DrizzleD1Database,
  env: Bindings,
  user: SessionUser,
  groups: string[] | null,
): Promise<SessionUser> {
  if (groups === null) return user
  if (env.OIDC_GROUP_PREFIX) await syncManagedSpaces(db, env, user.id, groups)
  if (!env.OIDC_ADMIN_GROUP) return user

  const admin = groups.includes(env.OIDC_ADMIN_GROUP) || user.email === env.SUPERADMIN_EMAIL.toLowerCase()
  const role = admin ? 'superadmin' : 'member'
  if (role === user.role) return user
  await db.update(users).set({ role }).where(eq(users.id, user.id))
  return { ...user, role }
}

async function syncManagedSpaces(db: DrizzleD1Database, env: Bindings, userId: string, groups: string[]) {
  const prefix = env.OIDC_GROUP_PREFIX as string
  const names = new Map<string, string>()
  for (const group of groups) {
    if (group !== env.OIDC_ADMIN_GROUP && group.startsWith(prefix) && group.length > prefix.length) {
      names.set(group, group.slice(prefix.length))
    }
  }

  const [current, ...found] = await batchAll(db, [
    db
      .select({ spaceId: spaceMembers.spaceId })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.userId, userId), isNotNull(spaces.oidcGroup))),
    ...chunk([...names.keys()], D1_MAX_IN).map((ids) =>
      db.select({ id: spaces.id, oidcGroup: spaces.oidcGroup }).from(spaces).where(inArray(spaces.oidcGroup, ids)),
    ),
  ])
  const existing = found.flat()
  const wanted = new Set(existing.map((s) => s.id))
  const known = new Set(existing.map((s) => s.oidcGroup))
  for (const [group, name] of names) {
    if (known.has(group)) continue
    const id = await createManagedSpace(db, group, name, userId)
    if (id) wanted.add(id)
  }

  // A space created above already lists its creator; onConflictDoNothing makes re-adding it a no-op.
  const have = new Set(current.map((m) => m.spaceId))
  const add = [...wanted].filter((id) => !have.has(id))
  const remove = [...have].filter((id) => !wanted.has(id))
  await batchAll(db, [
    ...chunk(add, D1_MAX_BOUND_PARAMETERS / 2).map((ids) =>
      db
        .insert(spaceMembers)
        .values(ids.map((spaceId) => ({ spaceId, userId })))
        .onConflictDoNothing(),
    ),
    ...chunk(remove, D1_MAX_IN).map((ids) =>
      db.delete(spaceMembers).where(and(eq(spaceMembers.userId, userId), inArray(spaceMembers.spaceId, ids))),
    ),
  ])
}

/** The space for `group`, its first member as createdBy (the column is NOT NULL; nobody owns a
 *  managed space and the routes treat it that way). A unique conflict can also mean a concurrent
 *  sign-in created it first: that row wins.
 *
 *  Slugs are a flat namespace any member can squat, so the readable candidates can all be gone
 *  (`platform`, `platform-1` … `platform-25`). Rather than fail the sign-in for everyone in the
 *  group, the last candidate is a name-derived suffix and, if even that is taken, this group's
 *  space is skipped with a warning. */
async function createManagedSpace(
  db: DrizzleD1Database,
  group: string,
  name: string,
  userId: string,
): Promise<string | undefined> {
  const raced = async () =>
    (await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.oidcGroup, group)).limit(1))[0]?.id
  const base = slugifyGroup(name)
  const suffixed = `${base.slice(0, 32).replace(/-+$/, '')}-${slugSuffix(group)}`
  const id = await createSpaceWithFreeSlug(
    db,
    [...slugCandidates(base), suffixed],
    { name, type: 'group', createdBy: userId, oidcGroup: group },
    { raced, skipOnExhausted: true },
  )
  if (!id) console.warn(`oidc: no free slug left for group space "${group}"; skipping it`)
  return id
}
