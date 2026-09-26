import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireSameOrigin } from '../middleware/auth'
import type { CommentEvent } from '../realtime/comment-events'
import { makeDb, makeKv, makeR2, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { comments } from './comments'
import { sites } from './sites'

// S5 — wiring the S4 push builders into the four comment write paths (JSON/voice create, JSON/
// voice reply). These specs sit at the ROUTE level (not realtime/) because the thing under test
// is "does a committed write actually reach notifyCommentEvent", not the fan-out mechanics
// themselves (already pinned in realtime/site-room.test.ts). A recordingRoom stands in for the
// SiteRoom DO exactly like data-ws.test.ts's — the route never inspects a real DO, only whether
// (and what) it addressed.

const APP_URL = 'https://glance.example.com'

/** A DurableObjectNamespace that records every /broadcast-comment request it receives. */
function recordingRoom() {
  const requests: { name: string; body: CommentEvent }[] = []
  const ns = {
    idFromName(name: string) {
      return { name }
    },
    get(id: { name: string }) {
      return {
        fetch: async (input: Request | string, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(input, init)
          requests.push({ name: id.name, body: await req.clone().json() })
          return new Response(null, { status: 204 })
        },
      }
    },
  }
  return { ns, requests }
}

async function setup(o: { room?: boolean } = { room: true }) {
  const db = makeDb()
  const r2 = makeR2()
  const kv = makeKv()
  const room = recordingRoom()
  // `room: false` drops the SITE_ROOM binding to exercise the no-realtime path; everything else
  // is identical, so the binding is added rather than the whole env written out twice.
  const bindings: Partial<AppEnv['Bindings']> = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv, GLANCE_FILES: r2 }
  if (o.room !== false) bindings.SITE_ROOM = room.ns as AppEnv['Bindings']['SITE_ROOM']
  const env = bindings as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/sites', sites)
  app.route('/api/sites', comments)
  return { db, r2, kv, app, env, room }
}

async function mintUser(db: ReturnType<typeof makeDb>, kv: ReturnType<typeof makeKv>, o: { id: string; role?: 'member' | 'superadmin' }) {
  const id = await seedUser(db, { id: o.id, role: o.role ?? 'member' })
  const tok = `tok-${id}`
  await kv.put(`cli:${tok}`, JSON.stringify({ id, email: `${id}@example.com`, name: null, role: o.role ?? 'member' }))
  return id
}

const auth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL, 'Content-Type': 'application/json' })

async function seedSiteWithFile(
  db: ReturnType<typeof makeDb>,
  ownerId: string,
  visibility: 'private' | 'members' | 'team' = 'team',
) {
  const sp = await seedSpace(db, { createdBy: ownerId, slug: 'acme' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId, slug: 'doc', visibility })
  return { spaceId: sp, siteId }
}

const url = (extra = '') => `/api/sites/acme/doc/comments${extra}`

const aiEnv = (base: AppEnv['Bindings'], run: () => Promise<{ text: string }>) =>
  ({ ...base, AI: { run } }) as unknown as AppEnv['Bindings']

const audioForm = (bytes: Uint8Array, extra: Record<string, string> = {}, type = 'audio/webm', name = 'take.webm') => {
  const fd = new FormData()
  fd.set('audio', new Blob([bytes], { type }), name)
  for (const [k, v] of Object.entries(extra)) fd.set(k, v)
  return fd
}
const voice = (id: string, body: FormData) => ({ method: 'POST', headers: { Authorization: `Bearer tok-${id}`, Origin: APP_URL }, body })

async function listThreads(app: Hono<AppEnv>, env: AppEnv['Bindings']) {
  const res = await app.request(url('?filePath=index.html'), { headers: auth('owner') }, env)
  return (await res.json()) as Array<{ id: string; comments: Array<{ id: string; body: string | null; hasAudio: boolean }> }>
}

