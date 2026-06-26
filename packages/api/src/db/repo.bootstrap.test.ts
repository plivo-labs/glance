import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { makeDb } from '../test/harness'
import { spaceMembers, spaces, users } from './schema'
import { findOrCreateUser } from '../routes/auth'
import type { AppEnv } from '../types'
import { bootstrapSuperadminByEmail, superadminExists } from './repo'

describe('superadminExists', () => {
  test('superadminExists-reflects-rows: false with no superadmin, true once one exists', async () => {
    const db = makeDb()
    expect(await superadminExists(db)).toBe(false)

    await db.insert(users).values({ id: 'm1', email: 'm@x.com', role: 'member' })
    expect(await superadminExists(db)).toBe(false)

    await db.insert(users).values({ id: 's1', email: 's@x.com', role: 'superadmin' })
    expect(await superadminExists(db)).toBe(true)
  })
})

describe('bootstrapSuperadminByEmail', () => {
  test('bootstrap-inserts-null-googleId: fresh insert leaves googleId null + personal space created', async () => {
    const db = makeDb()
    const user = await bootstrapSuperadminByEmail(db, 'Owner@Example.com', 'Owner')

    expect(user.role).toBe('superadmin')
    expect(user.email).toBe('owner@example.com') // lowercased

    const rows = await db.select().from(users).where(eq(users.id, user.id))
    expect(rows[0]?.googleId).toBeNull()
    expect(rows[0]?.role).toBe('superadmin')

    const memberships = await db.select().from(spaceMembers).where(eq(spaceMembers.userId, user.id))
    expect(memberships).toHaveLength(1)
    const space = await db.select().from(spaces).where(eq(spaces.id, memberships[0].spaceId))
    expect(space[0]?.type).toBe('personal')
  })

  test('bootstrap-promotes-existing-member: pre-existing member row → promoted to superadmin', async () => {
    const db = makeDb()
    await db.insert(users).values({ id: 'u1', email: 'owner@example.com', role: 'member', name: 'Existing' })

    const user = await bootstrapSuperadminByEmail(db, 'owner@example.com', 'Owner')

    expect(user.id).toBe('u1') // same row, not a new insert
    expect(user.role).toBe('superadmin')

    const rows = await db.select().from(users).where(eq(users.id, 'u1'))
    expect(rows[0]?.role).toBe('superadmin')
    expect(rows[0]?.googleId).toBeNull() // promotion must not invent a googleId
  })

  test('idempotent: re-bootstrapping an existing superadmin returns it unchanged', async () => {
    const db = makeDb()
    const first = await bootstrapSuperadminByEmail(db, 'owner@example.com', 'Owner')
    const second = await bootstrapSuperadminByEmail(db, 'owner@example.com', 'Owner')
    expect(second.id).toBe(first.id)
    expect(second.role).toBe('superadmin')
    const all = await db.select().from(users)
    expect(all).toHaveLength(1)
  })
})

describe('backfill-google-onto-bootstrap-user (characterization)', () => {
  test('Google login on a bootstrap user (googleId null, same email) backfills id, keeps superadmin', async () => {
    const db = makeDb()
    const env = { SUPERADMIN_EMAIL: 'owner@example.com', ALLOWED_HD: 'example.com' } as AppEnv['Bindings']

    const bootstrapped = await bootstrapSuperadminByEmail(db, 'owner@example.com', null)
    expect(bootstrapped.role).toBe('superadmin')

    const claims = {
      sub: 'google-sub-123',
      email: 'owner@example.com',
      email_verified: true,
      name: 'Owner G',
      hd: 'example.com',
    }
    const after = await findOrCreateUser(db, env, claims, 'owner@example.com')

    expect(after.id).toBe(bootstrapped.id) // same row, matched by email
    expect(after.role).toBe('superadmin') // role preserved — Google login does not demote

    const rows = await db.select().from(users).where(eq(users.id, bootstrapped.id))
    expect(rows[0]?.googleId).toBe('google-sub-123') // backfilled
    expect(await db.select().from(users)).toHaveLength(1) // no duplicate user
  })
})
