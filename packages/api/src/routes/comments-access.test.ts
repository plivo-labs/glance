import { describe, expect, test } from 'bun:test'
import { seedComment, seedMember, seedSite, seedSpace, seedThread } from '../test/harness'
import { APP_URL, auth, makeRouteApp, mintUser } from '../test/route-fixtures'

// S9 pins for the comments routes' access gate (T9.1), read-your-write ordering (T9.2), and the
// fused-batch request shape (T9.3). T9.1/T9.2 are characterization: they pin TODAY's exact
// statuses/bodies and list-visible effects so the S9a/S9b batching cannot reorder or reword a
// denial. Existing comments.test.ts specs are the wider regression net — never re-authored here.

const url = (space: string, site: string, extra = '') => `/api/sites/${space}/${site}/comments${extra}`

/** Seed acme/doc owned by `ownerId` (visibility overridable) with one thread + opening comment. */
async function seedCommentedSite(
  db: ReturnType<typeof makeRouteApp>['db'],
  ownerId: string,
  visibility: 'private' | 'members' | 'team' = 'team',
  status: 'active' | 'archived' = 'active',
) {
  const spaceId = await seedSpace(db, { createdBy: ownerId, slug: 'acme' })
  const siteId = await seedSite(db, { spaceId, ownerId, slug: 'doc', visibility, status })
  const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: ownerId })
  const commentId = await seedComment(db, { threadId, authorId: ownerId, body: 'opening' })
  return { spaceId, siteId, threadId, commentId }
}

describe('comments routes — T9.1 exact status/body pins', () => {
  test('unauthed → 401 {error:unauthorized}', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const res = await app.request(url('acme', 'doc', '?filePath=index.html'), {}, env)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  test('authed outsider on a private site → 403, body carries NO thread fields', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const outsider = await mintUser(db, kv, 'outsider')
    await seedCommentedSite(db, owner, 'private')
    for (const extra of ['?filePath=index.html', '']) {
      const res = await app.request(url('acme', 'doc', extra), { headers: auth(outsider) }, env)
      expect(res.status).toBe(403)
      // toEqual pins the WHOLE body: exactly the error field, no thread/comment data leaked.
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
  })

  test('missing site → 404 {error:not found}', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const res = await app.request(url('acme', 'nope', '?filePath=index.html'), { headers: auth(owner) }, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  test('archived site → 410 {error:forbidden} (checkAccess gone, body unchanged)', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner, 'team', 'archived')
    const res = await app.request(url('acme', 'doc', '?filePath=index.html'), { headers: auth(owner) }, env)
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })

  test('inaccessible site + INVALID filePath → the ACCESS error wins (403, never 400)', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const outsider = await mintUser(db, kv, 'outsider')
    await seedCommentedSite(db, owner, 'private')
    for (const extra of ['?filePath=', `?filePath=${'a'.repeat(1025)}`]) {
      const res = await app.request(url('acme', 'doc', extra), { headers: auth(outsider) }, env)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
  })

  test('accessible site + invalid filePath → 400 {error:filePath required}', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    for (const extra of ['?filePath=', `?filePath=${'a'.repeat(1025)}`]) {
      const res = await app.request(url('acme', 'doc', extra), { headers: auth(owner) }, env)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'filePath required' })
    }
  })
})

