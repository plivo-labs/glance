import { describe, expect, test } from 'bun:test'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { documents, sites } from '../db/schema'
import { signDataToken } from '../lib/data-token'
import { makeDb, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import { dataApi, dataCapsFor } from './data'

const HMAC_A = 'glance-test-aaa'
// getDb() prefers the injected harness db, so GLANCE_DB is never touched; CONTENT_URL drives CORS.
const ENV = { DATA_TOKEN_SECRET: HMAC_A, CONTENT_URL: 'https://content.example.com' } as never

function mount(db: DrizzleD1Database) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only injection of the harness db
    ;(c as any).set('injectedDb', db)
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
  const tokens = {
    ownerA: await signDataToken(HMAC_A, { siteId: 'siteA', viewerId: 'userA', caps: ['read', 'write'] }),
    viewerB_read: await signDataToken(HMAC_A, { siteId: 'siteA', viewerId: 'userB', caps: ['read'] }),
    // Over-privileged B token for siteA (simulates a compromised mint) — used to prove that even
    // WITH write+read caps, B still cannot reach A's rows (createdBy scoping is independent of caps).
    viewerB_write: await signDataToken(HMAC_A, { siteId: 'siteA', viewerId: 'userB', caps: ['read', 'write'] }),
    // B's legitimate token for their OWN site — used to prove cross-tenant reach is impossible.
    B_siteB: await signDataToken(HMAC_A, { siteId: 'siteB', viewerId: 'userB', caps: ['read', 'write'] }),
  }
  return { db, app, tokens }
}

function req(app: Hono, token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(`/api/_data${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }, ENV)
}

async function create(app: Hono, token: string, collection: string, body: unknown): Promise<string> {
  const res = await req(app, token, 'POST', `/${collection}`, body)
  expect(res.status).toBe(201)
  return (await res.json()).id
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

describe('P0-4/P0-3: write authority is distinct from view authority', () => {
  test('dataCapsFor: owner + superadmin get write; a mere viewer gets read-only', () => {
    expect(dataCapsFor({ id: 'userA', role: 'member' }, { ownerId: 'userA' })).toEqual(['read', 'write'])
    expect(dataCapsFor({ id: 'root', role: 'superadmin' }, { ownerId: 'userA' })).toEqual(['read', 'write'])
    expect(dataCapsFor({ id: 'userB', role: 'member' }, { ownerId: 'userA' })).toEqual(['read'])
  })

  test('ATTACK: a read-only token cannot write (create/put/delete → 403)', async () => {
    const { app, tokens } = await scenario()
    expect((await req(app, tokens.viewerB_read, 'POST', '/posts', { x: 1 })).status).toBe(403)
    expect((await req(app, tokens.viewerB_read, 'PUT', '/posts/x', { x: 1 })).status).toBe(403)
    expect((await req(app, tokens.viewerB_read, 'DELETE', '/posts/x')).status).toBe(403)
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
