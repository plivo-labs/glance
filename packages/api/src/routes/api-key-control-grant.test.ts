// `grants.control` is a promise made to the operator at mint time: the dialog offers it as an
// opt-in labelled "Also allow managing sites (deploy, create, fork)" and the docs page says it is
// what lets a key deploy. Before requireControlGrant that flag was stored, validated and shown —
// and never read, so a key minted with the box UNTICKED still had the entire control plane. These
// pin the two halves of the boundary: an unticked key cannot change control-plane state, and it
// can still do everything a data-only key is supposed to do.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../db/schema'
import { seedMember, seedSite, seedSpace } from '../test/harness'
import { DATA_ONLY_GRANTS, authKey, makeRouteApp, mintKey, mintUser } from '../test/route-fixtures'

async function setup() {
  const ctx = makeRouteApp()
  const { db, kv } = ctx
  await mintUser(db, kv, 'owner')
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  await seedSite(db, { id: 'deck', spaceId: 'acme', ownerId: 'owner', slug: 'deck' })
  return ctx
}

describe('requireControlGrant — a key without the control grant cannot change control state', () => {
  test('it cannot rename a site, and the site is untouched', async () => {
    const ctx = await setup()
    const dataOnly = await mintKey(ctx.db, 'owner', DATA_ONLY_GRANTS)

    const res = await ctx.app.request(
      '/api/sites/acme/deck',
      { method: 'PATCH', headers: authKey(dataOnly), body: JSON.stringify({ title: 'Renamed' }) },
      ctx.env,
    )
    expect(res.status).toBe(403)
    const [row] = await ctx.db.select().from(sites).where(eq(sites.id, 'deck'))
    expect(row.title).not.toBe('Renamed')
  })

  test('it cannot fork a site, create a space, or add a member', async () => {
    const ctx = await setup()
    const dataOnly = await mintKey(ctx.db, 'owner', DATA_ONLY_GRANTS)

    for (const [path, body] of [
      ['/api/sites/acme/deck/fork', { name: 'copy' }],
      ['/api/spaces', { slug: 'newspace', name: 'New' }],
      ['/api/spaces/acme/members', { email: 'x@example.com' }],
    ] as const) {
      const res = await ctx.app.request(
        path,
        { method: 'POST', headers: authKey(dataOnly), body: JSON.stringify(body) },
        ctx.env,
      )
      expect({ path, status: res.status }).toEqual({ path, status: 403 })
    }
  })

  // The other half. A data-only key is a legitimate credential, not a broken one — gating reads
  // would break the very use case the grant exists to express.
  test('it can still READ: the grant gates mutation, not access', async () => {
    const ctx = await setup()
    const dataOnly = await mintKey(ctx.db, 'owner', DATA_ONLY_GRANTS)

    const res = await ctx.app.request('/api/sites/mine', { headers: authKey(dataOnly) }, ctx.env)
    expect(res.status).toBe(200)
  })

  // And the same request with the grant ticked must go through, or the middleware would just be
  // a blanket key deny wearing a grant's name.
  test('the SAME request succeeds with a control-granted key', async () => {
    const ctx = await setup()
    const full = await mintKey(ctx.db, 'owner')

    const res = await ctx.app.request(
      '/api/sites/acme/deck',
      { method: 'PATCH', headers: authKey(full), body: JSON.stringify({ title: 'Renamed' }) },
      ctx.env,
    )
    expect(res.status).toBe(200)
    const [row] = await ctx.db.select().from(sites).where(eq(sites.id, 'deck'))
    expect(row.title).toBe('Renamed')
  })

  // Session and CLI credentials carry no grants at all; they must be governed by ownership alone,
  // exactly as before this middleware existed.
  test('a CLI-token caller is unaffected — it carries no grants to check', async () => {
    const ctx = await setup()

    const res = await ctx.app.request(
      '/api/sites/acme/deck',
      {
        method: 'PATCH',
        headers: { Authorization: 'Bearer tok-owner', Origin: 'https://glance.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed by CLI' }),
      },
      ctx.env,
    )
    expect(res.status).toBe(200)
  })
})