// Read-your-write pins for the mutations whose GET-visible effect wasn't already asserted
// elsewhere (create/reply/delete readbacks live in comments.test.ts). These guard the S9b/S9c
// reordering: a mutation followed by a GET list must show the change.
describe('comments routes — T9.2 read-your-write', () => {
  const list = async (ctx: ReturnType<typeof makeRouteApp>, userId: string) =>
    (await ctx.app.request(url('acme', 'doc', '?filePath=index.html'), { headers: auth(userId) }, ctx.env)).json()

  test('resolve → GET list shows resolved + resolver', async () => {
    const ctx = makeRouteApp()
    const owner = await mintUser(ctx.db, ctx.kv, 'owner')
    const { threadId } = await seedCommentedSite(ctx.db, owner)
    const res = await ctx.app.request(
      url('acme', 'doc', `/${threadId}`),
      { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ status: 'resolved' }) },
      ctx.env,
    )
    expect(res.status).toBe(200)
    const [thread] = await list(ctx, owner)
    expect(thread.status).toBe('resolved')
    expect(thread.resolvedBy).toBe(owner)
    expect(thread.resolvedAt).toBeTruthy()
  })

  test('reopen → GET list shows open again, resolver cleared', async () => {
    const ctx = makeRouteApp()
    const owner = await mintUser(ctx.db, ctx.kv, 'owner')
    const { threadId } = await seedCommentedSite(ctx.db, owner)
    const patch = (status: string) =>
      ctx.app.request(
        url('acme', 'doc', `/${threadId}`),
        { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ status }) },
        ctx.env,
      )
    expect((await patch('resolved')).status).toBe(200)
    expect((await patch('open')).status).toBe(200)
    const [thread] = await list(ctx, owner)
    expect(thread.status).toBe('open')
    expect(thread.resolvedBy).toBeNull()
    expect(thread.resolvedAt).toBeNull()
  })

  test('edit → GET list shows the new body + editedAt', async () => {
    const ctx = makeRouteApp()
    const owner = await mintUser(ctx.db, ctx.kv, 'owner')
    const { threadId, commentId } = await seedCommentedSite(ctx.db, owner)
    const res = await ctx.app.request(
      url('acme', 'doc', `/${threadId}/messages/${commentId}`),
      { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ body: 'edited body' }) },
      ctx.env,
    )
    expect(res.status).toBe(200)
    const [thread] = await list(ctx, owner)
    expect(thread.comments[0].body).toBe('edited body')
    expect(thread.comments[0].editedAt).toBeTruthy()
  })
})

// S9b request-shape pins. A "request" is one D1 round trip (a loose statement or one db.batch).
// GET list must be exactly: requireAuth's 1 loose user read (parked floor) + ONE fused batch of 7
// statements — 5 slug-keyed access facts + the 2 S8 list statements. Counters reset after seeding
// so only the request under test is measured.
describe('comments routes — T9.3 GET list = 1 loose read + 1 fused batch of 7', () => {
  test('allowed: per-file and site-wide lists each run exactly the fused batch', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    for (const extra of ['?filePath=index.html', '']) {
      db.resetCounters()
      const res = await app.request(url('acme', 'doc', extra), { headers: auth(owner) }, env)
      expect(res.status).toBe(200)
      expect((await res.json()).length).toBe(1)
      expect(db.counters.loose).toBe(1) // requireAuth's user read — nothing else loose
      expect(db.counters.batches).toBe(1) // facts + list statements FUSED, not two batches
      expect(db.counters.batchStmts).toBe(7) // 5 access facts + threads stmt + comments stmt
    }
  })

  test('fault-injection: forbidden request still runs the batch, list rows never reach the 403', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const outsider = await mintUser(db, kv, 'outsider')
    await seedCommentedSite(db, owner, 'private')
    db.resetCounters()
    const res = await app.request(url('acme', 'doc', '?filePath=index.html'), { headers: auth(outsider) }, env)
    expect(res.status).toBe(403)
    // The list statements executed inside the batch (arity proves it)…
    expect(db.counters.loose).toBe(1)
    expect(db.counters.batches).toBe(1)
    expect(db.counters.batchStmts).toBe(7)
    // …but their rows never reach the response: the body is the bare denial.
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })
})

// --- S9c fixtures shared by T9.4/T9.5 ----------------------------------------------------------

/** A SECOND site (other/doc2, same owner) whose thread + comment must never be reachable through
 *  acme/doc paths — the cross-site relationship-denial fixture. */
async function seedForeignSite(db: ReturnType<typeof makeRouteApp>['db'], ownerId: string) {
  const spaceId = await seedSpace(db, { createdBy: ownerId, slug: 'other' })
  const siteId = await seedSite(db, { spaceId, ownerId, slug: 'doc2', visibility: 'team' })
  const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: ownerId })
  const commentId = await seedComment(db, { threadId, authorId: ownerId, body: 'foreign' })
  return { spaceId, siteId, threadId, commentId }
}

