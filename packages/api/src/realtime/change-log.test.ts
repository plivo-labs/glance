import { describe, expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { changeLog, documents } from '../db/schema'
import { signDataToken } from '../lib/data-token'
import { dataApi } from '../routes/data'
import {
  type HarnessDb,
  type Recorder,
  makeDb,
  makeRecorder,
  seedMember,
  seedSite,
  seedSpace,
  seedUser,
} from '../test/harness'

const HMAC = 'glance-test-changelog'
// getDb() prefers the injected harness db, so GLANCE_DB is never touched. No SITE_ROOM: the
// binding is optional, so the default env is also the "binding-less deploy" case.
const ENV = { DATA_TOKEN_SECRET: HMAC, CONTENT_URL: 'https://content.example.com' } as never

function mount(db: HarnessDb) {
  const app = new Hono<{ Variables: { db: HarnessDb } }>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/_data', dataApi)
  return app
}

type TestApp = ReturnType<typeof mount>

// userA owns siteA (read_all + write); userB is a co-member who can VIEW siteA and owns siteB.
async function scenario(): Promise<{ db: HarnessDb; rec: Recorder; app: TestApp; tokens: Record<string, string> }> {
  const rec = makeRecorder()
  const db = makeDb(rec)
  await seedUser(db, { id: 'userA', email: 'a@example.com' })
  await seedUser(db, { id: 'userB', email: 'b@example.com' })
  const sp = await seedSpace(db, { id: 'sp1', slug: 'sam', createdBy: 'userA' })
  await seedMember(db, sp, 'userA')
  await seedMember(db, sp, 'userB')
  await seedSite(db, { id: 'siteA', spaceId: sp, ownerId: 'userA', slug: 'demo', visibility: 'team' })
  const sp2 = await seedSpace(db, { id: 'sp2', slug: 'bob', createdBy: 'userB' })
  await seedMember(db, sp2, 'userB')
  await seedSite(db, { id: 'siteB', spaceId: sp2, ownerId: 'userB', slug: 'bobsite', visibility: 'team' })

  const OWNER: Parameters<typeof signDataToken>[1]['caps'] = ['read', 'create', 'write', 'read_all']
  const tokens = {
    ownerA: await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userA', caps: OWNER }),
    viewerB: await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userB', caps: ['read', 'create'] }),
    // read+create+write but NO read_all: may write only its OWN rows (used for the zero-row delete).
    viewerB_write: await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userB', caps: ['read', 'create', 'write'] }),
    ownerB_siteB: await signDataToken(HMAC, { siteId: 'siteB', viewerId: 'userB', caps: OWNER }),
  }
  return { db, rec, app: mount(db), tokens }
}

function req(app: TestApp, token: string, method: string, path: string, body?: unknown, env: unknown = ENV) {
  return app.request(
    `/api/_data${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env as never,
  )
}

async function create(app: TestApp, token: string, collection: string, body: unknown, env?: unknown): Promise<string> {
  const res = await req(app, token, 'POST', `/${collection}`, body, env)
  expect(res.status).toBe(201)
  return (await res.json()).id
}

const logRows = (db: HarnessDb, siteId: string) =>
  db.select().from(changeLog).where(eq(changeLog.siteId, siteId)).orderBy(asc(changeLog.seq))

describe('#8 write side: change_log is fused into the mutation batch', () => {
  test('create writes its change_log row in the SAME batch as the document insert', async () => {
    const { db, rec, app, tokens } = await scenario()
    db.resetCounters()
    rec.resetCounters()

    const res = await req(app, tokens.ownerA, 'POST', '/notes', { a: 1 })
    expect(res.status).toBe(201)

    // Both writes are inserts, and they are the LAST three timeline entries: one batch open
    // followed by exactly two statements — nothing loose after the auth/quota reads.
    expect(db.counters.insert).toBe(2)
    expect(rec.timeline.slice(-3)).toEqual(['d1:batch', 'd1:stmt:insert', 'd1:stmt:insert'])
    expect(await logRows(db, 'siteA')).toHaveLength(1)
  })

  test('seq is monotonic per site and independent across sites', async () => {
    const { db, app, tokens } = await scenario()
    await create(app, tokens.ownerA, 'notes', { i: 1 })
    await create(app, tokens.ownerB_siteB, 'notes', { i: 1 })
    await create(app, tokens.ownerA, 'notes', { i: 2 })
    await create(app, tokens.ownerB_siteB, 'notes', { i: 2 })
    await create(app, tokens.ownerA, 'notes', { i: 3 })

    expect((await logRows(db, 'siteA')).map((r) => r.seq)).toEqual([1, 2, 3])
    expect((await logRows(db, 'siteB')).map((r) => r.seq)).toEqual([1, 2])
  })

  test("#7: an owner deleting another viewer's document logs the DOCUMENT's creator, not the writer", async () => {
    const { db, app, tokens } = await scenario()
    const id = await create(app, tokens.viewerB, 'shared-poll', { vote: 'yes' })

    const res = await req(app, tokens.ownerA, 'DELETE', `/shared-poll/${id}`)
    expect(res.status).toBe(204)

    const rows = await logRows(db, 'siteA')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ type: 'delete', createdBy: 'userB', collection: 'shared-poll', docId: id })
  })

  test('ATTACK: a delete that removes zero rows emits NO change_log row and still returns 204', async () => {
    const { db, app, tokens } = await scenario()
    const id = await create(app, tokens.ownerA, 'notes', { owner: true })
    const before = await logRows(db, 'siteA')

    // B holds write but not read_all, so the creator wall matches nothing — 204 over 0 rows.
    const res = await req(app, tokens.viewerB_write, 'DELETE', `/notes/${id}`)
    expect(res.status).toBe(204)

    expect(await db.select().from(documents).where(eq(documents.docId, id))).toHaveLength(1)
    expect(await logRows(db, 'siteA')).toEqual(before)
  })

  test("PUT logs 'create' when it lands as an insert and 'update' when it lands as an update", async () => {
    const { db, app, tokens } = await scenario()

    const first = await req(app, tokens.ownerA, 'PUT', '/notes/d1', { v: 1 })
    expect(first.status).toBe(201)
    const second = await req(app, tokens.ownerA, 'PUT', '/notes/d1', { v: 2 })
    expect(second.status).toBe(200)

    const rows = await logRows(db, 'siteA')
    expect(rows.map((r) => r.type)).toEqual(['create', 'update'])
    expect(rows.map((r) => r.docId)).toEqual(['d1', 'd1'])
  })

  test('change_log rows carry siteId, collection, docId and createdBy so fan-out needs no second read', async () => {
    const { db, app, tokens } = await scenario()
    // A body carrying its own siteId/createdBy keys must change nothing — both come from the token.
    const id = await create(app, tokens.viewerB, 'shared-poll', { siteId: 'siteB', createdBy: 'userA' })

    const [row] = await logRows(db, 'siteA')
    expect(Object.keys(row).sort()).toEqual(['at', 'collection', 'createdBy', 'docId', 'seq', 'siteId', 'type'])
    expect(row).toMatchObject({
      seq: 1,
      siteId: 'siteA',
      collection: 'shared-poll',
      docId: id,
      createdBy: 'userB',
      type: 'create',
    })
    expect(typeof row.at).toBe('string')
  })
})

describe('#10 broadcast never fails (or precedes) the D1 write', () => {
  test('a SITE_ROOM broadcast that throws never fails the D1 write', async () => {
    const { db, app, tokens } = await scenario()
    const env = {
      ...(ENV as object),
      SITE_ROOM: {
        idFromName() {
          throw new Error('boom')
        },
      },
    }

    const res = await req(app, tokens.ownerA, 'POST', '/notes', { a: 1 }, env)
    expect(res.status).toBe(201)
    const { id } = await res.json()
    expect(await db.select().from(documents).where(eq(documents.docId, id))).toHaveLength(1)
    expect(await logRows(db, 'siteA')).toHaveLength(1)
  })

  test('a SITE_ROOM stub whose fetch rejects never fails the D1 write', async () => {
    const { db, app, tokens } = await scenario()
    const env = {
      ...(ENV as object),
      SITE_ROOM: {
        idFromName: (n: string) => n,
        get: () => ({ fetch: () => Promise.reject(new Error('unreachable')) }),
      },
    }

    const res = await req(app, tokens.ownerA, 'POST', '/notes', { a: 1 }, env)
    expect(res.status).toBe(201)
    expect(await logRows(db, 'siteA')).toHaveLength(1)
  })

  test('the broadcast observes the committed row (notify runs after the write)', async () => {
    const { db, app, tokens } = await scenario()
    const seen: { docs: number; logged: number }[] = []
    const env = {
      ...(ENV as object),
      SITE_ROOM: {
        idFromName: (n: string) => n,
        get: () => ({
          async fetch(_url: string, init: { body: string }) {
            const e = JSON.parse(init.body)
            seen.push({
              docs: (await db.select().from(documents).where(eq(documents.docId, e.docId))).length,
              logged: (await logRows(db, e.siteId)).length,
            })
            return new Response(null, { status: 204 })
          },
        }),
      },
    }

    const res = await req(app, tokens.ownerA, 'POST', '/notes', { a: 1 }, env)
    expect(res.status).toBe(201)
    expect(seen).toEqual([{ docs: 1, logged: 1 }])
  })

  test('no SITE_ROOM binding at all → mutations still succeed and still log', async () => {
    const { db, app, tokens } = await scenario()
    expect(await create(app, tokens.ownerA, 'notes', { a: 1 })).toBeTruthy()
    expect((await req(app, tokens.ownerA, 'PUT', '/notes/d1', { v: 1 })).status).toBe(201)
    expect((await req(app, tokens.ownerA, 'DELETE', '/notes/d1')).status).toBe(204)

    expect((await logRows(db, 'siteA')).map((r) => r.type)).toEqual(['create', 'create', 'delete'])
  })
})
