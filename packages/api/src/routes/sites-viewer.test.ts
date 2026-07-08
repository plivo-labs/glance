import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, seedFile, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { sites } from './sites'

// Viewer metadata endpoint (GET /api/sites/:space/:site) — the source of the gated content URL.
// It reads the user inline via readSessionOrBearer, so a CLI Bearer token (no cookie) must mint
// the same `/_t/<token>/…` URL the browser viewer gets — this is what `glance read` relies on.

const APP_URL = 'https://glance.example.com'
const CONTENT_URL = 'https://content.example.com'

async function setup() {
  const db = makeDb()
  const kv = makeKv()
  const env = {
    APP_URL,
    CONTENT_URL,
    SESSION_SECRET: 's',
    CONTENT_TOKEN_SECRET: 'cts',
    GLANCE_SESSIONS: kv,
  } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/sites', sites)
  return { db, kv, app, env }
}

async function mintUser(db: ReturnType<typeof makeDb>, kv: ReturnType<typeof makeKv>, id: string, role: 'member' | 'superadmin' = 'member') {
  await seedUser(db, { id, role })
  await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@example.com`, name: null, role }))
  return id
}

const view = (app: Hono<AppEnv>, env: AppEnv['Bindings'], space: string, site: string, headers: Record<string, string> = {}) =>
  app.request(`/api/sites/${space}/${site}`, { headers }, env)

const exists = (app: Hono<AppEnv>, env: AppEnv['Bindings'], space: string, site: string, id: string) =>
  app.request(`/api/sites/${space}/${site}/exists`, { headers: { Authorization: `Bearer tok-${id}` } }, env)

describe('GET /api/sites/:space/:site (viewer metadata)', () => {
  test('CLI Bearer token mints a gated content URL', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    const space = await seedSpace(db, { createdBy: 'u1', slug: 'docs' })
    await seedMember(db, space, 'u1')
    await seedSite(db, { spaceId: space, ownerId: 'u1', slug: 'report' }) // team tier

    const res = await view(app, env, 'docs', 'report', { Authorization: 'Bearer tok-u1' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { contentUrl: string }
    expect(body.contentUrl.startsWith(`${CONTENT_URL}/_t/`)).toBe(true)
    expect(body.contentUrl.endsWith('/docs/report/')).toBe(true)
  })

  test('no auth → 401 (every tier requires a viewer)', async () => {
    const { db, app, env } = await setup()
    const space = await seedSpace(db, { createdBy: 'u1', slug: 'docs' })
    await seedSite(db, { spaceId: space, ownerId: 'u1', slug: 'report' })

    expect((await view(app, env, 'docs', 'report')).status).toBe(401)
  })

  test('unknown site → 404', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    expect((await view(app, env, 'docs', 'nope', { Authorization: 'Bearer tok-u1' })).status).toBe(404)
  })

  test('unknown site with NO auth → 404, not 401 (existence decided before auth)', async () => {
    // The concurrent site+session read must still return 404 for a missing site before any
    // auth-dependent branch — a nonexistent site never leaks as a 401 that a real one would 200.
    const { app, env } = await setup()
    expect((await view(app, env, 'docs', 'ghost')).status).toBe(404)
  })
})

// The slug-availability probe discloses existence ONLY to someone who could legitimately act on it
// (owner / space member / superadmin). Everyone else gets the identical not-found shape, so an
// unauthorized caller can't distinguish a real site from a missing one (fix #14).
describe('GET /api/sites/:space/:site/exists (slug-availability probe)', () => {
  async function seedProbe() {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'owner')
    const space = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    await seedMember(db, space, 'owner')
    await seedSite(db, { spaceId: space, ownerId: 'owner', slug: 'report', visibility: 'private' })
    return { db, kv, app, env, space }
  }

  test('owner sees the site exists (owned)', async () => {
    const { app, env } = await seedProbe()
    const res = await exists(app, env, 'docs', 'report', 'owner')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: true, owned: true })
  })

  test('a space member (non-owner) sees it exists but not owned', async () => {
    const { db, kv, app, env, space } = await seedProbe()
    await mintUser(db, kv, 'mate')
    await seedMember(db, space, 'mate')
    expect(await (await exists(app, env, 'docs', 'report', 'mate')).json()).toEqual({ exists: true, owned: false })
  })

  test('superadmin (non-member) sees it exists', async () => {
    const { db, kv, app, env } = await seedProbe()
    await mintUser(db, kv, 'admin', 'superadmin')
    expect(await (await exists(app, env, 'docs', 'report', 'admin')).json()).toMatchObject({ exists: true })
  })

  test('an unrelated authed user cannot distinguish a real site from a missing one', async () => {
    const { db, kv, app, env } = await seedProbe()
    await mintUser(db, kv, 'stranger') // neither owner nor a member of docs
    const real = await exists(app, env, 'docs', 'report', 'stranger') // the site EXISTS
    const missing = await exists(app, env, 'docs', 'ghost', 'stranger') // this one does NOT
    expect(await real.json()).toEqual({ exists: false })
    expect(await missing.json()).toEqual({ exists: false })
  })
})

describe('GET /api/sites/mine — audio flag (W4-2)', () => {
  test('a pure-audio site is audio:true; a mixed site audio:false', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    const space = await seedSpace(db, { createdBy: 'u1', slug: 'me' })
    await seedMember(db, space, 'u1')
    const voice = await seedSite(db, { spaceId: space, ownerId: 'u1', slug: 'take' })
    await seedFile(db, null, voice, { path: 'recording.webm', text: 'b' }) // D1 row only
    const mixed = await seedSite(db, { spaceId: space, ownerId: 'u1', slug: 'mixed' })
    await seedFile(db, null, mixed, { path: 'song.mp3', text: 'b' })
    await seedFile(db, null, mixed, { path: 'cover.png', text: 'b' })

    const res = await app.request('/api/sites/mine', { headers: { Authorization: 'Bearer tok-u1' } }, env)
    expect(res.status).toBe(200)
    const bySlug = Object.fromEntries(((await res.json()) as { siteSlug: string; audio: boolean }[]).map((s) => [s.siteSlug, s.audio]))
    expect(bySlug.take).toBe(true)
    expect(bySlug.mixed).toBe(false)
  })
})
