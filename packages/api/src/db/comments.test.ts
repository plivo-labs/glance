import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { makeDb, makeR2, seedComment, seedFile, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import { commentThreads } from './schema'
import { addComment, createThread, deleteComment, getComment, listSiteThreads, listThreads, resolveThread } from './comments'

// Comments repo: create/list/reply/resolve/delete over the S-D harness. Anchors are STORED, not
// resolved — the browser paints them — so there is no server-side reconciliation to test here.

describe('audioKey column (W1-1)', () => {
  test('defaults to null for a plain text comment, and persists when a voice comment sets it', async () => {
    const db = makeDb()
    const user = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: user })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })

    const textId = await seedComment(db, { threadId, body: 'just text' })
    expect((await getComment(db, textId))?.audioKey).toBeNull()

    const voiceId = await seedComment(db, { threadId, body: 'transcript', audioKey: 'comments/audio/abc.webm' })
    expect((await getComment(db, voiceId))?.audioKey).toBe('comments/audio/abc.webm')
  })
})

async function siteWithFile(text: string, path = 'index.html') {
  const db = makeDb()
  const r2 = makeR2()
  const user = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: user })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
  const storageKey = await seedFile(db, r2, siteId, { path, text })
  return { db, r2, user, siteId, storageKey, path }
}

describe('createThread — stores the anchor', () => {
  test('create-thread-stores-anchor: text quote → text thread + normalized quote; absent → page thread', async () => {
    const { db, siteId, user, path } = await siteWithFile('<p>The quick brown fox jumps.</p>')

    await createThread(db, { siteId, filePath: path, createdBy: user, body: 'look here', quote: '  brown fox ' })
    const text = await createThread(db, { siteId, filePath: path, createdBy: user, body: 'no anchor' })

    const threads = await listThreads(db, siteId, path)
    const anchored = threads.find((t) => t.anchorType === 'text')!
    expect(anchored.quote).toBe('brown fox') // normalized (trimmed)
    expect(anchored.anchor).toBeNull() // char: text threads carry no element anchor
    const page = threads.find((t) => t.id === text.threadId)!
    expect(page.anchorType).toBe('page')
    expect(page.quote).toBeNull()
    expect(page.anchor).toBeNull()
  })

  test('create-thread-stores-element-anchor: element anchorType persists selector/tag/preview and reads back', async () => {
    const { db, siteId, user, path } = await siteWithFile('<div id="chart"><svg></svg></div>')

    const { threadId } = await createThread(db, {
      siteId,
      filePath: path,
      createdBy: user,
      body: 'this chart is wrong',
      anchorType: 'element',
      anchor: { selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' },
    })

    const [thread] = await listThreads(db, siteId, path)
    expect(thread.id).toBe(threadId)
    expect(thread.anchorType).toBe('element')
    expect(thread.quote).toBeNull()
    expect(thread.anchor).toEqual({ selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' })
    expect(thread.comments.map((c) => c.body)).toEqual(['this chart is wrong'])
  })
})

describe('addComment — flat replies', () => {
  test('reply-appends-flat-row-same-thread: reply lands on the same thread, after the opener', async () => {
    const { db, siteId, user, path } = await siteWithFile('<p>hello world</p>')
    const { threadId } = await createThread(db, { siteId, filePath: path, createdBy: user, body: 'opening', quote: 'hello' })
    await addComment(db, { threadId, authorId: user, body: 'a reply' })
    const [thread] = await listThreads(db, siteId, path)
    expect(thread.comments.map((c) => c.body)).toEqual(['opening', 'a reply'])
  })
})

describe('listThreads — ordering + soft-delete shape', () => {
  test('list-threads-returns-ordered-comments: comments come back in createdAt order', async () => {
    const db = makeDb()
    const user = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: user })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    await seedComment(db, { threadId, body: 'first', createdAt: '2026-01-01T00:00:00.000Z' })
    await seedComment(db, { threadId, body: 'third', createdAt: '2026-01-03T00:00:00.000Z' })
    await seedComment(db, { threadId, body: 'second', createdAt: '2026-01-02T00:00:00.000Z' })
    const [thread] = await listThreads(db, siteId, 'index.html')
    expect(thread.comments.map((c) => c.body)).toEqual(['first', 'second', 'third'])
  })

  test('same-millisecond-comments-stay-chronological: identical createdAt orders by insertion, not random id', async () => {
    const db = makeDb()
    const user = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: user })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    // All three share the exact same millisecond timestamp — the createdAt tiebreaker decides
    // order. Random-UUID ids would scramble them; the rowid (insertion) tiebreaker must not.
    const ts = '2026-02-02T00:00:00.000Z'
    await seedComment(db, { threadId, body: 'one', createdAt: ts })
    await seedComment(db, { threadId, body: 'two', createdAt: ts })
    await seedComment(db, { threadId, body: 'three', createdAt: ts })
    const [thread] = await listThreads(db, siteId, 'index.html')
    expect(thread.comments.map((c) => c.body)).toEqual(['one', 'two', 'three'])
  })

  test('soft-delete-keeps-thread-shape: deleted comment row stays, body redacted', async () => {
    const { db, siteId, user, path } = await siteWithFile('<p>hi there</p>')
    const { threadId } = await createThread(db, { siteId, filePath: path, createdBy: user, body: 'keep me', quote: 'hi' })
    const replyId = await addComment(db, { threadId, authorId: user, body: 'delete me' })
    await deleteComment(db, threadId, replyId)
    const [thread] = await listThreads(db, siteId, path)
    expect(thread.comments).toHaveLength(2)
    const deleted = thread.comments.find((c) => c.id === replyId)!
    expect(deleted.deleted).toBe(true)
    expect(deleted.body).toBeNull()
  })
})

