import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { files as filesTable, sites as sitesTable } from '../db/schema'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, makeR2, seedFile, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from '../test/harness'
import type { AppEnv } from '../types'
import { sites } from './sites'

// Fork ("remix"): any user who can READ a site may copy it into a space they belong to (default:
// their personal space). The copy is INDEPENDENT — new id, new owner, fresh R2 objects under a new
// prefix, no shares, no comments. The bytes are COPIED, never shared: an R2 object belongs to
// exactly one file row, so deleting either site can never strand the other (the invariant that let
// us drop reference-counted deletion entirely).

const APP_URL = 'https://glance.example.com'

async function setup() {
  const db = makeDb()
  const kv = makeKv()
  const r2 = makeR2()
  const env = {
    APP_URL,
    SESSION_SECRET: 's',
    CONTENT_URL: 'https://content.example.com',
    CONTENT_TOKEN_SECRET: 'ct',
    GLANCE_SESSIONS: kv,
    GLANCE_FILES: r2,
  } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/sites', sites)

  // owner in `acme`; `rd` is a plain team-tier reader with a personal space; `st` has no space.
  await seedUser(db, { id: 'owner', email: 'owner@e.com' })
  await seedSpace(db, { id: 'acme', slug: 'acme', createdBy: 'owner' })
  await seedMember(db, 'acme', 'owner')
  const site = await seedSite(db, { id: 'site', spaceId: 'acme', ownerId: 'owner', slug: 'doc', visibility: 'team', title: 'Doc' })
  await seedFile(db, r2, site, { path: 'index.html', text: '<h1>hi</h1>', mimeType: 'text/html' })
  await seedFile(db, r2, site, { path: 'a/style.css', text: 'body{}', mimeType: 'text/css' })

  await seedUser(db, { id: 'rd', email: 'rd@e.com' })
  await seedSpace(db, { id: 'rd-personal', slug: 'rd', type: 'personal', createdBy: 'rd' })
  await seedMember(db, 'rd-personal', 'rd')

  await seedUser(db, { id: 'st', email: 'st@e.com' })

  for (const id of ['owner', 'rd', 'st'])
    await kv.put(`cli:tok-${id}`, JSON.stringify({ id, email: `${id}@e.com`, name: null, role: 'member' }))
  return { db, app, env, r2 }
}

const auth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL, 'content-type': 'application/json' })
const fork = (app: Hono<AppEnv>, env: AppEnv['Bindings'], id: string, body: unknown = {}, path = '/api/sites/acme/doc/fork') =>
  app.request(path, { method: 'POST', headers: auth(id), body: JSON.stringify(body) }, env)

