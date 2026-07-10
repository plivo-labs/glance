import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import { bootstrapSuperadminByEmail } from '../db/repo'
import { users } from '../db/schema'
import { findOrCreateUser } from '../routes/auth'
import { makeDb, seedUser } from '../test/harness'
import { NEWEST_RELEASE_DATE } from './catalog'

const drizzleDir = join(import.meta.dir, '..', '..', 'drizzle')
// The migrations that existed BEFORE 0011 — the "old" world a pre-existing user lives in.
const THROUGH_0010 = [
  '0000_init',
  '0001_steep_black_bolt',
  '0002_silly_gertrude_yorkes',
  '0003_rename_group_visibility',
  '0004_drop_public_visibility',
  '0005_peaceful_onslaught',
  '0006_glance_documents',
  '0007_add_indexes',
  '0008_comment_audio_key',
  '0009_editor_share',
  '0010_notifications',
]

function apply(sqlite: Database, tag: string) {
  const sql = readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) sqlite.run(t)
  }
}

describe('B1 migrate.0011 upgrades an existing DB (not just the final schema)', () => {
  test('a user present BEFORE 0011 survives and is backfilled to the newest release date', () => {
    const sqlite = new Database(':memory:')
    for (const tag of THROUGH_0010) apply(sqlite, tag)
    // A real row inserted in the pre-0011 world (no lastSeenReleaseAt column yet).
    sqlite.run("INSERT INTO users (id, email, role, createdAt) VALUES ('u-old', 'old@example.com', 'member', '2026-01-01T00:00:00.000Z')")

    apply(sqlite, '0011_whats_new_watermark')

    const cols = (sqlite.query('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('lastSeenReleaseAt')
    const row = sqlite.query("SELECT lastSeenReleaseAt AS w FROM users WHERE id='u-old'").get() as { w: string }
    // Pin the FROZEN migration literal, not the live NEWEST_RELEASE_DATE — migration 0011 is
    // immutable, so once a newer note is added the catalog constant advances while this stays.
    expect(row.w).toBe('2026-07-01T15:00:00.000Z')
  })

  test('a user seeded AFTER all migrations, with no watermark field, is SQL NULL', async () => {
    const db = makeDb()
    const uid = await seedUser(db, { id: 'u-new' })
    const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, uid)))[0]
    expect(row.w).toBeNull()
  })
})

describe('S10 caught-up default on the insert paths (unit)', () => {
  test('findOrCreateUser stamps a new user with the newest release date', async () => {
    const db = makeDb()
    const env = { SUPERADMIN_EMAIL: 'boss@example.com' } as never
    const u = await findOrCreateUser(db, env, { sub: 'g-1', name: 'A' } as never, 'a@example.com')
    const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, u.id)))[0]
    expect(row.w).toBe(NEWEST_RELEASE_DATE as string)
  })

  test('bootstrapSuperadminByEmail writes the caught-up watermark the auth path passes in', async () => {
    const db = makeDb()
    const u = await bootstrapSuperadminByEmail(db, 'boss@example.com', 'Boss', NEWEST_RELEASE_DATE)
    const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, u.id)))[0]
    expect(row.w).toBe(NEWEST_RELEASE_DATE as string)
  })
  test('bootstrapSuperadminByEmail defaults the watermark to null (keeps repo.ts catalog-free)', async () => {
    const db = makeDb()
    const u = await bootstrapSuperadminByEmail(db, 'boss2@example.com', 'Boss2')
    const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, u.id)))[0]
    expect(row.w).toBeNull()
  })
})
