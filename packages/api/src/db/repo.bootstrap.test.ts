import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { makeDb } from '../test/harness'
import { spaceMembers, spaces, users } from './schema'
import { findOrCreateUser } from '../routes/auth'
import type { AppEnv } from '../types'
import { bootstrapSuperadminByEmail, createPersonalSpace, createSpace, getUserById, superadminExists } from './repo'

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

describe('getUserById', () => {
  test('returns-identity-fields: existing user resolves to id/email/name/role', async () => {
    const db = makeDb()
    await db.insert(users).values({ id: 'u1', email: 'a@x.com', name: 'Ada', role: 'superadmin' })
    const u = await getUserById(db, 'u1')
    expect(u).toEqual({ id: 'u1', email: 'a@x.com', name: 'Ada', role: 'superadmin' })
  })

  test('null-when-missing: an unknown id resolves to null (a deleted user is logged out)', async () => {
    const db = makeDb()
    expect(await getUserById(db, 'ghost')).toBeNull()
  })
})

describe('createPersonalSpace — slug-conflict resilience (#27)', () => {
  test('retries-next-candidate-on-unique-conflict: base slug taken → uses base-1, never strands', async () => {
    const db = makeDb()
    // A racing signup already owns the base slug derived from the handle ('alice').
    await db.insert(users).values({ id: 'racer', email: 'racer@x.com', role: 'member' })
    await createSpace(db, { slug: 'alice', name: 'alice', type: 'personal', createdBy: 'racer' })

    await db.insert(users).values({ id: 'alice', email: 'alice@example.com', role: 'member' })
    await createPersonalSpace(db, 'alice', 'alice@example.com')

    // The pre-existing 'alice' space is untouched; the new user got 'alice-1' + a membership.
    const base = await db.select().from(spaces).where(eq(spaces.slug, 'alice'))
    expect(base[0]?.createdBy).toBe('racer')
    const mine = await db.select().from(spaces).where(eq(spaces.slug, 'alice-1'))
    expect(mine[0]?.createdBy).toBe('alice')
    expect(mine[0]?.type).toBe('personal')
    const membership = await db.select().from(spaceMembers).where(eq(spaceMembers.userId, 'alice'))
    expect(membership).toHaveLength(1)
    expect(membership[0].spaceId).toBe(mine[0].id)
  })

  test('skips-multiple-taken-candidates: base and base-1 taken → uses base-2', async () => {
    const db = makeDb()
    await db.insert(users).values({ id: 'racer', email: 'racer@x.com', role: 'member' })
    await createSpace(db, { slug: 'bob', name: 'bob', type: 'personal', createdBy: 'racer' })
    await createSpace(db, { slug: 'bob-1', name: 'bob-1', type: 'group', createdBy: 'racer' })

    await db.insert(users).values({ id: 'bob', email: 'bob@example.com', role: 'member' })
    await createPersonalSpace(db, 'bob', 'bob@example.com')

    const mine = await db.select().from(spaces).where(eq(spaces.slug, 'bob-2'))
    expect(mine[0]?.createdBy).toBe('bob')
  })
})

describe('indexes (0007 migration reaches the harness)', () => {
  test('new-perf-indexes-exist: 0007 is applied by makeDb (guards the silent S-MIGRATE seam)', async () => {
    const db = makeDb()
    const rows = (await (
      db as unknown as { all: (q: unknown) => Promise<Array<Record<string, unknown>>> }
    ).all(sql`SELECT name FROM sqlite_master WHERE type = 'index'`)) as Array<Record<string, unknown>>
    const names = new Set(rows.map((r) => String(r.name ?? Object.values(r)[0])))
    for (const idx of ['sites_owner', 'space_members_user', 'site_user_shares_user', 'site_group_shares_space']) {
      expect(names.has(idx)).toBe(true)
    }
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
