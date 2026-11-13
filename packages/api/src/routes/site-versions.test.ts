import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { files, siteVersionFiles, siteVersions, sites } from '../db/schema'
import { seedMember, seedSite, seedSpace, seedUserShare } from '../test/harness'
import { APP_URL, makeRouteApp, mintUser } from '../test/route-fixtures'

// Version history: every REPLACE snapshots the rows it replaces into a version and keeps their R2
// objects; owner/editor paths, restore, delete and fork all have to agree on who owns which key.

async function setup() {
  const ctx = makeRouteApp()
  const { db, kv } = ctx
  for (const id of ['owner', 'ed', 'other']) await mintUser(db, kv, id)
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  await seedSite(db, { id: 'site', spaceId: 'acme', ownerId: 'owner', slug: 'doc' })
  await seedUserShare(db, 'site', 'ed', 'editor')
  return ctx
}
type Ctx = Awaited<ReturnType<typeof setup>>

// Deploy through the real upload route (replace=true), as `as`. `expected` feeds the editor CAS.
function deploy(ctx: Ctx, as: string, content: Record<string, string>, expected?: number) {
  const fd = new FormData()
  for (const [name, text] of Object.entries(content)) fd.append('files', new File([text], name, { type: 'text/html' }))
  if (expected !== undefined) fd.append('expectedVersion', String(expected))
  const headers = { Authorization: `Bearer tok-${as}`, Origin: APP_URL }
  return ctx.app.request('/api/upload/acme/doc?replace=true', { method: 'POST', headers, body: fd }, ctx.env)
}

const versionRows = (ctx: Ctx) => ctx.db.select().from(siteVersions).where(eq(siteVersions.siteId, 'site'))
const liveKeys = (ctx: Ctx) =>
  ctx.db.select({ k: files.storageKey }).from(files).where(eq(files.siteId, 'site')).then((r) => r.map((x) => x.k))
const versionKeys = (ctx: Ctx) => ctx.db.select({ k: siteVersionFiles.storageKey }).from(siteVersionFiles).then((r) => r.map((x) => x.k))

describe('replace snapshots the replaced files into a version', () => {
  test('versions.owner.replace: old rows move to a version, old objects stay in R2, new rows get new keys', async () => {
    const ctx = await setup()
    // The seeded site has no files yet, so the first deploy has nothing to snapshot.
    await deploy(ctx, 'owner', { 'index.html': 'one', 'a.html': 'aa' })
    expect(await versionRows(ctx)).toHaveLength(0)
    const firstKeys = await liveKeys(ctx)

    expect((await deploy(ctx, 'owner', { 'index.html': 'two' })).status).toBe(200)

    const [v, ...rest] = await versionRows(ctx)
    expect(rest).toHaveLength(0)
    expect(v).toMatchObject({ siteId: 'site', version: 1, createdBy: 'owner', fileCount: 2, totalSize: 5 })
    expect((await versionKeys(ctx)).sort()).toEqual([...firstKeys].sort())
    for (const k of firstKeys) expect(await ctx.r2.get(k)).not.toBeNull() // kept, not deleted
    const live = await liveKeys(ctx)
    expect(live).toHaveLength(1)
    expect(firstKeys).not.toContain(live[0])
  })

  test('versions.editor.replace: the CAS path snapshots too, labelled with the pulled version; a stale 409 snapshots nothing', async () => {
    const ctx = await setup()
    await deploy(ctx, 'owner', { 'index.html': 'one' })
    const before = ctx.r2.store.size

    expect((await deploy(ctx, 'ed', { 'index.html': 'stale' }, 99)).status).toBe(409)
    expect(await versionRows(ctx)).toHaveLength(0)
    expect(ctx.r2.store.size).toBe(before) // the rejected upload's objects were reclaimed

    expect((await deploy(ctx, 'ed', { 'index.html': 'two' }, 1)).status).toBe(200)
    const [v] = await versionRows(ctx)
    expect(v).toMatchObject({ version: 1, createdBy: 'ed', fileCount: 1 })
    expect(await ctx.r2.get((await versionKeys(ctx))[0] ?? '')).not.toBeNull()
  })
})

