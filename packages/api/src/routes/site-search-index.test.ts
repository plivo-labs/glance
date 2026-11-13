import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { sites, users } from '../db/schema'
import { siteText } from '../lib/site-search'
import { seedFile, seedMember, seedSite, seedSpace } from '../test/harness'
import { APP_URL, makeRouteApp, mintUser } from '../test/route-fixtures'

async function setup() {
  const ctx = makeRouteApp()
  for (const id of ['owner', 'ed', 'rd']) await mintUser(ctx.db, ctx.kv, id)
  await mintUser(ctx.db, ctx.kv, 'root', { role: 'superadmin' })
  await seedSpace(ctx.db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(ctx.db, 'acme', 'owner')
  return ctx
}
type Ctx = Awaited<ReturnType<typeof setup>>

const hdr = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL })
const put = (ctx: Ctx, id: string, slug: string, files: Record<string, string>, o: { replace?: boolean; expectedVersion?: number } = {}) => {
  const fd = new FormData()
  if (o.expectedVersion !== undefined) fd.append('expectedVersion', String(o.expectedVersion))
  for (const [name, text] of Object.entries(files)) fd.append('files', new File([text], name, { type: name.endsWith('.md') ? 'text/markdown' : name.endsWith('.css') ? 'text/css' : 'text/html' }))
  return ctx.app.request(`/api/upload/acme/${slug}${o.replace ? '?replace=true' : ''}`, { method: 'POST', headers: hdr(id), body: fd }, ctx.env)
}
const send = (ctx: Ctx, id: string, method: string, path: string, body?: unknown) =>
  ctx.app.request(path, { method, headers: { ...hdr(id), 'content-type': 'application/json' }, body: body && JSON.stringify(body) }, ctx.env)
const body = async (ctx: Ctx, siteId: string) =>
  (await ctx.db.all<{ body: string }>(sql`SELECT body FROM site_text WHERE siteId = ${siteId}`))[0]?.body ?? null
// Sites the FTS INDEX (not just site_text) returns for a word — what search actually sees.
const matches = async (ctx: Ctx, word: string) =>
  (await ctx.db.all<{ siteId: string }>(sql`SELECT t.siteId AS siteId FROM site_search s JOIN site_text t ON t.id = s.rowid WHERE site_search MATCH ${`"${word}"`}`)).map((r) => r.siteId)
const stamp = async (ctx: Ctx, siteId: string) =>
  (await ctx.db.select({ at: sites.searchIndexedAt }).from(sites).where(eq(sites.id, siteId)))[0]?.at ?? null
const idOf = async (ctx: Ctx, slug: string) => (await ctx.db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)))[0]?.id as string

