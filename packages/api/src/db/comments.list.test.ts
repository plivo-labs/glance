import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { batchAll } from '../lib/d1'
import { makeDb, seedComment, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import { commentThreads, users } from './schema'
import { assembleThreadViews, commentsWithAuthorsBySlugsStmt, resolveThread, threadsWithUsersBySlugsStmt } from './comments'

// S8 — list-path perf rewrite. This file pins today's OUTPUT shape (T8.3), then pins the new
// D1 cost model: each list is ONE db.batch of TWO JOINed statements — no IN(threadIds) /
// IN(userIds) follow-ups, so the D1 bind cap can never be hit by a large thread/author set
// (T8.1, T8.2). Golden vectors (T8.4) freeze the exact ThreadView[] as literals — pinned on the
// SHIPPED slug-keyed statements, composed locally exactly as the GET list route ships them.

// The SHIPPED list path, composed locally: ONE batch of the two slug-keyed statements → pure
// assembler (the route fuses these same statements into its access-facts batch, S9b). The
// harness seeds slug = id, so the seeded space/site ids double as the slug keys below.
async function listThreads(db: DrizzleD1Database, spaceSlug: string, siteSlug: string, filePath?: string) {
  const [threadRows, commentRows] = await batchAll(db, [
    threadsWithUsersBySlugsStmt(db, spaceSlug, siteSlug, filePath),
    commentsWithAuthorsBySlugsStmt(db, spaceSlug, siteSlug, filePath),
  ] as const)
  return assembleThreadViews(threadRows, commentRows)
}
const listSiteThreads = (db: DrizzleD1Database, spaceSlug: string, siteSlug: string) =>
  listThreads(db, spaceSlug, siteSlug)

/** A bare site (no files); threads/comments are wired per spec. */
async function bareSite() {
  const db = makeDb()
  const owner = await seedUser(db, { id: 'owner' })
  const sp = await seedSpace(db, { createdBy: owner })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: owner })
  return { db, owner, sp, siteId }
}

