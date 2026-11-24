import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { sites } from '../db/schema'
import { makeDb, makeKv, makeR2, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import { auth, makeRouteApp, mintUser } from '../test/route-fixtures'
import type { AppEnv } from '../types'
import { upload } from './upload'

// `expires` mirrors theme's create/replace split: CREATE applies it, REPLACE touches expiresAt only
// when explicitly sent, and an owner's redeploy is how an EXPIRED site comes back. PATCH sets and
// clears it too; an admin-archived site is never revived by either, and an admin restore never revives an expired one.

const HOUR = 3_600_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

async function setupUpload() {
  const db = makeDb()
  const kv = makeKv()
  const owner = await seedUser(db, { id: 'owner' })
  const sp = await seedSpace(db, { createdBy: owner, slug: 'acme' })
  await seedMember(db, sp, owner)
  await kv.put('cli:tok', JSON.stringify({ id: owner, email: 'owner@example.com', name: null, role: 'member' }))
  const r2 = makeR2()
  const env = { APP_URL: 'https://glance.example.com', SESSION_SECRET: 's', GLANCE_SESSIONS: kv, GLANCE_FILES: r2 } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/upload', upload)
  const post = (slug: string, o: { expires?: string; replace?: boolean } = {}) => {
    const fd = new FormData()
    fd.append('files', new File(['<html><body>hi</body></html>'], 'index.html', { type: 'text/html' }))
    if (o.expires !== undefined) fd.append('expires', o.expires)
    return app.request(`/api/upload/acme/${slug}${o.replace ? '?replace=true' : ''}`, { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: fd }, env)
  }
  const row = async (slug: string) => (await db.select({ expiresAt: sites.expiresAt, status: sites.status }).from(sites).where(eq(sites.slug, slug)))[0]
  return { db, sp, owner, r2, post, row }
}

describe('upload expires field', () => {
  test('create applies it; absent stores null; garbage 400s before a site exists', async () => {
    const { post, row } = await setupUpload()
    expect((await post('timed', { expires: '2d' })).status).toBe(200)
    expect(Math.abs(Date.parse((await row('timed'))?.expiresAt as string) - (Date.now() + 48 * HOUR))).toBeLessThan(60_000)
    await post('plain')
    expect((await row('plain'))?.expiresAt).toBeNull()
    for (const bad of ['whenever', '']) expect((await post('bad', { expires: bad })).status).toBe(400)
    expect(await row('bad')).toBeUndefined()
  })

  test('replace without the field keeps the expiry; with it, changes it; none clears it', async () => {
    const { post, row } = await setupUpload()
    await post('site-a', { expires: '2d' })
    const first = (await row('site-a'))?.expiresAt
    await post('site-a', { replace: true })
    expect((await row('site-a'))?.expiresAt).toBe(first)
    await post('site-a', { replace: true, expires: '30d' })
    expect((await row('site-a'))?.expiresAt).not.toBe(first)
    await post('site-a', { replace: true, expires: 'none' })
    expect((await row('site-a'))?.expiresAt).toBeNull()
  })

  test('an owner redeploy revives a LAPSED site (stale expiry dropped, or the new one kept), even one the sweep has not flipped; archived stays archived', async () => {
    const { db, sp, owner, post, row } = await setupUpload()
    for (const [slug, status] of [['gone', 'expired'], ['late', 'active'], ['back', 'expired'], ['mod', 'archived']] as const) {
      await seedSite(db, { id: slug, spaceId: sp, ownerId: owner, slug, status, expiresAt: iso(-HOUR) })
    }
    await post('gone', { replace: true })
    expect(await row('gone')).toEqual({ status: 'active', expiresAt: null })
    await post('late', { replace: true })
    expect(await row('late')).toEqual({ status: 'active', expiresAt: null })
    await post('back', { replace: true, expires: '7d' })
    expect(Date.parse((await row('back'))?.expiresAt as string)).toBeGreaterThan(Date.now())
    await post('mod', { replace: true })
    expect((await row('mod'))?.status).toBe('archived')
  })

  test('an admin archive that lands during the R2 uploads is not undone by the revive', async () => {
    const { db, sp, owner, r2, post, row } = await setupUpload()
    const lapsedAt = iso(-HOUR)
    await seedSite(db, { id: 'racy', spaceId: sp, ownerId: owner, slug: 'racy', status: 'active', expiresAt: lapsedAt })
    const put = r2.put
    r2.put = async (...args: Parameters<typeof put>) => {
      await db.update(sites).set({ status: 'archived' }).where(eq(sites.id, 'racy'))
      return put(...args)
    }
    expect((await post('racy', { replace: true })).status).toBe(200)
    expect((await row('racy'))?.status).toBe('archived')
  })
})

describe('PATCH /api/sites expires', () => {
  async function setupPatch(status: 'active' | 'expired' | 'archived', expiresAt: string | null) {
    const { app, env, db, kv } = makeRouteApp()
    await mintUser(db, kv, 'owner')
    const sp = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    await seedMember(db, sp, 'owner')
    const id = await seedSite(db, { spaceId: sp, ownerId: 'owner', slug: 'report', status, expiresAt })
    const patch = (body: unknown) => app.request('/api/sites/docs/report', { method: 'PATCH', headers: auth('owner'), body: JSON.stringify(body) }, env)
    const row = async () => (await db.select({ s: sites.status, e: sites.expiresAt, v: sites.contentVersion }).from(sites).where(eq(sites.id, id)))[0]
    return { patch, row }
  }

  test('sets and clears; a bad value is a 400; the content version is not bumped', async () => {
    const { patch, row } = await setupPatch('active', null)
    expect((await patch({ expires: '7d' })).status).toBe(200)
    expect(Date.parse((await row())?.e as string)).toBeGreaterThan(Date.now())
    await patch({ expires: 'none' })
    expect((await row())?.e).toBeNull()
    for (const bad of ['yesterday', '']) expect((await patch({ expires: bad })).status).toBe(400)
    expect((await row())?.v).toBe(0)
  })

  test('a new expiry or a clear revives an EXPIRED site; an admin-archived site stays archived', async () => {
    const expired = await setupPatch('expired', iso(-HOUR))
    await expired.patch({ expires: '1d' })
    expect((await expired.row())?.s).toBe('active')
    const cleared = await setupPatch('expired', iso(-HOUR))
    await cleared.patch({ expires: null })
    expect(await cleared.row()).toMatchObject({ s: 'active', e: null })
    const archived = await setupPatch('archived', null)
    await archived.patch({ expires: '1d' })
    expect((await archived.row())?.s).toBe('archived')
  })
})

describe('PATCH /api/admin/sites/:id/restore', () => {
  test('lifts the archive only: a passed expiry comes back as expired and is kept, a live one as active', async () => {
    const { app, env, db, kv } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'owner')
    const sp = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    const expiries = { stale: iso(-HOUR), live: iso(HOUR) }
    for (const [id, expiresAt] of Object.entries(expiries)) {
      await seedSite(db, { id, spaceId: sp, ownerId: 'owner', slug: id, status: 'archived', expiresAt })
      expect((await app.request(`/api/admin/sites/${id}/restore`, { method: 'PATCH', headers: auth('admin') }, env)).status).toBe(200)
    }
    const row = async (id: string) => (await db.select({ status: sites.status, expiresAt: sites.expiresAt }).from(sites).where(eq(sites.id, id)))[0]
    expect(await row('stale')).toEqual({ status: 'expired', expiresAt: expiries.stale })
    expect(await row('live')).toEqual({ status: 'active', expiresAt: expiries.live })
  })
})

describe('upload over an owner-archived page', () => {
  test('the owner gets a 409 until they unarchive, and nothing is replaced', async () => {
    const { db, sp, owner, post, row } = await setupUpload()
    await seedSite(db, { id: 'shelved', spaceId: sp, ownerId: owner, slug: 'shelved', status: 'owner_archived' })
    expect((await post('shelved', { replace: true })).status).toBe(409)
    expect((await row('shelved'))?.status).toBe('owner_archived')
    await db.update(sites).set({ status: 'active' }).where(eq(sites.id, 'shelved'))
    expect((await post('shelved', { replace: true })).status).toBe(200)
  })
})
