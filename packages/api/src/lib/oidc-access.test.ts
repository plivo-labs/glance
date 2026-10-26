import { describe, expect, test } from 'bun:test'
import { and, eq, isNotNull } from 'drizzle-orm'
import { sites, spaceMembers, spaces, users } from '../db/schema'
import { makeDb, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import type { AppEnv, SessionUser } from '../types'
import { syncOidcAccess } from './oidc-access'
import { slugSuffix } from './slug'

const env = {
  SUPERADMIN_EMAIL: 'owner@example.com',
  OIDC_ADMIN_GROUP: 'app.glance.admins',
} as AppEnv['Bindings']

async function member(db: ReturnType<typeof makeDb>, id: string, role: SessionUser['role'] = 'member') {
  await seedUser(db, { id, email: `${id}@example.com`, role })
  return { id, email: `${id}@example.com`, name: null, role } satisfies SessionUser
}

const roleOf = async (db: ReturnType<typeof makeDb>, id: string) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]?.role

describe('syncOidcAccess — admin group', () => {
  test('the admin group grants superadmin, and losing it demotes', async () => {
    const db = makeDb()
    const john = await member(db, 'john')

    const promoted = await syncOidcAccess(db, env, john, ['app.glance.admins'])
    expect(promoted.role).toBe('superadmin')
    expect(await roleOf(db, 'john')).toBe('superadmin')

    const demoted = await syncOidcAccess(db, env, promoted, ['Everyone'])
    expect(demoted.role).toBe('member')
    expect(await roleOf(db, 'john')).toBe('member')
  })

  test('SUPERADMIN_EMAIL keeps superadmin without the admin group', async () => {
    const db = makeDb()
    await seedUser(db, { id: 'owner', email: 'owner@example.com', role: 'superadmin' })
    const owner = { id: 'owner', email: 'owner@example.com', name: null, role: 'superadmin' } satisfies SessionUser

    expect((await syncOidcAccess(db, env, owner, [])).role).toBe('superadmin')
  })

  test('unknown groups (null) leave the role alone', async () => {
    const db = makeDb()
    const john = await member(db, 'john', 'superadmin')

    expect(await syncOidcAccess(db, env, john, null)).toEqual(john)
    expect(await roleOf(db, 'john')).toBe('superadmin')
  })

  test('without OIDC_ADMIN_GROUP nothing changes', async () => {
    const db = makeDb()
    const john = await member(db, 'john', 'superadmin')
    const bare = { SUPERADMIN_EMAIL: 'owner@example.com' } as AppEnv['Bindings']

    expect(await syncOidcAccess(db, bare, john, ['app.glance.admins'])).toEqual(john)
  })
})

/** The managed-space half is driven by OIDC_GROUP_PREFIX; OIDC_ADMIN_GROUP here only proves it is
 *  excluded from the spaces (it is covered on its own above). */
const spaceEnv = {
  SUPERADMIN_EMAIL: 'owner@example.com',
  OIDC_GROUP_PREFIX: 'app.glance.',
  OIDC_ADMIN_GROUP: 'app.glance.admins',
} as AppEnv['Bindings']

async function managedSlugs(db: ReturnType<typeof makeDb>, userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: spaces.slug })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(and(eq(spaceMembers.userId, userId), isNotNull(spaces.oidcGroup)))
  return rows.map((r) => r.slug).sort()
}