describe('T8.3 pins — deleted users, cross-site isolation, empty threads', () => {
  test('comment author row DELETED (ON DELETE SET NULL path) → author null, body kept', async () => {
    const { db, sp, siteId } = await bareSite()
    const gone = await seedUser(db, { id: 'gone-author', name: 'Gone', email: 'gone@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    await seedComment(db, { threadId, authorId: gone, body: 'left behind' })
    await db.delete(users).where(eq(users.id, gone))

    const [thread] = await listThreads(db, sp, siteId, 'index.html')
    expect(thread.comments[0].author).toBeNull()
    expect(thread.comments[0].body).toBe('left behind')
  })

  test('thread CREATOR deleted, resolver alive → createdByName null, resolvedByName still resolves', async () => {
    const { db, sp, siteId } = await bareSite()
    const creator = await seedUser(db, { id: 'dead-creator', name: 'Dead Creator', email: 'dc@example.com' })
    const resolver = await seedUser(db, { id: 'live-resolver', name: 'Live Resolver', email: 'lr@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page', createdBy: creator })
    await resolveThread(db, threadId, resolver)
    await db.delete(users).where(eq(users.id, creator))

    const [thread] = await listThreads(db, sp, siteId, 'index.html')
    expect(thread.createdByName).toBeNull()
    expect(thread.resolvedByName).toBe('Live Resolver')
  })

  test('thread RESOLVER deleted, creator alive → resolvedByName null, createdByName still resolves', async () => {
    const { db, sp, siteId } = await bareSite()
    const creator = await seedUser(db, { id: 'live-creator', name: 'Live Creator', email: 'lc@example.com' })
    const resolver = await seedUser(db, { id: 'dead-resolver', name: 'Dead Resolver', email: 'dr@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page', createdBy: creator })
    await resolveThread(db, threadId, resolver)
    await db.delete(users).where(eq(users.id, resolver))

    const [thread] = await listThreads(db, sp, siteId, 'index.html')
    expect(thread.resolvedByName).toBeNull()
    expect(thread.createdByName).toBe('Live Creator')
  })

  test('two sites with the SAME filePath → no cross-site bleed in either list', async () => {
    const { db, owner, sp, siteId: siteA } = await bareSite()
    const spB = await seedSpace(db, { createdBy: owner })
    const siteB = await seedSite(db, { spaceId: spB, ownerId: owner })
    const tA = await seedThread(db, { id: 'th-a', siteId: siteA, filePath: 'index.html', anchorType: 'page' })
    const tB = await seedThread(db, { id: 'th-b', siteId: siteB, filePath: 'index.html', anchorType: 'page' })
    await seedComment(db, { threadId: tA, body: 'on A' })
    await seedComment(db, { threadId: tB, body: 'on B' })

    const perFile = await listThreads(db, sp, siteA, 'index.html')
    expect(perFile.map((t) => t.id)).toEqual(['th-a'])
    expect(perFile[0].comments.map((c) => c.body)).toEqual(['on A'])
    const siteWide = await listSiteThreads(db, spB, siteB)
    expect(siteWide.map((t) => t.id)).toEqual(['th-b'])
    expect(siteWide[0].comments.map((c) => c.body)).toEqual(['on B'])
  })

  test('an EMPTY thread beside a populated one → both present, empty carries comments: []', async () => {
    const { db, sp, siteId } = await bareSite()
    await seedThread(db, { id: 'th-full', siteId, filePath: 'index.html', anchorType: 'page' })
    await seedThread(db, { id: 'th-empty', siteId, filePath: 'index.html', anchorType: 'page' })
    await seedComment(db, { threadId: 'th-full', body: 'hello' })

    const threads = await listThreads(db, sp, siteId, 'index.html')
    expect(threads.map((t) => t.id)).toEqual(['th-full', 'th-empty'])
    expect(threads.find((t) => t.id === 'th-empty')!.comments).toEqual([])
    expect(threads.find((t) => t.id === 'th-full')!.comments.map((c) => c.body)).toEqual(['hello'])
  })
})

describe('T8.1 — each list is ONE db.batch of TWO statements', () => {
  test('listThreads: 1 batch, 2 batchStmts, 0 loose', async () => {
    const { db, sp, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'a1', name: 'Author', email: 'a1@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page', createdBy: author })
    await seedComment(db, { threadId, authorId: author, body: 'hi' })
    db.resetCounters()

    const threads = await listThreads(db, sp, siteId, 'index.html')
    expect(threads).toHaveLength(1)
    expect(threads[0].comments[0].author).toBe('Author')
    expect(db.counters).toMatchObject({ batches: 1, batchStmts: 2, loose: 0 })
  })

  test('listSiteThreads: 1 batch, 2 batchStmts, 0 loose', async () => {
    const { db, sp, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'a2', name: 'Author Two', email: 'a2@example.com' })
    const threadId = await seedThread(db, { siteId, filePath: 'b.html', anchorType: 'page', createdBy: author })
    await seedComment(db, { threadId, authorId: author, body: 'hi' })
    db.resetCounters()

    const threads = await listSiteThreads(db, sp, siteId)
    expect(threads).toHaveLength(1)
    expect(threads[0].comments[0].author).toBe('Author Two')
    expect(db.counters).toMatchObject({ batches: 1, batchStmts: 2, loose: 0 })
  })

  test('empty site: still exactly one batch → [] (both lists)', async () => {
    const { db, sp, siteId } = await bareSite()
    db.resetCounters()
    expect(await listThreads(db, sp, siteId, 'index.html')).toEqual([])
    expect(db.counters).toMatchObject({ batches: 1, batchStmts: 2, loose: 0 })
    db.resetCounters()
    expect(await listSiteThreads(db, sp, siteId)).toEqual([])
    expect(db.counters).toMatchObject({ batches: 1, batchStmts: 2, loose: 0 })
  })
})

