import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, makeR2, seedComment, seedFile, seedMember, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { comments } from './comments'
import { sites } from './sites'

// Comments routes, mounted the way index.ts mounts them (requireSameOrigin global + comments
// under /api/sites) so CSRF, auth, access-tier and authz are all exercised end to end.

const APP_URL = 'https://glance.example.com'

async function setup() {
  const db = makeDb()
  const r2 = makeR2()
  const kv = makeKv()
  const env = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv, GLANCE_FILES: r2 } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/sites', sites)
  app.route('/api/sites', comments)
  return { db, r2, kv, app, env }
}

async function mintUser(db: ReturnType<typeof makeDb>, kv: ReturnType<typeof makeKv>, o: { id: string; role?: 'member' | 'superadmin' }) {
  const id = await seedUser(db, { id: o.id, role: o.role ?? 'member' })
  const tok = `tok-${id}`
  await kv.put(`cli:${tok}`, JSON.stringify({ id, email: `${id}@example.com`, name: null, role: o.role ?? 'member' }))
  return id
}

const auth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL, 'Content-Type': 'application/json' })

/** Seed a space + site (default team) owned by `ownerId`, with one HTML file. */
async function seedSiteWithFile(
  db: ReturnType<typeof makeDb>,
  r2: ReturnType<typeof makeR2>,
  ownerId: string,
  visibility: 'private' | 'members' | 'team' = 'team',
) {
  const sp = await seedSpace(db, { createdBy: ownerId, slug: 'acme' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId, slug: 'doc', visibility })
  await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>The quick brown fox jumps.</p>' })
  return { spaceId: sp, siteId }
}

const url = (extra = '') => `/api/sites/acme/doc/comments${extra}`

describe('comments routes — auth / access / authz', () => {
  test('comments-require-auth: no session and no token → 401', async () => {
    const { app, env, db, r2 } = await setup()
    const owner = await mintUser(db, makeKv(), { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const res = await app.request(url('?filePath=index.html'), {}, env)
    expect(res.status).toBe(401)
  })

  test('comments-respect-access-tier: non-member on group → 403; member → allowed', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const member = await mintUser(db, kv, { id: 'member' })
    const outsider = await mintUser(db, kv, { id: 'outsider' })
    const { spaceId } = await seedSiteWithFile(db, r2, owner, 'members')
    await seedMember(db, spaceId, member)

    const blocked = await app.request(url('?filePath=index.html'), { headers: auth(outsider) }, env)
    expect(blocked.status).toBe(403)
    const allowed = await app.request(url('?filePath=index.html'), { headers: auth(member) }, env)
    expect(allowed.status).toBe(200)
  })

  test('csrf-cross-origin-comment-post-403: cookie + foreign Origin → 403 from global guard', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const res = await app.request(
      url(),
      { method: 'POST', headers: { cookie: 'glance_session=x', Origin: 'https://evil.com', 'Content-Type': 'application/json' }, body: '{}' },
      env,
    )
    expect(res.status).toBe(403)
  })

  test('body-length-cap-rejected: over-cap body → 400', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const res = await app.request(url(), { method: 'POST', headers: auth(owner), body: JSON.stringify({ filePath: 'index.html', body: 'x'.repeat(10_001), quote: 'fox' }) }, env)
    expect(res.status).toBe(400)
  })

  test('author-can-edit-delete-own-only: author edits own; a non-author cannot', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const member = await mintUser(db, kv, { id: 'member' })
    const { spaceId } = await seedSiteWithFile(db, r2, owner, 'members')
    await seedMember(db, spaceId, member)
    // member opens a thread (its opening comment is authored by member)
    const created = await (await app.request(url(), { method: 'POST', headers: auth(member), body: JSON.stringify({ filePath: 'index.html', body: 'mine', quote: 'fox' }) }, env)).json()
    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(member) }, env)).json()
    const commentId = list[0].comments[0].id
    const path = url(`/${created.threadId}/messages/${commentId}`)

    const byOther = await app.request(path, { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ body: 'hijack' }) }, env)
    expect(byOther.status).toBe(403)
    const byAuthor = await app.request(path, { method: 'PATCH', headers: auth(member), body: JSON.stringify({ body: 'edited' }) }, env)
    expect(byAuthor.status).toBe(200)
  })

  test('owner-superadmin-resolve-and-delete-any: owner resolves + deletes a member comment; member cannot resolve', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const member = await mintUser(db, kv, { id: 'member' })
    const { spaceId } = await seedSiteWithFile(db, r2, owner, 'members')
    await seedMember(db, spaceId, member)
    const created = await (await app.request(url(), { method: 'POST', headers: auth(member), body: JSON.stringify({ filePath: 'index.html', body: 'mine', quote: 'fox' }) }, env)).json()
    const commentId = (await (await app.request(url('?filePath=index.html'), { headers: auth(member) }, env)).json())[0].comments[0].id

    const memberResolve = await app.request(url(`/${created.threadId}`), { method: 'PATCH', headers: auth(member), body: JSON.stringify({ status: 'resolved' }) }, env)
    expect(memberResolve.status).toBe(403)
    const ownerResolve = await app.request(url(`/${created.threadId}`), { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ status: 'resolved' }) }, env)
    expect(ownerResolve.status).toBe(200)
    const ownerDelete = await app.request(url(`/${created.threadId}/messages/${commentId}`), { method: 'DELETE', headers: auth(owner) }, env)
    expect(ownerDelete.status).toBe(200)

    // soft-delete-keeps-thread-shape: the comment row survives, body redacted.
    const after = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    expect(after[0].comments).toHaveLength(1)
    expect(after[0].comments[0].deleted).toBe(true)
    expect(after[0].comments[0].body).toBeNull()
  })
})