describe('every lifecycle path accounts for version-owned objects', () => {
  // Two deploys → one live file + one version file: two R2 objects, both must be reclaimed.
  async function withHistory() {
    const ctx = await setup()
    await deploy(ctx, 'owner', { 'index.html': 'one' })
    await deploy(ctx, 'owner', { 'index.html': 'two' })
    expect(ctx.r2.store.size).toBe(2)
    return ctx
  }

  test('versions.delete.site: owner delete leaves no orphan object and no version rows', async () => {
    const ctx = await withHistory()
    const res = await ctx.app.request('/api/sites/acme/doc', { method: 'DELETE', headers: { Authorization: 'Bearer tok-owner', Origin: APP_URL } }, ctx.env)
    expect(res.status).toBe(200)
    expect(ctx.r2.store.size).toBe(0)
    expect(await versionRows(ctx)).toHaveLength(0)
    expect(await versionKeys(ctx)).toHaveLength(0)
  })

  test('versions.delete.admin: admin delete leaves no orphan object', async () => {
    const ctx = await withHistory()
    await mintUser(ctx.db, ctx.kv, 'root', { role: 'superadmin' })
    const res = await ctx.app.request('/api/admin/sites/site', { method: 'DELETE', headers: { Authorization: 'Bearer tok-root', Origin: APP_URL } }, ctx.env)
    expect(res.status).toBe(200)
    expect(ctx.r2.store.size).toBe(0)
  })

  test('versions.delete.space: deleting the space leaves no orphan object', async () => {
    const ctx = await withHistory()
    const res = await ctx.app.request('/api/spaces/acme', { method: 'DELETE', headers: { Authorization: 'Bearer tok-owner', Origin: APP_URL } }, ctx.env)
    expect(res.status).toBe(200)
    expect(ctx.r2.store.size).toBe(0)
  })

  test('versions.fork: a fork copies the live files only, never the history', async () => {
    const ctx = await withHistory()
    await seedSpace(ctx.db, { id: 'o-personal', slug: 'other', type: 'personal', createdBy: 'other' })
    await seedMember(ctx.db, 'o-personal', 'other')
    const res = await ctx.app.request('/api/sites/acme/doc/fork', { method: 'POST', headers: { Authorization: 'Bearer tok-other', Origin: APP_URL } }, ctx.env)
    expect(res.status).toBe(200)

    const all = await ctx.db.select().from(siteVersions)
    expect(all.map((v) => v.siteId)).toEqual(['site']) // the source keeps its one version; the fork has none
    expect(ctx.r2.store.size).toBe(3) // 2 source objects + 1 copied live file
    expect(await versionKeys(ctx)).toHaveLength(1)
  })

  test('versions.move: moving the site needs nothing — the history rides along on siteId', async () => {
    const ctx = await withHistory()
    await seedSpace(ctx.db, { id: 'beta', slug: 'beta', createdBy: 'owner' })
    await seedMember(ctx.db, 'beta', 'owner')
    const headers = { Authorization: 'Bearer tok-owner', Origin: APP_URL, 'content-type': 'application/json' }
    const res = await ctx.app.request('/api/sites/acme/doc/move', { method: 'POST', headers, body: JSON.stringify({ space: 'beta' }) }, ctx.env)
    expect(res.status).toBe(200)
    expect(await versionRows(ctx)).toHaveLength(1)
    expect(ctx.r2.store.size).toBe(2)
  })
})

