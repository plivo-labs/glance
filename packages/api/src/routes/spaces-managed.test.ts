import { describe, expect, test } from 'bun:test'
import { seedMember, seedSpace } from '../test/harness'
import { auth, makeRouteApp as setup, mintUser } from '../test/route-fixtures'

// A space whose roster mirrors an identity-provider group (lib/oidc-access.ts) has no owner: its
// first member is createdBy only because the column is NOT NULL.
async function managedSpace() {
  const ctx = await setup()
  await mintUser(ctx.db, ctx.kv, 'first')
  await mintUser(ctx.db, ctx.kv, 'other')
  await mintUser(ctx.db, ctx.kv, 'admin', { role: 'superadmin' })
  await seedSpace(ctx.db, { id: 'g', slug: 'platform', createdBy: 'first', oidcGroup: 'app.glance.Platform' })
  await seedMember(ctx.db, 'g', 'first')
  return ctx
}

describe('IdP-managed group spaces', () => {
  test('GET reports managed and no owner, even to the member who created it', async () => {
    const { app, env } = await managedSpace()
    const res = await app.request('/api/spaces/platform', { headers: auth('first') }, env)
    expect(await res.json()).toMatchObject({ managed: true, isOwner: false, isMember: true })
  })

  test('inviting and removing members is refused with 409', async () => {
    const { app, env } = await managedSpace()
    const invite = await app.request(
      '/api/spaces/platform/members',
      { method: 'POST', headers: auth('first'), body: JSON.stringify({ email: 'other@example.com' }) },
      env,
    )
    expect(invite.status).toBe(409)
    const remove = await app.request('/api/spaces/platform/members/first', { method: 'DELETE', headers: auth('first') }, env)
    expect(remove.status).toBe(409)
  })

  test('only a superadmin can delete it', async () => {
    const { app, env } = await managedSpace()
    expect((await app.request('/api/spaces/platform', { method: 'DELETE', headers: auth('first') }, env)).status).toBe(
      403,
    )
    expect((await app.request('/api/spaces/platform', { method: 'DELETE', headers: auth('admin') }, env)).status).toBe(
      200,
    )
  })
})
