import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { apiKeys } from '../db/schema'
import { makeDb, seedApiKey, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { API_KEY_PREFIX, apiKeyDb, generateApiKey, hashApiKey, resolveApiKey } from './api-key'
import { b64urlDecode } from './hmac'

describe('generateApiKey', () => {
  test('returns a "glk_"-prefixed, unpadded base64url secret carrying 32 CSPRNG bytes', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.startsWith('glk_')).toBe(true)
    expect(a).not.toEqual(b)

    const payload = a.slice(API_KEY_PREFIX.length)
    expect(payload).not.toContain('=')
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(b64urlDecode(payload)).toHaveLength(32)
  })
})

describe('hashApiKey', () => {
  test('is the plain SHA-256 hex digest of the UTF-8 secret, no salt/pepper (known vector)', async () => {
    // Known-answer vector — pins the exact bytes hashed. Seeded rows in other tests derive
    // their hash from hashApiKey itself, so only this fixed vector catches a change to what
    // gets hashed (e.g. a prepended pepper or altered encoding).
    expect(await hashApiKey('glk_test-secret')).toEqual(
      'f4866cfe9ce3d1ae85dffc3709cbbea3d1d157cf4d9046fd8b5276b9d6433371',
    )
  })

  test('is deterministic lowercase hex SHA-256 of the secret', async () => {
    const hash = await hashApiKey('glk_test-secret')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashApiKey('glk_test-secret')).toEqual(hash)
  })
})

describe('resolveApiKey', () => {
  test('CASE-01: a key whose expiresAt is one second in the past does not resolve', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const secret = generateApiKey()
    const hash = await hashApiKey(secret)
    const expiresAt = new Date(Date.now() - 1000).toISOString()
    await seedApiKey(db, { userId: uid, hash, expiresAt })

    expect(await resolveApiKey(db, secret)).toBeNull()
  })

  test('CASE-03: a key expiring later today resolves and maps id/userId/grants correctly (happy path — NOT the datetime(now) trap; see CASE-01 for that)', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const secret = generateApiKey()
    const hash = await hashApiKey(secret)
    // Same-day expiry a few hours out. This does NOT catch the datetime('now') space-vs-T trap:
    // lexically '<today>T<laterHours>...Z' > '<today> <nowHours>...' (space 0x20 < 'T' 0x54) is
    // ALWAYS true regardless of the hours, so this case stays green even under the buggy
    // `sql`datetime('now')`` predicate. CASE-01 (an already-expired key) is what actually kills
    // that mutation — this test only pins field mapping (id/userId/grants) on the happy path.
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    await seedApiKey(db, { userId: uid, hash, expiresAt })

    const resolved = await resolveApiKey(db, secret)
    expect(resolved).toEqual({ id: expect.any(String), userId: uid, grants: [] })
  })

  test('CASE-04: non-empty grants round-trip through resolveApiKey unchanged', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const secret = generateApiKey()
    const hash = await hashApiKey(secret)
    const grants = { scopes: ['sites:read', 'sites:write'] }
    await seedApiKey(db, { userId: uid, hash, grants })

    const resolved = await resolveApiKey(db, secret)
    expect(resolved).toEqual({ id: expect.any(String), userId: uid, grants })
  })

  test('CASE-02: a revoked key does not resolve, but its row is still readable directly (tombstone)', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const secret = generateApiKey()
    const hash = await hashApiKey(secret)
    const id = await seedApiKey(db, { userId: uid, hash, revokedAt: new Date().toISOString() })

    expect(await resolveApiKey(db, secret)).toBeNull()
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id))
    expect(row).toBeDefined()
    expect(row.revokedAt).not.toBeNull()
  })

  test('CASE-05: the plaintext secret appears nowhere in the stored row', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const secret = generateApiKey()
    const hash = await hashApiKey(secret)
    const id = await seedApiKey(db, { userId: uid, hash })

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id))
    expect(JSON.stringify(row)).not.toContain(secret)
  })

  test('an unknown hash resolves to null', async () => {
    const db = makeDb()
    expect(await resolveApiKey(db, 'glk_never-issued')).toBeNull()
  })

  test('an unparseable grants blob resolves to null (fail closed), not throw', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const secret = generateApiKey()
    const hash = await hashApiKey(secret)
    const id = await seedApiKey(db, { userId: uid, hash })
    // Bypass drizzle's json-mode serialization to plant a corrupt blob directly.
    await db.run(sql`update api_keys set grants = 'not-json' where id = ${id}`)

    await expect(resolveApiKey(db, secret)).resolves.toBeNull()
  })
})

describe('apiKeyDb', () => {
  test('no GLANCE_DB binding → falls back to c.get(\'db\') (route-fixtures harness shape)', async () => {
    const harnessDb = makeDb()
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('db', harnessDb)
      await next()
    })
    let seen: unknown
    app.get('/x', (c) => {
      seen = apiKeyDb(c)
      return c.text('ok')
    })
    await app.request('/x', {}, {} as AppEnv['Bindings'])
    expect(seen).toBe(harnessDb)
  })

  test('GLANCE_DB bound → a first-primary session client, not the fallback db', async () => {
    const statement = {
      bind: () => statement,
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
    }
    const anchors: string[] = []
    const binding = {
      withSession: (a: string) => {
        anchors.push(a)
        return { prepare: () => statement, getBookmark: () => null }
      },
    } as unknown as D1Database
    const app = new Hono<AppEnv>()
    let seen: unknown
    app.get('/x', (c) => {
      seen = apiKeyDb(c)
      return c.text('ok')
    })
    await app.request('/x', {}, { GLANCE_DB: binding } as unknown as AppEnv['Bindings'])
    expect(anchors).toEqual(['first-primary'])
    expect(seen).toBeDefined()
  })
})