/** A bare site (no files) so multi-file site-list specs can wire their own threads. */
async function bareSite() {
  const db = makeDb()
  const user = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: user })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
  return { db, user, siteId }
}

describe('listSiteThreads — site-wide listing', () => {
  test('site-list-mixed-files: returns every thread ordered by (filePath, createdAt)', async () => {
    const { db, siteId } = await bareSite()
    await seedThread(db, { id: 'tb1', siteId, filePath: 'b.html', anchorType: 'page' })
    await seedThread(db, { id: 'ta1', siteId, filePath: 'a.html', anchorType: 'page' })
    await seedThread(db, { id: 'tb2', siteId, filePath: 'b.html', anchorType: 'page' })
    // a.html's thread has the LATEST createdAt, yet sorts first → filePath is primary.
    await db.update(commentThreads).set({ createdAt: '2026-01-09T00:00:00.000Z' }).where(eq(commentThreads.id, 'ta1'))
    await db.update(commentThreads).set({ createdAt: '2026-01-02T00:00:00.000Z' }).where(eq(commentThreads.id, 'tb1'))
    await db.update(commentThreads).set({ createdAt: '2026-01-01T00:00:00.000Z' }).where(eq(commentThreads.id, 'tb2'))

    const threads = await listSiteThreads(db, siteId)
    expect(threads.map((t) => t.id)).toEqual(['ta1', 'tb2', 'tb1'])
    expect(threads.map((t) => t.filePath)).toEqual(['a.html', 'b.html', 'b.html'])
  })

  test('site-list-keeps-comments-for-missing-file: a thread for an absent file still lists', async () => {
    const { db, siteId } = await bareSite()
    const ghost = await seedThread(db, {
      siteId,
      filePath: 'ghost.html',
      anchorType: 'text',
      quote: 'ghost quote',
    })
    await seedComment(db, { threadId: ghost, body: 'survives' })

    const threads = await listSiteThreads(db, siteId)
    const t = threads.find((x) => x.filePath === 'ghost.html')!
    expect(t.quote).toBe('ghost quote')
    expect(t.comments.map((c) => c.body)).toEqual(['survives'])
  })
})

describe('author legibility — display name resolution', () => {
  test('author-name-preferred-over-email: comment.author is the user name', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'au1', name: 'Ada Lovelace', email: 'ada@example.com' })
    await createThread(db, { siteId, filePath: 'index.html', createdBy: author, body: 'hi', quote: 'hello' })
    const [thread] = await listThreads(db, siteId, 'index.html')
    expect(thread.comments[0].author).toBe('Ada Lovelace')
  })

  test('author-falls-back-to-email: name null → author is the email', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'au2', name: null, email: 'noname@example.com' })
    await createThread(db, { siteId, filePath: 'index.html', createdBy: author, body: 'hi', quote: 'hello' })
    const [thread] = await listThreads(db, siteId, 'index.html')
    expect(thread.comments[0].author).toBe('noname@example.com')
  })

  test('author-null-when-id-null: a comment with no authorId resolves to null', async () => {
    const { db, siteId } = await bareSite()
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    await seedComment(db, { threadId, body: 'anon', authorId: null })
    const [thread] = await listThreads(db, siteId, 'index.html')
    expect(thread.comments[0].author).toBeNull()
  })

  test('author-null-when-user-missing: dangling authorId resolves to null without throwing', async () => {
    const { db, siteId } = await bareSite()
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    // FK-off harness lets us reference a user that was never inserted.
    await seedComment(db, { threadId, body: 'ghost author', authorId: 'u-does-not-exist' })
    const [thread] = await listThreads(db, siteId, 'index.html')
    expect(thread.comments[0].author).toBeNull()
  })

  test('author-retained-on-soft-delete: deleted comment redacts body but keeps author', async () => {
    const { db, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'au3', name: 'Grace Hopper', email: 'grace@example.com' })
    const { threadId } = await createThread(db, { siteId, filePath: 'index.html', createdBy: author, body: 'keep', quote: 'hello' })
    const replyId = await addComment(db, { threadId, authorId: author, body: 'delete me' })
    await deleteComment(db, threadId, replyId)
    const [thread] = await listThreads(db, siteId, 'index.html')
    const del = thread.comments.find((c) => c.id === replyId)!
    expect(del.body).toBeNull()
    expect(del.author).toBe('Grace Hopper')
  })

  test('thread-createdBy-resolvedBy-names: both actors resolve, raw ids retained', async () => {
    const { db, siteId } = await bareSite()
    const creator = await seedUser(db, { id: 'creator1', name: 'Creator One', email: 'c1@example.com' })
    const resolver = await seedUser(db, { id: 'resolver1', name: null, email: 'resolver@example.com' })
    const { threadId } = await createThread(db, { siteId, filePath: 'index.html', createdBy: creator, body: 'hi', quote: 'hello' })
    await resolveThread(db, threadId, resolver)
    const [thread] = await listThreads(db, siteId, 'index.html')
    expect(thread.createdByName).toBe('Creator One')
    expect(thread.resolvedByName).toBe('resolver@example.com') // name null → email
    expect(thread.createdBy).toBe('creator1')
    expect(thread.resolvedBy).toBe('resolver1')
  })
})
