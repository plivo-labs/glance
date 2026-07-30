import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { apiKeys as apiKeysTable } from '../db/schema'
import { API_KEY_PREFIX, LAST_USED_THROTTLE_MS, generateApiKey, hashApiKey } from '../lib/api-key'
import { createSession, readSessionOrBearer } from '../lib/session'
import { makeDb, makeKv, seedApiKey, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { requireAuth } from './auth'

// The seam the rest of the api-keys plan hangs off: requireAuth attaches a Credential (not just
// a user) so downstream code can tell HOW the caller authenticated. `/whoami` stands in for any
// requireAuth-guarded route and echoes back exactly what got set on the context.
function setup() {
  const db = makeDb()
  const kv = makeKv()
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.get('/whoami', requireAuth, (c) => c.json(c.get('credential')))
  // Stands in for the INLINE-auth routes (the viewer endpoint `glance read` hits), which call
  // readSessionOrBearer directly instead of running requireAuth. It must resolve the same
  // credentials the middleware does — see the projection test below.
  app.get('/inline', async (c) => {
    const user = await readSessionOrBearer(c)
    return user ? c.json(user) : c.json({ error: 'unauthorized' }, 401)
  })
  const env = {
    GLANCE_SESSIONS: kv,
    SESSION_SECRET: 'sekret',
    APP_URL: 'https://glance.example.com',
  } as unknown as AppEnv['Bindings']
  return { app, db, kv, env }
}

async function sessionCookie(
  app: Hono<AppEnv>,
  env: AppEnv['Bindings'],
  user: { id: string; email: string; name: string | null; role: 'member' | 'superadmin' },
) {
  app.get('/login', async (c) => {
    await createSession(c, user)
    return c.text('ok')
  })
  const res = await app.request('/login', {}, env)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

describe('requireAuth credential dispatch', () => {
  test('a session-cookie caller yields kind "session"', async () => {
    const { app, db, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const cookie = await sessionCookie(app, env, { id: uid, email: 'u1@x.com', name: null, role: 'member' })

    const res = await app.request('/whoami', { headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'session', user: { id: uid } })
  })

  test('CASE-06: an existing KV CLI (plain Bearer) token still authenticates, yielding kind "cli"', async () => {
    const { app, db, kv, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    await kv.put(`cli:tok-${uid}`, JSON.stringify({ id: uid, email: 'u1@x.com', name: null, role: 'member' }))

    const res = await app.request('/whoami', { headers: { Authorization: `Bearer tok-${uid}` } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'cli', user: { id: uid } })
  })

  test('a live glk_ key yields kind "key" with keyId and grants', async () => {
    const { app, db, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const secret = generateApiKey()
    const hash = await hashApiKey(secret)
    const grants = { control: true, data: { scope: { kind: 'all-owned' as const }, caps: ['read' as const] } }
    const keyId = await seedApiKey(db, { userId: uid, hash, grants })

    const res = await app.request('/whoami', { headers: { Authorization: `Bearer ${secret}` } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'key', keyId, grants, user: { id: uid } })
  })

  test('CASE-04: an unknown glk_ token 401s and never falls through to the KV CLI lookup', async () => {
    const { app, db, kv, env } = setup()
    // Composed from the exported prefix rather than written out — a literal key-shaped string
    // here trips the repo's pre-commit secret scanner.
    const token = `${API_KEY_PREFIX}definitely-not-issued`
    // The KV-planted user must be a REAL D1 row — otherwise a fall-through would still 401 via
    // requireAuth's live getUserById re-resolution, masking the exact bug this case exists to
    // catch. With the user seeded, a fall-through authenticates as 200, not a coincidental 401.
    const uid = await seedUser(db, { id: 'ghost' })
    // Plant a live CLI-token KV entry under this EXACT string. If prefix dispatch fell through to
    // the KV lookup on a failed D1 resolve, this would authenticate — it must not, in either
    // direction: a glk_ token never gets a shot at the CLI store.
    await kv.put(`cli:${token}`, JSON.stringify({ id: uid, email: 'ghost@x.com', name: null, role: 'member' }))

    const res = await app.request('/whoami', { headers: { Authorization: `Bearer ${token}` } }, env)
    expect(res.status).toBe(401)
  })

  // readSessionOrBearer is a PROJECTION of readCredential, not a second resolver. Reverting it to
  // its own readSession -> readCliToken implementation leaves every test above green while silently
  // 401ing API keys on the inline-auth routes — which is the whole `glance read` path. This is the
  // test that fails when the two paths drift apart.
  test('readSessionOrBearer resolves a glk_ key too, so inline-auth routes accept API keys', async () => {
    const { app, db, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const secret = generateApiKey()
    await seedApiKey(db, { userId: uid, hash: await hashApiKey(secret) })

    const res = await app.request('/inline', { headers: { Authorization: `Bearer ${secret}` } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: uid })
  })

  // Resolution order, step 1: the cookie is checked BEFORE the Authorization header. A browser
  // request that also carries a key must resolve as its logged-in user, not as the key's owner —
  // otherwise `credential.kind` would disagree with requireAuth's 'web' authKind tag.
  test('the session cookie wins over a Bearer glk_ key on the same request', async () => {
    const { app, db, env } = setup()
    const owner = await seedUser(db, { id: 'u1' })
    const keyOwner = await seedUser(db, { id: 'u2' })
    const secret = generateApiKey()
    await seedApiKey(db, { userId: keyOwner, hash: await hashApiKey(secret) })
    const cookie = await sessionCookie(app, env, { id: owner, email: 'u1@x.com', name: null, role: 'member' })

    const res = await app.request(
      '/whoami',
      { headers: { Cookie: cookie, Authorization: `Bearer ${secret}` } },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'session', user: { id: owner } })
  })
})

describe('api key lastUsedAt touch', () => {
  test('CASE-18: two authed requests inside the throttle window write lastUsedAt exactly once', async () => {
    const { app, db, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const secret = generateApiKey()
    await seedApiKey(db, { userId: uid, hash: await hashApiKey(secret), lastUsedAt: null })
    db.resetCounters()

    await app.request('/whoami', { headers: { Authorization: `Bearer ${secret}` } }, env)
    await app.request('/whoami', { headers: { Authorization: `Bearer ${secret}` } }, env)

    expect(db.counters.update).toBe(1)
  })

  test('a first-ever use writes lastUsedAt; a use after the window elapses writes again', async () => {
    const { app, db, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const secret = generateApiKey()
    const keyId = await seedApiKey(db, { userId: uid, hash: await hashApiKey(secret), lastUsedAt: null })
    db.resetCounters()

    await app.request('/whoami', { headers: { Authorization: `Bearer ${secret}` } }, env)
    expect(db.counters.update).toBe(1)
    const [afterFirst] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, keyId))
    expect(afterFirst.lastUsedAt).not.toBeNull()

    // Back-date lastUsedAt past the throttle window to simulate elapsed time.
    const stale = new Date(Date.now() - LAST_USED_THROTTLE_MS - 1000).toISOString()
    await db.update(apiKeysTable).set({ lastUsedAt: stale }).where(eq(apiKeysTable.id, keyId))
    db.resetCounters()

    await app.request('/whoami', { headers: { Authorization: `Bearer ${secret}` } }, env)
    expect(db.counters.update).toBe(1)
    const [afterSecond] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, keyId))
    expect(afterSecond.lastUsedAt).not.toBe(stale)
  })

  test('a request whose lastUsedAt write THROWS still returns its normal authenticated response', async () => {
    const { app, db, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const secret = generateApiKey()
    await seedApiKey(db, { userId: uid, hash: await hashApiKey(secret), lastUsedAt: null })
    const originalUpdate = db.update.bind(db)
    db.update = (() => {
      throw new Error('boom')
    }) as typeof db.update

    const res = await app.request('/whoami', { headers: { Authorization: `Bearer ${secret}` } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'key', user: { id: uid } })

    db.update = originalUpdate
  })

  test('the CLI-token and cookie paths perform no api_keys write at all', async () => {
    const { app, db, kv, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    await kv.put(`cli:tok-${uid}`, JSON.stringify({ id: uid, email: 'u1@x.com', name: null, role: 'member' }))
    // Registers a route on `app`, so it must happen before any app.request() call builds the
    // matcher (Hono freezes routing on first dispatch) — same ordering the other cookie tests use.
    const cookie = await sessionCookie(app, env, { id: uid, email: 'u1@x.com', name: null, role: 'member' })

    db.resetCounters()
    const cliRes = await app.request('/whoami', { headers: { Authorization: `Bearer tok-${uid}` } }, env)
    expect(cliRes.status).toBe(200)
    expect(db.counters.update).toBe(0)

    db.resetCounters()
    const cookieRes = await app.request('/whoami', { headers: { Cookie: cookie } }, env)
    expect(cookieRes.status).toBe(200)
    expect(db.counters.update).toBe(0)
  })
})