describe('comments routes — element (pinpoint) anchors', () => {
  const post = (headers: Record<string, string>, body: unknown) =>
    ({ method: 'POST', headers, body: JSON.stringify(body) }) as const

  test('element-create-and-readback: valid element payload → 201, thread lists with the element anchor', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const res = await app.request(
      url(),
      post(auth(owner), {
        filePath: 'index.html',
        body: 'this chart is off',
        anchorType: 'element',
        element: { selector: '#chart', tag: 'div', preview: 'Bar chart', textFallback: 'Revenue' },
      }),
      env,
    )
    expect(res.status).toBe(201)
    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    expect(list[0].anchorType).toBe('element')
    expect(list[0].anchor).toEqual({ selector: '#chart', tag: 'div', preview: 'Bar chart', textFallback: 'Revenue' })
    expect(list[0].quote).toBeNull()
  })

  test('element-missing-selector-rejected: anchorType element with no selector → 400 (no silent coerce to text)', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const res = await app.request(url(), post(auth(owner), { filePath: 'index.html', body: 'x', anchorType: 'element', element: { tag: 'div' } }), env)
    expect(res.status).toBe(400)
  })

  test('element-oversize-field-rejected: over-cap selector → 400', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const res = await app.request(url(), post(auth(owner), { filePath: 'index.html', body: 'x', anchorType: 'element', element: { selector: 'a'.repeat(2000) } }), env)
    expect(res.status).toBe(400)
  })

  test('text-create-unchanged: a text payload still creates a text thread (char)', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const res = await app.request(url(), post(auth(owner), { filePath: 'index.html', body: 'here', quote: 'fox' }), env)
    expect(res.status).toBe(201)
    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    expect(list[0].anchorType).toBe('text')
    expect(list[0].quote).toBe('fox')
    expect(list[0].anchor).toBeNull()
  })
})

