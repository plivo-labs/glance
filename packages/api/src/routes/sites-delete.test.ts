import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../db/schema'
import { seedMember, seedSite, seedSpace } from '../test/harness'
import { auth, authKey, makeRouteApp, mintKey, mintUser } from '../test/route-fixtures'

// DELETE /api/sites/:space/:site — an API key MAY create sites (deploy is the headline use case)
// but MUST NOT delete them. The deny keys on the credential kind, checked BEFORE the ownership
// check, so a key never learns whether the site exists or who owns it.

async function setup() {
  const ctx = makeRouteApp()
  const { db, kv } = ctx
  await mintUser(db, kv, 'owner', { email: 'owner@e.com' })
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  await seedSite(db, { id: 'deck', spaceId: 'acme', ownerId: 'owner', slug: 'deck' })
  return ctx
}

describe('DELETE /api/sites/:space/:site — credential-based deny', () => {
  test('CASE-07: a key-authenticated delete, from the owner’s own key, is 403’d and the site survives', async () => {
    const ctx = await setup()
    const secret = await mintKey(ctx.db, 'owner')

    const res = await ctx.app.request('/api/sites/acme/deck', { method: 'DELETE', headers: authKey(secret) }, ctx.env)
    expect(res.status).toBe(403)
    expect(await ctx.db.select().from(sites).where(eq(sites.id, 'deck'))).toHaveLength(1)
  })

  test('CASE-07b: the same delete with a CLI Bearer token, same owner, same site, still succeeds', async () => {
    const ctx = await setup()

    const res = await ctx.app.request('/api/sites/acme/deck', { method: 'DELETE', headers: auth('owner') }, ctx.env)
    expect(res.status).toBe(200)
    expect(await ctx.db.select().from(sites).where(eq(sites.id, 'deck'))).toHaveLength(0)
  })

  // Pins the ORDERING the handler's comment claims. Moving the deny below the site lookup keeps
  // both cases above green while turning the route into an existence oracle: a key would get 404
  // for a site that does not exist and 403 for one that does, which is exactly the leak the
  // credential check is placed first to avoid.
  test('CASE-07c: a key-authenticated delete of a NONEXISTENT site is 403, not 404', async () => {
    const ctx = await setup()
    const secret = await mintKey(ctx.db, 'owner')

    const res = await ctx.app.request('/api/sites/acme/ghost', { method: 'DELETE', headers: authKey(secret) }, ctx.env)
    expect(res.status).toBe(403)
  })
})