describe('T8.2 — no IN() bind cap; ordering survives the join', () => {
  test('101 threads x 101 distinct authors on one site list without hitting the D1 bind cap', async () => {
    const { db, sp, siteId } = await bareSite()
    const expectedAuthors: string[] = []
    for (let i = 0; i < 101; i++) {
      const name = `Author ${String(i).padStart(3, '0')}`
      const author = await seedUser(db, { id: `wide-u-${i}`, name, email: `wide-u-${i}@example.com` })
      const threadId = await seedThread(db, {
        id: `wide-th-${i}`,
        siteId,
        filePath: 'index.html',
        anchorType: 'page',
        createdBy: author,
      })
      await seedComment(db, { threadId, authorId: author, body: `comment ${i}` })
      expectedAuthors.push(name)
    }
    db.resetCounters()

    // Old impl: comments IN(101 threadIds) + users IN(101 ids) → harness bind-cap throw.
    const threads = await listSiteThreads(db, sp, siteId)
    expect(threads).toHaveLength(101)
    // Insertion (rowid) order — every thread shares filePath and a near-identical createdAt.
    expect(threads.map((t) => t.id)).toEqual(expectedAuthors.map((_, i) => `wide-th-${i}`))
    expect(threads.map((t) => t.createdByName)).toEqual(expectedAuthors)
    expect(threads.map((t) => t.comments[0].author)).toEqual(expectedAuthors)
  })

  test('thread order (filePath, createdAt, rowid) + same-ms comment insertion order — hand-coded', async () => {
    const { db, sp, siteId } = await bareSite()
    // Insertion order deliberately differs from the expected list order.
    await seedThread(db, { id: 't-b-late', siteId, filePath: 'b.html', anchorType: 'page' }) // rowid 1
    await seedThread(db, { id: 't-a', siteId, filePath: 'a.html', anchorType: 'page' }) // rowid 2
    await seedThread(db, { id: 't-b-early', siteId, filePath: 'b.html', anchorType: 'page' }) // rowid 3
    await seedThread(db, { id: 't-b-tie', siteId, filePath: 'b.html', anchorType: 'page' }) // rowid 4
    await db.update(commentThreads).set({ createdAt: '2026-01-05T00:00:00.000Z' }).where(eq(commentThreads.id, 't-b-late'))
    await db.update(commentThreads).set({ createdAt: '2026-01-09T00:00:00.000Z' }).where(eq(commentThreads.id, 't-a'))
    await db.update(commentThreads).set({ createdAt: '2026-01-01T00:00:00.000Z' }).where(eq(commentThreads.id, 't-b-early'))
    // Ties t-b-late on createdAt; inserted later → rowid puts it AFTER.
    await db.update(commentThreads).set({ createdAt: '2026-01-05T00:00:00.000Z' }).where(eq(commentThreads.id, 't-b-tie'))
    // Two comments in the SAME thread with EQUAL createdAt → insertion (rowid) order.
    const ts = '2026-01-09T12:00:00.000Z'
    await seedComment(db, { threadId: 't-a', body: 'first inserted', createdAt: ts })
    await seedComment(db, { threadId: 't-a', body: 'second inserted', createdAt: ts })

    const threads = await listSiteThreads(db, sp, siteId)
    // a.html first (filePath primary), then b.html by createdAt, rowid breaking the 01-05 tie.
    expect(threads.map((t) => t.id)).toEqual(['t-a', 't-b-early', 't-b-late', 't-b-tie'])
    expect(threads[0].comments.map((c) => c.body)).toEqual(['first inserted', 'second inserted'])
  })
})

