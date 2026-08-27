import { describe, expect, test } from 'bun:test'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { documents } from '../db/schema'
import { dataApi } from '../routes/data'
import { makeDb, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import type { DataCapability } from './data-token'
import { signDataToken } from './data-token'
import { canViewerRead } from './data-visibility'

const HMAC = 'glance-test-vis'
const ENV = { DATA_TOKEN_SECRET: HMAC, CONTENT_URL: 'https://content.example.com' } as never

const VIEWER_CAPS: DataCapability[] = ['read', 'create']
const OWNER_CAPS: DataCapability[] = ['read', 'create', 'write', 'read_all']

describe('canViewerRead — the ONE read-visibility predicate (constraint 6)', () => {
  test('own document in a private collection is visible to its creator', () => {
    expect(canViewerRead({ viewerId: 'userA', caps: VIEWER_CAPS }, 'notes', 'userA')).toBe(true)
  })

  test("ATTACK: another viewer's document in a private collection is invisible", () => {
    expect(canViewerRead({ viewerId: 'userA', caps: VIEWER_CAPS }, 'notes', 'userB')).toBe(false)
  })

  test('shared- collections are visible to every site viewer regardless of creator', () => {
    expect(canViewerRead({ viewerId: 'userA', caps: VIEWER_CAPS }, 'shared-poll', 'userB')).toBe(true)
  })

  test('ATTACK: a collection named "shared" (no trailing dash) does NOT opt into site-wide reads', () => {
    expect(canViewerRead({ viewerId: 'userA', caps: VIEWER_CAPS }, 'shared', 'userB')).toBe(false)
  })

  test('ATTACK: a collection named "notshared-x" does NOT match the shared- prefix', () => {
    expect(canViewerRead({ viewerId: 'userA', caps: VIEWER_CAPS }, 'notshared-x', 'userB')).toBe(false)
  })

  test('read_all widens reads to every creator but only for that token', () => {
    expect(canViewerRead({ viewerId: 'userA', caps: OWNER_CAPS }, 'notes', 'userB')).toBe(true)
    expect(canViewerRead({ viewerId: 'userA', caps: VIEWER_CAPS }, 'notes', 'userB')).toBe(false)
  })
})

// --- SQL path vs boolean path: they must agree row-for-row, forever ---

const COLLECTIONS = ['notes', 'shared-poll', 'shared', 'notshared-x'] as const
const CREATORS = ['userA', 'userB'] as const

function mount(db: DrizzleD1Database) {
  const app = new Hono<{ Variables: { db: DrizzleD1Database } }>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/_data', dataApi)
  return app
}

// userA owns team-site "siteA"; userB is a co-member who can view it. One document per
// (collection x creator) cell, with a docId that names its own cell so failures are readable.
async function matrix() {
  const db = makeDb()
  await seedUser(db, { id: 'userA', email: 'a@example.com' })
  await seedUser(db, { id: 'userB', email: 'b@example.com' })
  const sp = await seedSpace(db, { id: 'sp1', slug: 'sam', createdBy: 'userA' })
  await seedMember(db, sp, 'userA')
  await seedMember(db, sp, 'userB')
  await seedSite(db, { id: 'siteA', spaceId: sp, ownerId: 'userA', slug: 'demo', visibility: 'team' })

  const at = '2020-01-01T00:00:00.000Z'
  const docs = COLLECTIONS.flatMap((collection) =>
    CREATORS.map((createdBy) => ({
      siteId: 'siteA',
      collection,
      docId: `${collection}-by-${createdBy}`,
      json: {},
      createdBy,
      createdAt: at,
      updatedAt: at,
    })),
  )
  for (let i = 0; i < docs.length; i += 12) await db.insert(documents).values(docs.slice(i, i + 12))

  // Each principal pairs the bearer token with the claim fields the predicate reads, so the
  // SQL path and the boolean path are driven from the SAME authority.
  const principals = [
    { name: 'viewer read+create (userB)', claims: { viewerId: 'userB', caps: VIEWER_CAPS } },
    { name: 'owner read_all (userA)', claims: { viewerId: 'userA', caps: OWNER_CAPS } },
  ]
  return {
    db,
    app: mount(db),
    docs,
    principals: await Promise.all(
      principals.map(async (p) => {
        const token = await signDataToken(HMAC, { siteId: 'siteA', viewerId: p.claims.viewerId, caps: p.claims.caps })
        return { name: p.name, claims: p.claims, token }
      }),
    ),
  }
}

type TestApp = ReturnType<typeof mount>

function get(app: TestApp, token: string, path: string) {
  return app.request(`/api/_data${path}`, { headers: { Authorization: `Bearer ${token}` } }, ENV)
}

describe('constraint 6: the SQL read path and canViewerRead agree row-for-row', () => {
  test('GET /:collection returns exactly the documents canViewerRead accepts (full matrix)', async () => {
    const { app, docs, principals } = await matrix()
    for (const { name, token, claims } of principals) {
      for (const collection of COLLECTIONS) {
        const res = await get(app, token, `/${collection}`)
        expect(res.status).toBe(200)
        const got = new Set<string>(((await res.json()) as { items: { id: string }[] }).items.map((d) => d.id))
        const want = new Set(
          docs
            .filter((d) => d.collection === collection && canViewerRead(claims, collection, d.createdBy))
            .map((d) => d.docId),
        )
        expect({ name, collection, got }).toEqual({ name, collection, got: want })
      }
    }
  })

  test('GET /:collection/:docId 404s for exactly the documents canViewerRead rejects', async () => {
    const { app, docs, principals } = await matrix()
    for (const { name, token, claims } of principals) {
      for (const doc of docs) {
        const res = await get(app, token, `/${doc.collection}/${doc.docId}`)
        const visible = canViewerRead(claims, doc.collection, doc.createdBy)
        expect({ name, doc: doc.docId, status: res.status }).toEqual({
          name,
          doc: doc.docId,
          status: visible ? 200 : 404,
        })
        // Existence is never disclosed: an invisible row reads exactly like a missing one.
        if (!visible) expect(await res.json()).toEqual({ error: 'not found' })
      }
    }
  })
})
