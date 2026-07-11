import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { seedFile, seedGroupShare, seedMember, seedSite, seedSpace, seedUserShare } from '../test/harness'
import { makeRouteApp, mintUser as mintFixtureUser } from '../test/route-fixtures'
import type { AppEnv } from '../types'

// Viewer metadata endpoint (GET /api/sites/:space/:site) — the source of the gated content URL.
// It reads the user inline via readSessionOrBearer, so a CLI Bearer token (no cookie) must mint
// the same `/_t/<token>/…` URL the browser viewer gets — this is what `glance read` relies on.

const CONTENT_URL = 'https://content.example.com'

const setup = async () => makeRouteApp()

const mintUser = (
  db: ReturnType<typeof makeRouteApp>['db'],
  kv: ReturnType<typeof makeRouteApp>['kv'],
  id: string,
  role: 'member' | 'superadmin' = 'member',
) => mintFixtureUser(db, kv, id, { role })

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
    expect(await res.json()).toEqual({ exists: true, owned: true, canReplace: true, contentVersion: 0 })
  })

  test('a space member (non-owner) sees it exists but not owned', async () => {
    const { db, kv, app, env, space } = await seedProbe()
    await mintUser(db, kv, 'mate')
    await seedMember(db, space, 'mate')
    expect(await (await exists(app, env, 'docs', 'report', 'mate')).json()).toEqual({ exists: true, owned: false, canReplace: false, contentVersion: 0 })
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

describe('GET /api/sites/:space/:site — indexPath (root-file resolution)', () => {
  test('single audio file → indexPath is that file, so the viewer plays it at the site root', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    const space = await seedSpace(db, { createdBy: 'u1', slug: 'me' })
    await seedMember(db, space, 'u1')
    const site = await seedSite(db, { spaceId: space, ownerId: 'u1', slug: 'take' })
    await seedFile(db, null, site, { path: 'recording.webm', text: 'b' })

    const body = (await (await view(app, env, 'me', 'take', { Authorization: 'Bearer tok-u1' })).json()) as { indexPath: string }
    expect(body.indexPath).toBe('recording.webm')
  })

  test('index.html wins over other files; a multi-file site with no index → empty', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    const space = await seedSpace(db, { createdBy: 'u1', slug: 'me' })
    await seedMember(db, space, 'u1')
    const withIndex = await seedSite(db, { spaceId: space, ownerId: 'u1', slug: 'html' })
    await seedFile(db, null, withIndex, { path: 'index.html', text: 'b' })
    await seedFile(db, null, withIndex, { path: 'about.html', text: 'b' })
    const noIndex = await seedSite(db, { spaceId: space, ownerId: 'u1', slug: 'dir' })
    await seedFile(db, null, noIndex, { path: 'a.html', text: 'b' })
    await seedFile(db, null, noIndex, { path: 'b.html', text: 'b' })

    const idx = (await (await view(app, env, 'me', 'html', { Authorization: 'Bearer tok-u1' })).json()) as { indexPath: string }
    const dir = (await (await view(app, env, 'me', 'dir', { Authorization: 'Bearer tok-u1' })).json()) as { indexPath: string }
    expect(idx.indexPath).toBe('index.html')
    expect(dir.indexPath).toBe('')
  })
})

// S7 pins — the meta route's share-reach contract, via the PUBLIC endpoint. `role` in the response
// is the DIRECT share role only: a group-only reacher gets access (200) but NO role field, canReplace
// false, and no manifest — group shares never confer edit capability. Pinned before the single-resolve
// refactor so the response shape provably cannot drift.
describe('GET /api/sites/:space/:site — share-reach role resolution (S7 pins)', () => {
  type MetaBody = { role?: string; canReplace?: boolean; files?: string[]; contentVersion?: number }

  // Private site: only an explicit share (or owner/superadmin) reaches it — no tier fallback.
  async function seedPrivate() {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'owner')
    const space = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    await seedMember(db, space, 'owner')
    const site = await seedSite(db, { spaceId: space, ownerId: 'owner', slug: 'report', visibility: 'private' })
    await seedFile(db, null, site, { path: 'index.html', text: 'b' })
    return { db, kv, app, env, site }
  }

  test('meta.groupOnly.viewerAccess: 200 with NO role field, canReplace:false, no manifest', async () => {
    const { db, kv, app, env, site } = await seedPrivate()
    await mintUser(db, kv, 'gv')
    const grp = await seedSpace(db, { createdBy: 'owner', slug: 'grp' })
    await seedMember(db, grp, 'gv')
    await seedGroupShare(db, site, grp)

    const res = await view(app, env, 'docs', 'report', { Authorization: 'Bearer tok-gv' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MetaBody
    expect('role' in body).toBe(false)
    expect(body.canReplace).toBe(false)
    expect(body.files).toBeUndefined()
    expect(body.contentVersion).toBeUndefined()
  })

  test('meta.directViewer: role viewer, canReplace:false, no manifest', async () => {
    const { db, kv, app, env, site } = await seedPrivate()
    await mintUser(db, kv, 'dv')
    await seedUserShare(db, site, 'dv', 'viewer')

    const res = await view(app, env, 'docs', 'report', { Authorization: 'Bearer tok-dv' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MetaBody
    expect(body.role).toBe('viewer')
    expect(body.canReplace).toBe(false)
    expect(body.files).toBeUndefined()
  })

  test('meta.directEditorPlusGroup: direct role wins — editor, canReplace:true, manifest present', async () => {
    const { db, kv, app, env, site } = await seedPrivate()
    await mintUser(db, kv, 'ed')
    await seedUserShare(db, site, 'ed', 'editor')
    const grp = await seedSpace(db, { createdBy: 'owner', slug: 'grp' })
    await seedMember(db, grp, 'ed')
    await seedGroupShare(db, site, grp)

    const res = await view(app, env, 'docs', 'report', { Authorization: 'Bearer tok-ed' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MetaBody
    expect(body.role).toBe('editor')
    expect(body.canReplace).toBe(true)
    expect(body.files).toEqual(['index.html'])
    expect(body.contentVersion).toBe(0)
  })

  test('meta.noReach: authed user with no share and no membership → 403', async () => {
    const { db, kv, app, env } = await seedPrivate()
    await mintUser(db, kv, 'st')
    expect((await view(app, env, 'docs', 'report', { Authorization: 'Bearer tok-st' })).status).toBe(403)
  })

  test('meta.singleResolve: share reach rides ONE db.batch (direct role + group reach together)', async () => {
    const { db, kv, app, env, site } = await seedPrivate()
    await mintUser(db, kv, 'dv')
    await seedUserShare(db, site, 'dv', 'viewer')
    db.resetCounters()

    const res = await view(app, env, 'docs', 'report', { Authorization: 'Bearer tok-dv' })
    expect(res.status).toBe(200)
    expect(db.counters.batches).toBe(1) // resolveShareAccess — the only share scan
    // Loose/batch attribution races under Promise.all in the sequential harness shim, so pin the
    // TOTAL: site resolve + membership + files + (direct-role + group-reach) = 5, down from 6.
    expect(db.counters.loose + db.counters.batchStmts).toBe(5)
  })

  test('meta.superadmin: 200 with canReplace:true, manifest present, NO role field (no direct share)', async () => {
    const { db, kv, app, env } = await seedPrivate()
    await mintUser(db, kv, 'admin', 'superadmin')

    const res = await view(app, env, 'docs', 'report', { Authorization: 'Bearer tok-admin' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MetaBody
    expect('role' in body).toBe(false)
    expect(body.canReplace).toBe(true)
    expect(body.files).toEqual(['index.html'])
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
