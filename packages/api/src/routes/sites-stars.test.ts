import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { siteStars, users } from '../db/schema'
import { seedMember, seedSite, seedSpace, seedStar } from '../test/harness'
import { auth, makeRouteApp, mintUser, type RouteApp } from '../test/route-fixtures'

// Star toggle — POST/DELETE /api/sites/:space/:site/star. The route owns no access model of its
// own: it re-runs the same fetchAccessFacts + checkAccess pair every other site route uses, so
// 404/403/410 precedence is inherited rather than re-implemented. The ONE rule it adds is that a
// `private` site is never starrable — not even by its owner (a star is a pin on something you can
// come back to through a shared surface; a private site has no such surface).

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

  test('a private site is not starrable — not even by its own owner', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'draft', spaceId: 'acme', ownerId: 'owner', slug: 'draft', visibility: 'private' })

    const res = await star(ctx, 'acme', 'draft', 'owner', 'POST')
    expect(res.status).toBe(400)
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
