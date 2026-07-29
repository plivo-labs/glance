import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { sites } from '../db/schema'
import { signDataToken } from '../lib/data-token'
import { encodeCursor } from '../realtime/cursor'
import { type HarnessDb, makeDb, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import { MAX_CHANGES, dataApi } from './data'

const HMAC = 'glance-test-catchup'
// getDb() prefers the injected harness db, so GLANCE_DB is never touched; CONTENT_URL drives CORS.
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

  const OWNER: Parameters<typeof signDataToken>[1]['caps'] = ['read', 'create', 'write', 'read_all']
  const tokens = {
    ownerA: await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userA', caps: OWNER }),
    viewerB: await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userB', caps: ['read', 'create'] }),
    ownerB_siteB: await signDataToken(HMAC, { siteId: 'siteB', viewerId: 'userB', caps: OWNER }),
  }
  return { db, app: mount(db), tokens }
}

function req(app: TestApp, token: string | null, method: string, path: string, body?: unknown, env: unknown = ENV) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(
    `/api/_data${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env as never,
  )
}

async function create(app: TestApp, token: string, collection: string, body: unknown): Promise<string> {
  const res = await req(app, token, 'POST', `/${collection}`, body)
  expect(res.status).toBe(201)
  return (await res.json()).id
}

type ClientEvent = { type: string; collection: string; id: string; createdBy: string; at: string }
type CatchUp = { events: ClientEvent[]; cursor: string; more: boolean }

async function catchUp(app: TestApp, token: string, cursor?: string): Promise<CatchUp> {
  const res = await req(app, token, 'GET', changesPath(cursor))
  expect(res.status).toBe(200)
  return res.json()
}

const changesPath = (cursor?: string) =>
  cursor === undefined ? '/_sync/changes' : `/_sync/changes?cursor=${encodeURIComponent(cursor)}`

/** A cursor pinned to the very beginning of a site's stream — the only way to ask for the full
 *  backlog, since a missing cursor deliberately means "from now". */
const fromZero = (siteId: string, viewerId: string) => encodeCursor(HMAC, { siteId, viewerId, seq: 0 })

/** Every key appearing anywhere in a parsed JSON body. */
function deepKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) deepKeys(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      deepKeys(v, out)
    }
  }
  return out
}

describe('#8 read side: catch-up replay', () => {
  test('catch-up returns events after the cursor, oldest first, with a fresh cursor', async () => {
    const { app, tokens } = await scenario()
    const first = await create(app, tokens.ownerA, 'notes', { n: 1 })
    // Position taken AFTER the first create: a bare GET means "from now".
    const { cursor } = await catchUp(app, tokens.ownerA)
    const second = await create(app, tokens.ownerA, 'notes', { n: 2 })
    const third = await create(app, tokens.ownerA, 'notes', { n: 3 })

    const caught = await catchUp(app, tokens.ownerA, cursor)
    expect(caught.events.map((e) => e.id)).toEqual([second, third])
    expect(caught.events.map((e) => e.type)).toEqual(['create', 'create'])
    expect(caught.events.some((e) => e.id === first)).toBe(false)

    // The cursor it handed back replays nothing.
    expect((await catchUp(app, tokens.ownerA, caught.cursor)).events).toEqual([])
  })

  test('no cursor → current position with an empty backlog (subscribe-from-now)', async () => {
    const { app, tokens } = await scenario()
    await create(app, tokens.ownerA, 'notes', { n: 1 })
    await create(app, tokens.ownerA, 'notes', { n: 2 })

    const now = await catchUp(app, tokens.ownerA)
    expect(now.events).toEqual([])
    expect(typeof now.cursor).toBe('string')

    const later = await create(app, tokens.ownerA, 'notes', { n: 3 })
    expect((await catchUp(app, tokens.ownerA, now.cursor)).events.map((e) => e.id)).toEqual([later])
  })

  test('catch-up hides events for documents the viewer cannot read', async () => {
    const { app, tokens } = await scenario()
    const aPrivate = await create(app, tokens.ownerA, 'notes', { who: 'A' })
    const bPrivate = await create(app, tokens.viewerB, 'notes', { who: 'B' })
    const shared = await create(app, tokens.ownerA, 'shared-poll', { who: 'A' })

    const asB = await catchUp(app, tokens.viewerB, await fromZero('siteA', 'userB'))
    expect(asB.events.map((e) => e.id)).toEqual([bPrivate, shared])

    // read_all sees every row regardless of creator — the same widening the GET routes apply.
    const asOwner = await catchUp(app, tokens.ownerA, await fromZero('siteA', 'userA'))
    expect(asOwner.events.map((e) => e.id)).toEqual([aPrivate, bPrivate, shared])
  })

  test('events carry the DOCUMENT creator and the mutation type, matching the read-path doc shape', async () => {
    const { app, tokens } = await scenario()
    const id = await create(app, tokens.viewerB, 'shared-poll', { vote: 'yes' })
    await req(app, tokens.ownerA, 'DELETE', `/shared-poll/${id}`)

    const { events } = await catchUp(app, tokens.viewerB, await fromZero('siteA', 'userB'))
    expect(events).toHaveLength(2)
    expect(Object.keys(events[0]).sort()).toEqual(['at', 'collection', 'createdBy', 'id', 'type'])
    expect(events[0]).toMatchObject({ type: 'create', collection: 'shared-poll', id, createdBy: 'userB' })
    // #7: the owner's moderating delete is attributed to the DOCUMENT's creator, not the writer.
    expect(events[1]).toMatchObject({ type: 'delete', id, createdBy: 'userB' })
  })
})

describe('#8: a backlog wider than one page is paged, never skipped', () => {
  /** What a correct client does: keep asking while the server says there is more. */
  async function pageThrough(app: TestApp, token: string, cursor: string) {
    const ids: string[] = []
    let pages = 0
    let page: CatchUp
    do {
      page = await catchUp(app, token, cursor)
      cursor = page.cursor
      pages++
      ids.push(...page.events.map((e) => e.id))
    } while (page.more)
    return { ids, pages, cursor }
  }

  test('a full page says `more` and paging reaches the head — nothing between is dropped', async () => {
    const { app, tokens } = await scenario()
    const created: string[] = []
    for (let i = 0; i < MAX_CHANGES + 5; i++) created.push(await create(app, tokens.ownerA, 'notes', { n: i }))

    const first = await catchUp(app, tokens.ownerA, await fromZero('siteA', 'userA'))
    expect(first.events).toHaveLength(MAX_CHANGES)
    // Without this the caller stops here and rows MAX_CHANGES+1..head are never requested again.
    expect(first.more).toBe(true)

    const caught = await pageThrough(app, tokens.ownerA, await fromZero('siteA', 'userA'))
    expect(caught.ids).toEqual(created)
    expect(caught.pages).toBe(2)
    // And the cursor the last page handed back replays nothing.
    expect((await catchUp(app, tokens.ownerA, caught.cursor)).events).toEqual([])
  })

  test('a backlog that fits in one page does not ask the client to page again', async () => {
    const { app, tokens } = await scenario()
    await create(app, tokens.ownerA, 'notes', { n: 1 })

    const caught = await catchUp(app, tokens.ownerA, await fromZero('siteA', 'userA'))
    expect(caught.events).toHaveLength(1)
    expect(caught.more).toBe(false)
  })

  test('a full page of INVISIBLE rows still says `more`, so the event beyond them survives', async () => {
    const { app, tokens } = await scenario()
    // A whole page of documents private to A — viewer B may see none of them.
    for (let i = 0; i < MAX_CHANGES; i++) await create(app, tokens.ownerA, 'notes', { n: i })
    const mine = await create(app, tokens.viewerB, 'notes', { who: 'B' })

    // `more` is decided by rows SCANNED, not events returned: an empty page is not the head.
    const first = await catchUp(app, tokens.viewerB, await fromZero('siteA', 'userB'))
    expect(first.events).toEqual([])
    expect(first.more).toBe(true)

    const caught = await pageThrough(app, tokens.viewerB, await fromZero('siteA', 'userB'))
    expect(caught.ids).toEqual([mine])
  })
})

describe('#9 the raw site sequence never reaches the client', () => {
  test('ATTACK: no raw site sequence is observable in any response field', async () => {
    const { app, tokens } = await scenario()
    await create(app, tokens.ownerA, 'notes', { s: 1 })
    const visible1 = await create(app, tokens.viewerB, 'notes', { s: 2 })
    await create(app, tokens.ownerA, 'notes', { s: 3 })
    await create(app, tokens.ownerA, 'notes', { s: 4 })
    const visible2 = await create(app, tokens.viewerB, 'notes', { s: 5 })

    const res = await req(app, tokens.viewerB, 'GET', changesPath(await fromZero('siteA', 'userB')))
    expect(res.status).toBe(200)
    const body = await res.json()

    // No field named seq anywhere, at any depth.
    expect(deepKeys(body)).not.toContain('seq')
    // The two visible events arrive adjacent: nothing marks the three hidden rows between them.
    expect(body.events.map((e: { id: string }) => e.id)).toEqual([visible1, visible2])

    // And the cursor itself is opaque: it does not spell out the position it encodes.
    const a = await catchUp(app, tokens.viewerB, await fromZero('siteA', 'userB'))
    const b = await catchUp(app, tokens.viewerB, a.cursor)
    for (const cursor of [a.cursor, b.cursor]) {
      expect(cursor).not.toContain('seq')
      expect(() => JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')))).toThrow()
    }
    // Two cursors for the same viewer are not ordinally comparable client-side.
    expect(a.cursor).not.toBe(b.cursor)
  })
})

describe('#9/#6 ATTACK: cursor forgery and cross-identity replay', () => {
  test('ATTACK: a tampered cursor is rejected and never falls back to seq 0', async () => {
    const { db, app, tokens } = await scenario()
    await create(app, tokens.ownerA, 'notes', { n: 1 })
    const good = await fromZero('siteA', 'userA')

    for (const bad of [`${good.slice(0, -2)}AA`, good.slice(0, good.length >> 1), 'not-a-cursor', `${good}.`]) {
      const res = await req(app, tokens.ownerA, 'GET', changesPath(bad))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid cursor' })
    }

    // A rejected cursor must abort BEFORE the change_log scan — never replay the whole history.
    db.resetCounters()
    await req(app, tokens.ownerA, 'GET', changesPath('not-a-cursor'))
    const rejected = db.counters.loose
    db.resetCounters()
    await req(app, tokens.ownerA, 'GET', changesPath(good))
    expect(db.counters.loose).toBeGreaterThan(rejected)
  })

  test("ATTACK: viewer B cannot replay with viewer A's cursor", async () => {
    const { app, tokens } = await scenario()
    await create(app, tokens.ownerA, 'notes', { secret: true })
    const aCursor = await fromZero('siteA', 'userA')

    const res = await req(app, tokens.viewerB, 'GET', changesPath(aCursor))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid cursor' })
  })

  test('ATTACK: a cursor minted for siteB is rejected by a siteA token', async () => {
    const { app, tokens } = await scenario()
    await create(app, tokens.ownerA, 'notes', { n: 1 })
    // Same viewer identity, wrong site — the siteId is inside the cursor and must match the token.
    const bCursor = await encodeCursor(HMAC, { siteId: 'siteB', viewerId: 'userB', seq: 0 })

    const res = await req(app, tokens.viewerB, 'GET', changesPath(bCursor))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid cursor' })
  })
})

describe('the catch-up route is just another dataApi route', () => {
  test('ATTACK: a document collection named _sync cannot shadow the catch-up route', async () => {
    const { app, tokens } = await scenario()
    const doc = await create(app, tokens.ownerA, '_sync', { pretending: 'to be the feed' })

    const feed = await catchUp(app, tokens.ownerA, await fromZero('siteA', 'userA'))
    expect(feed.events.map((e) => e.collection)).toEqual(['_sync'])
    expect(feed.events[0].id).toBe(doc)

    const list = await req(app, tokens.ownerA, 'GET', '/_sync')
    expect(list.status).toBe(200)
    expect((await list.json()).items.map((d: { id: string }) => d.id)).toEqual([doc])
  })

  test('the catch-up route inherits the data-plane gates', async () => {
    const { db, app, tokens } = await scenario()
    const cursor = await fromZero('siteA', 'userA')
    // Control: the same request with every gate satisfied is served — so each status below is the
    // gate speaking, not the route being absent.
    expect((await req(app, tokens.ownerA, 'GET', changesPath(cursor))).status).toBe(200)

    // Feature not enabled on this deploy → the whole surface is inert.
    const inert = await req(app, tokens.ownerA, 'GET', changesPath(cursor), undefined, {
      CONTENT_URL: 'https://content.example.com',
    })
    expect(inert.status).toBe(404)

    expect((await req(app, null, 'GET', changesPath(cursor))).status).toBe(401)
    expect((await req(app, 'garbage.token', 'GET', changesPath(cursor))).status).toBe(401)

    await db.update(sites).set({ status: 'archived' }).where(eq(sites.id, 'siteA'))
    expect((await req(app, tokens.ownerA, 'GET', changesPath(cursor))).status).toBe(410)
  })
})
