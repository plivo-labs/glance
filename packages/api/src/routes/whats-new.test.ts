import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { bootstrapSuperadminByEmail } from '../db/repo'
import { getWatermark } from '../db/whats-new'
import { users } from '../db/schema'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { NEWEST_RELEASE_DATE, RELEASES } from '../whats-new/catalog'
import { findOrCreateUser } from './auth'
import { whatsNew } from './whats-new'

const APP_URL = 'https://glance.example.com'
// A watermark strictly between the two seeded releases (2026-06-20 links, 2026-07-01 voice), so
// exactly the newest one is unread.
const MID = '2026-06-25T00:00:00.000Z'

function setup() {
  const db = makeDb()
  const kv = makeKv()
  const env = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/whats-new', whatsNew)
  return { db, kv, env, app }
}

async function mintBearer(kv: ReturnType<typeof makeKv>, id: string) {
  await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@example.com`, name: id, role: 'member' }))
  return { Authorization: `Bearer tok-${id}`, Origin: APP_URL, 'Content-Type': 'application/json' }
}

describe('C6 route.auth.401 — unauthenticated GET and POST both 401, watermark untouched', () => {
  test('GET without a bearer → 401', async () => {
    const { app, env } = setup()
    const res = await app.request('/api/whats-new', { headers: { Origin: APP_URL } }, env)
    expect(res.status).toBe(401)
  })
  test('POST /seen without a bearer → 401 and the state-changer never runs', async () => {
    const { app, db, env } = setup()
    const id = await seedUser(db, { id: 'u1' })
    await db.update(users).set({ lastSeenReleaseAt: MID }).where(eq(users.id, id))
    const res = await app.request(
      '/api/whats-new/seen',
      { method: 'POST', headers: { Origin: APP_URL, 'Content-Type': 'application/json' }, body: JSON.stringify({ throughDate: NEWEST_RELEASE_DATE }) },
      env,
    )
    expect(res.status).toBe(401)
    expect(await getWatermark(db, id)).toBe(MID)
  })
})

describe('C7 route.get.exactJSON — exact ordered items, unreadCount, throughDate', () => {
  test('mid watermark → exact slugs/dates/bodies + unreadCount 1 + throughDate===newest', async () => {
    const { app, db, kv, env } = setup()
    const id = await seedUser(db, { id: 'u1' })
    await db.update(users).set({ lastSeenReleaseAt: MID }).where(eq(users.id, id))
    const res = await app.request('/api/whats-new', { headers: await mintBearer(kv, id) }, env)
    expect(res.status).toBe(200)
    // Whole-response deep-equal, not key-presence: a dropped item field or an extra top-level key fails.
    expect(await res.json()).toEqual({
      items: JSON.parse(JSON.stringify(RELEASES)),
      unreadCount: 1,
      throughDate: NEWEST_RELEASE_DATE,
    })
  })
})

describe('C8 route.seen.malformed.400 — bad throughDate → 400, watermark unchanged', () => {
  const bad: Array<[string, unknown]> = [
    ['offset not Z', { throughDate: '2026-07-01T15:00:00+05:30' }],
    ['date-only', { throughDate: '2026-07-01' }],
    ['variable precision', { throughDate: '2026-07-01T15:00:00.1Z' }],
    ['invalid calendar date', { throughDate: '2026-02-30T00:00:00.000Z' }],
    ['missing throughDate', {}],
    ['non-string throughDate', { throughDate: 123 }],
  ]
  for (const [label, body] of bad) {
    test(`${label} → 400`, async () => {
      const { app, db, kv, env } = setup()
      const id = await seedUser(db, { id: 'u1' })
      await db.update(users).set({ lastSeenReleaseAt: MID }).where(eq(users.id, id))
      const res = await app.request('/api/whats-new/seen', { method: 'POST', headers: await mintBearer(kv, id), body: JSON.stringify(body) }, env)
      expect(res.status).toBe(400)
      expect(await getWatermark(db, id)).toBe(MID)
    })
  }
  test('malformed JSON body → 400, watermark unchanged', async () => {
    const { app, db, kv, env } = setup()
    const id = await seedUser(db, { id: 'u1' })
    await db.update(users).set({ lastSeenReleaseAt: MID }).where(eq(users.id, id))
    const res = await app.request('/api/whats-new/seen', { method: 'POST', headers: await mintBearer(kv, id), body: 'not json{' }, env)
    expect(res.status).toBe(400)
    expect(await getWatermark(db, id)).toBe(MID)
  })
})

describe('C9 route.seen.advances — POST then GET reflects 0 unread', () => {
  test('POST /seen {throughDate:newest} → next GET unreadCount 0', async () => {
    const { app, db, kv, env } = setup()
    const id = await seedUser(db, { id: 'u1' }) // null watermark → all unread
    const headers = await mintBearer(kv, id)
    const post = await app.request('/api/whats-new/seen', { method: 'POST', headers, body: JSON.stringify({ throughDate: NEWEST_RELEASE_DATE }) }, env)
    expect(post.status).toBe(200)
    const get = await app.request('/api/whats-new', { headers }, env)
    expect(((await get.json()) as { unreadCount: number }).unreadCount).toBe(0)
  })
})

describe('B2 newuser.caughtUp — created through the real insert paths → 0 unread', () => {
  test('findOrCreateUser then GET → unreadCount 0, throughDate===newest', async () => {
    const { app, db, kv, env } = setup()
    const u = await findOrCreateUser(db, { SUPERADMIN_EMAIL: 'boss@example.com' } as never, { sub: 'g1', name: 'A' } as never, 'a@example.com')
    const res = await app.request('/api/whats-new', { headers: await mintBearer(kv, u.id) }, env)
    const json = (await res.json()) as { unreadCount: number; throughDate: string }
    expect(json.unreadCount).toBe(0)
    expect(json.throughDate).toBe(NEWEST_RELEASE_DATE as string)
  })
  test('bootstrapSuperadminByEmail (auth path passes the watermark) → 0 unread', async () => {
    const { app, db, kv, env } = setup()
    const u = await bootstrapSuperadminByEmail(db, 'boss@example.com', 'Boss', NEWEST_RELEASE_DATE)
    const res = await app.request('/api/whats-new', { headers: await mintBearer(kv, u.id) }, env)
    expect(((await res.json()) as { unreadCount: number }).unreadCount).toBe(0)
  })
})

describe('B3 relogin.noReset — the existing-user branch must not clear an existing watermark', () => {
  test('re-running findOrCreateUser leaves a mid watermark + unreadCount unchanged', async () => {
    const { app, db, kv, env } = setup()
    const first = await findOrCreateUser(db, { SUPERADMIN_EMAIL: 'boss@example.com' } as never, { sub: 'g1', name: 'A' } as never, 'a@example.com')
    // Simulate a user who has NOT caught up: roll their watermark back to a middle value.
    await db.update(users).set({ lastSeenReleaseAt: MID }).where(eq(users.id, first.id))
    const before = await getWatermark(db, first.id)
    // Re-login: same googleId/email → the existing-user branch (updates name/googleId only).
    await findOrCreateUser(db, { SUPERADMIN_EMAIL: 'boss@example.com' } as never, { sub: 'g1', name: 'A2' } as never, 'a@example.com')
    expect(await getWatermark(db, first.id)).toBe(before as string)
    const res = await app.request('/api/whats-new', { headers: await mintBearer(kv, first.id) }, env)
    expect(((await res.json()) as { unreadCount: number }).unreadCount).toBe(1)
  })
})
