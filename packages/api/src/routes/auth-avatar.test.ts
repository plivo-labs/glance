import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { makeDb } from '../test/harness'
import type { AppEnv } from '../types'
import { findOrCreateUser } from './auth'

// findOrCreateUser and the `picture` claim. Login is the ONLY moment Google hands us a photo, so
// it is also the only backfill available: a user who signed up before this column existed gets one
// on their next sign-in, and everyone keeps initials until then.

const env = { SUPERADMIN_EMAIL: 'boss@example.com', ALLOWED_HD: 'example.com' } as AppEnv['Bindings']
const claims = (picture?: string) =>
  ({ sub: 'g-1', email: 'a@example.com', email_verified: true, name: 'A', picture, hd: 'example.com' }) as never

const storedAvatar = async (db: ReturnType<typeof makeDb>, id: string) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]?.avatarUrl

describe('findOrCreateUser — avatar capture', () => {
  test('a new signup stores the photo from the id_token', async () => {
    const db = makeDb()
    const user = await findOrCreateUser(
      db,
      env,
      claims('https://lh3.googleusercontent.com/a/new=s96-c'),
      'a@example.com',
    )
    expect(await storedAvatar(db, user.id)).toBe('https://lh3.googleusercontent.com/a/new=s96-c')
  })

  test('an existing user (no photo yet) is backfilled on their next login', async () => {
    const db = makeDb()
    const first = await findOrCreateUser(db, env, claims(), 'a@example.com')
    expect(await storedAvatar(db, first.id)).toBeNull()

    await findOrCreateUser(db, env, claims('https://lh3.googleusercontent.com/a/later=s96-c'), 'a@example.com')
    expect(await storedAvatar(db, first.id)).toBe('https://lh3.googleusercontent.com/a/later=s96-c')
  })

  test('a changed photo replaces the stored one', async () => {
    const db = makeDb()
    const user = await findOrCreateUser(
      db,
      env,
      claims('https://lh3.googleusercontent.com/a/old=s96-c'),
      'a@example.com',
    )
    await findOrCreateUser(db, env, claims('https://lh3.googleusercontent.com/a/fresh=s96-c'), 'a@example.com')
    expect(await storedAvatar(db, user.id)).toBe('https://lh3.googleusercontent.com/a/fresh=s96-c')
  })

  test('a login without a usable photo leaves the stored one intact', async () => {
    const db = makeDb()
    const user = await findOrCreateUser(
      db,
      env,
      claims('https://lh3.googleusercontent.com/a/keep=s96-c'),
      'a@example.com',
    )
    await findOrCreateUser(db, env, claims(), 'a@example.com')
    expect(await storedAvatar(db, user.id)).toBe('https://lh3.googleusercontent.com/a/keep=s96-c')
  })

  test('a photo from a non-Google host is never stored', async () => {
    const db = makeDb()
    const user = await findOrCreateUser(db, env, claims('https://evil.example.com/pic.png'), 'a@example.com')
    expect(await storedAvatar(db, user.id)).toBeNull()
  })
})