describe('syncOidcAccess — managed spaces', () => {
  test('creates a space per prefixed group once and adds later members to the same space', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    const jane = await member(db, 'jane')

    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform', 'app.glance.SRE', 'Everyone'])
    await syncOidcAccess(db, spaceEnv, jane, ['app.glance.Platform'])

    expect(await managedSlugs(db, 'john')).toEqual(['platform', 'sre'])
    expect(await managedSlugs(db, 'jane')).toEqual(['platform'])
    expect(await db.select().from(spaces).where(isNotNull(spaces.oidcGroup))).toHaveLength(2)
  })

  test('a group the provider no longer sends removes the membership but keeps the space', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform', 'app.glance.SRE'])

    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform'])
    expect(await managedSlugs(db, 'john')).toEqual(['platform'])

    await syncOidcAccess(db, spaceEnv, john, [])
    expect(await managedSlugs(db, 'john')).toEqual([])
    expect(await db.select().from(spaces).where(isNotNull(spaces.oidcGroup))).toHaveLength(2)
  })

  test('unknown groups leave memberships alone', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform'])

    await syncOidcAccess(db, spaceEnv, john, null)
    expect(await managedSlugs(db, 'john')).toEqual(['platform'])
  })

  test('manual group spaces are left alone, and a slug they hold makes the managed space walk on', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    await seedSpace(db, { id: 'manual', slug: 'platform', createdBy: 'john' })
    await seedMember(db, 'manual', 'john')

    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform'])

    expect(await managedSlugs(db, 'john')).toEqual(['platform-1'])
    const manual = await db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, 'manual'))
    expect(manual).toHaveLength(1)
  })

  test("deleting a managed space's first member hands it to another member instead of cascading", async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    const jane = await member(db, 'jane')
    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform'])
    await syncOidcAccess(db, spaceEnv, jane, ['app.glance.Platform'])
    const [space] = await db.select().from(spaces).where(isNotNull(spaces.oidcGroup))
    await seedSite(db, { spaceId: space.id, ownerId: 'jane' })

    await db.delete(users).where(eq(users.id, 'john'))

    expect((await db.select().from(spaces).where(eq(spaces.id, space.id)))[0]?.createdBy).toBe('jane')
    expect(await db.select().from(sites).where(eq(sites.spaceId, space.id))).toHaveLength(1)
  })

  test("deleting a managed space's only member is refused", async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform'])

    await expect((async () => db.delete(users).where(eq(users.id, 'john')))()).rejects.toThrow(/NOT NULL/)
    expect(await db.select().from(spaces).where(isNotNull(spaces.oidcGroup))).toHaveLength(1)
  })

  test('the admin group is not a space', async () => {
    const db = makeDb()
    const john = await member(db, 'john')

    const promoted = await syncOidcAccess(db, spaceEnv, john, ['app.glance.admins'])
    expect(promoted.role).toBe('superadmin')
    expect(await managedSlugs(db, 'john')).toEqual([])
  })

  test('pre-created slugs fall back to a suffixed name', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    for (const slug of ['platform', ...Array.from({ length: 25 }, (_, i) => `platform-${i + 1}`)]) {
      await seedSpace(db, { id: `s-${slug}`, slug, createdBy: 'john' })
    }

    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform'])
    expect(await managedSlugs(db, 'john')).toEqual([`platform-${slugSuffix('app.glance.Platform')}`])
  })

  test('squatted slugs cost one lookup, not a failed insert each (Free plan: 50 D1 calls a request)', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    for (const slug of ['platform', ...Array.from({ length: 25 }, (_, i) => `platform-${i + 1}`)]) {
      await seedSpace(db, { id: `s-${slug}`, slug, createdBy: 'john' })
    }
    db.resetCounters()

    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform'])
    expect(await managedSlugs(db, 'john')).toEqual([`platform-${slugSuffix('app.glance.Platform')}`])
    expect(db.counters.loose + db.counters.batches).toBeLessThanOrEqual(5)
  })

  test('when the suffixed slug is taken too, the group is skipped instead of failing the sign-in', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    const suffix = `platform-${slugSuffix('app.glance.Platform')}`
    const squatted = ['platform', ...Array.from({ length: 25 }, (_, i) => `platform-${i + 1}`)]
    for (const slug of [...squatted, suffix]) {
      await seedSpace(db, { id: `s-${slug}`, slug, createdBy: 'john' })
    }

    await syncOidcAccess(db, spaceEnv, john, ['app.glance.Platform'])
    expect(await managedSlugs(db, 'john')).toEqual([])
  })
})
