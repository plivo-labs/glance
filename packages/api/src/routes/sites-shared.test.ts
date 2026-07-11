import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { siteUserShares } from '../db/schema'
import { seedFile, seedGroupShare, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from '../test/harness'
import { at, auth, makeRouteApp, mintUser, postAuthRequests, type RouteApp } from '../test/route-fixtures'
import type { AppEnv } from '../types'

// Phase 5 / S17 — GET /api/sites/shared carries the viewer's direct-share role so the dashboard can
// badge "You can edit". A group-only reacher (no direct row) is a plain viewer.
// S5 — the handler must answer in at most 2 post-auth D1 requests (roles layer, then site rows +
// audio fused); the pins below freeze today's response semantics so the rewire can't drift.

async function setup() {
  const { app, env, db, kv } = makeRouteApp()
  await seedUser(db, { id: 'owner', email: 'owner@e.com' })
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  const site = await seedSite(db, { id: 'site', spaceId: 'acme', ownerId: 'owner', slug: 'doc', visibility: 'private' })
  for (const [id, role] of [['ed', 'editor'], ['vw', 'viewer']] as const) {
    await mintUser(db, kv, id, { email: `${id}@e.com` })
    await seedUserShare(db, site, id, role)
  }
  return { app, env }
}

const shared = (app: Hono<AppEnv>, env: AppEnv['Bindings'], id: string) =>
  app.request('/api/sites/shared', { headers: auth(id) }, env).then((r) => r.json())

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

// --- S5 harness: app + owner-run 'acme' space + signed-in member 'me' (no shares yet). Each test
// seeds its own candidate sites; group shares travel through group spaces 'me' is a member of. ---

type FeedRow = { id: string; siteSlug: string; role: string; audio: boolean }

async function setupFeed() {
  const ctx = makeRouteApp()
  const { db, kv } = ctx
  await seedUser(db, { id: 'owner', email: 'owner@e.com' })
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  await mintUser(db, kv, 'me', { email: 'me@e.com' })
  return ctx
}

/** A group space 'me' belongs to — the vehicle for group shares. */
async function seedGroupOfMe(db: RouteApp['db'], id: string) {
  await seedSpace(db, { id, slug: id, createdBy: 'owner' })
  await seedMember(db, id, 'me')
}

const ownerSite = (db: RouteApp['db'], id: string) =>
  seedSite(db, { id, spaceId: 'acme', ownerId: 'owner', slug: id, visibility: 'private' })

describe('GET /api/sites/shared — role + feed pins (S5 T5.1)', () => {
  test('pin: a group-only share resolves to role viewer', async () => {
    const { app, env, db } = await setupFeed()
    await seedGroupOfMe(db, 'grp1')
    await ownerSite(db, 'g-only')
    await seedGroupShare(db, 'g-only', 'grp1')

    const rows = (await shared(app, env, 'me')) as FeedRow[]
    expect(rows.map((r) => ({ id: r.id, role: r.role }))).toEqual([{ id: 'g-only', role: 'viewer' }])
  })

  test('pin: direct editor + group share on the same site → editor (direct wins)', async () => {
    const { app, env, db } = await setupFeed()
    await seedGroupOfMe(db, 'grp1')
    await ownerSite(db, 'both')
    await seedUserShare(db, 'both', 'me', 'editor')
    await seedGroupShare(db, 'both', 'grp1')

    const rows = (await shared(app, env, 'me')) as FeedRow[]
    expect(rows.map((r) => ({ id: r.id, role: r.role }))).toEqual([{ id: 'both', role: 'editor' }])
  })

  test('pin: two group shares reaching the same site → ONE row', async () => {
    const { app, env, db } = await setupFeed()
    await seedGroupOfMe(db, 'grp1')
    await seedGroupOfMe(db, 'grp2')
    await ownerSite(db, 'twice')
    await seedGroupShare(db, 'twice', 'grp1')
    await seedGroupShare(db, 'twice', 'grp2')

    const rows = (await shared(app, env, 'me')) as FeedRow[]
    expect(rows.map((r) => ({ id: r.id, role: r.role }))).toEqual([{ id: 'twice', role: 'viewer' }])
  })

  test('pin: deleting the direct share with a group share remaining falls back to viewer', async () => {
    const { app, env, db } = await setupFeed()
    await seedGroupOfMe(db, 'grp1')
    await ownerSite(db, 'demoted')
    await seedUserShare(db, 'demoted', 'me', 'editor')
    await seedGroupShare(db, 'demoted', 'grp1')
    expect(((await shared(app, env, 'me')) as FeedRow[])[0]?.role).toBe('editor')

    await db.delete(siteUserShares).where(and(eq(siteUserShares.siteId, 'demoted'), eq(siteUserShares.userId, 'me')))
    const rows = (await shared(app, env, 'me')) as FeedRow[]
    expect(rows.map((r) => ({ id: r.id, role: r.role }))).toEqual([{ id: 'demoted', role: 'viewer' }])
  })

  test('pin: owned and archived candidates are excluded from the feed', async () => {
    const { app, env, db } = await setupFeed()
    await seedGroupOfMe(db, 'grp1')
    // A site 'me' OWNS, reachable via a group grant → excluded (it's not "shared with me").
    await seedMember(db, 'acme', 'me')
    await seedSite(db, { id: 'mine', spaceId: 'acme', ownerId: 'me', slug: 'mine', visibility: 'private' })
    await seedGroupShare(db, 'mine', 'grp1')
    // An archived site with a live direct share → excluded.
    await seedSite(db, { id: 'gone', spaceId: 'acme', ownerId: 'owner', slug: 'gone', status: 'archived' })
    await seedUserShare(db, 'gone', 'me', 'editor')
    // Control: one plain live share so the feed isn't trivially empty.
    await ownerSite(db, 'live')
    await seedUserShare(db, 'live', 'me', 'viewer')

    const rows = (await shared(app, env, 'me')) as FeedRow[]
    expect(rows.map((r) => r.id)).toEqual(['live'])
  })

  test('pin: empty shared feed answers [] with zero site/audio statements after the roles layer', async () => {
    const { app, env, db } = await setupFeed()
    db.resetCounters()
    expect(await shared(app, env, 'me')).toEqual([])
    // Exactly 3 statements end to end: requireAuth's getUserById (1 loose) + the two share-reach
    // reads (direct + via-group). Nothing may touch sites/files when the candidate set is empty.
    expect(db.counters.loose + db.counters.batchStmts).toBe(3)
  })
})

describe('GET /api/sites/shared — post-auth D1 request budget (S5 T5.2)', () => {
  test('perf: a populated feed costs at most 2 post-auth D1 requests', async () => {
    const { app, env, db } = await setupFeed()
    await seedGroupOfMe(db, 'grp1')
    await ownerSite(db, 'direct-hit')
    await seedUserShare(db, 'direct-hit', 'me', 'editor')
    await ownerSite(db, 'group-hit')
    await seedGroupShare(db, 'group-hit', 'grp1')
    db.resetCounters()

    const rows = (await shared(app, env, 'me')) as FeedRow[]
    expect(new Set(rows.map((r) => ({ id: r.id, role: r.role })))).toEqual(
      new Set([
        { id: 'direct-hit', role: 'editor' },
        { id: 'group-hit', role: 'viewer' },
      ]),
    )
    expect(postAuthRequests(db)).toBeLessThanOrEqual(2)
    // Exact shape: roles layer (1 batch) + fused site-rows-and-audio layer (1 batch), nothing loose.
    expect(db.counters.loose).toBe(1)
    expect(db.counters.batches).toBe(2)
  })
})

describe('GET /api/sites/shared — 91-candidate chunk boundary (S5 T5.6)', () => {
  test('boundary: roles, global newest-first order, and no dupes hold across the 90-id chunk seam', async () => {
    const { app, env, db } = await setupFeed()
    await seedGroupOfMe(db, 'grp')
    // 91 candidates: s1..s91, createdAt strictly increasing with i (s91 newest). Odd i → direct
    // viewer share; even i → group share via 'grp'. Candidate #91 gets a direct EDITOR grant AND
    // a group share, so the direct-wins override is exercised on the chunk-boundary element.
    const n = 91
    for (let i = 1; i <= n; i++) {
      const id = `s${i}`
      await seedSite(db, {
        id,
        spaceId: 'acme',
        ownerId: 'owner',
        slug: id,
        visibility: 'private',
        createdAt: at(i),
      })
      if (i === n) {
        await seedUserShare(db, id, 'me', 'editor')
        await seedGroupShare(db, id, 'grp')
      } else if (i % 2 === 1) {
        await seedUserShare(db, id, 'me', 'viewer')
      } else {
        await seedGroupShare(db, id, 'grp')
      }
    }
    // Audio must fold correctly through the CHUNKED row selects: s89 is the 91st candidate key
    // (group-share keys fold first — s2..s90,s91 — then the direct-only s1..s89), so its audio
    // scalar rides the second chunk statement.
    await seedFile(db, null, 's89', { path: 'take.webm', text: 'x' })
    db.resetCounters()

    const rows = (await shared(app, env, 'me')) as FeedRow[]
    expect(rows).toHaveLength(n)
    expect(new Set(rows.map((r) => r.id)).size).toBe(n) // no dupes across the seam
    // Global newest-first: s91, s90, ..., s1 — regardless of which 90-id chunk served each row.
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: n }, (_, k) => `s${n - k}`))
    // Roles: editor only on the boundary candidate (direct editor beats its group grant).
    expect(rows[0].id).toBe('s91')
    expect(rows[0].role).toBe('editor')
    expect(rows.slice(1).every((r) => r.role === 'viewer')).toBe(true)
    // Audio: true exactly for the s89 pure-audio site, false everywhere else (see seeding note).
    expect(rows.filter((r) => r.audio).map((r) => r.id)).toEqual(['s89'])
    // Still 2 post-auth requests: 91 ids → 2 row-chunk statements in ONE batch.
    expect(db.counters.loose).toBe(1)
    expect(db.counters.batches).toBe(2)
  })
})
