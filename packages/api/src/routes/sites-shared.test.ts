import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from '../test/harness'
import type { AppEnv } from '../types'
import { sites } from './sites'

// Phase 5 / S17 — GET /api/sites/shared carries the viewer's direct-share role so the dashboard can
// badge "You can edit". A group-only reacher (no direct row) is a plain viewer.

const APP_URL = 'https://glance.example.com'

async function setup() {
  const db = makeDb()
  const kv = makeKv()
  const env = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/sites', sites)
  await seedUser(db, { id: 'owner', email: 'owner@e.com' })
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  const site = await seedSite(db, { id: 'site', spaceId: 'acme', ownerId: 'owner', slug: 'doc', visibility: 'private' })
  for (const [id, role] of [['ed', 'editor'], ['vw', 'viewer']] as const) {
    await seedUser(db, { id, email: `${id}@e.com` })
    await seedUserShare(db, site, id, role)
    await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@e.com`, name: null, role: 'member' }))
  }
  return { app, env }
}

const shared = (app: Hono<AppEnv>, env: AppEnv['Bindings'], id: string) =>
  app.request('/api/sites/shared', { headers: { Authorization: `Bearer tok-${id}`, Origin: APP_URL } }, env).then((r) => r.json())

describe('GET /api/sites/shared — carries the viewer role', () => {
  test('shared.response.role: an editor-shared row reports role editor; a viewer-shared row role viewer', async () => {
    const { app, env } = await setup()
    const edRows = (await shared(app, env, 'ed')) as { siteSlug: string; role: string }[]
    expect(edRows).toHaveLength(1)
    expect(edRows[0]).toMatchObject({ siteSlug: 'doc', role: 'editor' })

    const vwRows = (await shared(app, env, 'vw')) as { siteSlug: string; role: string }[]
    expect(vwRows[0]).toMatchObject({ siteSlug: 'doc', role: 'viewer' })
  })
})
