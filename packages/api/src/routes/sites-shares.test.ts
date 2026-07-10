import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { resolveShareRole } from '../db/repo'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, seedSite, seedSpace, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { parseShareGrants, sites } from './sites'

// PUT/GET /shares is role-aware AND backward-compatible: the live web dialog still PUTs legacy
// `userIds[]` (→ viewer) while the new dialog PUTs `users:[{id,role}]`. Groups stay view-only —
// there is no editor row on site_group_shares, so an editor grant on a group is a 400.

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
  await seedUser(db, { id: 'owner', role: 'member' })
  await kv.put('cli:tok-owner', JSON.stringify({ id: 'owner', email: 'owner@example.com', name: null, role: 'member' }))
  await seedUser(db, { id: 'ed', email: 'ed@example.com' })
  await seedUser(db, { id: 'vw', email: 'vw@example.com' })
  await seedSpace(db, { id: 'sp', slug: 'mine', createdBy: 'owner' })
  const grp = await seedSpace(db, { id: 'grp', slug: 'grp', createdBy: 'owner', type: 'group' })
  const site = await seedSite(db, { id: 'site', spaceId: 'sp', ownerId: 'owner', slug: 'doc' })
  return { db, app, env, site, grp }
}

const auth = { Authorization: 'Bearer tok-owner', Origin: APP_URL, 'Content-Type': 'application/json' }
const put = (app: Hono<AppEnv>, env: AppEnv['Bindings'], body: unknown) =>
  app.request('/api/sites/mine/doc/shares', { method: 'PUT', headers: auth, body: JSON.stringify(body) }, env)
const get = (app: Hono<AppEnv>, env: AppEnv['Bindings']) =>
  app.request('/api/sites/mine/doc/shares', { headers: auth }, env)

describe('parseShareGrants — pure body normalization', () => {
  test('new users:[{id,role}] shape carries roles; groups view-only', () => {
    expect(parseShareGrants({ users: [{ id: 'a', role: 'editor' }, { id: 'b' }], groupIds: ['g'] })).toEqual({
      users: [{ userId: 'a', role: 'editor' }, { userId: 'b', role: 'viewer' }],
      groupIds: ['g'],
    })
  })
  test('legacy userIds → viewer; users wins on collision; ids dedup', () => {
    expect(parseShareGrants({ users: [{ id: 'a', role: 'editor' }], userIds: ['a', 'b', 'b'] })).toEqual({
      users: [{ userId: 'a', role: 'editor' }, { userId: 'b', role: 'viewer' }],
      groupIds: [],
    })
  })
  test('an editor role on a group is rejected', () => {
    expect(parseShareGrants({ groups: [{ id: 'g', role: 'editor' }] })).toEqual({ error: 'groups cannot be granted editor' })
  })
  test('garbage/empty body → empty grants, never throws', () => {
    expect(parseShareGrants(null)).toEqual({ users: [], groupIds: [] })
    expect(parseShareGrants({ users: 'nope', userIds: [1, 2] })).toEqual({ users: [], groupIds: [] })
  })
})

describe('PUT/GET /shares — roles + backcompat', () => {
  test('shares.role.roundtrip: PUT users:[{id,role:editor}] → GET returns role editor, DB agrees', async () => {
    const { db, app, env, site } = await setup()
    const res = await put(app, env, { users: [{ id: 'ed', role: 'editor' }, { id: 'vw', role: 'viewer' }] })
    expect(res.status).toBe(200)
    const body = (await get(app, env).then((r) => r.json())) as { users: { id: string; role: string }[] }
    expect(body.users).toContainEqual({ id: 'ed', role: 'editor' })
    expect(body.users).toContainEqual({ id: 'vw', role: 'viewer' })
    expect(await resolveShareRole(db, site, 'ed')).toBe('editor')
  })

  test('shares.backcompat: legacy PUT userIds:[id] still 200, role defaults viewer', async () => {
    const { db, app, env, site } = await setup()
    const res = await put(app, env, { userIds: ['ed'], groupIds: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    const body = (await get(app, env).then((r) => r.json())) as { userIds: string[]; users: { id: string; role: string }[] }
    expect(body.userIds).toContain('ed')
    expect(body.users).toContainEqual({ id: 'ed', role: 'viewer' })
    expect(await resolveShareRole(db, site, 'ed')).toBe('viewer')
  })

  test('shares.group.editor.rejected: a group granted editor → 400, nothing written', async () => {
    const { db, app, env, site, grp } = await setup()
    const res = await put(app, env, { groups: [{ id: grp, role: 'editor' }] })
    expect(res.status).toBe(400)
    // no direct share smuggled in for the group id
    expect(await resolveShareRole(db, site, grp)).toBeNull()
  })
})
