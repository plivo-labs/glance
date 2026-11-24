import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../db/schema'
import { seedMember, seedSite, seedSpace } from '../test/harness'
import { auth, makeRouteApp, mintUser } from '../test/route-fixtures'

// The owner shelves their own page ('owner_archived') instead of deleting it. It is a state apart from
// the admin's hold ('archived'): the owner undoes theirs and can never lift an admin's.

const HOUR = 3_600_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

async function setup(status: 'active' | 'expired' | 'archived' | 'owner_archived' = 'active', expiresAt: string | null = null) {
  const { app, env, db, kv } = makeRouteApp()
  await mintUser(db, kv, 'owner')
  await mintUser(db, kv, 'other')
  const sp = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
  await seedMember(db, sp, 'owner')
  const id = await seedSite(db, { spaceId: sp, ownerId: 'owner', slug: 'report', status, expiresAt })
  const patch = (body: unknown, who = 'owner') => app.request('/api/sites/docs/report', { method: 'PATCH', headers: auth(who), body: JSON.stringify(body) }, env)
  const row = async () => (await db.select({ s: sites.status, e: sites.expiresAt }).from(sites).where(eq(sites.id, id)))[0]
  return { patch, row }
}

describe('PATCH /api/sites archived', () => {
  test('archive shelves the page and unarchive brings it back', async () => {
    const { patch, row } = await setup()
    expect((await patch({ archived: true })).status).toBe(200)
    expect((await row())?.s).toBe('owner_archived')
    expect((await patch({ archived: false })).status).toBe(200)
    expect((await row())?.s).toBe('active')
  })

  test('unarchive is a no-op on a page that was not shelved, and returns a lapsed one to expired', async () => {
    const { patch, row } = await setup('active', iso(-HOUR))
    await patch({ archived: false })
    expect((await row())?.s).toBe('active')
    await patch({ archived: true })
    await patch({ archived: false })
    expect((await row())?.s).toBe('expired')
  })

  test("an admin's archive is not the owner's to lift, and stays archived under archive:true", async () => {
    const { patch, row } = await setup('archived')
    expect((await patch({ archived: false })).status).toBe(403)
    expect((await row())?.s).toBe('archived')
    expect((await patch({ archived: true })).status).toBe(200)
    expect((await row())?.s).toBe('archived')
  })

  test('only the owner, only a boolean, and never together with expires', async () => {
    const { patch, row } = await setup()
    expect((await patch({ archived: true }, 'other')).status).toBe(403)
    expect((await patch({ archived: 'yes' })).status).toBe(400)
    expect((await patch({ archived: true, expires: '7d' })).status).toBe(400)
    expect((await row())?.s).toBe('active')
  })

  test('setting an expiry on a shelved page does not bring it back', async () => {
    const { patch, row } = await setup('owner_archived')
    expect((await patch({ expires: '7d' })).status).toBe(200)
    expect((await row())?.s).toBe('owner_archived')
  })
})