describe('S5 C1/C2 — a successful JSON create/reply pushes exactly one matching event', () => {
  test('create: exactly one thread.created, byte-identical to the list endpoint, response unchanged', async () => {
    const { app, env, db, kv, room } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, owner)

    const res = await app.request(url(), { method: 'POST', headers: auth(owner), body: JSON.stringify({ filePath: 'index.html', body: 'hello world' }) }, env)
    expect(res.status).toBe(201)
    const out = (await res.json()) as { threadId: string; openingCommentId: string }
    expect(out.threadId).toBeTruthy()

    expect(room.requests).toHaveLength(1)
    const [{ name, body }] = room.requests
    expect(name).toBe(siteId)
    expect(body.type).toBe('thread.created')
    // Top-level filePath (distinct from the nested thread.filePath pinned via listedThread below)
    // is what the client rail compares to decide "is this event for the file I'm showing" — wrong
    // here silently drops the push client-side, with nothing else to catch it.
    expect(body.filePath).toBe('index.html')

    const listed = await listThreads(app, env)
    const listedThread = listed.find((t) => t.id === out.threadId)
    expect(body.thread).toEqual(listedThread)
    // The public 201 body is a hand-written narrowing of the full thread/comment rows createThread
    // now returns for the push (Phase 2) — pin its exact key set so a revert to c.json(out, 201)
    // (which would leak e.g. comment.audioKey, the R2 object key) goes red.
    expect(Object.keys(out).sort()).toEqual(['openingCommentId', 'threadId'])
  })

  test('reply: exactly one comment.created carrying the right threadId', async () => {
    const { app, env, db, kv, room } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })

    const res = await app.request(
      url(`/${threadId}/replies`),
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'a reply' }) },
      env,
    )
    expect(res.status).toBe(201)
    const out = (await res.json()) as { id: string }

    expect(room.requests).toHaveLength(1)
    const [{ name, body }] = room.requests
    // siteId names the target DO room — the create test above asserts this, but this reply push
    // builds its own `notifyCommentEvent` call and a wrong siteId here would route it into a room
    // nobody is subscribed to, silently, with no failing assertion anywhere else.
    expect(name).toBe(siteId)
    expect(body.type).toBe('comment.created')
    expect(body.threadId).toBe(threadId)
    expect((body.comment as { id: string }).id).toBe(out.id)
    // Top-level filePath is what the client rail compares to decide the event is for the open
    // file — a reply push carries no nested thread to fall back on, so this is the only pin.
    expect(body.filePath).toBe('index.html')
  })
})

describe('S5 C3 — voice create/reply push, hasAudio true with the transcript as the body', () => {
  test('voice create pushes a thread.created whose opening comment matches the list endpoint', async () => {
    const { app, env, db, kv, room } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, owner)

    const fd = audioForm(new Uint8Array([1, 2, 3]), { filePath: 'index.html' })
    const res = await app.request(url(), voice(owner, fd), aiEnv(env, async () => ({ text: 'hello there' })))
    expect(res.status).toBe(201)
    const out = (await res.json()) as { threadId: string; openingCommentId: string }

    expect(room.requests).toHaveLength(1)
    const [{ body }] = room.requests
    expect(body.type).toBe('thread.created')
    // Same silent-drop field as the JSON create test: wrong top-level filePath here and the voice
    // create push never shows up client-side, with no error anywhere.
    expect(body.filePath).toBe('index.html')
    const thread = body.thread as { comments: Array<{ id: string; body: string; hasAudio: boolean }> }
    const opening = thread.comments.find((c) => c.id === out.openingCommentId)!
    expect(opening.hasAudio).toBe(true)
    expect(opening.body).toBe('hello there')

    const listed = await listThreads(app, aiEnv(env, async () => ({ text: 'hello there' })))
    expect(thread).toEqual(listed.find((t) => t.id === out.threadId))
    // Same narrowing pin as the JSON create path — the voice create route has its own
    // `c.json(...)` call, so a revert there is a separate mutant from the JSON one.
    expect(Object.keys(out).sort()).toEqual(['openingCommentId', 'threadId'])
  })

  test('voice reply pushes a comment.created with hasAudio true and the transcript as the body', async () => {
    const { app, env, db, kv, room } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })

    const fd = audioForm(new Uint8Array([4, 5, 6]))
    const res = await app.request(url(`/${threadId}/replies`), voice(owner, fd), aiEnv(env, async () => ({ text: 'a spoken reply' })))
    expect(res.status).toBe(201)
    const out = (await res.json()) as { id: string }

    expect(room.requests).toHaveLength(1)
    const [{ name, body }] = room.requests
    // Same DO-routing pin as the JSON reply test — the voice reply path builds its own push.
    expect(name).toBe(siteId)
    expect(body.type).toBe('comment.created')
    expect(body.filePath).toBe('index.html')
    const comment = body.comment as { id: string; body: string; hasAudio: boolean }
    expect(comment.id).toBe(out.id)
    expect(comment.hasAudio).toBe(true)
    expect(comment.body).toBe('a spoken reply')
  })
})

