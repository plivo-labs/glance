import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { siteStars, users } from '../db/schema'
import { seedMember, seedSite, seedSpace, seedStar, seedUserShare } from '../test/harness'
import { auth, makeRouteApp, mintUser, type RouteApp } from '../test/route-fixtures'

// Star toggle — POST/DELETE /api/sites/:space/:site/star. The route owns no access model of its
// own and adds NO rule of its own: it re-runs the same fetchAccessFacts + checkAccess pair every
// other site route uses, so if you can open a page you can star it. A star is a private, per-user
// bookmark — invisible to everyone else and granting nothing — so a page's visibility tier has
// nothing to protect here. Private pages you own, and private pages shared with you, are starrable.

/** App + an 'acme' group space owned by `owner`, with `me` signed in as a plain member. */
async function setup() {
  const ctx = makeRouteApp()
  const { db, kv } = ctx
  await mintUser(db, kv, 'owner', { email: 'owner@e.com' })
  await mintUser(db, kv, 'me', { email: 'me@e.com' })
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  return ctx
}

const star = (ctx: RouteApp, space: string, site: string, id: string, method: 'POST' | 'DELETE') =>
  ctx.app.request(`/api/sites/${space}/${site}/star`, { method, headers: auth(id) }, ctx.env)

describe('POST/DELETE /api/sites/:space/:site/star', () => {
  test('starring a team site returns {starred:true}, and starring twice leaves exactly one row', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'deck', spaceId: 'acme', ownerId: 'owner', slug: 'deck' })

    const first = await star(ctx, 'acme', 'deck', 'me', 'POST')
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ starred: true })

    const again = await star(ctx, 'acme', 'deck', 'me', 'POST')
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ starred: true })
    expect(await ctx.db.select().from(siteStars)).toHaveLength(1)
  })

  test('unstarring returns {starred:false}, and unstarring what was never starred is still 200', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'deck', spaceId: 'acme', ownerId: 'owner', slug: 'deck' })
    await seedStar(ctx.db, 'deck', 'me')

    const removed = await star(ctx, 'acme', 'deck', 'me', 'DELETE')
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ starred: false })
    expect(await ctx.db.select().from(siteStars)).toHaveLength(0)

    const noop = await star(ctx, 'acme', 'deck', 'me', 'DELETE')
    expect(noop.status).toBe(200)
    expect(await noop.json()).toEqual({ starred: false })
  })

  test('your OWN private page is starrable', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'draft', spaceId: 'acme', ownerId: 'owner', slug: 'draft', visibility: 'private' })

    const res = await star(ctx, 'acme', 'draft', 'owner', 'POST')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ starred: true })
  })

  test('a private page SHARED with you is starrable — the case an explicit share exists for', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'hush', spaceId: 'acme', ownerId: 'owner', slug: 'hush', visibility: 'private' })
    // 'me' is not an acme member: the direct share is the only thing admitting them.
    await seedUserShare(ctx.db, 'hush', 'me')

    const res = await star(ctx, 'acme', 'hush', 'me', 'POST')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ starred: true })
  })

  test('a private page you cannot reach is still 403 — checkAccess, not the star rule, is the gate', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'walled', spaceId: 'acme', ownerId: 'owner', slug: 'walled', visibility: 'private' })

    expect((await star(ctx, 'acme', 'walled', 'me', 'POST')).status).toBe(403)
    expect(await ctx.db.select().from(siteStars)).toHaveLength(0)
  })

  test('access precedence is checkAccess’s, not the route’s: member 200 / non-member 403 / unknown 404 / archived 410', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'crew', spaceId: 'acme', ownerId: 'owner', slug: 'crew', visibility: 'members' })
    await seedSite(ctx.db, { id: 'old', spaceId: 'acme', ownerId: 'owner', slug: 'old', status: 'archived' })

    expect((await star(ctx, 'acme', 'crew', 'me', 'POST')).status).toBe(403)
    await seedMember(ctx.db, 'acme', 'me')
    expect((await star(ctx, 'acme', 'crew', 'me', 'POST')).status).toBe(200)

    expect((await star(ctx, 'acme', 'ghost', 'me', 'POST')).status).toBe(404)
    expect((await star(ctx, 'acme', 'old', 'me', 'POST')).status).toBe(410)
  })
})

describe('site_stars rows', () => {
  test('deleting a site leaves no orphan star rows (FK cascade, through the real DELETE route)', async () => {
    const { app, env, db } = await setup()
    await seedSite(db, { id: 'deck', spaceId: 'acme', ownerId: 'owner', slug: 'deck' })
    await seedStar(db, 'deck', 'me')
    expect(await db.select().from(siteStars)).toHaveLength(1)

    const res = await app.request('/api/sites/acme/deck', { method: 'DELETE', headers: auth('owner') }, env)
    expect(res.status).toBe(200)
    expect(await db.select().from(siteStars)).toHaveLength(0)
  })

  test('deleting a user leaves no orphan star rows', async () => {
    const { db } = await setup()
    await seedSite(db, { id: 'deck', spaceId: 'acme', ownerId: 'owner', slug: 'deck' })
    await seedStar(db, 'deck', 'me')

    await db.delete(users).where(eq(users.id, 'me'))
    expect(await db.select().from(siteStars)).toHaveLength(0)
  })
})