describe('search index follows the files', () => {
  test('create indexes html and markdown text, entry first; replace swaps it; no text files leaves no row but a stamp', async () => {
    const ctx = await setup()
    expect((await put(ctx, 'owner', 'doc', { 'index.html': '<h1>Roadmap</h1>', 'notes.md': '# Launch plan', 'a.css': 'body{color:red}' })).status).toBe(200)
    const id = await idOf(ctx, 'doc')
    expect(await body(ctx, id)).toBe('Roadmap\n# Launch plan')
    expect(await stamp(ctx, id)).not.toBeNull()
    expect(await matches(ctx, 'roadmap')).toEqual([id])
    await put(ctx, 'owner', 'doc', { 'index.html': '<p>bravo</p>' }, { replace: true })
    expect(await body(ctx, id)).toBe('bravo')
    expect([await matches(ctx, 'bravo'), await matches(ctx, 'roadmap')]).toEqual([[id], []]) // one hit, old words gone
    await put(ctx, 'owner', 'doc', { 'a.css': 'body{}' }, { replace: true })
    expect([await body(ctx, id), await matches(ctx, 'bravo')]).toEqual([null, []])
    expect(await stamp(ctx, id)).not.toBeNull()
  })

  test('editor replace re-indexes; a stale-version 409 leaves the index alone', async () => {
    const ctx = await setup()
    await put(ctx, 'owner', 'doc', { 'index.html': '<p>alpha</p>' })
    const id = await idOf(ctx, 'doc')
    await send(ctx, 'owner', 'PUT', '/api/sites/acme/doc/shares', { users: [{ id: 'ed', role: 'editor' }] })
    expect((await put(ctx, 'ed', 'doc', { 'index.html': '<p>stale</p>' }, { replace: true, expectedVersion: 9 })).status).toBe(409)
    expect(await body(ctx, id)).toBe('alpha')
    expect((await put(ctx, 'ed', 'doc', { 'index.html': '<p>charlie</p>' }, { replace: true, expectedVersion: 0 })).status).toBe(200)
    expect([await body(ctx, id), await matches(ctx, 'charlie'), await matches(ctx, 'alpha')]).toEqual(['charlie', [id], []])
  })

  test('fork copies the source text and stamp; a fork of an unindexed source stays unindexed', async () => {
    const ctx = await setup()
    await seedSpace(ctx.db, { id: 'rd-sp', slug: 'rd', type: 'personal', createdBy: 'rd' })
    await seedMember(ctx.db, 'rd-sp', 'rd')
    await put(ctx, 'owner', 'doc', { 'index.html': '<p>forkable words</p>' })
    const raw = await seedSite(ctx.db, { spaceId: 'acme', ownerId: 'owner', slug: 'raw' }) // never indexed
    await seedFile(ctx.db, ctx.r2, raw, { path: 'index.html', text: '<p>raw</p>' })
    for (const slug of ['doc', 'raw']) expect((await send(ctx, 'rd', 'POST', `/api/sites/acme/${slug}/fork`)).status).toBe(200)
    const copy = await idOf(ctx, 'doc-copy')
    expect(await body(ctx, copy)).toBe('forkable words')
    expect(await stamp(ctx, copy)).toBe(await stamp(ctx, await idOf(ctx, 'doc')))
    const rawCopy = await idOf(ctx, 'raw-copy')
    expect([await body(ctx, rawCopy), await stamp(ctx, rawCopy)]).toEqual([null, null])
  })
})

describe('search text leaves with its site', () => {
  test('site, admin, space and user delete each leave no FTS match for their sites, and spare the others', async () => {
    const ctx = await setup()
    await mintUser(ctx.db, ctx.kv, 'gone')
    for (const [id, slug] of [['other', 'other'], ['gone-sp', 'gone-sp']] as const) {
      await seedSpace(ctx.db, { id, slug, createdBy: id === 'other' ? 'owner' : 'gone' })
      await seedMember(ctx.db, id, id === 'other' ? 'owner' : 'gone')
    }
    const indexed = async (spaceId: string, owner: string, slug: string) => {
      const id = await seedSite(ctx.db, { spaceId, ownerId: owner, slug })
      await ctx.db.insert(siteText).values({ siteId: id, body: `${slug}word` })
      return id
    }
    const byAdmin = await indexed('acme', 'owner', 'byadmin')
    const [, , , survivor] = [await indexed('acme', 'owner', 'own'), await indexed('acme', 'owner', 'inspace'), await indexed('gone-sp', 'gone', 'ofuser'), await indexed('other', 'owner', 'survivor')]
    // Raw index rowids (no join to site_text): an orphaned index entry would still show up here.
    const gone = async (word: string) => expect(await ctx.db.all(sql`SELECT rowid FROM site_search WHERE site_search MATCH ${`"${word}"`}`)).toEqual([])
    expect((await send(ctx, 'owner', 'DELETE', '/api/sites/acme/own')).status).toBe(200)
    expect((await send(ctx, 'root', 'DELETE', `/api/admin/sites/${byAdmin}`)).status).toBe(200)
    expect((await send(ctx, 'owner', 'DELETE', '/api/spaces/acme')).status).toBe(200)
    await ctx.db.delete(users).where(eq(users.id, 'gone')) // no route deletes users; the FK cascade must still clean up
    for (const w of ['ownword', 'byadminword', 'inspaceword', 'ofuserword']) await gone(w)
    expect(await matches(ctx, 'survivorword')).toEqual([survivor])
  })
})
