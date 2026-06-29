import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { sites } from './sites'

// Move endpoint, mounted the way index.ts mounts it (requireSameOrigin global + sites under
// /api/sites) so CSRF, auth and ownership are exercised end to end.

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
  return { db, kv, app, env }
}

async function mintUser(db: ReturnType<typeof makeDb>, kv: ReturnType<typeof makeKv>, id: string, role: 'member' | 'superadmin' = 'member') {
  await seedUser(db, { id, role })
  await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@example.com`, name: null, role }))
  return id
}

const auth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL, 'Content-Type': 'application/json' })

const move = (app: Hono<AppEnv>, env: AppEnv['Bindings'], space: string, site: string, id: string, body: unknown) =>
  app.request(`/api/sites/${space}/${site}/move`, { method: 'POST', headers: auth(id), body: JSON.stringify(body) }, env)

describe('POST /api/sites/:space/:site/move', () => {
  test('owner moves a site into a space they belong to', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    const from = await seedSpace(db, { createdBy: 'u1', slug: 'personal-u1', type: 'personal' })
    const to = await seedSpace(db, { createdBy: 'u1', slug: 'acme' })
    await seedMember(db, from, 'u1')
    await seedMember(db, to, 'u1')
    await seedSite(db, { spaceId: from, ownerId: 'u1', slug: 'report' })

    const res = await move(app, env, 'personal-u1', 'report', 'u1', { space: 'acme' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, spaceSlug: 'acme', siteSlug: 'report', url: `${APP_URL}/acme/report` })

    // Reachable at the new path, gone from the old one.
    expect(await (await app.request('/api/sites/acme/report/exists', { headers: auth('u1') }, env)).json()).toMatchObject({ exists: true })
    expect(await (await app.request('/api/sites/personal-u1/report/exists', { headers: auth('u1') }, env)).json()).toMatchObject({ exists: false })
  })

  test('non-owner is forbidden', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    const from = await seedSpace(db, { createdBy: 'u1', slug: 'sp1' })
    const to = await seedSpace(db, { createdBy: 'u2', slug: 'sp2' })
    await seedMember(db, to, 'u2')
    await seedSite(db, { spaceId: from, ownerId: 'u1', slug: 'doc' })

    expect((await move(app, env, 'sp1', 'doc', 'u2', { space: 'sp2' })).status).toBe(403)
  })

  test('cannot move into a space you are not a member of', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    const from = await seedSpace(db, { createdBy: 'u1', slug: 'mine' })
    await seedMember(db, from, 'u1')
    await seedSpace(db, { createdBy: 'u9', slug: 'theirs' }) // u1 not a member
    await seedSite(db, { spaceId: from, ownerId: 'u1', slug: 'doc' })

    expect((await move(app, env, 'mine', 'doc', 'u1', { space: 'theirs' })).status).toBe(403)
  })

  test('unknown target space → 404', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    const from = await seedSpace(db, { createdBy: 'u1', slug: 'mine' })
    await seedMember(db, from, 'u1')
    await seedSite(db, { spaceId: from, ownerId: 'u1', slug: 'doc' })

    expect((await move(app, env, 'mine', 'doc', 'u1', { space: 'nope' })).status).toBe(404)
  })

  test('slug already taken in the target space → 409', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    const from = await seedSpace(db, { createdBy: 'u1', slug: 'mine' })
    const to = await seedSpace(db, { createdBy: 'u1', slug: 'acme' })
    await seedMember(db, from, 'u1')
    await seedMember(db, to, 'u1')
    await seedSite(db, { spaceId: from, ownerId: 'u1', slug: 'doc' })
    await seedSite(db, { spaceId: to, ownerId: 'u1', slug: 'doc' }) // collision in target

    const res = await move(app, env, 'mine', 'doc', 'u1', { space: 'acme' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ conflict: true })
  })

  test('superadmin may move into a space they do not belong to', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'admin', 'superadmin')
    await mintUser(db, kv, 'u1')
    const from = await seedSpace(db, { createdBy: 'u1', slug: 'mine' })
    await seedSpace(db, { createdBy: 'u1', slug: 'acme' }) // admin is NOT a member
    await seedSite(db, { spaceId: from, ownerId: 'u1', slug: 'doc' })

    expect((await move(app, env, 'mine', 'doc', 'admin', { space: 'acme' })).status).toBe(200)
  })
})