describe('S5 C4 (P0) — no phantoms: a write that never happened pushes nothing', () => {
  test('invalid body (400) pushes nothing', async () => {
    const { app, env, db, kv, room } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, owner)
    const res = await app.request(url(), { method: 'POST', headers: auth(owner), body: JSON.stringify({ filePath: 'index.html', body: '' }) }, env)
    expect(res.status).toBe(400)
    expect(room.requests).toEqual([])
  })

  test('parseThreadFields 400 (missing filePath) pushes nothing', async () => {
    const { app, env, db, kv, room } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, owner)
    const res = await app.request(url(), { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'hello' }) }, env)
    expect(res.status).toBe(400)
    expect(room.requests).toEqual([])
  })

  test('denied gate (403 on a members-only site) pushes nothing', async () => {
    const { app, env, db, kv, room } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const outsider = await mintUser(db, kv, { id: 'outsider' })
    await seedSiteWithFile(db, owner, 'members')
    const res = await app.request(
      url(),
      { method: 'POST', headers: auth(outsider), body: JSON.stringify({ filePath: 'index.html', body: 'hello' }) },
      env,
    )
    expect(res.status).toBe(403)
    expect(room.requests).toEqual([])
  })

  test('reply to a thread not in this site (404) pushes nothing', async () => {
    const { app, env, db, kv, room } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, owner)
    // A second, distinct space+site so the thread genuinely belongs to a DIFFERENT site.
    const sp2 = await seedSpace(db, { createdBy: owner, slug: 'other' })
    const otherSiteId = await seedSite(db, { spaceId: sp2, ownerId: owner, slug: 'doc2', visibility: 'team' })
    const foreignThreadId = await seedThread(db, { siteId: otherSiteId, filePath: 'index.html', createdBy: owner })

    const res = await app.request(
      url(`/${foreignThreadId}/replies`),
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'hello' }) },
      env,
    )
    expect(res.status).toBe(404)
    expect(room.requests).toEqual([])
  })
})

describe('S5 C5 — SITE_ROOM unbound: all four write paths behave exactly as they do today', () => {
  test('JSON create: same 201 status/body, no throw, nothing to assert-push (no room bound)', async () => {
    const { app, env, db, kv } = await setup({ room: false })
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, owner)
    const res = await app.request(url(), { method: 'POST', headers: auth(owner), body: JSON.stringify({ filePath: 'index.html', body: 'hello' }) }, env)
    expect(res.status).toBe(201)
    const out = (await res.json()) as { threadId: string; openingCommentId: string }
    expect(out.threadId).toBeTruthy()
  })

  test('JSON reply: same 201 status/body, no throw', async () => {
    const { app, env, db, kv } = await setup({ room: false })
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    const res = await app.request(
      url(`/${threadId}/replies`),
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'hi' }) },
      env,
    )
    expect(res.status).toBe(201)
    expect(((await res.json()) as { id: string }).id).toBeTruthy()
  })

  test('voice create: same 201 status/body, no throw', async () => {
    const { app, env, db, kv } = await setup({ room: false })
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, owner)
    const fd = audioForm(new Uint8Array([1, 2, 3]), { filePath: 'index.html' })
    const res = await app.request(url(), voice(owner, fd), aiEnv(env, async () => ({ text: 'hi' })))
    expect(res.status).toBe(201)
  })

  test('voice reply: same 201 status/body, no throw', async () => {
    const { app, env, db, kv } = await setup({ room: false })
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    const fd = audioForm(new Uint8Array([4, 5, 6]))
    const res = await app.request(url(`/${threadId}/replies`), voice(owner, fd), aiEnv(env, async () => ({ text: 'hi' })))
    expect(res.status).toBe(201)
  })
})
