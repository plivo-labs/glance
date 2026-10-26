import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { makeDb, seedUser } from '../test/harness'
import type { AppEnv, SessionUser } from '../types'
import { syncOidcAccess } from './oidc-access'

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
