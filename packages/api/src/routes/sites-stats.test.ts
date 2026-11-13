import { describe, expect, test } from 'bun:test'
import { auth, makeRouteApp, mintUser } from '../test/route-fixtures'
import { seedEvent, seedMember, seedSite, seedSpace, seedUserShare } from '../test/harness'

const url = '/api/sites/acme/doc/stats'

async function setup() {
  const route = makeRouteApp()
  const owner = await mintUser(route.db, route.kv, 'owner')
  const spaceId = await seedSpace(route.db, { createdBy: owner, slug: 'acme' })
  const siteId = await seedSite(route.db, { spaceId, ownerId: owner, slug: 'doc', visibility: 'team' })
  return { ...route, owner, spaceId, siteId }
}

describe('GET /api/sites/:space/:site/stats', () => {
  test('the owner gets counts and no viewer identity', async () => {
    const { app, env, db, kv, owner, siteId } = await setup()
    const peer = await mintUser(db, kv, 'peer-viewer')
    await seedEvent(db, { siteId, userId: owner, action: 'index.html' })
    await seedEvent(db, { siteId, userId: peer, action: 'index.html' })
    const res = await app.request(url, { headers: auth(owner) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['days', 'pages', 'series', 'totalViews', 'uniqueViewers'])
    expect(body).toMatchObject({ days: 30, totalViews: 2, uniqueViewers: 2, pages: [{ path: 'index.html', views: 2 }] })
    expect(JSON.stringify(body)).not.toContain('peer-viewer')
  })

  test('everyone but the owner is denied: reader, space member, editor share, superadmin', async () => {
    const { app, env, db, kv, spaceId, siteId } = await setup()
    await seedEvent(db, { siteId, userId: 'owner', action: 'index.html' })
    const member = await mintUser(db, kv, 'member')
    await seedMember(db, spaceId, member)
    const editor = await mintUser(db, kv, 'editor')
    await seedUserShare(db, siteId, editor, 'editor')
    const admin = await mintUser(db, kv, 'admin', { role: 'superadmin' })
    const reader = await mintUser(db, kv, 'reader')
    for (const who of [reader, member, editor, admin]) {
      const res = await app.request(url, { headers: auth(who) }, env)
      expect(res.status, who).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
  })

  test('anonymous is 401 and an unknown site is 404', async () => {
    const { app, env, owner } = await setup()
    expect((await app.request(url, { headers: { Origin: 'https://glance.example.com' } }, env)).status).toBe(401)
    const res = await app.request('/api/sites/acme/nope/stats', { headers: auth(owner) }, env)
    expect(res.status).toBe(404)
  })
})
