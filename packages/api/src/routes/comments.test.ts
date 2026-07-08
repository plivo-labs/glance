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

// --- Voice (multipart) helpers, shared by the create/reply specs and the audio-GET specs. ---
// env with a Whisper stub returning `text`. Cast because the harness env is partial.
const aiEnv = (base: AppEnv['Bindings'], run: () => Promise<{ text: string }>) =>
  ({ ...base, AI: { run } }) as unknown as AppEnv['Bindings']

const audioForm = (bytes: Uint8Array, extra: Record<string, string> = {}, type = 'audio/webm', name = 'take.webm') => {
  const fd = new FormData()
  fd.set('audio', new Blob([bytes], { type }), name)
  for (const [k, v] of Object.entries(extra)) fd.set(k, v)
  return fd
}
// Multipart POST: DON'T set Content-Type (the FormData boundary is auto-added); keep auth+Origin.
const voice = (id: string, body: FormData) => ({ method: 'POST', headers: { Authorization: `Bearer tok-${id}`, Origin: APP_URL }, body })

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

describe('comments routes — input sanitization + lifecycle guards', () => {
  test('quote-nfkc-overcap-rejected: under the raw cap but > MAX_QUOTE once NFKC-folded → 400', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    // U+FDFA folds to ~18 chars under NFKC; 1000 raw code units (< MAX_QUOTE 8000) explode past it.
    const quote = 'ﷺ'.repeat(1000)
    expect(quote.length).toBeLessThan(8_000) // a naive raw-length cap would accept it…
    expect(quote.normalize('NFKC').length).toBeGreaterThan(8_000) // …but the stored (folded) quote blows the cap
    const res = await app.request(url(), { method: 'POST', headers: auth(owner), body: JSON.stringify({ filePath: 'index.html', body: 'hi', quote }) }, env)
    expect(res.status).toBe(400)
  })

  test('control-chars-stripped: ANSI escapes removed from body + quote on input; newline/tab preserved', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const esc = '[31mred[0m' // ESC (0x1B) + SGR: raw terminal injection if printed unescaped
    await app.request(url(), { method: 'POST', headers: auth(owner), body: JSON.stringify({ filePath: 'index.html', body: `esc ${esc}`, quote: `fox ${esc}` }) }, env)
    await app.request(url(), { method: 'POST', headers: auth(owner), body: JSON.stringify({ filePath: 'index.html', body: 'multi\nline\tkept' }) }, env)

    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    const escThread = list.find((t: { comments: { body: string }[] }) => t.comments[0].body.startsWith('esc'))
    const nlThread = list.find((t: { comments: { body: string }[] }) => t.comments[0].body.startsWith('multi'))
    // Any surviving C0 (0x00-0x1F) or DEL (0x7F) char, excluding the allowed tab/newline.
    const controlCodes = (s: string) =>
      [...s].map((ch) => ch.charCodeAt(0)).filter((code) => (code < 32 || code === 127) && code !== 9 && code !== 10)
    expect(controlCodes(escThread.comments[0].body)).toEqual([]) // ESC stripped, printable payload survives
    expect(escThread.comments[0].body).toContain('[31mred')
    expect(controlCodes(escThread.quote)).toEqual([])
    // Newline + tab are legitimate multi-line comment text and MUST survive.
    expect(nlThread.comments[0].body).toBe('multi\nline\tkept')
  })

  test('edit-deleted-comment-404: editing or re-deleting an already soft-deleted comment → 404', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, r2, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    const commentId = await seedComment(db, { threadId, authorId: owner, body: 'mine' })
    const path = url(`/${threadId}/messages/${commentId}`)

    const del = await app.request(path, { method: 'DELETE', headers: auth(owner) }, env)
    expect(del.status).toBe(200)
    // The author would otherwise pass the authz check — the deleted guard must 404 first.
    const editAfter = await app.request(path, { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ body: 'resurrect' }) }, env)
    expect(editAfter.status).toBe(404)
    const delAgain = await app.request(path, { method: 'DELETE', headers: auth(owner) }, env)
    expect(delAgain.status).toBe(404)
  })

  test('archived-site-410: a comment request on an archived site → 410 (checkAccess gone, not 403)', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const sp = await seedSpace(db, { createdBy: owner, slug: 'acme' })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: owner, slug: 'doc', visibility: 'team', status: 'archived' })
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>x</p>' })

    const res = await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)
    expect(res.status).toBe(410)
  })
})

