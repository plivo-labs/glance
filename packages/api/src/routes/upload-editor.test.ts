import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { files, sites } from '../db/schema'
import { makeDb, makeKv, makeR2, seedFile, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from '../test/harness'
import type { AppEnv } from '../types'
import { upload } from './upload'

// Phase 2 — editor-share enforcement. An 'editor' direct-share may content-replace a site they
// neither own nor are a space member of; a plain 'viewer' or a stranger may not. Editor replaces are
// content-only (no visibility change), blocked on archived sites, and CAS-guarded on contentVersion.

const APP_URL = 'https://glance.example.com'
const html = (s: string) => new File([s], 'index.html', { type: 'text/html' })

async function fx() {
  const db = makeDb()
  const kv = makeKv()
  const r2 = makeR2()
  const owner = await seedUser(db, { id: 'owner', email: 'owner@e.com' })
  const sp = await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: owner })
  await seedMember(db, sp, owner)
  for (const id of ['owner', 'ed', 'vw', 'st']) {
    await seedUser(db, { id, email: `${id}@e.com` }).catch(() => {}) // owner already seeded
    await kv.put(`cli:${id}`, JSON.stringify({ id, email: `${id}@e.com`, name: null, role: 'member' }))
  }
  const site = await seedSite(db, { id: 'site', spaceId: 'acme', ownerId: 'owner', slug: 'doc', visibility: 'team' })
  const oldKey = await seedFile(db, r2, site, { path: 'index.html', text: '<html>old</html>' })
  await seedUserShare(db, site, 'ed', 'editor')
  await seedUserShare(db, site, 'vw', 'viewer')

  const env = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv, GLANCE_FILES: r2 } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/upload', upload)
  return { db, app, env, site, oldKey }
}

type Opts = { slug?: string; replace?: boolean; visibility?: string; expectedVersion?: number }
function post(app: Hono<AppEnv>, env: AppEnv['Bindings'], token: string, opts: Opts = {}) {
  const fd = new FormData()
  fd.append('files', html('<html>new</html>'))
  if (opts.visibility !== undefined) fd.append('visibility', opts.visibility)
  if (opts.expectedVersion !== undefined) fd.append('expectedVersion', String(opts.expectedVersion))
  const q = opts.replace ? '?replace=true' : ''
  return app.request(`/api/upload/acme/${opts.slug ?? 'doc'}${q}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }, env)
}

const siteRow = (db: Awaited<ReturnType<typeof fx>>['db']) =>
  db.select().from(sites).where(eq(sites.id, 'site')).limit(1).then((r) => r[0])
const fileKeys = (db: Awaited<ReturnType<typeof fx>>['db']) =>
  db.select({ k: files.storageKey }).from(files).where(eq(files.siteId, 'site')).then((r) => r.map((x) => x.k))

describe('upload — editor-share enforcement', () => {
  test('upload.editor.replace.200: a non-member editor replaces another owner’s site', async () => {
    const { app, env } = await fx()
    expect((await post(app, env, 'ed', { replace: true, expectedVersion: 0 })).status).toBe(200)
  })

  test('upload.viewer.replace.403: a viewer-share replace is forbidden', async () => {
    const { app, env } = await fx()
    expect((await post(app, env, 'vw', { replace: true, expectedVersion: 0 })).status).toBe(403)
  })

  test('upload.stranger.replace.403 / create.nonmember.403: unchanged denials', async () => {
    const { app, env } = await fx()
    expect((await post(app, env, 'st', { replace: true, expectedVersion: 0 })).status).toBe(403)
    expect((await post(app, env, 'st', { slug: 'brandnew' })).status).toBe(403) // create in a space they’re not in
  })

  test('upload.editor.visibility.ignored: an editor replace cannot change visibility', async () => {
    const { db, app, env } = await fx()
    expect((await post(app, env, 'ed', { replace: true, expectedVersion: 0, visibility: 'private' })).status).toBe(200)
    expect((await siteRow(db)).visibility).toBe('team')
  })

  test('upload.owner.visibility.applied: an owner replace with visibility changes it', async () => {
    const { db, app, env } = await fx()
    expect((await post(app, env, 'owner', { replace: true, visibility: 'private' })).status).toBe(200)
    expect((await siteRow(db)).visibility).toBe('private')
  })

  test('upload.editor.archived.403: an editor cannot replace an archived site', async () => {
    const { db, app, env } = await fx()
    await db.update(sites).set({ status: 'archived' }).where(eq(sites.id, 'site'))
    expect((await post(app, env, 'ed', { replace: true, expectedVersion: 0 })).status).toBe(403)
  })

  test('upload.editor.absentVersion.400: an editor replace without expectedVersion is rejected', async () => {
    const { app, env } = await fx()
    expect((await post(app, env, 'ed', { replace: true })).status).toBe(400)
  })

  test('upload.editor.staleVersion.409: a stale expectedVersion conflicts and leaves files untouched', async () => {
    const { db, app, env, oldKey } = await fx()
    expect((await post(app, env, 'ed', { replace: true, expectedVersion: 99 })).status).toBe(409)
    expect(await fileKeys(db)).toEqual([oldKey])
  })

  test('upload.editor.freshVersion.200: correct version bumps contentVersion + records lastReplacedBy', async () => {
    const { db, app, env } = await fx()
    const res = await post(app, env, 'ed', { replace: true, expectedVersion: 0 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ contentVersion: 1 })
    const row = await siteRow(db)
    expect(row.contentVersion).toBe(1)
    expect(row.lastReplacedBy).toBe('ed')
  })

  test('upload.cas.concurrent: two editor replaces at the same version → exactly one 200, one 409', async () => {
    const { app, env } = await fx()
    const [a, b] = await Promise.all([
      post(app, env, 'ed', { replace: true, expectedVersion: 0 }),
      post(app, env, 'ed', { replace: true, expectedVersion: 0 }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  test('upload.owner.absentVersion.200: an owner replace without a version still succeeds (advisory)', async () => {
    const { db, app, env } = await fx()
    expect((await post(app, env, 'owner', { replace: true })).status).toBe(200)
    expect((await siteRow(db)).contentVersion).toBe(1) // owner replace bumps advisorily
  })
})