describe('GET / POST /api/sites/:space/:site/versions', () => {
  const call = (ctx: Ctx, as: string | null, method: string, path = '') =>
    ctx.app.request(
      `/api/sites/acme/doc/versions${path}`,
      { method, headers: { Origin: APP_URL, ...(as && { Authorization: `Bearer tok-${as}` }) } },
      ctx.env,
    )
  const liveText = async (ctx: Ctx) => (await ctx.r2.get((await liveKeys(ctx))[0] ?? ''))?.text()
  const blurb = (s: string) => `<meta name="description" content="blurb ${s}">${s}`
  // Three deploys on an empty site: the first has nothing to snapshot, so v1 = 'zero', v2 = 'one', live = 'two'.
  async function withHistory() {
    const ctx = await setup()
    for (const t of ['zero', 'one', 'two']) await deploy(ctx, 'owner', { 'index.html': blurb(t) })
    return ctx
  }
  const listed = async (ctx: Ctx) =>
    ((await (await call(ctx, 'owner', 'GET')).json()) as { versions: { id: string; version: number }[] }).versions

  test('versions.list: the owner sees the snapshots newest first, with who and how big', async () => {
    const ctx = await withHistory()
    const res = await call(ctx, 'owner', 'GET')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { versions: Record<string, unknown>[] }
    expect(body.versions.map((v) => v.version)).toEqual([2, 1])
    expect(body.versions[0]).toMatchObject({ fileCount: 1, createdBy: { id: 'owner', email: 'owner@example.com' } })
  })

  test('versions.owner-only: an editor, a stranger and a superadmin get 403 on list AND restore; unknown site 404', async () => {
    const ctx = await withHistory()
    await mintUser(ctx.db, ctx.kv, 'root', { role: 'superadmin' })
    const [v] = await listed(ctx)
    for (const as of ['ed', 'other', 'root']) {
      expect((await call(ctx, as, 'GET')).status).toBe(403)
      expect((await call(ctx, as, 'POST', `/${v?.id}/restore`)).status).toBe(403)
    }
    expect((await call(ctx, null, 'GET')).status).toBe(401)
    const missing = await ctx.app.request('/api/sites/acme/nope/versions', { headers: { Authorization: 'Bearer tok-owner', Origin: APP_URL } }, ctx.env)
    expect(missing.status).toBe(404)
    expect(await listed(ctx)).toHaveLength(2) // nothing was restored
  })

  test('versions.restore.roundtrip: restore swaps the content in, snapshots what it replaced, and is itself reversible', async () => {
    const ctx = await withHistory()
    expect(await liveText(ctx)).toBe(blurb('two'))
    const v2 = (await listed(ctx)).find((v) => v.version === 2) // holds 'one'
    const oldKeys = await versionKeys(ctx)

    expect((await call(ctx, 'owner', 'POST', `/${v2?.id}/restore`)).status).toBe(200)
    expect(await liveText(ctx)).toBe(blurb('one'))
    const live = await liveKeys(ctx)
    expect(oldKeys).not.toContain(live[0]) // copied to a NEW prefix; the versions keep their own objects
    for (const k of oldKeys) expect(await ctx.r2.get(k)).not.toBeNull()
    const site = (await ctx.db.select().from(sites).where(eq(sites.id, 'site')))[0]
    expect(site).toMatchObject({ contentVersion: 4, lastReplacedBy: 'owner', description: 'blurb one' })

    // The replaced content ('two') is now the newest version — restoring it undoes the restore.
    const after = await listed(ctx)
    expect(after).toHaveLength(3)
    expect((await call(ctx, 'owner', 'POST', `/${after[0]?.id}/restore`)).status).toBe(200)
    expect(await liveText(ctx)).toBe(blurb('two'))
  })

  test('versions.restore.batch-failure: a failed swap reclaims the copied objects', async () => {
    const ctx = await withHistory()
    const [v] = await listed(ctx)
    ctx.db.batch = () => Promise.reject(new Error('d1 down'))
    expect((await call(ctx, 'owner', 'POST', `/${v?.id}/restore`)).status).toBe(500)
    expect(ctx.r2.store.size).toBe(3) // live + 2 version objects; the copy was deleted
  })

  test('versions.restore.read-failure: an R2 read failing after the first read leaves no copied object behind', async () => {
    const ctx = await withHistory()
    const [v] = await listed(ctx)
    const get = ctx.r2.get
    let reads = 0 // a 1-file version: read 1 = the entry blurb, read 2 = the copy's source read
    ctx.r2.get = ((...a: Parameters<typeof get>) => (++reads === 2 ? Promise.reject(new Error('r2 down')) : get(...a))) as never
    expect((await call(ctx, 'owner', 'POST', `/${v?.id}/restore`)).status).toBe(500)
    expect(ctx.r2.store.size).toBe(3)
  })

  test('versions.restore.guards: archived, foreign version, oversized and vanished-object restores change nothing', async () => {
    const ctx = await withHistory()
    const [v] = await listed(ctx)
    const live = await liveKeys(ctx)
    const unchanged = async () => {
      expect(await liveKeys(ctx)).toEqual(live)
      expect(await listed(ctx)).toHaveLength(2)
      expect(ctx.r2.store.size).toBe(3) // live + 2 version objects, no stray copies
    }

    expect((await call(ctx, 'owner', 'POST', '/nope/restore')).status).toBe(404)
    // Another site's version id, even one the caller owns, is not restorable here.
    await seedSite(ctx.db, { id: 'site2', spaceId: 'acme', ownerId: 'owner', slug: 'other-doc' })
    await ctx.db.insert(siteVersions).values({ id: 'foreign', siteId: 'site2', version: 1, fileCount: 1, totalSize: 1 })
    expect((await call(ctx, 'owner', 'POST', '/foreign/restore')).status).toBe(404)

    await ctx.db.update(siteVersions).set({ fileCount: 201 }).where(eq(siteVersions.id, v?.id ?? ''))
    expect((await call(ctx, 'owner', 'POST', `/${v?.id}/restore`)).status).toBe(400)
    await ctx.db.update(siteVersions).set({ fileCount: 1 }).where(eq(siteVersions.id, v?.id ?? ''))

    await ctx.db.update(sites).set({ status: 'archived' }).where(eq(sites.id, 'site'))
    expect((await call(ctx, 'owner', 'POST', `/${v?.id}/restore`)).status).toBe(409)
    await ctx.db.update(sites).set({ status: 'active' }).where(eq(sites.id, 'site'))
    await unchanged()

    // A version whose object is gone fails clean: copyObjects reclaims what it wrote, no swap happens.
    await ctx.r2.delete(await ctx.db.select({ k: siteVersionFiles.storageKey }).from(siteVersionFiles).where(eq(siteVersionFiles.versionId, v?.id ?? '')).then((r) => r.map((x) => x.k)))
    expect((await call(ctx, 'owner', 'POST', `/${v?.id}/restore`)).status).toBe(500)
    expect(await liveKeys(ctx)).toEqual(live)
    expect(ctx.r2.store.size).toBe(2)
  })
})