// Step 6 — voice comments. The JSON create/reply paths are unchanged; a multipart/form-data
// request takes a new voice branch that stores the audio in R2 and stores the transcript as the
// comment body. W2-8 pins the pre-existing JSON behavior before the parseThreadFields extraction.
describe('comments routes — JSON create characterization (W2-8, pre-refactor pin)', () => {
  const post = (headers: Record<string, string>, body: unknown) =>
    ({ method: 'POST', headers, body: JSON.stringify(body) }) as const

  test('W2-8: JSON create is unchanged for text / element / page threads', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)

    const textRes = await app.request(url(), post(auth(owner), { filePath: 'index.html', body: 'on text', quote: 'fox' }), env)
    expect(textRes.status).toBe(201)
    const elRes = await app.request(
      url(),
      post(auth(owner), { filePath: 'index.html', body: 'on element', anchorType: 'element', element: { selector: '#c', tag: 'div', preview: 'Chart', textFallback: 'Rev' } }),
      env,
    )
    expect(elRes.status).toBe(201)
    const pageRes = await app.request(url(), post(auth(owner), { filePath: 'index.html', body: 'on page', anchorType: 'page' }), env)
    expect(pageRes.status).toBe(201)

    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    const byBody = (b: string) => list.find((t: { comments: { body: string }[] }) => t.comments[0].body === b)
    const text = byBody('on text')
    expect(text.anchorType).toBe('text')
    expect(text.quote).toBe('fox')
    expect(text.anchor).toBeNull()
    const el = byBody('on element')
    expect(el.anchorType).toBe('element')
    expect(el.anchor).toEqual({ selector: '#c', tag: 'div', preview: 'Chart', textFallback: 'Rev' })
    expect(el.quote).toBeNull()
    const page = byBody('on page')
    expect(page.anchorType).toBe('page')
    expect(page.quote).toBeNull()
    expect(page.anchor).toBeNull()
  })
})

describe('comments routes — voice (multipart) create + reply (Step 6)', () => {
  test('W2-1 multipart create: transcript becomes the body, audio lands in R2, hasAudio true', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 128])
    const fd = audioForm(bytes, { filePath: 'index.html', quote: 'fox' })
    const res = await app.request(url(), voice(owner, fd), aiEnv(env, async () => ({ text: 'hello there' })))
    expect(res.status).toBe(201)
    const { openingCommentId } = await res.json()

    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    expect(list[0].comments[0].body).toBe('hello there')
    expect(list[0].comments[0].hasAudio).toBe(true)
    expect(r2.store.has(`comment-audio/${openingCommentId}.webm`)).toBe(true)
    expect(r2.store.get(`comment-audio/${openingCommentId}.webm`)?.body.length).toBe(bytes.byteLength)
  })

  test('W2-2 multipart reply: transcript body + audio by returned id', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, r2, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    await seedComment(db, { threadId, authorId: owner, body: 'opening' })

    const fd = audioForm(new Uint8Array([9, 9, 9]))
    const res = await app.request(url(`/${threadId}/replies`), voice(owner, fd), aiEnv(env, async () => ({ text: 'reply spoken' })))
    expect(res.status).toBe(201)
    const { id } = await res.json()
    expect(id).toBeTruthy()

    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    const reply = list[0].comments.find((cm: { id: string }) => cm.id === id)
    expect(reply.body).toBe('reply spoken')
    expect(reply.hasAudio).toBe(true)
    expect(r2.store.has(`comment-audio/${id}.webm`)).toBe(true)
  })

  test('W2-3 AI throws → fallback body, audio still stored, 201', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const fd = audioForm(new Uint8Array([1, 2, 3]), { filePath: 'index.html' })
    const throwingEnv = aiEnv(env, async () => {
      throw new Error('model down')
    })
    const res = await app.request(url(), voice(owner, fd), throwingEnv)
    expect(res.status).toBe(201)
    const { openingCommentId } = await res.json()
    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    expect(list[0].comments[0].body).toBe('[voice message]')
    expect(r2.store.has(`comment-audio/${openingCommentId}.webm`)).toBe(true)
  })

  test('W2-4 AI binding absent → fallback body, audio stored, 201', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const fd = audioForm(new Uint8Array([4, 5, 6]), { filePath: 'index.html' })
    const res = await app.request(url(), voice(owner, fd), env) // env has no AI
    expect(res.status).toBe(201)
    const { openingCommentId } = await res.json()
    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    expect(list[0].comments[0].body).toBe('[voice message]')
    expect(r2.store.has(`comment-audio/${openingCommentId}.webm`)).toBe(true)
  })

  test('W2-5 oversize audio → 413, no R2 put, no thread created', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const before = r2.store.size
    const huge = new Uint8Array(10 * 1024 * 1024 + 1)
    const fd = audioForm(huge, { filePath: 'index.html' })
    const res = await app.request(url(), voice(owner, fd), aiEnv(env, async () => ({ text: 'x' })))
    expect(res.status).toBe(413)
    expect(r2.store.size).toBe(before) // no put
    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    expect(list).toHaveLength(0) // no thread created
  })

  test('W2-6 non-audio part → 400; missing audio part → 400', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)

    const nonAudio = audioForm(new Uint8Array([1]), { filePath: 'index.html' }, 'text/plain', 'note.txt')
    const badType = await app.request(url(), voice(owner, nonAudio), env)
    expect(badType.status).toBe(400)

    const noAudio = new FormData()
    noAudio.set('filePath', 'index.html')
    const missing = await app.request(url(), voice(owner, noAudio), env)
    expect(missing.status).toBe(400)
  })

  test('W2-7 malformed element JSON in multipart create → 400', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    await seedSiteWithFile(db, r2, owner)
    const fd = audioForm(new Uint8Array([1, 2]), { filePath: 'index.html', anchorType: 'element', element: '{not json' })
    const res = await app.request(url(), voice(owner, fd), env)
    expect(res.status).toBe(400)
  })
})

