import { describe, expect, test } from 'bun:test'
import { and, eq, isNotNull } from 'drizzle-orm'
import { spaceMembers, spaces, users } from '../db/schema'
import { makeDb, seedMember, seedSpace, seedUser } from '../test/harness'
import type { AppEnv, SessionUser } from '../types'
import { syncOidcAccess } from './oidc-access'

const env = {
  SUPERADMIN_EMAIL: 'owner@example.com',
  OIDC_GROUP_PREFIX: 'app.glance.',
  OIDC_ADMIN_GROUP: 'app.glance.admins',
} as AppEnv['Bindings']

async function member(db: ReturnType<typeof makeDb>, id: string, role: SessionUser['role'] = 'member') {
  await seedUser(db, { id, email: `${id}@example.com`, role })
  return { id, email: `${id}@example.com`, name: null, role } satisfies SessionUser
}

async function managedSlugs(db: ReturnType<typeof makeDb>, userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: spaces.slug })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(and(eq(spaceMembers.userId, userId), isNotNull(spaces.oidcGroup)))
  return rows.map((r) => r.slug).sort()
}

describe('syncOidcAccess', () => {
  test('creates a space per prefixed group once and adds later members to the same space', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    const jane = await member(db, 'jane')

    await syncOidcAccess(db, env, john, ['app.glance.Platform', 'app.glance.SRE', 'Everyone'])
    await syncOidcAccess(db, env, jane, ['app.glance.Platform'])

    expect(await managedSlugs(db, 'john')).toEqual(['platform', 'sre'])
    expect(await managedSlugs(db, 'jane')).toEqual(['platform'])
    expect(await db.select().from(spaces).where(isNotNull(spaces.oidcGroup))).toHaveLength(2)
  })

  test('a group the provider no longer sends removes the membership but keeps the space', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    await syncOidcAccess(db, env, john, ['app.glance.Platform', 'app.glance.SRE'])

    await syncOidcAccess(db, env, john, ['app.glance.Platform'])
    expect(await managedSlugs(db, 'john')).toEqual(['platform'])

    await syncOidcAccess(db, env, john, [])
    expect(await managedSlugs(db, 'john')).toEqual([])
    expect(await db.select().from(spaces).where(isNotNull(spaces.oidcGroup))).toHaveLength(2)
  })

  test('manual group spaces are left alone, and a slug they hold makes the managed space walk on', async () => {
    const db = makeDb()
    const john = await member(db, 'john')
    await seedSpace(db, { id: 'manual', slug: 'platform', createdBy: 'john' })
    await seedMember(db, 'manual', 'john')

    await syncOidcAccess(db, env, john, ['app.glance.Platform'])

    expect(await managedSlugs(db, 'john')).toEqual(['platform-1'])
    const manual = await db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, 'manual'))
    expect(manual).toHaveLength(1)
  })

  test('the admin group grants superadmin, is not a space, and losing it demotes', async () => {
    const db = makeDb()
    const john = await member(db, 'john')

    const promoted = await syncOidcAccess(db, env, john, ['app.glance.admins'])
    expect(promoted.role).toBe('superadmin')
    expect(await managedSlugs(db, 'john')).toEqual([])

    const demoted = await syncOidcAccess(db, env, promoted, [])
    expect(demoted.role).toBe('member')
    expect((await db.select().from(users).where(eq(users.id, 'john')))[0]?.role).toBe('member')
  })

  test('SUPERADMIN_EMAIL keeps superadmin without the admin group', async () => {
    const db = makeDb()
    await seedUser(db, { id: 'owner', email: 'owner@example.com', role: 'superadmin' })
    const owner = { id: 'owner', email: 'owner@example.com', name: null, role: 'superadmin' } satisfies SessionUser

    expect((await syncOidcAccess(db, env, owner, [])).role).toBe('superadmin')
  })

  test('without OIDC_GROUP_PREFIX and OIDC_ADMIN_GROUP nothing changes', async () => {
    const db = makeDb()
    const john = await member(db, 'john', 'superadmin')
    const bare = { SUPERADMIN_EMAIL: 'owner@example.com' } as AppEnv['Bindings']

    expect(await syncOidcAccess(db, bare, john, ['app.glance.Platform'])).toEqual(john)
    expect(await db.select().from(spaces)).toHaveLength(0)
  })
})
