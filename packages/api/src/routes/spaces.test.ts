import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, makeR2, seedFile, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { spaces } from './spaces'

// Spaces routes mounted the way index.ts mounts them (requireSameOrigin global + spaces under
// /api/spaces) so CSRF, auth and ownership are exercised end to end. GLANCE_FILES is a real R2
// mock so the delete path's object purge is observable.

const APP_URL = 'https://glance.example.com'

async function setup() {
  const db = makeDb()
  const kv = makeKv()
  const r2 = makeR2()
  const env = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv, GLANCE_FILES: r2 } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/spaces', spaces)
  return { db, kv, r2, app, env }
}

async function mintUser(
  db: ReturnType<typeof makeDb>,
  kv: ReturnType<typeof makeKv>,
  id: string,
  role: 'member' | 'superadmin' = 'member',
) {
  await seedUser(db, { id, role })
  await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@example.com`, name: null, role }))
  return id
}

const auth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL, 'Content-Type': 'application/json' })

const invite = (app: Hono<AppEnv>, env: AppEnv['Bindings'], slug: string, id: string, body: unknown) =>
  app.request(`/api/spaces/${slug}/members`, { method: 'POST', headers: auth(id), body: JSON.stringify(body) }, env)

const del = (app: Hono<AppEnv>, env: AppEnv['Bindings'], slug: string, id: string) =>
  app.request(`/api/spaces/${slug}`, { method: 'DELETE', headers: auth(id) }, env)

describe('POST /api/spaces/:slug/members', () => {
  test('re-inviting an existing member is an idempotent 200 (composite-PK collision swallowed)', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')
    await seedMember(db, 'g', 'u2') // u2 already a member

    const res = await invite(app, env, 'acme', 'u1', { email: 'u2@example.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  test('inviting a member to a personal space is rejected with 409', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    await seedSpace(db, { id: 'p', createdBy: 'u1', slug: 'u1-personal', type: 'personal' })
    await seedMember(db, 'p', 'u1')

    const res = await invite(app, env, 'u1-personal', 'u1', { email: 'u2@example.com' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'cannot invite members to a personal space' })
  })

  test('a real (non-UNIQUE) write failure surfaces as a 5xx, not a false ok', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')

    // Break the membership insert with a non-constraint error AFTER seeding is done.
    db.insert = (() => {
      throw new Error('disk I/O error')
    }) as typeof db.insert

    const res = await invite(app, env, 'acme', 'u1', { email: 'u2@example.com' })
    expect(res.status).toBe(500)
  })
})

describe('DELETE /api/spaces/:slug', () => {
  test('purges every site’s R2 objects in the space, then removes the space', async () => {
    const { db, kv, r2, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')
    const s1 = await seedSite(db, { spaceId: 'g', ownerId: 'u1', slug: 'one' })
    const s2 = await seedSite(db, { spaceId: 'g', ownerId: 'u1', slug: 'two' })
    const k1 = await seedFile(db, r2, s1, { path: 'index.html', text: '<h1>one</h1>' })
    const k2 = await seedFile(db, r2, s2, { path: 'index.html', text: '<h1>two</h1>' })
    expect(r2.store.has(k1)).toBe(true)
    expect(r2.store.has(k2)).toBe(true)

    const res = await del(app, env, 'acme', 'u1')
    expect(res.status).toBe(200)
    expect(r2.store.has(k1)).toBe(false)
    expect(r2.store.has(k2)).toBe(false)
    // Space row is gone.
    const gone = await app.request('/api/spaces/acme', { headers: auth('u1') }, env)
    expect(gone.status).toBe(404)
  })

  test('owner cannot delete a group space holding sites owned by other members (409)', async () => {
    const { db, kv, r2, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')
    await seedMember(db, 'g', 'u2')
    await seedSite(db, { spaceId: 'g', ownerId: 'u1', slug: 'mine' })
    const other = await seedSite(db, { spaceId: 'g', ownerId: 'u2', slug: 'theirs' })
    const k = await seedFile(db, r2, other, { path: 'index.html', text: '<h1>theirs</h1>' })

    const res = await del(app, env, 'acme', 'u1')
    expect(res.status).toBe(409)
    // Nothing destroyed: the other member's object survives the refused delete.
    expect(r2.store.has(k)).toBe(true)
  })

  test('superadmin may delete a group space holding other members’ sites (bypass)', async () => {
    const { db, kv, r2, app, env } = await setup()
    await mintUser(db, kv, 'admin', 'superadmin')
    await mintUser(db, kv, 'u1')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')
    const other = await seedSite(db, { spaceId: 'g', ownerId: 'u1', slug: 'theirs' })
    const k = await seedFile(db, r2, other, { path: 'index.html', text: '<h1>theirs</h1>' })

    const res = await del(app, env, 'acme', 'admin')
    expect(res.status).toBe(200)
    expect(r2.store.has(k)).toBe(false)
  })
})

describe('GET /api/spaces/:slug/sites — audio flag (W4-2)', () => {
  test('a pure-audio site is flagged audio:true; an html site audio:false', async () => {
    const { db, kv, r2, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await seedSpace(db, { id: 'sp', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'sp', 'u1')
    const voice = await seedSite(db, { spaceId: 'sp', ownerId: 'u1', slug: 'a-take' })
    await seedFile(db, r2, voice, { path: 'recording.webm', text: 'bytes' })
    const web = await seedSite(db, { spaceId: 'sp', ownerId: 'u1', slug: 'a-page' })
    await seedFile(db, r2, web, { path: 'index.html', text: '<h1>hi</h1>' })

    const res = await app.request('/api/spaces/acme/sites', { headers: auth('u1') }, env)
    expect(res.status).toBe(200)
    const list = (await res.json()) as { siteSlug: string; audio: boolean }[]
    const bySlug = Object.fromEntries(list.map((s) => [s.siteSlug, s.audio]))
    expect(bySlug['a-take']).toBe(true)
    expect(bySlug['a-page']).toBe(false)
  })
})