describe('comments routes — voice audio serving + delete lifecycle (Steps 8, 9)', () => {
  // Post a voice comment (owner, team site) and return the opening comment id + fixtures.
  async function withVoiceComment(bytes: Uint8Array) {
    const ctx = await setup()
    const owner = await mintUser(ctx.db, ctx.kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(ctx.db, ctx.r2, owner)
    const fd = audioForm(bytes, { filePath: 'index.html' })
    const res = await ctx.app.request(url(), voice(owner, fd), aiEnv(ctx.env, async () => ({ text: 'spoken' })))
    const { openingCommentId } = await res.json()
    return { ...ctx, owner, siteId, commentId: openingCommentId as string }
  }
  const audioUrl = (id: string) => url(`/audio/${id}`)

  test('W2-10 audio GET → 200 with audio content-type, etag, accept-ranges', async () => {
    const { app, env, owner, commentId } = await withVoiceComment(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    const res = await app.request(audioUrl(commentId), { headers: auth(owner) }, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/webm')
    expect(res.headers.get('etag')).toBeTruthy()
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('W2-11 audio GET with Range → 206 slice', async () => {
    const { app, env, owner, commentId } = await withVoiceComment(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    const res = await app.request(audioUrl(commentId), { headers: { ...auth(owner), Range: 'bytes=0-3' } }, env)
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-3/8')
    expect(res.headers.get('content-length')).toBe('4')
    expect((await res.arrayBuffer()).byteLength).toBe(4)
  })

  test('W2-12 audio GET with matching If-None-Match → 304', async () => {
    const { app, env, owner, commentId } = await withVoiceComment(new Uint8Array([1, 2, 3, 4]))
    const first = await app.request(audioUrl(commentId), { headers: auth(owner) }, env)
    const etag = first.headers.get('etag') as string
    const res = await app.request(audioUrl(commentId), { headers: { ...auth(owner), 'If-None-Match': etag } }, env)
    expect(res.status).toBe(304)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  test('W2-13a non-member on a private site → audio 4xx (no access)', async () => {
    const ctx = await setup()
    const owner = await mintUser(ctx.db, ctx.kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(ctx.db, ctx.r2, owner, 'private')
    const fd = audioForm(new Uint8Array([1, 2, 3, 4]), { filePath: 'index.html' })
    const created = await ctx.app.request(url(), voice(owner, fd), aiEnv(ctx.env, async () => ({ text: 'spoken' })))
    const { openingCommentId } = await created.json()
    const stranger = await mintUser(ctx.db, ctx.kv, { id: 'stranger' })
    const res = await ctx.app.request(audioUrl(openingCommentId), { headers: auth(stranger) }, ctx.env)
    expect([401, 403, 404]).toContain(res.status)
    void siteId
  })

  test('W2-13b a text (no-audio) comment id → 404', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, r2, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    const textId = await seedComment(db, { threadId, authorId: owner, body: 'text only' })
    const res = await app.request(audioUrl(textId), { headers: auth(owner) }, env)
    expect(res.status).toBe(404)
  })

  test('W2-13c a soft-deleted voice comment id → 404, and the R2 audio is gone (W2-14 route half)', async () => {
    const { app, env, r2, owner, commentId } = await withVoiceComment(new Uint8Array([1, 2, 3, 4]))
    expect(r2.store.has(`comment-audio/${commentId}.webm`)).toBe(true)
    // Delete via the DELETE route (thread id needed for the path).
    const list = await (await app.request(url('?filePath=index.html'), { headers: auth(owner) }, env)).json()
    const threadId = list[0].id
    const del = await app.request(url(`/${threadId}/messages/${commentId}`), { method: 'DELETE', headers: auth(owner) }, env)
    expect(del.status).toBe(200)
    expect(r2.store.has(`comment-audio/${commentId}.webm`)).toBe(false) // audio hard-deleted
    const res = await app.request(audioUrl(commentId), { headers: auth(owner) }, env)
    expect(res.status).toBe(404)
  })

  test('W2-14 text-comment delete makes no R2 delete (redaction path unchanged)', async () => {
    const { app, env, db, r2, kv } = await setup()
    const owner = await mintUser(db, kv, { id: 'owner' })
    const { siteId } = await seedSiteWithFile(db, r2, owner)
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    const textId = await seedComment(db, { threadId, authorId: owner, body: 'text only' })
    const before = r2.store.size
    const del = await app.request(url(`/${threadId}/messages/${textId}`), { method: 'DELETE', headers: auth(owner) }, env)
    expect(del.status).toBe(200)
    expect(r2.store.size).toBe(before) // no R2 delete for a text comment
  })
})