const writes = (db: ReturnType<typeof makeRouteApp>['db']) =>
  db.counters.insert + db.counters.update + db.counters.delete

// Multipart request bits: NO Content-Type header (FormData sets its own boundary; auth() would
// force application/json and break the multipart parse).
const multipartAuth = (id: string) => ({ Authorization: `Bearer tok-${id}`, Origin: APP_URL })
const voiceForm = () => {
  const fd = new FormData()
  fd.set('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'take.webm')
  fd.set('filePath', 'index.html')
  return fd
}

// T9.4 relationship-denial guards (S9c pins). The fused pre-write batch reads target rows
// ALONGSIDE the access facts, so every denial below must stay strictly side-effect-free:
// today's exact status + ZERO D1 writes, zero R2 ops, zero AI calls. comments.test.ts already
// pins most of these statuses; the zero-side-effect half is pinned only here.
describe('comments routes — T9.4 relationship denials are side-effect-free', () => {
  const list = async (ctx: ReturnType<typeof makeRouteApp>, userId: string) =>
    (await ctx.app.request(url('acme', 'doc', '?filePath=index.html'), { headers: auth(userId) }, ctx.env)).json()

  test("reply to another site's thread → 404, zero writes", async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const foreign = await seedForeignSite(db, owner)
    db.resetCounters()
    const res = await app.request(
      url('acme', 'doc', `/${foreign.threadId}/replies`),
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ body: 'hi' }) },
      env,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
    expect(writes(db)).toBe(0)
  })

  test('edit + delete with URL threadId ≠ comment.threadId → 404, zero writes', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const { siteId, commentId } = await seedCommentedSite(db, owner)
    // A second thread on the SAME site: the comment exists, the thread exists, they just don't match.
    const otherThread = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    db.resetCounters()
    for (const init of [
      { method: 'PATCH', body: JSON.stringify({ body: 'x' }) },
      { method: 'DELETE' },
    ]) {
      const res = await app.request(url('acme', 'doc', `/${otherThread}/messages/${commentId}`), { ...init, headers: auth(owner) }, env)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
    expect(writes(db)).toBe(0)
  })

  test("edit + delete a comment from another site's thread (consistent ids) → 404, zero writes", async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    // threadId/commentId agree with each other — only the SITE in the path is wrong.
    const foreign = await seedForeignSite(db, owner)
    db.resetCounters()
    for (const init of [
      { method: 'PATCH', body: JSON.stringify({ body: 'x' }) },
      { method: 'DELETE' },
    ]) {
      const res = await app.request(url('acme', 'doc', `/${foreign.threadId}/messages/${foreign.commentId}`), { ...init, headers: auth(owner) }, env)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
    expect(writes(db)).toBe(0)
  })

  test('non-owner resolve → 403, zero writes, thread stays open', async () => {
    const ctx = makeRouteApp()
    const owner = await mintUser(ctx.db, ctx.kv, 'owner')
    const member = await mintUser(ctx.db, ctx.kv, 'member')
    const { spaceId, threadId } = await seedCommentedSite(ctx.db, owner, 'members')
    await seedMember(ctx.db, spaceId, member)
    ctx.db.resetCounters()
    const res = await ctx.app.request(
      url('acme', 'doc', `/${threadId}`),
      { method: 'PATCH', headers: auth(member), body: JSON.stringify({ status: 'resolved' }) },
      ctx.env,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(writes(ctx.db)).toBe(0)
    const [thread] = await list(ctx, member)
    expect(thread.status).toBe('open')
  })

  test('non-author edit → 403, zero writes, body unchanged', async () => {
    const ctx = makeRouteApp()
    const owner = await mintUser(ctx.db, ctx.kv, 'owner')
    const member = await mintUser(ctx.db, ctx.kv, 'member')
    const { spaceId, threadId, commentId } = await seedCommentedSite(ctx.db, owner, 'members')
    await seedMember(ctx.db, spaceId, member)
    ctx.db.resetCounters()
    const res = await ctx.app.request(
      url('acme', 'doc', `/${threadId}/messages/${commentId}`),
      { method: 'PATCH', headers: auth(member), body: JSON.stringify({ body: 'hijack' }) },
      ctx.env,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(writes(ctx.db)).toBe(0)
    const [thread] = await list(ctx, member)
    expect(thread.comments[0].body).toBe('opening')
    expect(thread.comments[0].editedAt).toBeNull()
  })

  test('outsider voice POST (create + reply) → 403, zero AI calls, zero R2 puts, zero writes', async () => {
    const { app, env, db, kv, r2 } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const outsider = await mintUser(db, kv, 'outsider')
    const { threadId } = await seedCommentedSite(db, owner, 'private')
    let aiCalls = 0
    const aiSpy = {
      ...env,
      AI: {
        run: async () => {
          aiCalls++
          return { text: 'never' }
        },
      },
    } as typeof env
    const r2Before = r2.store.size
    db.resetCounters()
    for (const extra of ['', `/${threadId}/replies`]) {
      const res = await app.request(url('acme', 'doc', extra), { method: 'POST', headers: multipartAuth(outsider), body: voiceForm() }, aiSpy)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
    expect(aiCalls).toBe(0)
    expect(r2.store.size).toBe(r2Before)
    expect(writes(db)).toBe(0)
  })
})

// T9.5 (S9c): every mutation's PRE-WRITE reads are exactly requireAuth's 1 loose read + ONE fused
// db.batch — the 5 access facts plus the URL-id-keyed target rows (thread and/or comment). The
// write, when reached, is the only further request on the response path; notification work runs
// post-response through waitUntil. Denial paths stop at the fused batch, so their counts ARE the
// pre-write shape. The voice-audio GET does no writes: its ENTIRE pre-R2 D1 bill is 2 requests.
describe('comments routes — T9.5 mutations fuse target reads into the access batch', () => {
  const shape = (db: ReturnType<typeof makeRouteApp>['db'], loose: number, batches: number, batchStmts: number) => {
    expect(db.counters.loose).toBe(loose)
    expect(db.counters.batches).toBe(batches)
    expect(db.counters.batchStmts).toBe(batchStmts)
  }

  test('reply = gate + write + notify(reads, 1 insert); denial stops unchanged at the gate', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const commenter = await mintUser(db, kv, 'commenter')
    const { threadId } = await seedCommentedSite(db, owner)
    const foreign = await seedForeignSite(db, owner)
    const reply = (tid: string) =>
      app.request(url('acme', 'doc', `/${tid}/replies`), { method: 'POST', headers: auth(commenter), body: JSON.stringify({ body: 'hi' }) }, env)

    db.resetCounters()
    expect((await reply(threadId)).status).toBe(201)
    // The harness drains post-response waitUntil work inline, so the observed reply shape is auth
    // (1 loose) + gate batch (6) + write batch (2) + notify batch (2) + notification INSERT (loose).
    shape(db, 2, 3, 10)

    db.resetCounters()
    expect((await reply(foreign.threadId)).status).toBe(404)
    shape(db, 1, 1, 6) // pre-write shape exactly: nothing after the fused gate
    expect(writes(db)).toBe(0)
  })

  test('resolve + reopen: gate batch of 6; the status UPDATE is the only post-gate statement', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const { threadId } = await seedCommentedSite(db, owner)
    const patch = (status: string) =>
      app.request(url('acme', 'doc', `/${threadId}`), { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ status }) }, env)

    db.resetCounters()
    expect((await patch('resolved')).status).toBe(200)
    shape(db, 2, 1, 6) // auth read + loose UPDATE; one fused gate batch
    expect(db.counters.update).toBe(1)

    db.resetCounters()
    expect((await patch('open')).status).toBe(200)
    shape(db, 2, 1, 6)
    expect(db.counters.update).toBe(1)
  })

  test('edit: gate batch of 7 (5 facts + comment + thread), then ONLY the write batch of 2', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const { siteId, threadId, commentId } = await seedCommentedSite(db, owner)
    const otherThread = await seedThread(db, { siteId, filePath: 'index.html', createdBy: owner })
    const edit = (tid: string) =>
      app.request(
        url('acme', 'doc', `/${tid}/messages/${commentId}`),
        { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ body: 'edited' }) },
        env,
      )

    db.resetCounters()
    expect((await edit(threadId)).status).toBe(200)
    shape(db, 1, 2, 9) // fused gate (7) + editComment's write batch (2)

    db.resetCounters()
    expect((await edit(otherThread)).status).toBe(404) // threadId ≠ comment.threadId
    shape(db, 1, 1, 7) // pre-write shape exactly
    expect(writes(db)).toBe(0)
  })

  test('delete: gate batch of 7, then ONLY the write batch of 2 (text comment — no R2)', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const { threadId, commentId } = await seedCommentedSite(db, owner)
    db.resetCounters()
    const res = await app.request(url('acme', 'doc', `/${threadId}/messages/${commentId}`), { method: 'DELETE', headers: auth(owner) }, env)
    expect(res.status).toBe(200)
    shape(db, 1, 2, 9)
  })

  test('voice-audio GET: pre-R2 D1 = 2 requests total (1 loose + 1 fused batch of 7), one R2 get', async () => {
    const ctx = makeRouteApp()
    const owner = await mintUser(ctx.db, ctx.kv, 'owner')
    const { threadId } = await seedCommentedSite(ctx.db, owner)
    const audioKey = 'comment-audio/vc1.webm'
    await ctx.r2.put(audioKey, new Uint8Array([1, 2, 3, 4]), { httpMetadata: { contentType: 'audio/webm' } })
    const voiceId = await seedComment(ctx.db, { threadId, authorId: owner, body: 'spoken', audioKey })
    ctx.db.resetCounters()
    const res = await ctx.app.request(url('acme', 'doc', `/audio/${voiceId}`), { headers: auth(owner) }, ctx.env)
    expect(res.status).toBe(200)
    shape(ctx.db, 1, 1, 7) // 5 facts + comment + thread-of-comment; NOTHING else before R2
    expect(ctx.r2.gets()).toBe(1)
  })

  test('voice-audio GET denial matrix → zero R2, same single-batch pre-R2 shape', async () => {
    const ctx = makeRouteApp()
    const owner = await mintUser(ctx.db, ctx.kv, 'owner')
    const outsider = await mintUser(ctx.db, ctx.kv, 'outsider')
    const { threadId } = await seedCommentedSite(ctx.db, owner, 'private')
    const foreign = await seedForeignSite(ctx.db, owner)
    // Audio-bearing comment on the FOREIGN site; deleted-voice + text + live-voice on acme/doc.
    const foreignVoice = await seedComment(ctx.db, { threadId: foreign.threadId, authorId: owner, body: 'x', audioKey: 'comment-audio/f.webm' })
    const deletedVoice = await seedComment(ctx.db, {
      threadId,
      authorId: owner,
      body: 'x',
      audioKey: 'comment-audio/d.webm',
      deletedAt: new Date().toISOString(),
    })
    const textId = await seedComment(ctx.db, { threadId, authorId: owner, body: 'text' })
    const liveVoice = await seedComment(ctx.db, { threadId, authorId: owner, body: 'x', audioKey: 'comment-audio/l.webm' })
    const matrix: [string, string, number][] = [
      [owner, foreignVoice, 404], // comment whose thread lives on ANOTHER site
      [owner, deletedVoice, 404], // soft-deleted voice comment
      [owner, textId, 404], // text comment (no audio)
      [owner, 'cm-missing', 404], // no such comment
      [outsider, liveVoice, 403], // denied site — access refusal wins, target rows never leak
    ]
    for (const [who, id, status] of matrix) {
      ctx.db.resetCounters()
      const res = await ctx.app.request(url('acme', 'doc', `/audio/${id}`), { headers: auth(who) }, ctx.env)
      expect(res.status).toBe(status)
      shape(ctx.db, 1, 1, 7)
    }
    expect(ctx.r2.gets()).toBe(0)
  })
})
