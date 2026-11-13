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
// clears it too; an admin-archived site is never revived by either.

const HOUR = 3_600_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

async function setupUpload() {
  const db = makeDb()
  const kv = makeKv()
  const owner = await seedUser(db, { id: 'owner' })
  const sp = await seedSpace(db, { createdBy: owner, slug: 'acme' })
  await seedMember(db, sp, owner)
  await kv.put('cli:tok', JSON.stringify({ id: owner, email: 'owner@example.com', name: null, role: 'member' }))
  const env = { APP_URL: 'https://glance.example.com', SESSION_SECRET: 's', GLANCE_SESSIONS: kv, GLANCE_FILES: makeR2() } as unknown as AppEnv['Bindings']
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
  return { db, sp, owner, post, row }
}

describe('upload expires field', () => {
  test('create applies it; absent stores null; garbage 400s before a site exists', async () => {
    const { post, row } = await setupUpload()
    expect((await post('timed', { expires: '2d' })).status).toBe(200)
    expect(Math.abs(Date.parse((await row('timed'))?.expiresAt as string) - (Date.now() + 48 * HOUR))).toBeLessThan(60_000)
    await post('plain')
    expect((await row('plain'))?.expiresAt).toBeNull()
    expect((await post('bad', { expires: 'whenever' })).status).toBe(400)
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

  test('an owner redeploy revives an EXPIRED site (stale expiry dropped, or the new one kept); archived stays archived', async () => {
    const { db, sp, owner, post, row } = await setupUpload()
    for (const [slug, status] of [['gone', 'expired'], ['back', 'expired'], ['mod', 'archived']] as const) {
      await seedSite(db, { id: slug, spaceId: sp, ownerId: owner, slug, status, expiresAt: status === 'expired' ? iso(-HOUR) : null })
    }
    await post('gone', { replace: true })
    expect(await row('gone')).toEqual({ status: 'active', expiresAt: null })
    await post('back', { replace: true, expires: '7d' })
    expect(Date.parse((await row('back'))?.expiresAt as string)).toBeGreaterThan(Date.now())
    await post('mod', { replace: true })
    expect((await row('mod'))?.status).toBe('archived')
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
    expect((await patch({ expires: 'yesterday' })).status).toBe(400)
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
