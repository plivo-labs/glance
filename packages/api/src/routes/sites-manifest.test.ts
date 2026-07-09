import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, makeR2, seedFile, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from '../test/harness'
import type { AppEnv } from '../types'
import { sites } from './sites'

// Phase 3 — read-side endpoints. The site meta route exposes the file MANIFEST + contentVersion +
// canReplace ONLY to owner/editor/superadmin (a plain viewer sees none of it); /exists recognizes a
// non-member editor as authorized-with-canReplace so the CLI takes the REPLACE path, not CREATE.

const APP_URL = 'https://glance.example.com'

async function setup() {
  const db = makeDb()
  const kv = makeKv()
  const r2 = makeR2()
  const env = { APP_URL, SESSION_SECRET: 's', CONTENT_URL: 'https://content.example.com', CONTENT_TOKEN_SECRET: 'ct', GLANCE_SESSIONS: kv, GLANCE_FILES: r2 } as unknown as AppEnv['Bindings']
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
  const site = await seedSite(db, { id: 'site', spaceId: 'acme', ownerId: 'owner', slug: 'doc', visibility: 'team' })
  await seedFile(db, r2, site, { path: 'index.html', text: '<h1>hi</h1>' })
  await seedFile(db, r2, site, { path: 'about.md', text: '# about' })
  for (const [id, role] of [['ed', 'editor'], ['vw', 'viewer']] as const) {
    await seedUser(db, { id, email: `${id}@e.com` })
    await seedUserShare(db, site, id, role) // ed/vw are NOT space members
  }
  await seedUser(db, { id: 'mem', email: 'mem@e.com' })
  await seedMember(db, 'acme', 'mem') // plain member: read via team tier, no share
  await seedUser(db, { id: 'st', email: 'st@e.com' })
  for (const id of ['owner', 'ed', 'vw', 'mem', 'st'])
    await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@e.com`, name: null, role: 'member' }))
  return { db, app, env }
}

const auth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL })
const exists = (app: Hono<AppEnv>, env: AppEnv['Bindings'], id: string) =>
  app.request('/api/sites/acme/doc/exists', { headers: auth(id) }, env).then((r) => r.json())
const meta = (app: Hono<AppEnv>, env: AppEnv['Bindings'], id: string) =>
  app.request('/api/sites/acme/doc', { headers: auth(id) }, env).then((r) => r.json())

describe('GET /exists — editor recognition + canReplace', () => {
  test('exists.nonmember.editor.true: a non-member editor gets exists:true, canReplace:true', async () => {
    const { app, env } = await setup()
    expect(await exists(app, env, 'ed')).toMatchObject({ exists: true, canReplace: true, contentVersion: 0 })
  })
  test('owner canReplace:true; a plain member canReplace:false; a stranger exists:false (unchanged)', async () => {
    const { app, env } = await setup()
    expect(await exists(app, env, 'owner')).toMatchObject({ exists: true, canReplace: true })
    expect(await exists(app, env, 'mem')).toMatchObject({ exists: true, canReplace: false })
    expect(await exists(app, env, 'st')).toMatchObject({ exists: false })
  })
})

describe('GET meta — gated manifest', () => {
  test('manifest.owner.includesFiles: owner meta returns files[] + contentVersion + canReplace:true', async () => {
    const { app, env } = await setup()
    const body = (await meta(app, env, 'owner')) as { files?: string[]; contentVersion?: number; canReplace?: boolean }
    expect(body.canReplace).toBe(true)
    expect(body.contentVersion).toBe(0)
    expect(body.files?.sort()).toEqual(['about.md', 'index.html'])
  })
  test('manifest.editor.includesFiles: a non-member editor also sees the manifest', async () => {
    const { app, env } = await setup()
    const body = (await meta(app, env, 'ed')) as { files?: string[]; canReplace?: boolean; role?: string }
    expect(body.canReplace).toBe(true)
    expect(body.role).toBe('editor')
    expect(body.files?.sort()).toEqual(['about.md', 'index.html'])
  })
  test('manifest.viewer.excludesFiles: a plain member gets NO files[] and canReplace:false', async () => {
    const { app, env } = await setup()
    const body = (await meta(app, env, 'mem')) as { files?: string[]; canReplace?: boolean }
    expect(body.canReplace).toBe(false)
    expect(body.files).toBeUndefined()
  })
})
