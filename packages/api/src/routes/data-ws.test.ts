import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { signDataToken } from '../lib/data-token'
import { TOKEN_HEADER } from '../realtime/site-room'
import { type HarnessDb, makeDb, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import wrangler from '../../wrangler.jsonc'
import { dataApi } from './data'

// The WORKER side of the realtime upgrade. Everything here is about what happens BEFORE the
// Durable Object is addressed: a junk, expired or revoked credential must cost zero DO quota, and
// the room a caller lands in must be derived from the verified token — never from the URL.
// The DO itself is a recording fake; its own behaviour is pinned in realtime/site-room.test.ts.

const HMAC = 'glance-test-ws'
const WS_PROTOCOL = 'glance.db.v1'
const SOCKET = '/api/_data/_sync/socket'

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

/** A DurableObjectNamespace that records every hop a request takes toward the object, so a test
 *  can assert the object was NEVER addressed (the quota-drain guard) as easily as that it was. */
function recordingRoom(respond: (req: Request) => Response = () => new Response(null, { status: 101 })) {
  const names: string[] = []
  const gets: string[] = []
  const requests: Request[] = []
  const ns = {
    idFromName(name: string) {
      names.push(name)
      return { name, toString: () => name }
    },
    get(id: { name: string }) {
      gets.push(id.name)
      return {
        fetch: async (input: Request | string, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(input, init)
          requests.push(req)
          return respond(req)
        },
      }
    },
  }
  const touches = () => names.length + gets.length + requests.length
  return { ns, names, gets, requests, touches }
}
type Room = ReturnType<typeof recordingRoom>

const envWith = (room: Room) =>
  ({ DATA_TOKEN_SECRET: HMAC, CONTENT_URL: 'https://content.example.com', SITE_ROOM: room.ns }) as never

/** A deploy that never enabled glance.db: the secret is absent, so the whole surface is inert. */
const envNoSecret = (room: Room) => ({ CONTENT_URL: 'https://content.example.com', SITE_ROOM: room.ns }) as never

/** The credential channel a browser actually has: `new WebSocket(url, [sentinel, token])`. */
const wsHeaders = (token?: string) => ({
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  ...(token === undefined ? {} : { 'Sec-WebSocket-Protocol': `${WS_PROTOCOL}, ${token}` }),
})

const socket = (app: TestApp, headers: Record<string, string>, env: unknown, path = SOCKET) =>
  app.request(path, { method: 'GET', headers }, env as never)

// userA owns siteA; userB owns siteB in its own space; siteM is a `members` site userB cannot
// reach; siteZ is archived. Every token below is validly signed — the point of most tests here
// is what happens to a WELL-FORMED credential.
async function scenario() {
  const db = makeDb()
  await seedUser(db, { id: 'userA', email: 'a@example.com' })
  await seedUser(db, { id: 'userB', email: 'b@example.com' })
  const sp = await seedSpace(db, { id: 'sp1', slug: 'sam', createdBy: 'userA' })
  await seedMember(db, sp, 'userA')
  await seedMember(db, sp, 'userB')
  await seedSite(db, { id: 'siteA', spaceId: sp, ownerId: 'userA', slug: 'demo', visibility: 'team' })
  await seedSite(db, { id: 'siteZ', spaceId: sp, ownerId: 'userA', slug: 'gone', status: 'archived' })
  const sp2 = await seedSpace(db, { id: 'sp2', slug: 'bob', createdBy: 'userB' })
  await seedMember(db, sp2, 'userB')
  await seedSite(db, { id: 'siteB', spaceId: sp2, ownerId: 'userB', slug: 'bobsite', visibility: 'team' })
  const sp3 = await seedSpace(db, { id: 'sp3', slug: 'closed', createdBy: 'userA' })
  await seedMember(db, sp3, 'userA')
  await seedSite(db, { id: 'siteM', spaceId: sp3, ownerId: 'userA', slug: 'members', visibility: 'members' })

  const VIEWER: Parameters<typeof signDataToken>[1]['caps'] = ['read', 'create']
  const tokens = {
    viewerA: await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userA', caps: VIEWER }),
    ownerB_siteB: await signDataToken(HMAC, { siteId: 'siteB', viewerId: 'userB', caps: VIEWER }),
    archived: await signDataToken(HMAC, { siteId: 'siteZ', viewerId: 'userA', caps: VIEWER }),
    unreachable: await signDataToken(HMAC, { siteId: 'siteM', viewerId: 'userB', caps: VIEWER }),
    expired: await signDataToken(HMAC, { siteId: 'siteA', viewerId: 'userA', caps: VIEWER }, -1),
    otherSecret: await signDataToken('a-different-secret', { siteId: 'siteA', viewerId: 'userA', caps: VIEWER }),
  }
  return { db, app: mount(db), tokens }
}

/** The positive control every negative test is measured against: the SAME app, the SAME path, a
 *  valid token — upgrades and addresses exactly one room. Without this a "401 + zero DO calls"
 *  assertion passes just as happily against a route that does not exist at all. */
async function expectUpgrade(app: TestApp, token: string, siteId: string) {
  const room = recordingRoom()
  const res = await socket(app, wsHeaders(token), envWith(room))
  expect(res.status).toBe(101)
  expect(room.names).toEqual([siteId])
  expect(room.requests).toHaveLength(1)
  return room
}

describe('#5: the socket upgrade authenticates in the WORKER, before any DO quota is spent', () => {
  test('a garbage or missing token is rejected 401 and the DO stub is never touched', async () => {
    const { app, tokens } = await scenario()
    await expectUpgrade(app, tokens.viewerA, 'siteA')

    for (const token of [undefined, 'not-a-token', `${tokens.viewerA}x`, tokens.otherSecret]) {
      const room = recordingRoom()
      const res = await socket(app, wsHeaders(token), envWith(room))
      expect(res.status).toBe(401)
      expect(room.touches()).toBe(0)
    }
  })

  test('ATTACK: an expired token never reaches the DO', async () => {
    const { app, tokens } = await scenario()
    await expectUpgrade(app, tokens.viewerA, 'siteA')

    const room = recordingRoom()
    const res = await socket(app, wsHeaders(tokens.expired), envWith(room))
    expect(res.status).toBe(401)
    expect(room.touches()).toBe(0)
  })

  test('ATTACK: a revoked viewer is rejected by the live re-auth before the DO', async () => {
    const { app, tokens } = await scenario()
    await expectUpgrade(app, tokens.viewerA, 'siteA')

    // Archived site: the token is still valid, the SITE is not.
    const archived = recordingRoom()
    expect((await socket(app, wsHeaders(tokens.archived), envWith(archived))).status).toBe(410)
    expect(archived.touches()).toBe(0)

    // A `members` site the viewer was never (or is no longer) a member of.
    const revoked = recordingRoom()
    expect((await socket(app, wsHeaders(tokens.unreachable), envWith(revoked))).status).toBe(403)
    expect(revoked.touches()).toBe(0)
  })

  test('ATTACK: a token supplied only in the query string is rejected', async () => {
    const { app, tokens } = await scenario()
    await expectUpgrade(app, tokens.viewerA, 'siteA')

    // A token in a URL lands in Cloudflare's request logs forever, so that channel does not exist.
    const room = recordingRoom()
    const path = `${SOCKET}?token=${encodeURIComponent(tokens.viewerA)}`
    const res = await socket(app, wsHeaders(undefined), envWith(room), path)
    expect(res.status).toBe(401)
    expect(room.touches()).toBe(0)
  })

  test('a non-upgrade GET on the socket path is 426 and never reaches the DO', async () => {
    const { app, tokens } = await scenario()
    const room = recordingRoom()
    // Authorization is the non-browser channel; it authenticates fine, so the 426 can only come
    // from the missing Upgrade header — not from a failed credential check.
    const res = await socket(app, { Authorization: `Bearer ${tokens.viewerA}` }, envWith(room))
    expect(res.status).toBe(426)
    expect(room.touches()).toBe(0)
  })

  test('the socket route is inert (404) when DATA_TOKEN_SECRET is unset', async () => {
    const { app, tokens } = await scenario()
    await expectUpgrade(app, tokens.viewerA, 'siteA')

    const room = recordingRoom()
    const res = await socket(app, wsHeaders(tokens.viewerA), envNoSecret(room))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not found')
    expect(room.touches()).toBe(0)
  })
})

describe('#5/IDOR: the room a caller joins is derived from the verified token', () => {
  test('the room id is derived from claims.siteId, never from the URL', async () => {
    const { app, tokens } = await scenario()
    const room = recordingRoom()
    // A siteB token on a URL that names siteA's space/slug in every way the URL can.
    const path = `${SOCKET}?space=sam&site=demo&siteId=siteA`
    const res = await socket(app, wsHeaders(tokens.ownerB_siteB), envWith(room), path)
    expect(res.status).toBe(101)
    expect(room.names).toEqual(['siteB'])
    expect(room.gets).toEqual(['siteB'])
  })

  test('the forwarded request carries the token ONLY on the dedicated header, never in the URL', async () => {
    const { app, tokens } = await scenario()
    const room = await expectUpgrade(app, tokens.viewerA, 'siteA')
    const forwarded = room.requests[0] as Request

    // The DO re-verifies the token itself (a worker bug must not be enough to join a room), so the
    // credential does travel — but on exactly ONE header, and never anywhere a log would keep it.
    expect(forwarded.headers.get(TOKEN_HEADER)).toBe(tokens.viewerA)
    const carrying = [...forwarded.headers.entries()].filter(([, v]) => v.includes(tokens.viewerA))
    expect(carrying.map(([k]) => k)).toEqual([TOKEN_HEADER])

    expect(new URL(forwarded.url).pathname).toBe('/subscribe')
    expect(new URL(forwarded.url).search).toBe('')
    expect(forwarded.url).not.toContain(tokens.viewerA)
    expect(forwarded.headers.get('Upgrade')).toBe('websocket')
    expect(forwarded.headers.get('Authorization')).toBeNull()
    expect(forwarded.body).toBeNull()
  })
})

describe('#1: Durable Object wiring', () => {
  test('the DO namespace is optional: a binding-less deploy answers 503, it does not crash', async () => {
    const { app, tokens } = await scenario()
    const env = { DATA_TOKEN_SECRET: HMAC, CONTENT_URL: 'https://content.example.com' } as never
    const res = await socket(app, wsHeaders(tokens.viewerA), env)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'realtime unavailable' })
  })

  test('wrangler.jsonc declares SITE_ROOM with new_sqlite_classes', async () => {
    const cfg = wrangler as {
      durable_objects?: { bindings: { name: string; class_name: string }[] }
      migrations?: Record<string, unknown>[]
    }
    expect(cfg.durable_objects?.bindings).toEqual([{ name: 'SITE_ROOM', class_name: 'SiteRoom' }])
    const migrations = cfg.migrations ?? []
    expect(migrations.some((m) => JSON.stringify(m.new_sqlite_classes) === JSON.stringify(['SiteRoom']))).toBe(true)
    // KV-backed Durable Objects (`new_classes`) are not available on the free plan.
    expect(migrations.every((m) => !('new_classes' in m))).toBe(true)
    expect(migrations.every((m) => typeof m.tag === 'string')).toBe(true)
  })
})
