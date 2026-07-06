import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { events } from '../db/schema'
import { parseCliVersion } from '../lib/events'
import { readSessionOrBearer } from '../lib/session'
import { makeDb, makeKv, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { trackCliUsage } from './analytics'
import { requireAuth } from './auth'

// Mirror index.ts's chain: inject the harness db, tag the credential (requireAuth), track usage.
// A route guarded by requireAuth stands in for any CLI-reachable endpoint.
function setup() {
  const db = makeDb()
  const kv = makeKv()
  const app = new Hono<AppEnv>()
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.use('/api/*', trackCliUsage)
  app.get('/api/upload/:a/:b', requireAuth, (c) => c.json({ ok: true }))
  app.get('/api/sites/:a', requireAuth, (c) => c.json({ ok: true }))
  // The viewer-metadata GET that `glance read` hits authenticates INLINE (readSessionOrBearer) to
  // shape its own 404/403 JSON — it never runs requireAuth, so `authKind`/`user` stay unset. Stands
  // in for that route to prove trackCliUsage still records a CLI read it doesn't own the auth for.
  app.get('/api/sites/:space/:site', async (c) => {
    const user = await readSessionOrBearer(c)
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    return c.json({ contentUrl: 'https://content.example.com/x/' })
  })
  const env = { GLANCE_SESSIONS: kv, SESSION_SECRET: 'sekret', APP_URL: 'https://glance.example.com' }
  return { app, db, kv, env }
}

describe('parseCliVersion', () => {
  test('extracts semver from a glance-cli User-Agent', () => {
    expect(parseCliVersion('glance-cli/1.4.2')).toBe('1.4.2')
  })
  test('returns null for browsers / unknown / missing agents', () => {
    expect(parseCliVersion('Mozilla/5.0')).toBeNull()
    expect(parseCliVersion(undefined)).toBeNull()
    expect(parseCliVersion('glance-cli')).toBeNull()
  })
})

describe('trackCliUsage', () => {
  async function cliToken(kv: ReturnType<typeof makeKv>, userId: string) {
    await kv.put(
      `cli:tok-${userId}`,
      JSON.stringify({ id: userId, email: `${userId}@x.com`, name: null, role: 'member' }),
    )
    return `tok-${userId}`
  }

  test('a Bearer (CLI) request records one cli event with action + version', async () => {
    const { app, db, kv, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const tok = await cliToken(kv, uid)

    const res = await app.request(
      '/api/upload/acme/site',
      { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'glance-cli/2.0.0' } },
      env,
    )
    expect(res.status).toBe(200)

    const rows = await db.select().from(events)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'cli', action: 'upload', userId: uid, cliVersion: '2.0.0' })
  })

  test('action is the top-level resource segment (sites, not the slug)', async () => {
    const { app, db, kv, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const tok = await cliToken(kv, uid)

    await app.request('/api/sites/acme', { headers: { Authorization: `Bearer ${tok}` } }, env)

    const rows = await db.select().from(events)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'cli', action: 'sites', cliVersion: null })
  })

  test('#22: `glance read` (inline-auth route, no requireAuth) is still tracked', async () => {
    const { app, db, kv, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const tok = await cliToken(kv, uid)

    const res = await app.request(
      '/api/sites/acme/demo',
      { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'glance-cli/3.1.0' } },
      env,
    )
    expect(res.status).toBe(200)

    const rows = await db.select().from(events)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'cli', action: 'sites', userId: uid, cliVersion: '3.1.0' })
  })

  test('cookie wins: a request carrying a session cookie is web, not CLI, so it is NOT tracked', async () => {
    const { app, db, kv, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const tok = await cliToken(kv, uid)
    // Both a cookie AND a Bearer: the presence of the cookie flips the request to 'web' (the exact
    // rule requireAuth uses). The route still 200s via the Bearer fallback, but nothing is recorded.
    const res = await app.request(
      '/api/sites/acme/demo',
      { headers: { Authorization: `Bearer ${tok}`, Cookie: 'glance_session=irrelevant' } },
      env,
    )
    expect(res.status).toBe(200)
    expect(await db.select().from(events)).toHaveLength(0)
  })

  test('an unauthorized request (bad token) records nothing', async () => {
    const { app, db, env } = setup()
    const res = await app.request('/api/upload/acme/site', { headers: { Authorization: 'Bearer nope' } }, env)
    expect(res.status).toBe(401)
    expect(await db.select().from(events)).toHaveLength(0)
  })
})
