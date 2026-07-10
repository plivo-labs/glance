import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { seedFile, seedGroupShare, seedMember, seedSite, seedSpace, seedUserShare } from '../test/harness'
import { auth, makeRouteApp as setup, mintUser, postAuthRequests } from '../test/route-fixtures'
import type { AppEnv } from '../types'

// Spaces routes mounted the way index.ts mounts them (requireSameOrigin global + spaces under
// /api/spaces — via the shared route-fixtures app) so CSRF, auth and ownership are exercised
// end to end. GLANCE_FILES is a real R2 mock so the delete path's object purge is observable.

const invite = (app: Hono<AppEnv>, env: AppEnv['Bindings'], slug: string, id: string, body: unknown) =>
  app.request(`/api/spaces/${slug}/members`, { method: 'POST', headers: auth(id), body: JSON.stringify(body) }, env)

const del = (app: Hono<AppEnv>, env: AppEnv['Bindings'], slug: string, id: string) =>
  app.request(`/api/spaces/${slug}`, { method: 'DELETE', headers: auth(id) }, env)

describe('POST /api/spaces/:slug/members', () => {
  test('re-inviting an existing member is an idempotent 200 (composite-PK collision swallowed)', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')
    await seedMember(db, 'g', 'u2') // u2 already a member

    const res = await invite(app, env, 'acme', 'u1', { email: 'u2@example.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  test('inviting a member to a personal space is rejected with 409', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    await seedSpace(db, { id: 'p', createdBy: 'u1', slug: 'u1-personal', type: 'personal' })
    await seedMember(db, 'p', 'u1')

    const res = await invite(app, env, 'u1-personal', 'u1', { email: 'u2@example.com' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'cannot invite members to a personal space' })
  })

  test('a real (non-UNIQUE) write failure surfaces as a 5xx, not a false ok', async () => {
    const { db, kv, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')

    // Break the membership insert with a non-constraint error AFTER seeding is done.
    db.insert = (() => {
      throw new Error('disk I/O error')
    }) as typeof db.insert

    const res = await invite(app, env, 'acme', 'u1', { email: 'u2@example.com' })
    expect(res.status).toBe(500)
  })
})

describe('DELETE /api/spaces/:slug', () => {
  test('purges every site’s R2 objects in the space, then removes the space', async () => {
    const { db, kv, r2, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')
    const s1 = await seedSite(db, { spaceId: 'g', ownerId: 'u1', slug: 'one' })
    const s2 = await seedSite(db, { spaceId: 'g', ownerId: 'u1', slug: 'two' })
    const k1 = await seedFile(db, r2, s1, { path: 'index.html', text: '<h1>one</h1>' })
    const k2 = await seedFile(db, r2, s2, { path: 'index.html', text: '<h1>two</h1>' })
    expect(r2.store.has(k1)).toBe(true)
    expect(r2.store.has(k2)).toBe(true)

    const res = await del(app, env, 'acme', 'u1')
    expect(res.status).toBe(200)
    expect(r2.store.has(k1)).toBe(false)
    expect(r2.store.has(k2)).toBe(false)
    // Space row is gone.
    const gone = await app.request('/api/spaces/acme', { headers: auth('u1') }, env)
    expect(gone.status).toBe(404)
  })

  test('owner cannot delete a group space holding sites owned by other members (409)', async () => {
    const { db, kv, r2, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await mintUser(db, kv, 'u2')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')
    await seedMember(db, 'g', 'u2')
    await seedSite(db, { spaceId: 'g', ownerId: 'u1', slug: 'mine' })
    const other = await seedSite(db, { spaceId: 'g', ownerId: 'u2', slug: 'theirs' })
    const k = await seedFile(db, r2, other, { path: 'index.html', text: '<h1>theirs</h1>' })

    const res = await del(app, env, 'acme', 'u1')
    expect(res.status).toBe(409)
    // Nothing destroyed: the other member's object survives the refused delete.
    expect(r2.store.has(k)).toBe(true)
  })

  test('superadmin may delete a group space holding other members’ sites (bypass)', async () => {
    const { db, kv, r2, app, env } = await setup()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'u1')
    await seedSpace(db, { id: 'g', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'g', 'u1')
    const other = await seedSite(db, { spaceId: 'g', ownerId: 'u1', slug: 'theirs' })
    const k = await seedFile(db, r2, other, { path: 'index.html', text: '<h1>theirs</h1>' })

    const res = await del(app, env, 'acme', 'admin')
    expect(res.status).toBe(200)
    expect(r2.store.has(k)).toBe(false)
  })
})

// --- S6 T6.1 fixture: space 'acme' (owner + member 'mem') holding one site per visibility tier,
// an explicit private→outsider share, a group-share vehicle ('grp', outsider is a member) granting
// exactly one private site, and an archived team site. Expected id sets are hand-coded per viewer. ---
async function seedVisibilityFixture() {
  const ctx = await setup()
  const { db, kv } = ctx
  for (const [id, role] of [['owner', 'member'], ['mem', 'member'], ['out', 'member'], ['admin', 'superadmin']] as const)
    await mintUser(db, kv, id, { role })
  await seedSpace(db, { id: 'sp', createdBy: 'owner', slug: 'acme' })
  await seedMember(db, 'sp', 'owner')
  await seedMember(db, 'sp', 'mem')
  await seedSite(db, { id: 't1', spaceId: 'sp', ownerId: 'owner', slug: 't1', visibility: 'team' })
  await seedSite(db, { id: 'm1', spaceId: 'sp', ownerId: 'owner', slug: 'm1', visibility: 'members' })
  await seedSite(db, { id: 'p1', spaceId: 'sp', ownerId: 'owner', slug: 'p1', visibility: 'private' })
  await seedSite(db, { id: 'p-shared', spaceId: 'sp', ownerId: 'owner', slug: 'p-shared', visibility: 'private' })
  await seedUserShare(db, 'p-shared', 'out', 'viewer')
  await seedSite(db, { id: 'gone', spaceId: 'sp', ownerId: 'owner', slug: 'gone', visibility: 'team', status: 'archived' })
  await seedSpace(db, { id: 'grp', createdBy: 'owner', slug: 'grp' })
  await seedMember(db, 'grp', 'out')
  await seedSite(db, { id: 'g1', spaceId: 'sp', ownerId: 'owner', slug: 'g1', visibility: 'private' })
  await seedGroupShare(db, 'g1', 'grp')
  return ctx
}

const listedIds = async (app: Hono<AppEnv>, env: AppEnv['Bindings'], viewer: string, slug = 'acme') => {
  const res = await app.request(`/api/spaces/${slug}/sites`, { headers: auth(viewer) }, env)
  expect(res.status).toBe(200)
  return new Set(((await res.json()) as { id: string }[]).map((s) => s.id))
}

describe('GET /api/spaces/:slug/sites — visibility pins (S6 T6.1)', () => {
  test('pin: an authed non-member sees team-tier + explicitly-shared sites only', async () => {
    const { app, env } = await seedVisibilityFixture()
    // t1 (team), p-shared (direct grant), g1 (group grant) — NOT m1/p1 (tier), NOT gone (archived).
    expect(await listedIds(app, env, 'out')).toEqual(new Set(['t1', 'p-shared', 'g1']))
  })

  test('pin: an own-space member sees members-tier sites but not others’ private ones', async () => {
    const { app, env } = await seedVisibilityFixture()
    expect(await listedIds(app, env, 'mem')).toEqual(new Set(['t1', 'm1']))
  })

  test('pin: a group share grants exactly its site, not the whole space', async () => {
    const { app, env } = await seedVisibilityFixture()
    const ids = await listedIds(app, env, 'out')
    expect(ids.has('g1')).toBe(true) // the granted site
    expect(ids.has('p1')).toBe(false) // sibling private site in the same space stays hidden
    expect(ids.has('m1')).toBe(false) // group share is not space membership
  })

  test('pin: superadmin sees every site including archived', async () => {
    const { app, env } = await seedVisibilityFixture()
    expect(await listedIds(app, env, 'admin')).toEqual(new Set(['t1', 'm1', 'p1', 'p-shared', 'g1', 'gone']))
  })

  test('pin: missing space → 404 even when sibling statements return empty (garbage slug)', async () => {
    const { app, env } = await seedVisibilityFixture()
    const sitesRes = await app.request('/api/spaces/no-such-space/sites', { headers: auth('out') }, env)
    expect(sitesRes.status).toBe(404)
    expect(await sitesRes.json()).toMatchObject({ error: 'space not found' })
    const metaRes = await app.request('/api/spaces/no-such-space', { headers: auth('out') }, env)
    expect(metaRes.status).toBe(404)
  })
})

describe('GET /api/spaces/:slug/sites — post-auth D1 request budget (S6 T6.2)', () => {
  test('perf: a populated listing (shares + group grant + audio) costs at most 3 post-auth D1 requests', async () => {
    const { app, env, db } = await seedVisibilityFixture()
    await seedFile(db, null, 't1', { path: 'take.mp3', mimeType: 'audio/mpeg' })
    await seedFile(db, null, 'g1', { path: 'index.html' })
    db.resetCounters()

    const res = await app.request('/api/spaces/acme/sites', { headers: auth('out') }, env)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as { id: string; audio: boolean }[]
    expect(new Set(rows.map((r) => ({ id: r.id, audio: r.audio })))).toEqual(
      new Set([
        { id: 't1', audio: true },
        { id: 'p-shared', audio: false },
        { id: 'g1', audio: false },
      ]),
    )
    expect(postAuthRequests(db)).toBeLessThanOrEqual(3)
    // Exact shape: auth's getUserById is the only loose statement; the handler is ONE batch
    // carrying all five SELECTs (space row, direct shares, group shares, membership, site rows).
    expect(db.counters.loose).toBe(1)
    expect(db.counters.batches).toBe(1)
    expect(db.counters.batchStmts).toBe(5)
  })
})

describe('GET /api/spaces/:slug — post-auth D1 request budget + member facts (S6 T6.2)', () => {
  test('perf+values: memberCount/isMember are correct and cost at most 2 post-auth D1 requests', async () => {
    const { db, kv, app, env } = await setup()
    for (const id of ['owner', 'm2', 'm3', 'out']) await mintUser(db, kv, id)
    await seedSpace(db, { id: 'sp', createdBy: 'owner', slug: 'acme' })
    for (const id of ['owner', 'm2', 'm3']) await seedMember(db, 'sp', id)

    db.resetCounters()
    const asMember = await app.request('/api/spaces/acme', { headers: auth('m2') }, env)
    expect(asMember.status).toBe(200)
    expect(await asMember.json()).toMatchObject({ slug: 'acme', memberCount: 3, isMember: true })
    expect(postAuthRequests(db)).toBeLessThanOrEqual(2)

    db.resetCounters()
    const asOutsider = await app.request('/api/spaces/acme', { headers: auth('out') }, env)
    expect(asOutsider.status).toBe(200)
    expect(await asOutsider.json()).toMatchObject({ slug: 'acme', memberCount: 3, isMember: false })
    expect(postAuthRequests(db)).toBeLessThanOrEqual(2)
    // Exact shape: ONE batch carrying all three SELECTs (space row, member count, membership).
    expect(db.counters.loose).toBe(1)
    expect(db.counters.batches).toBe(1)
    expect(db.counters.batchStmts).toBe(3)
  })
})

describe('GET /api/spaces/:slug/sites — audio flag (W4-2)', () => {
  test('a pure-audio site is flagged audio:true; an html site audio:false', async () => {
    const { db, kv, r2, app, env } = await setup()
    await mintUser(db, kv, 'u1')
    await seedSpace(db, { id: 'sp', createdBy: 'u1', slug: 'acme' })
    await seedMember(db, 'sp', 'u1')
    const voice = await seedSite(db, { spaceId: 'sp', ownerId: 'u1', slug: 'a-take' })
    await seedFile(db, r2, voice, { path: 'recording.webm', text: 'bytes' })
    const web = await seedSite(db, { spaceId: 'sp', ownerId: 'u1', slug: 'a-page' })
    await seedFile(db, r2, web, { path: 'index.html', text: '<h1>hi</h1>' })

    const res = await app.request('/api/spaces/acme/sites', { headers: auth('u1') }, env)
    expect(res.status).toBe(200)
    const list = (await res.json()) as { siteSlug: string; audio: boolean }[]
    const bySlug = Object.fromEntries(list.map((s) => [s.siteSlug, s.audio]))
    expect(bySlug['a-take']).toBe(true)
    expect(bySlug['a-page']).toBe(false)
  })
})