describe('POST /api/sites/:space/:site/fork', () => {
  test('fork.reader.ok: a plain reader forks into their personal space; copy is independent', async () => {
    const { db, app, env } = await setup()
    const res = await fork(app, env, 'rd')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ spaceSlug: 'rd', siteSlug: 'doc-copy', url: `${APP_URL}/rd/doc-copy` })

    const copy = (await db.select().from(sitesTable).where(eq(sitesTable.slug, 'doc-copy')))[0]
    expect(copy).toMatchObject({ ownerId: 'rd', spaceId: 'rd-personal', forkedFrom: 'site', contentVersion: 0 })
    expect(copy?.id).not.toBe('site')
  })

  test('fork.files.copied: every file row is reproduced with FRESH storage keys (no shared objects)', async () => {
    const { db, app, env, r2 } = await setup()
    await fork(app, env, 'rd')
    const copy = (await db.select().from(sitesTable).where(eq(sitesTable.slug, 'doc-copy')))[0]

    const src = await db.select().from(filesTable).where(eq(filesTable.siteId, 'site'))
    const dst = await db.select().from(filesTable).where(eq(filesTable.siteId, copy?.id ?? ''))
    expect(dst.map((f) => f.path).sort()).toEqual(['a/style.css', 'index.html'])

    // The invariant the whole design rests on: one R2 object, one file row.
    const srcKeys = new Set(src.map((f) => f.storageKey))
    for (const f of dst) expect(srcKeys.has(f.storageKey)).toBe(false)

    // Bytes really were copied — the new keys resolve to the same content.
    const idx = dst.find((f) => f.path === 'index.html')
    expect(await (await r2.get(idx?.storageKey ?? ''))?.text()).toBe('<h1>hi</h1>')
    expect(dst.find((f) => f.path === 'index.html')?.mimeType).toBe('text/html')

    // Forked rows carry the COPY's denormalized etag (not the source's, not NULL) — without it
    // every conditional request on a forked site pays the legacy head() probe forever.
    for (const f of dst) {
      expect(f.etag).toBe((await r2.head(f.storageKey))?.httpEtag ?? '(missing)')
    }
  })

  test('fork.deleting.source.keeps.copy: purging the source never touches the fork’s objects', async () => {
    const { db, app, env, r2 } = await setup()
    // The harness runs with FK enforcement OFF (bun:sqlite default) so seeds can reference absent
    // parents — but `forkedFrom`'s ON DELETE SET NULL is exactly what this test is here to pin, and
    // it's a FK action. Turn FKs on for this one connection so the real D1 behaviour is exercised.
    await db.run(sql`PRAGMA foreign_keys = ON`)
    await fork(app, env, 'rd')
    const copy = (await db.select().from(sitesTable).where(eq(sitesTable.slug, 'doc-copy')))[0]
    const dst = await db.select().from(filesTable).where(eq(filesTable.siteId, copy?.id ?? ''))

    const del = await app.request('/api/sites/acme/doc', { method: 'DELETE', headers: auth('owner') }, env)
    expect(del.status).toBe(200)

    for (const f of dst) expect(await r2.get(f.storageKey)).not.toBeNull()
    // forkedFrom is SET NULL on source delete — provenance is lost, the content is not.
    const after = (await db.select().from(sitesTable).where(eq(sitesTable.id, copy?.id ?? '')))[0]
    expect(after?.forkedFrom).toBeNull()
  })

  test('fork.slug.collision: a second fork lands on doc-copy-2', async () => {
    const { app, env } = await setup()
    await fork(app, env, 'rd')
    const res = await fork(app, env, 'rd')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ siteSlug: 'doc-copy-2' })
  })

  test('fork.custom.slug: an explicit slug is honoured; an invalid one 400s', async () => {
    const { app, env } = await setup()
    expect(await (await fork(app, env, 'rd', { slug: 'my-fork' })).json()).toMatchObject({ siteSlug: 'my-fork' })
    expect((await fork(app, env, 'rd', { slug: 'Not A Slug' })).status).toBe(400)
  })

  test('fork.custom.title: an explicit title is honoured; an omitted one keeps the source’s', async () => {
    const { db, app, env } = await setup()
    await fork(app, env, 'rd', { title: '  My Fork  ', slug: 'named' })
    await fork(app, env, 'rd', { slug: 'unnamed' })
    const named = (await db.select().from(sitesTable).where(eq(sitesTable.slug, 'named')))[0]
    const unnamed = (await db.select().from(sitesTable).where(eq(sitesTable.slug, 'unnamed')))[0]
    expect(named?.title).toBe('My Fork')
    expect(unnamed?.title).toBe('Doc')
  })

  // The fork dialog lets the user choose who can see the copy. An OMITTED visibility keeps the old
  // behaviour (inherit the source's tier) — the dialog just defaults its picker to that.
  test('fork.visibility.inherited: an omitted visibility still inherits the source tier', async () => {
    const { db, app, env } = await setup()
    expect((await fork(app, env, 'rd')).status).toBe(200)
    const copy = (await db.select().from(sitesTable).where(eq(sitesTable.slug, 'doc-copy')))[0]
    expect(copy?.visibility).toBe('team')
  })

  test('fork.visibility.chosen: an explicit tier wins — including narrowing a team site to private', async () => {
    const { db, app, env } = await setup()
    expect((await fork(app, env, 'rd', { visibility: 'private', slug: 'priv' })).status).toBe(200)
    expect((await fork(app, env, 'rd', { visibility: 'members', slug: 'memb' })).status).toBe(200)
    expect((await fork(app, env, 'rd', { visibility: 'team', slug: 'tier' })).status).toBe(200)
    const tier = async (slug: string) =>
      (await db.select().from(sitesTable).where(eq(sitesTable.slug, slug)))[0]?.visibility
    expect(await tier('priv')).toBe('private')
    expect(await tier('memb')).toBe('members')
    expect(await tier('tier')).toBe('team')
  })

  // Same normalization the PATCH route uses: legacy wire values are mapped, never rejected.
  test('fork.visibility.legacy: `public` normalizes to team rather than 400ing', async () => {
    const { db, app, env } = await setup()
    expect((await fork(app, env, 'rd', { visibility: 'public', slug: 'legacy' })).status).toBe(200)
    const copy = (await db.select().from(sitesTable).where(eq(sitesTable.slug, 'legacy')))[0]
    expect(copy?.visibility).toBe('team')
  })

  test('fork.visibility.invalid: junk 400s and copies nothing', async () => {
    const { db, app, env, r2 } = await setup()
    for (const visibility of ['nope', 42, null, {}]) {
      const res = await fork(app, env, 'rd', { visibility })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid visibility' })
    }
    // Validation runs before any R2 copy or D1 write — nothing was created.
    expect((await db.select().from(sitesTable).where(eq(sitesTable.spaceId, 'rd-personal'))).length).toBe(0)
    expect(r2.store.size).toBe(2)
  })

  test('fork.no.read.403: a stranger with no access cannot fork', async () => {
    const { db, app, env } = await setup()
    await db.update(sitesTable).set({ visibility: 'private' }).where(eq(sitesTable.id, 'site'))
    expect((await fork(app, env, 'st')).status).toBe(403)
  })

  test('fork.shared.reader.ok: a viewer-share on a PRIVATE site is enough to fork it', async () => {
    const { db, app, env } = await setup()
    await db.update(sitesTable).set({ visibility: 'private' }).where(eq(sitesTable.id, 'site'))
    await seedUserShare(db, 'site', 'rd', 'viewer')
    expect((await fork(app, env, 'rd')).status).toBe(200)
  })

  test('fork.dest.space.membership: forking into a space you are not in is 403', async () => {
    const { app, env } = await setup()
    expect((await fork(app, env, 'rd', { space: 'acme' })).status).toBe(403)
  })

  test('fork.no.personal.space: a user with no space and no explicit dest 400s (never silently drops)', async () => {
    const { app, env } = await setup()
    // `st` can READ (team tier) but has no personal space to fork into.
    expect((await fork(app, env, 'st')).status).toBe(400)
  })

  test('fork.missing.404: forking a site that does not exist', async () => {
    const { app, env } = await setup()
    expect((await fork(app, env, 'rd', {}, '/api/sites/acme/nope/fork')).status).toBe(404)
  })

  test('fork.archived.410: an archived site cannot be forked', async () => {
    const { db, app, env } = await setup()
    await db.update(sitesTable).set({ status: 'archived' }).where(eq(sitesTable.id, 'site'))
    expect((await fork(app, env, 'rd')).status).toBe(410)
  })
})
