import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { siteStars, siteUserShares, sites as sitesTable } from '../db/schema'
import { seedMember, seedSite, seedSpace, seedStar, seedUserShare } from '../test/harness'
import { at, auth, makeRouteApp, mintUser, postAuthRequests, type RouteApp } from '../test/route-fixtures'

// GET /api/sites/starred — the feed behind the Starred tab. Two decisions are load-bearing and
// both are pinned here: it orders by STAR time (what you pinned most recently), not site time; and
// it re-filters at READ time through the same checkAccess the rest of the app uses, so a site that
// leaves your reach drops out of the feed while its star row survives for a flip back.

async function setup() {
  const ctx = makeRouteApp()
  const { db, kv } = ctx
  await mintUser(db, kv, 'owner', { email: 'owner@e.com' })
  await mintUser(db, kv, 'me', { email: 'me@e.com' })
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  return ctx
}

const starred = (ctx: RouteApp) =>
  ctx.app
    .request('/api/sites/starred', { headers: auth('me') }, ctx.env)
    .then((r) => r.json() as Promise<{ id: string; starred: boolean }[]>)

describe('GET /api/sites/starred', () => {
  test('orders newest-STAR-first, not newest-site-first', async () => {
    const ctx = await setup()
    // 'fresh' is the newer SITE; 'old' is the more recently STARRED one. A feed that reused the
    // site-feed ORDER BY would answer ['fresh', 'old'].
    await seedSite(ctx.db, { id: 'old', spaceId: 'acme', ownerId: 'owner', slug: 'old', createdAt: at(1) })
    await seedSite(ctx.db, { id: 'fresh', spaceId: 'acme', ownerId: 'owner', slug: 'fresh', createdAt: at(9) })
    await seedStar(ctx.db, 'fresh', 'me', at(2))
    await seedStar(ctx.db, 'old', 'me', at(5))

    expect((await starred(ctx)).map((r) => r.id)).toEqual(['old', 'fresh'])
  })

  test('every row carries the full feed shape with starred:true', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'deck', spaceId: 'acme', ownerId: 'owner', slug: 'deck', title: 'Deck', createdAt: at(3) })
    await seedStar(ctx.db, 'deck', 'me', at(4))

    expect(await starred(ctx)).toEqual([
      {
        id: 'deck',
        spaceSlug: 'acme',
        siteSlug: 'deck',
        title: 'Deck',
        visibility: 'team',
        status: 'active',
        theme: null,
        audio: false,
        hasSummary: false,
        starred: true,
        url: 'https://glance.example.com/acme/deck',
        createdAt: at(3),
        updatedAt: at(3),
      },
    ])
  })

  test('drops what the caller can no longer reach — private, archived, share-revoked — keeping the star row', async () => {
    const ctx = await setup()
    const { db } = ctx
    await seedSite(db, { id: 'keep', spaceId: 'acme', ownerId: 'owner', slug: 'keep', createdAt: at(1) })
    await seedSite(db, { id: 'hidden', spaceId: 'acme', ownerId: 'owner', slug: 'hidden', createdAt: at(2) })
    await seedSite(db, { id: 'gone', spaceId: 'acme', ownerId: 'owner', slug: 'gone', createdAt: at(3) })
    // 'me' is not an acme member: only the direct share admits them to a members-tier site.
    await seedSite(db, { id: 'walled', spaceId: 'acme', ownerId: 'owner', slug: 'walled', visibility: 'members', createdAt: at(4) })
    await seedUserShare(db, 'walled', 'me')
    for (const id of ['keep', 'hidden', 'gone', 'walled']) await seedStar(db, id, 'me', at(1))

    expect((await starred(ctx)).map((r) => r.id).sort()).toEqual(['gone', 'hidden', 'keep', 'walled'])

    await db.update(sitesTable).set({ visibility: 'private' }).where(eq(sitesTable.id, 'hidden'))
    await db.update(sitesTable).set({ status: 'archived' }).where(eq(sitesTable.id, 'gone'))
    await ctx.app.request('/api/sites/acme/walled/shares', {
      method: 'PUT',
      headers: auth('owner'),
      body: JSON.stringify({ userIds: [] }),
    }, ctx.env)

    expect((await starred(ctx)).map((r) => r.id)).toEqual(['keep'])
    // Every star ROW survives — the filter is a read-time view, not a delete.
    expect(await db.select().from(siteStars)).toHaveLength(4)

    // Flipping back restores it, which is the whole reason the row is kept.
    await db.update(sitesTable).set({ visibility: 'team' }).where(eq(sitesTable.id, 'hidden'))
    expect((await starred(ctx)).map((r) => r.id).sort()).toEqual(['hidden', 'keep'])
  })

  test('your OWN page flipping to private KEEPS its place — visibility is not a star rule', async () => {
    const ctx = await setup()
    const { db } = ctx
    await seedSite(db, { id: 'draft', spaceId: 'acme', ownerId: 'me', slug: 'draft', createdAt: at(1) })
    await seedStar(db, 'draft', 'me', at(2))
    expect((await starred(ctx)).map((r) => r.id)).toEqual(['draft'])

    // checkAccess still admits the owner, and that is the whole gate — the feed must not add one.
    await db.update(sitesTable).set({ visibility: 'private' }).where(eq(sitesTable.id, 'draft'))
    expect((await starred(ctx)).map((r) => r.id)).toEqual(['draft'])
  })

  test('a private page shared with you stays in the feed until the share is revoked', async () => {
    const ctx = await setup()
    const { db } = ctx
    await seedSite(db, { id: 'hush', spaceId: 'acme', ownerId: 'owner', slug: 'hush', visibility: 'private', createdAt: at(1) })
    await seedUserShare(db, 'hush', 'me')
    await seedStar(db, 'hush', 'me', at(2))
    expect((await starred(ctx)).map((r) => r.id)).toEqual(['hush'])

    await db.delete(siteUserShares).where(eq(siteUserShares.siteId, 'hush'))
    expect(await starred(ctx)).toEqual([])
    expect(await db.select().from(siteStars)).toHaveLength(1) // the row waits for a re-share
  })

  test('zero stars → [] without issuing the row-fetch statement', async () => {
    const ctx = await setup()
    await seedSite(ctx.db, { id: 'deck', spaceId: 'acme', ownerId: 'owner', slug: 'deck' })
    ctx.db.resetCounters()

    expect(await starred(ctx)).toEqual([])
    expect(postAuthRequests(ctx.db)).toBe(1)
  })
})