describe('comments routes — site-wide list (filePath optional)', () => {
  /** Seed acme/doc with TWO files, each carrying one thread + opening comment. */
  async function seedSiteWithTwoFiles(
    db: ReturnType<typeof makeDb>,
    r2: ReturnType<typeof makeR2>,
    ownerId: string,
    visibility: 'private' | 'members' | 'team' = 'members',
  ) {
    const sp = await seedSpace(db, { createdBy: ownerId, slug: 'acme' })
    const siteId = await seedSite(db, { spaceId: sp, ownerId, slug: 'doc', visibility })
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>The quick brown fox jumps.</p>' })
    await seedFile(db, r2, siteId, { path: 'about.html', text: '<p>About the lazy dog.</p>' })
    const t1 = await seedThread(db, { siteId, filePath: 'index.html', createdBy: ownerId })
    await seedComment(db, { threadId: t1, authorId: ownerId, body: 'on index' })
    const t2 = await seedThread(db, { siteId, filePath: 'about.html', createdBy: ownerId })
    await seedComment(db, { threadId: t2, authorId: ownerId, body: 'on about' })
    return { spaceId: sp, siteId, t1, t2 }
  }

  test('get-no-filePath-lists-whole-site: no ?filePath → threads from BOTH files', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const member = await mintUser(db, kv, { id: 'member' })
    const { spaceId } = await seedSiteWithTwoFiles(db, r2, owner, 'members')
    await seedMember(db, spaceId, member)

    const res = await app.request(url(), { headers: auth(member) }, env)
    expect(res.status).toBe(200)
    const threads = await res.json()
    expect(threads).toHaveLength(2)
    expect(new Set(threads.map((t: { filePath: string }) => t.filePath))).toEqual(new Set(['index.html', 'about.html']))
  })

  test('get-with-filePath-still-per-file: ?filePath=<one file> → only that file (back-compat)', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const member = await mintUser(db, kv, { id: 'member' })
    const { spaceId } = await seedSiteWithTwoFiles(db, r2, owner, 'members')
    await seedMember(db, spaceId, member)

    const res = await app.request(url('?filePath=index.html'), { headers: auth(member) }, env)
    expect(res.status).toBe(200)
    const threads = await res.json()
    expect(threads).toHaveLength(1)
    expect(threads[0].filePath).toBe('index.html')
  })

  test('get-oversized-filePath-still-400: ?filePath over MAX_PATH → 400 (guard preserved)', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const member = await mintUser(db, kv, { id: 'member' })
    const { spaceId } = await seedSiteWithTwoFiles(db, r2, owner, 'members')
    await seedMember(db, spaceId, member)

    const res = await app.request(url(`?filePath=${'a'.repeat(1025)}`), { headers: auth(member) }, env)
    expect(res.status).toBe(400)
  })

  test('get-empty-filePath-still-400: explicit ?filePath= (present but empty) → 400, not site-wide', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const member = await mintUser(db, kv, { id: 'member' })
    const { spaceId } = await seedSiteWithTwoFiles(db, r2, owner, 'members')
    await seedMember(db, spaceId, member)

    // Present-but-empty is distinct from truly-absent: it must hit the 400 guard, NOT fall through
    // to the site-wide list (the empty-vs-undefined seam this phase introduces).
    const res = await app.request(url('?filePath='), { headers: auth(member) }, env)
    expect(res.status).toBe(400)
  })

  test('site-list-access-still-gated: group non-member → 403', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const outsider = await mintUser(db, kv, { id: 'outsider' })

    await seedSiteWithTwoFiles(db, r2, owner, 'members')
    const onGroupNonMember = await app.request(url(), { headers: auth(outsider) }, env)
    expect(onGroupNonMember.status).toBe(403)
  })
})

// The endpoint `glance reply` depends on. Not unit-testable through the CLI (token auth needs
// OAuth locally), so pin it here via the same cli:<token> KV harness the other routes use.
describe('comments routes — POST …/:threadId/replies (glance reply)', () => {
  const reply = (threadId: string) => url(`/${threadId}/replies`)

  test('RR-success: authed reply → 201 {id} and the reply appears in the thread list', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, r2, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: owner, body: 'opening' })

    const res = await app.request(reply(threadId), { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: '[agent] fixed it' }) }, env)
    expect(res.status).toBe(201)
    expect((await res.json()).id).toBeTruthy()

    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    const thread = list.find((t: { id: string }) => t.id === threadId)
    expect(thread.comments.map((c: { body: string }) => c.body)).toContain('[agent] fixed it')
  })

  test('RR-wrong-site-404: a threadId from another site → 404', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    // A thread that lives on a DIFFERENT site — resolving acme/doc succeeds, but the thread
    // isn't in it, so the site-scoping check must 404 (never leak a cross-site reply).
    const otherSpace = await seedSpace(db, { createdBy: owner, slug: 'other' })
    const otherSite = await seedSite(db, { spaceId: otherSpace, ownerId: owner, slug: 'doc2', visibility: 'team' })
    const foreignThread = await seedThread(db, { siteId: otherSite, filePath: 'index.html', createdBy: owner })

    const res = await app.request(reply(foreignThread), { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'hi' }) }, env)
    expect(res.status).toBe(404)
  })

  test('RR-empty-400: whitespace-only body → 400', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, r2, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })

    const res = await app.request(reply(threadId), { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: '   ' }) }, env)
    expect(res.status).toBe(400)
  })

  test('RR-oversize-400: over-cap body → 400 (the server 400 the CLI surfaces, no client cap)', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, r2, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })

    const res = await app.request(reply(threadId), { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'x'.repeat(10_001) }) }, env)
    expect(res.status).toBe(400)
  })

  test('RR-unauth-401: no token → 401', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, r2, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })

    const res = await app.request(reply(threadId), { method: 'POST', headers: { Origin: APP_URL, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) }, env)
    expect(res.status).toBe(401)
  })
})
