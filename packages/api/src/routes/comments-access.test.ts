import { describe, expect, test } from 'bun:test'
import { verifyDataToken } from '../lib/data-token'
import { TOKEN_HEADER, WS_PROTOCOL } from '../realtime/protocol'
import { seedComment, seedMember, seedSite, seedSpace, seedThread, seedUserShare } from '../test/harness'
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
// GET list must be exactly: requireAuth's 1 loose user read (parked floor) + ONE fused batch of 8
// statements — 5 slug-keyed access facts + the 2 S8 list statements + the reactions statement.
// Counters reset after seeding so only the request under test is measured.
describe('comments routes — T9.3 GET list = 1 loose read + 1 fused batch of 8', () => {
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
      expect(db.counters.batchStmts).toBe(8) // 5 access facts + threads + comments + reactions
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
    expect(db.counters.batchStmts).toBe(8)
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

  test('reply = gate + write + notify(reads, batched insert); denial stops unchanged at the gate', async () => {
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
    // (1 loose) + gate batch (6) + write batch (2) + notify-read batch (2) + notification batch (1).
    // Even one insert chunk is batched so 10+ recipients can split under D1's 100-param cap in the
    // same round trip.
    shape(db, 1, 4, 11)

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

  // #116 gave delete a branch, so it gets both arms. Its gate batch is 8, not 7: the thread's
  // comment list rides it (id-keyed from the URL like every other fused read), because WHICH delete
  // this is depends on the target's place in that list. Total D1 requests are unchanged either way
  // — 3 — since the branch it feeds writes at most one batch.
  test('delete: gate batch of 8, then ONLY the write — 3 D1 requests on both arms (text comment, no R2)', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const { threadId, commentId } = await seedCommentedSite(db, owner)
    const del = (id: string) =>
      app.request(url('acme', 'doc', `/${threadId}/messages/${id}`), { method: 'DELETE', headers: auth(owner) }, env)

    // A reply present ⇒ the opening is soft-deleted: gate (8) + deleteComment's write batch (2).
    const replyId = await seedComment(db, { threadId, authorId: owner, body: 'a reply' })
    db.resetCounters()
    expect((await del(replyId)).status).toBe(200) // a reply — the hard-delete arm, same write batch
    shape(db, 1, 2, 10)

    // Nothing else left ⇒ the thread goes, in ONE statement (comments cascade off it), so the write
    // is a loose delete rather than a batch. Still 1 + 1 + 1 requests.
    db.resetCounters()
    expect((await del(commentId)).status).toBe(200)
    shape(db, 2, 1, 8)
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

// --- S6: GET .../comments/socket — authenticated WS upgrade for the comments channel -----------
// The highest-risk route in the plan: a mistake here is an IDOR that leaks another site's
// comments. C9 pins every denial status, including a DIRECT comparison against the LIST
// endpoint's status for the same caller/slug — proof the gate cannot drift weaker. C10 pins the
// minted internal token: it is scoped (siteId + caps:[]) and NEVER reaches the browser. The DO's
// own fan-out mechanics are pinned in realtime/site-room.test.ts — this file only checks what the
// WORKER does before (and instead of) addressing it, exactly like data-ws.test.ts does for
// data.ts's twin route.

const HMAC = 'glance-test-comments-socket'
const socketUrl = (space: string, site: string) => `/api/sites/${space}/${site}/comments/socket`
const wsHeaders = (proto?: string) => {
  const headers: Record<string, string> = { Upgrade: 'websocket', Connection: 'Upgrade' }
  if (proto !== undefined) headers['Sec-WebSocket-Protocol'] = proto
  return headers
}

/** A DurableObjectNamespace that records every hop toward the object — so a denial test can prove
 *  the DO was NEVER addressed, not just that the response looked right. Mirrors data-ws.test.ts's
 *  recordingRoom (this route's DO mechanics are pinned there / in site-room.test.ts, not here). */
function recordingRoom(respond: (req: Request) => Response = () => new Response(null, { status: 101 })) {
  const names: string[] = []
  const requests: Request[] = []
  const ns = {
    idFromName(name: string) {
      names.push(name)
      return { name }
    },
    get(_id: { name: string }) {
      return {
        fetch: async (input: Request | string, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(input, init)
          requests.push(req)
          return respond(req)
        },
      }
    },
  }
  return { ns, names, requests }
}

const withRoom = (env: unknown, room: ReturnType<typeof recordingRoom>) =>
  ({ ...(env as object), SITE_ROOM: room.ns, DATA_TOKEN_SECRET: HMAC }) as never

describe('comments routes — S6 GET .../comments/socket (authenticated WS upgrade)', () => {
  test('C9: no Upgrade header → 426, DO never touched', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const room = recordingRoom()
    const res = await app.request(socketUrl('acme', 'doc'), { headers: auth(owner) }, withRoom(env, room))
    expect(res.status).toBe(426)
    expect(room.requests).toHaveLength(0)
  })

  test('C9: no session → 401 (requireAuth), same as an ordinary comments request', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const room = recordingRoom()
    const res = await app.request(socketUrl('acme', 'doc'), { headers: wsHeaders() }, withRoom(env, room))
    expect(res.status).toBe(401)
    expect(room.requests).toHaveLength(0)
  })

  test('C9: a site the caller may not read → the SAME status the LIST endpoint returns, DO never touched', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const outsider = await mintUser(db, kv, 'outsider')
    await seedCommentedSite(db, owner, 'private')
    const room = recordingRoom()
    const listRes = await app.request(url('acme', 'doc'), { headers: auth(outsider) }, env)
    const res = await app.request(
      socketUrl('acme', 'doc'),
      { headers: { ...auth(outsider), ...wsHeaders() } },
      withRoom(env, room),
    )
    expect(listRes.status).toBe(403) // sanity: pins what "the list endpoint's status" concretely is
    expect(res.status).toBe(listRes.status)
    expect(room.requests).toHaveLength(0)
  })

  test('C9: a missing site → the SAME status the LIST endpoint returns, DO never touched', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const room = recordingRoom()
    const listRes = await app.request(url('acme', 'nope'), { headers: auth(owner) }, env)
    const res = await app.request(
      socketUrl('acme', 'nope'),
      { headers: { ...auth(owner), ...wsHeaders() } },
      withRoom(env, room),
    )
    expect(listRes.status).toBe(404)
    expect(res.status).toBe(listRes.status)
    // Status alone doesn't prove THIS route's own gate produced it: an unrouted path also lands
    // on a 404 (Hono's built-in "no handler matched"), which would make this test pass even
    // against a socket route that doesn't exist. That built-in 404 is plain text; `gated()`'s is
    // JSON `{error:'not found'}` — the SAME body the list endpoint's 404 gives — so comparing
    // bodies proves the SAME gate ran, not an accidental status collision.
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.clone().json()).toEqual(await listRes.clone().json())
    expect(room.requests).toHaveLength(0)
  })

  test('C9: an archived site → the SAME status (410) the LIST endpoint returns, DO never touched', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner, 'team', 'archived')
    const room = recordingRoom()
    const listRes = await app.request(url('acme', 'doc'), { headers: auth(owner) }, env)
    const res = await app.request(
      socketUrl('acme', 'doc'),
      { headers: { ...auth(owner), ...wsHeaders() } },
      withRoom(env, room),
    )
    expect(listRes.status).toBe(410)
    expect(res.status).toBe(listRes.status)
    expect(room.requests).toHaveLength(0)
  })

  // Two independent optional bindings guard this route (see comments.ts's own two `!room`/`!secret`
  // checks). A single "one of them is missing" test can't tell the two branches apart — deleting
  // EITHER guard would still leave the other firing and the test green. Pin each bind state alone.
  test('C9: DATA_TOKEN_SECRET set, SITE_ROOM unbound → 503, matching the data route', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const res = await app.request(
      socketUrl('acme', 'doc'),
      { headers: { ...auth(owner), ...wsHeaders() } },
      { ...(env as object), DATA_TOKEN_SECRET: HMAC } as never,
    )
    expect(res.status).toBe(503)
  })

  test('C9: SITE_ROOM bound, DATA_TOKEN_SECRET unbound → 503, matching the data route', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const room = recordingRoom()
    const res = await app.request(
      socketUrl('acme', 'doc'),
      { headers: { ...auth(owner), ...wsHeaders() } },
      { ...(env as object), SITE_ROOM: room.ns } as never,
    )
    expect(res.status).toBe(503)
  })

  test('C10: the minted token is scoped (siteId, caps:[]) and NEVER reaches the browser', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    // A non-owner (userShare) caller, not the owner: owner id and caller id must differ, or a
    // `viewerId: site.ownerId` mutant is indistinguishable from the real `c.get('user').id`.
    const viewer = await mintUser(db, kv, 'viewer')
    const { siteId } = await seedCommentedSite(db, owner, 'private')
    await seedUserShare(db, siteId, viewer)
    const room = recordingRoom()
    const res = await app.request(
      socketUrl('acme', 'doc'),
      // A spoofed x-viewer header claiming to be the owner: the token must ignore it and still
      // pin to the AUTHENTICATED caller, or a `viewerId: header('x-viewer') ?? user.id` mutant
      // (which happens to equal the correct value whenever no such header is sent) survives.
      { headers: { ...auth(viewer), 'x-viewer': owner, ...wsHeaders() } },
      withRoom(env, room),
    )
    expect(res.status).toBe(101)
    expect(room.requests).toHaveLength(1)
    const forwarded = room.requests[0] as Request
    const token = forwarded.headers.get(TOKEN_HEADER)
    expect(token).toBeTruthy()

    const claims = await verifyDataToken(HMAC, token)
    expect(claims?.siteId).toBe(siteId)
    expect(claims?.viewerId).toBe(viewer) // the CALLER, never the owner or a spoofed header
    expect(claims?.caps).toEqual([])
    // TTL pins the 300s revocation window (the reason a short-lived socket credential is
    // acceptable at all: a redial re-runs the access gate, so revoked access dies within 300s).
    // Tolerant, not exact — real wall-clock time elapses between mint and this assertion.
    const nowSec = Math.floor(Date.now() / 1000)
    expect(claims?.exp).toBeGreaterThan(nowSec + 290)
    expect(claims?.exp).toBeLessThanOrEqual(nowSec + 300)

    // Absent from every response header AND the body...
    for (const [, v] of res.headers.entries()) expect(v).not.toContain(token as string)
    expect(await res.text()).not.toContain(token as string)
    // ...and travels only on the DO subrequest's dedicated header, never its URL.
    const carrying = [...forwarded.headers.entries()].filter(([, v]) => v.includes(token as string))
    expect(carrying.map(([k]) => k)).toEqual([TOKEN_HEADER])
    expect(forwarded.url).not.toContain(token as string)
  })

  test('the forwarded DO subrequest carries ?channel=comments — not db, not absent', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const room = recordingRoom()
    await app.request(socketUrl('acme', 'doc'), { headers: { ...auth(owner), ...wsHeaders() } }, withRoom(env, room))
    expect(room.requests).toHaveLength(1)
    const forwarded = room.requests[0] as Request
    expect(new URL(forwarded.url).pathname).toBe('/subscribe')
    expect(new URL(forwarded.url).search).toBe('?channel=comments')
  })

  // `channel=comments` is hard-coded, not read off the request — it is the ONLY wall keeping this
  // socket off the site's document events (readsEveryCreator grants shared-* reads to ANY
  // capability-less viewer, so caps:[] alone does not stop a mis-routed push — see the route's own
  // comment). A caller-supplied `channel` query param must be silently ignored, not forwarded.
  test.each(['db', '', 'garbage'])(
    'a caller-supplied ?channel=%s query param is ignored — the DO still gets channel=comments',
    async (callerChannel) => {
      const { app, env, db, kv } = makeRouteApp()
      const owner = await mintUser(db, kv, 'owner')
      await seedCommentedSite(db, owner)
      const room = recordingRoom()
      await app.request(
        `${socketUrl('acme', 'doc')}?channel=${callerChannel}`,
        { headers: { ...auth(owner), ...wsHeaders() } },
        withRoom(env, room),
      )
      expect(room.requests).toHaveLength(1)
      const forwarded = room.requests[0] as Request
      expect(forwarded.url).toBe('https://site-room/subscribe?channel=comments')
    },
  )

  test('subprotocol negotiation mirrors data.ts: echoed back on the 101 when offered, silent when not', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)

    const offered = await app.request(
      socketUrl('acme', 'doc'),
      { headers: { ...auth(owner), ...wsHeaders(WS_PROTOCOL) } },
      withRoom(env, recordingRoom()),
    )
    expect(offered.status).toBe(101)
    expect(offered.headers.get('Sec-WebSocket-Protocol')).toBe(WS_PROTOCOL)

    const silent = await app.request(
      socketUrl('acme', 'doc'),
      { headers: { ...auth(owner), ...wsHeaders() } },
      withRoom(env, recordingRoom()),
    )
    expect(silent.status).toBe(101)
    expect(silent.headers.get('Sec-WebSocket-Protocol')).toBeNull()
  })

  test('CSWSH: cookie-authed + foreign Origin → 403, DO never touched; cookie-authed + APP_URL ' +
    'Origin (or Sec-Fetch-Site: same-origin) still upgrades', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    await seedCommentedSite(db, owner)
    const room = recordingRoom()
    // Presence of the cookie, not its validity, is the signal (matches requireSameOrigin) — the
    // Bearer token still authenticates the request; a foreign Origin alone must deny it.
    const res = await app.request(
      socketUrl('acme', 'doc'),
      { headers: { ...auth(owner), cookie: '__Host-glance_session=x', Origin: 'https://evil.example.com', ...wsHeaders() } },
      withRoom(env, room),
    )
    expect(res.status).toBe(403)
    expect(room.requests).toHaveLength(0)

    // 'same-site' is NOT 'same-origin': the sandboxed content origin (glance-content.*.workers.dev)
    // shares this app's registrable domain (workers.dev is a public suffix) but is untrusted — a
    // predicate loosened to accept same-site would let that origin ride the session cookie and
    // hijack the socket. isSameOrigin's own doc comment says never to loosen it; pin the refusal.
    // No Origin header (matches the secFetchSite success case below) — Sec-Fetch-Site is the ONLY
    // signal under test; auth()'s Origin: APP_URL would pass the gate on its own and prove nothing.
    const sameSiteRoom = recordingRoom()
    const sameSite = await app.request(
      socketUrl('acme', 'doc'),
      {
        headers: {
          Authorization: `Bearer tok-${owner}`,
          'Content-Type': 'application/json',
          cookie: '__Host-glance_session=x',
          'Sec-Fetch-Site': 'same-site',
          ...wsHeaders(),
        },
      },
      withRoom(env, sameSiteRoom),
    )
    expect(sameSite.status).toBe(403)
    expect(sameSiteRoom.requests).toHaveLength(0)

    const sameOrigin = await app.request(
      socketUrl('acme', 'doc'),
      { headers: { ...auth(owner), cookie: '__Host-glance_session=x', ...wsHeaders() } }, // auth() sets Origin: APP_URL
      withRoom(env, recordingRoom()),
    )
    expect(sameOrigin.status).toBe(101)

    const secFetchSite = await app.request(
      socketUrl('acme', 'doc'),
      {
        headers: {
          Authorization: `Bearer tok-${owner}`,
          'Content-Type': 'application/json',
          cookie: '__Host-glance_session=x',
          'Sec-Fetch-Site': 'same-origin',
          ...wsHeaders(),
        },
      },
      withRoom(env, recordingRoom()),
    )
    expect(secFetchSite.status).toBe(101)
  })

  test('the room is addressed by site.id, never the URL slugs: an identical slug on a DIFFERENT ' +
    'site reaches a DIFFERENT room, and the caller\'s own site always reaches the same one', async () => {
    const { app, env, db, kv } = makeRouteApp()
    const owner = await mintUser(db, kv, 'owner')
    const { siteId: siteA } = await seedCommentedSite(db, owner) // acme/doc
    const spaceB = await seedSpace(db, { createdBy: owner, slug: 'other' })
    const siteB = await seedSite(db, { spaceId: spaceB, ownerId: owner, slug: 'doc', visibility: 'team' })

    const roomA1 = recordingRoom()
    await app.request(socketUrl('acme', 'doc'), { headers: { ...auth(owner), ...wsHeaders() } }, withRoom(env, roomA1))
    const roomA2 = recordingRoom()
    await app.request(socketUrl('acme', 'doc'), { headers: { ...auth(owner), ...wsHeaders() } }, withRoom(env, roomA2))
    const roomB = recordingRoom()
    await app.request(socketUrl('other', 'doc'), { headers: { ...auth(owner), ...wsHeaders() } }, withRoom(env, roomB))

    expect(roomA1.names).toEqual([siteA])
    expect(roomA2.names).toEqual([siteA]) // same site, same slug, same room — every time
    expect(roomB.names).toEqual([siteB]) // same SLUG ("doc"), different site → different room
    expect(siteA).not.toBe(siteB)
  })
})
