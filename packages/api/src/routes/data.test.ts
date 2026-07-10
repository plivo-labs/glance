import { describe, expect, test } from 'bun:test'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { documents, sites } from '../db/schema'
import { signDataToken } from '../lib/data-token'
import { makeDb, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import { MAX_DOCS_PER_SITE, dataApi, dataCapsFor } from './data'

const HMAC_A = 'glance-test-aaa'
// getDb() prefers the injected harness db, so GLANCE_DB is never touched; CONTENT_URL drives CORS.
const ENV = { DATA_TOKEN_SECRET: HMAC_A, CONTENT_URL: 'https://content.example.com' } as never

function mount(db: DrizzleD1Database) {
  const app = new Hono<{ Variables: { db: DrizzleD1Database } }>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/_data', dataApi)
  return app
}

// Scenario: userA owns team-site "siteA"; userB is a co-member (can VIEW it). userB also owns a
// separate site "siteB". Tokens are minted directly so the ROUTE's enforcement is what's tested.
async function scenario() {
  const db = makeDb()
  await seedUser(db, { id: 'userA', email: 'a@example.com' })
  await seedUser(db, { id: 'userB', email: 'b@example.com' })
  const sp = await seedSpace(db, { id: 'sp1', slug: 'sam', createdBy: 'userA' })
  await seedMember(db, sp, 'userA')
  await seedMember(db, sp, 'userB')
  await seedSite(db, { id: 'siteA', spaceId: sp, ownerId: 'userA', slug: 'demo', visibility: 'team' })
  const sp2 = await seedSpace(db, { id: 'sp2', slug: 'bob', createdBy: 'userB' })
  await seedMember(db, sp2, 'userB')
  await seedSite(db, { id: 'siteB', spaceId: sp2, ownerId: 'userB', slug: 'bobsite', visibility: 'team' })

  const app = mount(db)
  const OWNER_CAPS: Parameters<typeof signDataToken>[1]['caps'] = ['read', 'create', 'write', 'read_all']
  const tokens = {
    ownerA: await signDataToken(HMAC_A, { siteId: 'siteA', viewerId: 'userA', caps: OWNER_CAPS }),
    // What the mint actually issues a viewer: read (own rows + shared-*) and create.
    viewerB: await signDataToken(HMAC_A, { siteId: 'siteA', viewerId: 'userB', caps: ['read', 'create'] }),
    // Legacy pre-policy-v2 read-only token — still verifies, still read-only.
    viewerB_read: await signDataToken(HMAC_A, { siteId: 'siteA', viewerId: 'userB', caps: ['read'] }),
    // Over-privileged B token for siteA (simulates a compromised mint) — used to prove that even
    // WITH write caps (but no read_all), B still cannot reach A's rows (createdBy scoping is
    // independent of write caps).
    viewerB_write: await signDataToken(HMAC_A, { siteId: 'siteA', viewerId: 'userB', caps: ['read', 'create', 'write'] }),
    // B's legitimate token for their OWN site — used to prove cross-tenant reach is impossible.
    B_siteB: await signDataToken(HMAC_A, { siteId: 'siteB', viewerId: 'userB', caps: OWNER_CAPS }),
  }
  return { db, app, tokens }
}

type TestApp = ReturnType<typeof mount>

function req(app: TestApp, token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(`/api/_data${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }, ENV)
}

async function create(app: TestApp, token: string, collection: string, body: unknown): Promise<string> {
  const res = await req(app, token, 'POST', `/${collection}`, body)
  expect(res.status).toBe(201)
  return (await res.json()).id
}

// Bulk-seed n rows straight into the table (bypassing the route) to fill a site to its quota
// without thousands of HTTP round-trips. Chunked to stay under D1's 100-bound-parameter cap
// (enforced by the harness): 12 rows x 8 bound values = 96.
async function seedDocs(db: DrizzleD1Database, siteId: string, collection: string, n: number, createdBy: string) {
  const at = '2020-01-01T00:00:00.000Z'
  const rows = Array.from({ length: n }, (_, i) => ({
    siteId,
    collection,
    docId: `seed-${i}`,
    json: {},
    createdBy,
    createdAt: at,
    updatedAt: at,
  }))
  for (let i = 0; i < rows.length; i += 12) await db.insert(documents).values(rows.slice(i, i + 12))
}

describe('glance.db data plane — happy path', () => {
  test('owner can create, read back, and list own documents', async () => {
    const { app, tokens } = await scenario()
    const id = await create(app, tokens.ownerA, 'posts', { title: 'Hello Glance DB' })

    const got = await req(app, tokens.ownerA, 'GET', `/posts/${id}`)
    expect(got.status).toBe(200)
    expect((await got.json()).data.title).toBe('Hello Glance DB')

    const list = await req(app, tokens.ownerA, 'GET', '/posts')
    expect(list.status).toBe(200)
    expect((await list.json()).items).toHaveLength(1)
  })

  test('owner can upsert (PUT) and delete own document', async () => {
    const { app, tokens } = await scenario()
    const put = await req(app, tokens.ownerA, 'PUT', '/notes/n1', { v: 1 })
    expect(put.status).toBe(201)
    const put2 = await req(app, tokens.ownerA, 'PUT', '/notes/n1', { v: 2 })
    expect(put2.status).toBe(200)
    expect((await put2.json()).data.v).toBe(2)
    expect((await req(app, tokens.ownerA, 'DELETE', '/notes/n1')).status).toBe(204)
    expect((await req(app, tokens.ownerA, 'GET', '/notes/n1')).status).toBe(404)
  })
})

describe('P0-4/P0-3: modify authority is distinct from view authority', () => {
  test('dataCapsFor: owner + superadmin get write/read_all; a viewer gets read+create only', () => {
    expect(dataCapsFor({ id: 'userA', role: 'member' }, { ownerId: 'userA' })).toEqual(['read', 'create', 'write', 'read_all'])
    expect(dataCapsFor({ id: 'root', role: 'superadmin' }, { ownerId: 'userA' })).toEqual(['read', 'create', 'write', 'read_all'])
    expect(dataCapsFor({ id: 'userB', role: 'member' }, { ownerId: 'userA' })).toEqual(['read', 'create'])
  })

  // editor-share residual-risk pin (confused-deputy, S9): dataCapsFor keys on ownerId ONLY, so a
  // designated editor of someone else's site is indistinguishable from any other non-owner viewer —
  // it can never mint write/read_all. This is the guard: if a future change threads share-role into
  // cap minting, an editor could read-all/delete the OWNER's glance.db docs. Owner path unchanged.
  test('dataCaps.editor.pin: an editor-share grantee still gets read+create only; owner unchanged', () => {
    expect(dataCapsFor({ id: 'editor', role: 'member' }, { ownerId: 'owner' })).toEqual(['read', 'create'])
    expect(dataCapsFor({ id: 'owner', role: 'member' }, { ownerId: 'owner' })).toEqual(['read', 'create', 'write', 'read_all'])
  })

  test('ATTACK: a viewer token cannot modify — put/delete → 403; legacy read-only also blocked from create', async () => {
    const { app, tokens } = await scenario()
    expect((await req(app, tokens.viewerB, 'PUT', '/posts/x', { x: 1 })).status).toBe(403)
    expect((await req(app, tokens.viewerB, 'DELETE', '/posts/x')).status).toBe(403)
    expect((await req(app, tokens.viewerB_read, 'POST', '/posts', { x: 1 })).status).toBe(403)
  })

  test('a viewer CAN create — the submission is attributed to them, not the owner', async () => {
    const { db, app, tokens } = await scenario()
    const id = await create(app, tokens.viewerB, 'feedback', { msg: 'from B' })
    const row = (await db.select().from(documents).where(eq(documents.docId, id)))[0]
    expect(row.createdBy).toBe('userB')
  })
})

describe('P0-6: per-document read policy (cross-viewer isolation)', () => {
  test("ATTACK: a co-viewer of the site cannot read another viewer's documents", async () => {
    const { app, tokens } = await scenario()
    const id = await create(app, tokens.ownerA, 'secrets', { pii: 'A-only' })

    // B can VIEW the team site, yet sees none of A's docs and cannot fetch one by id...
    expect((await req(app, tokens.viewerB_read, 'GET', '/secrets')).status).toBe(200)
    expect((await (await req(app, tokens.viewerB_read, 'GET', '/secrets')).json()).items).toHaveLength(0)
    expect((await req(app, tokens.viewerB_read, 'GET', `/secrets/${id}`)).status).toBe(404)
    // ...not even with a write-capable token (caps do not widen the read scope).
    expect((await req(app, tokens.viewerB_write, 'GET', `/secrets/${id}`)).status).toBe(404)
  })
})

describe('policy v2: owner read_all + shared-* collections', () => {
  test("owner sees viewers' submissions (read_all) — the feedback-form story", async () => {
    const { app, tokens } = await scenario()
    const id = await create(app, tokens.viewerB, 'feedback', { msg: 'B says hi' })
    const items = (await (await req(app, tokens.ownerA, 'GET', '/feedback')).json()).items
    expect(items).toHaveLength(1)
    expect(items[0].createdBy).toBe('userB')
    expect((await req(app, tokens.ownerA, 'GET', `/feedback/${id}`)).status).toBe(200)
  })

  test('shared-* collection: every viewer reads every row; modification stays locked', async () => {
    const { app, tokens } = await scenario()
    const id = await create(app, tokens.ownerA, 'shared-votes', { v: 'A' })
    await create(app, tokens.viewerB, 'shared-votes', { v: 'B' })
    // B sees both rows (and who wrote them)...
    const items = (await (await req(app, tokens.viewerB, 'GET', '/shared-votes')).json()).items
    expect(items).toHaveLength(2)
    expect(new Set(items.map((d: { createdBy: string }) => d.createdBy))).toEqual(new Set(['userA', 'userB']))
    expect((await req(app, tokens.viewerB, 'GET', `/shared-votes/${id}`)).status).toBe(200)
    // ...but ATTACK: shared visibility must not widen write reach — B cannot touch A's row.
    expect((await req(app, tokens.viewerB, 'PUT', `/shared-votes/${id}`, { v: 'hacked' })).status).toBe(403)
    expect((await req(app, tokens.viewerB, 'DELETE', `/shared-votes/${id}`)).status).toBe(403)
    expect((await req(app, tokens.viewerB_write, 'DELETE', `/shared-votes/${id}`)).status).toBe(204) // scoped: removes 0 rows
    expect((await req(app, tokens.ownerA, 'GET', `/shared-votes/${id}`)).status).toBe(200)
  })

  test('owner can delete ANY document in their site (moderation), and only in their site', async () => {
    const { app, tokens } = await scenario()
    const spam = await create(app, tokens.viewerB, 'feedback', { msg: 'spam' })
    expect((await req(app, tokens.ownerA, 'DELETE', `/feedback/${spam}`)).status).toBe(204)
    expect((await req(app, tokens.ownerA, 'GET', `/feedback/${spam}`)).status).toBe(404)
    // Cross-tenant: B's owner-tier token for siteB cannot moderate siteA's rows.
    const keep = await create(app, tokens.viewerB, 'feedback', { msg: 'keep' })
    expect((await req(app, tokens.B_siteB, 'DELETE', `/feedback/${keep}`)).status).toBe(204) // siteB-scoped: removes 0 rows
    expect((await req(app, tokens.ownerA, 'GET', `/feedback/${keep}`)).status).toBe(200)
  })

  test('non-shared collections stay per-creator for viewers (unchanged default)', async () => {
    const { app, tokens } = await scenario()
    await create(app, tokens.ownerA, 'notes', { private: 'A only' })
    expect((await (await req(app, tokens.viewerB, 'GET', '/notes')).json()).items).toHaveLength(0)
  })
})

describe('P0-7: tenant isolation (siteId derives from the token, never the client)', () => {
  test("ATTACK: B's token for siteB cannot reach a document in siteA", async () => {
    const { app, tokens } = await scenario()
    const id = await create(app, tokens.ownerA, 'posts', { title: 'in-site-A' })
    // Same collection + docId, but the token is scoped to siteB → the row in siteA is invisible.
    expect((await req(app, tokens.B_siteB, 'GET', `/posts/${id}`)).status).toBe(404)
    expect((await req(app, tokens.B_siteB, 'PUT', `/posts/${id}`, { hijack: true })).status).toBe(201) // writes into siteB, not siteA
    // A's original document is untouched.
    expect((await (await req(app, tokens.ownerA, 'GET', `/posts/${id}`)).json()).data.title).toBe('in-site-A')
  })
})

describe('P0-8: mass assignment (identity/scope columns are server-set)', () => {
  test('ATTACK: body cannot spoof createdBy / siteId — they come from the token', async () => {
    const { db, app, tokens } = await scenario()
    const id = await create(app, tokens.ownerA, 'posts', {
      title: 'x',
      createdBy: 'userB',
      siteId: 'siteB',
      id: 'evil-id',
    })
    const row = (await db.select().from(documents).where(eq(documents.docId, id)))[0]
    expect(row.createdBy).toBe('userA') // from the token, not the body
    expect(row.siteId).toBe('siteA') // from the token, not the body
    // And because createdBy is really userA, viewer B still cannot see it.
    expect((await (await req(app, tokens.viewerB_read, 'GET', '/posts')).json()).items).toHaveLength(0)
  })

  test("ATTACK: B with a write token cannot overwrite or delete A's document", async () => {
    const { db, app, tokens } = await scenario()
    const id = await create(app, tokens.ownerA, 'posts', { title: 'original' })
    expect((await req(app, tokens.viewerB_write, 'PUT', `/posts/${id}`, { title: 'defaced' })).status).toBe(404)
    expect((await req(app, tokens.viewerB_write, 'DELETE', `/posts/${id}`)).status).toBe(204) // scoped delete removes 0 rows
    const row = (await db.select().from(documents).where(eq(documents.docId, id)))[0]
    expect(row?.json).toEqual({ title: 'original' })
  })
})

describe('P0-10: live re-authorization (revocation takes effect within the token TTL)', () => {
  test('ATTACK: tightening visibility to private blocks a still-valid viewer token', async () => {
    const { db, app, tokens } = await scenario()
    expect((await req(app, tokens.viewerB_read, 'GET', '/posts')).status).toBe(200) // B can view team site
    await db.update(sites).set({ visibility: 'private' }).where(eq(sites.id, 'siteA'))
    // Same unexpired token, but B is no longer authorized → blocked live.
    expect((await req(app, tokens.viewerB_read, 'GET', '/posts')).status).toBe(403)
    expect((await req(app, tokens.ownerA, 'GET', '/posts')).status).toBe(200) // owner still fine
  })

  test('ATTACK: archiving the site blocks data access', async () => {
    const { db, app, tokens } = await scenario()
    await db.update(sites).set({ status: 'archived' }).where(eq(sites.id, 'siteA'))
    expect((await req(app, tokens.ownerA, 'GET', '/posts')).status).toBe(410)
  })
})

describe('P0-3: CORS is exact-origin and credential-less', () => {
  test('ACAO is pinned to CONTENT_URL, no Allow-Credentials, and OPTIONS preflights', async () => {
    const { app } = await scenario()
    const pre = await app.request(
      '/api/_data/posts',
      { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } },
      ENV,
    )
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://content.example.com')
    expect(pre.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com')
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull()
    expect(pre.headers.get('vary')).toContain('Origin')
  })
})

describe('#10: per-site document quota (DoS guard on unbounded creation)', () => {
  test('POST is blocked with 429 once the site is at MAX_DOCS_PER_SITE', async () => {
    const { db, app, tokens } = await scenario()
    await seedDocs(db, 'siteA', 'bulk', MAX_DOCS_PER_SITE, 'userA')
    const res = await req(app, tokens.ownerA, 'POST', '/posts', { x: 1 })
    expect(res.status).toBe(429)
    // A viewer's create is capped the same way — the quota is site-wide, not per-caller.
    expect((await req(app, tokens.viewerB, 'POST', '/feedback', { x: 1 })).status).toBe(429)
  })

  test('a fresh-id PUT (new row) is capped, but an in-place PUT update is exempt', async () => {
    const { db, app, tokens } = await scenario()
    await seedDocs(db, 'siteA', 'bulk', MAX_DOCS_PER_SITE, 'userA')
    // Fresh id → would grow the table → 429.
    expect((await req(app, tokens.ownerA, 'PUT', '/posts/brand-new', { v: 1 })).status).toBe(429)
    // Overwriting an existing own row adds no row, so it succeeds even at quota.
    const upd = await req(app, tokens.ownerA, 'PUT', '/bulk/seed-0', { v: 2 })
    expect(upd.status).toBe(200)
    expect((await upd.json()).data.v).toBe(2)
  })

  test('just under the cap still creates (boundary is inclusive at the cap)', async () => {
    const { db, app, tokens } = await scenario()
    await seedDocs(db, 'siteA', 'bulk', MAX_DOCS_PER_SITE - 1, 'userA')
    expect((await req(app, tokens.ownerA, 'POST', '/posts', { x: 1 })).status).toBe(201)
    // ...and that create tips the site to the cap, so the next one is refused.
    expect((await req(app, tokens.ownerA, 'POST', '/posts', { x: 1 })).status).toBe(429)
  })

  test("another site's fullness never blocks writes to this site (quota is per-site)", async () => {
    const { db, app, tokens } = await scenario()
    await seedDocs(db, 'siteB', 'bulk', MAX_DOCS_PER_SITE, 'userB')
    expect((await req(app, tokens.ownerA, 'POST', '/posts', { x: 1 })).status).toBe(201)
  })
})

describe('auth + validation + inert-when-unconfigured', () => {
  test('no token / garbage token → 401', async () => {
    const { app, tokens } = await scenario()
    expect((await req(app, null, 'GET', '/posts')).status).toBe(401)
    expect((await req(app, 'garbage.token', 'GET', '/posts')).status).toBe(401)
    // sanity: a good token is 200
    expect((await req(app, tokens.ownerA, 'GET', '/posts')).status).toBe(200)
  })

  test('invalid collection name → 400; oversized body → 413', async () => {
    const { app, tokens } = await scenario()
    expect((await req(app, tokens.ownerA, 'POST', '/bad%20name', { x: 1 })).status).toBe(400)
    const big = { blob: 'x'.repeat(100_001) }
    expect((await req(app, tokens.ownerA, 'POST', '/posts', big)).status).toBe(413)
  })

  test('ATTACK: multibyte body cannot sneak past the size cap (bytes, not UTF-16 units)', async () => {
    const { app, tokens } = await scenario()
    // 40k '€' chars = 40k UTF-16 units (passes a .length check) but ~120KB of UTF-8 bytes.
    const sneaky = { blob: '€'.repeat(40_000) }
    expect((await req(app, tokens.ownerA, 'POST', '/posts', sneaky)).status).toBe(413)
  })

  test('#41: an oversized body with NO declared content-length is still capped (post-read guard)', async () => {
    const { app, tokens } = await scenario()
    // A ReadableStream body carries no content-length, so the declared-length precheck can't fire
    // — the post-read byte cap is the only thing standing between us and an unbounded document.
    const raw = new TextEncoder().encode(JSON.stringify({ blob: 'x'.repeat(100_001) }))
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(raw)
        ctrl.close()
      },
    })
    const res = await app.request(
      '/api/_data/posts',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.ownerA}`, 'Content-Type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit,
      ENV,
    )
    expect(res.status).toBe(413)
  })

  test('list returns newest first', async () => {
    const { db, app, tokens } = await scenario()
    const oldId = await create(app, tokens.ownerA, 'posts', { title: 'old' })
    // Force a strictly older createdAt so the ordering assertion can't tie on same-ms writes.
    await db.update(documents).set({ createdAt: '2020-01-01T00:00:00.000Z' }).where(eq(documents.docId, oldId))
    await create(app, tokens.ownerA, 'posts', { title: 'new' })
    const items = (await (await req(app, tokens.ownerA, 'GET', '/posts')).json()).items
    expect(items.map((d: { data: { title: string } }) => d.data.title)).toEqual(['new', 'old'])
  })

  test('inert (404) when DATA_TOKEN_SECRET is unset', async () => {
    const { app, tokens } = await scenario()
    const res = await app.request(
      '/api/_data/posts',
      { method: 'GET', headers: { Authorization: `Bearer ${tokens.ownerA}` } },
      { CONTENT_URL: 'https://content.example.com' } as never,
    )
    expect(res.status).toBe(404)
  })
})