describe('T8.4 — golden vectors (expectations frozen as literals)', () => {
  /** Deterministic fixture: fixed ids + timestamps; mixes soft-delete, resolved/open, a missing
   *  (never-inserted) creator, a null-name user, a voice comment, legacy anchor JSON on a text
   *  thread, and an empty element thread. */
  async function goldenSite() {
    const { db, sp, siteId } = await bareSite()
    await seedUser(db, { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com' })
    await seedUser(db, { id: 'u-noname', name: null, email: 'noname@example.com' })

    await seedThread(db, {
      id: 'th-open',
      siteId,
      filePath: 'a.html',
      anchorType: 'text',
      quote: 'q-one',
      // Legacy pre-element JSON still in the column — must NOT leak into the view (anchor: null).
      anchor: { quote: 'old', prefix: 'p', suffix: 's' },
      createdBy: 'u-ada',
    })
    await seedComment(db, {
      id: 'cm-1',
      threadId: 'th-open',
      authorId: 'u-ada',
      body: 'looks wrong',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    await seedComment(db, {
      id: 'cm-2',
      threadId: 'th-open',
      authorId: 'u-noname',
      body: 'redacted secret',
      createdAt: '2026-03-01T01:00:00.000Z',
      editedAt: '2026-03-01T02:00:00.000Z',
      deletedAt: '2026-03-01T06:00:00.000Z',
      audioKey: 'comment-audio/cm-2.webm', // soft-deleted voice: hasAudio must read false
    })

    await seedThread(db, {
      id: 'th-resolved',
      siteId,
      filePath: 'b.html',
      anchorType: 'page',
      createdBy: 'u-ghost', // never inserted → createdByName null (FK-off harness keeps the id)
      status: 'resolved',
      resolvedBy: 'u-noname',
      resolvedAt: '2026-03-03T00:00:00.000Z',
    })
    await seedComment(db, {
      id: 'cm-3',
      threadId: 'th-resolved',
      authorId: null,
      body: 'voice transcript',
      createdAt: '2026-03-02T01:00:00.000Z',
      audioKey: 'comment-audio/cm-3.webm',
    })

    await seedThread(db, {
      id: 'th-empty',
      siteId,
      filePath: 'b.html',
      anchorType: 'element',
      anchor: { selector: '#chart', tag: 'svg', preview: 'Chart', textFallback: 'Rev' },
      createdBy: null,
    })

    // Pin thread timestamps (seedThread leaves them at $defaultFn now).
    const stamp = (id: string, createdAt: string, updatedAt: string) =>
      db.update(commentThreads).set({ createdAt, updatedAt }).where(eq(commentThreads.id, id))
    await stamp('th-open', '2026-03-01T00:00:00.000Z', '2026-03-04T00:00:00.000Z')
    await stamp('th-resolved', '2026-03-02T00:00:00.000Z', '2026-03-03T00:00:00.000Z')
    await stamp('th-empty', '2026-03-05T00:00:00.000Z', '2026-03-05T00:00:00.000Z')
    return { db, sp, siteId }
  }

  const GOLDEN_TH_OPEN = {
    id: 'th-open',
    filePath: 'a.html',
    anchorType: 'text' as const,
    quote: 'q-one',
    anchor: null,
    status: 'open' as const,
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    createdBy: 'u-ada',
    createdByName: 'Ada Lovelace',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    comments: [
      {
        id: 'cm-1',
        authorId: 'u-ada',
        author: 'Ada Lovelace',
        body: 'looks wrong',
        deleted: false,
        hasAudio: false,
        createdAt: '2026-03-01T00:00:00.000Z',
        editedAt: null,
      },
      {
        id: 'cm-2',
        authorId: 'u-noname',
        author: 'noname@example.com', // identity survives soft-delete; name null → email
        body: null, // redacted
        deleted: true,
        hasAudio: false, // audioKey set but deleted → never surfaces
        createdAt: '2026-03-01T01:00:00.000Z',
        editedAt: '2026-03-01T02:00:00.000Z',
      },
    ],
  }

  const GOLDEN_TH_RESOLVED = {
    id: 'th-resolved',
    filePath: 'b.html',
    anchorType: 'page' as const,
    quote: null,
    anchor: null,
    status: 'resolved' as const,
    resolvedBy: 'u-noname',
    resolvedByName: 'noname@example.com',
    resolvedAt: '2026-03-03T00:00:00.000Z',
    createdBy: 'u-ghost',
    createdByName: null, // user row missing
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-03T00:00:00.000Z',
    comments: [
      {
        id: 'cm-3',
        authorId: null,
        author: null,
        body: 'voice transcript',
        deleted: false,
        hasAudio: true,
        createdAt: '2026-03-02T01:00:00.000Z',
        editedAt: null,
      },
    ],
  }

  const GOLDEN_TH_EMPTY = {
    id: 'th-empty',
    filePath: 'b.html',
    anchorType: 'element' as const,
    quote: null,
    anchor: { selector: '#chart', tag: 'svg', preview: 'Chart', textFallback: 'Rev' },
    status: 'open' as const,
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    createdBy: null,
    createdByName: null,
    createdAt: '2026-03-05T00:00:00.000Z',
    updatedAt: '2026-03-05T00:00:00.000Z',
    comments: [],
  }

  test('listSiteThreads: exact ThreadView[] deep-equal', async () => {
    const { db, sp, siteId } = await goldenSite()
    expect(await listSiteThreads(db, sp, siteId)).toEqual([GOLDEN_TH_OPEN, GOLDEN_TH_RESOLVED, GOLDEN_TH_EMPTY])
  })

  test('listThreads(a.html): exact per-file subset deep-equal', async () => {
    const { db, sp, siteId } = await goldenSite()
    expect(await listThreads(db, sp, siteId, 'a.html')).toEqual([GOLDEN_TH_OPEN])
  })
})
