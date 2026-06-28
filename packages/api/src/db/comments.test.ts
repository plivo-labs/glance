import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { hashContent } from '../lib/anchor'
import { makeDb, makeR2, seedComment, seedFile, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import { files } from './schema'
import { addComment, createThread, deleteComment, listThreads } from './comments'

// Phase 2 correctness surface: anchor resolution + reconciliation run SERVER-SIDE over trusted
// R2 bytes (never iframe-trusted). Driven directly through the S-D harness.

async function siteWithFile(text: string, path = 'index.html') {
  const db = makeDb()
  const r2 = makeR2()
  const user = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: user })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
  const storageKey = await seedFile(db, r2, siteId, { path, text })
  return { db, r2, user, siteId, storageKey, path }
}

describe('createThread — resolves the anchor server-side', () => {
  test('create-thread-resolves-anchor-server-side: present quote → anchored + contentHash; absent → orphaned', async () => {
    const text = '<p>The quick brown fox jumps.</p>'
    const { db, r2, siteId, user, path } = await siteWithFile(text)

    const ok = await createThread(db, r2, { siteId, filePath: path, createdBy: user, body: 'look here', quote: 'brown fox' })
    expect(ok.anchorStatus).toBe('anchored')
    const [thread] = await listThreads(db, r2, siteId, path)
    expect(thread.contentHash).toBe(await hashContent(text))
    expect(thread.start).not.toBeNull()

    const gone = await createThread(db, r2, { siteId, filePath: path, createdBy: user, body: 'where?', quote: 'not in the document at all' })
    expect(gone.anchorStatus).toBe('orphaned')
  })
})

describe('addComment — flat replies', () => {
  test('reply-appends-flat-row-same-thread: reply lands on the same thread, after the opener', async () => {
    const { db, r2, siteId, user, path } = await siteWithFile('<p>hello world</p>')
    const { threadId } = await createThread(db, r2, { siteId, filePath: path, createdBy: user, body: 'opening', quote: 'hello' })
    await addComment(db, { threadId, authorId: user, body: 'a reply' })
    const [thread] = await listThreads(db, r2, siteId, path)
    expect(thread.comments.map((c) => c.body)).toEqual(['opening', 'a reply'])
  })
})

describe('listThreads — ordering + soft-delete shape', () => {
  test('list-threads-returns-ordered-comments: comments come back in createdAt order', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const user = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: user })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>x</p>' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page', contentHash: await hashContent('<p>x</p>') })
    await seedComment(db, { threadId, body: 'first', createdAt: '2026-01-01T00:00:00.000Z' })
    await seedComment(db, { threadId, body: 'third', createdAt: '2026-01-03T00:00:00.000Z' })
    await seedComment(db, { threadId, body: 'second', createdAt: '2026-01-02T00:00:00.000Z' })
    const [thread] = await listThreads(db, r2, siteId, 'index.html')
    expect(thread.comments.map((c) => c.body)).toEqual(['first', 'second', 'third'])
  })

  test('soft-delete-keeps-thread-shape: deleted comment row stays, body redacted', async () => {
    const { db, r2, siteId, user, path } = await siteWithFile('<p>hi there</p>')
    const { threadId } = await createThread(db, r2, { siteId, filePath: path, createdBy: user, body: 'keep me', quote: 'hi' })
    const replyId = await addComment(db, { threadId, authorId: user, body: 'delete me' })
    await deleteComment(db, replyId)
    const [thread] = await listThreads(db, r2, siteId, path)
    expect(thread.comments).toHaveLength(2)
    const deleted = thread.comments.find((c) => c.id === replyId)!
    expect(deleted.deleted).toBe(true)
    expect(deleted.body).toBeNull()
  })
})

describe('listThreads — server-side reconciliation (hash-gated)', () => {
  test('reconcile-shifted-on-hash-change: relocated quote re-resolves to shifted + new offsets', async () => {
    const v1 = 'Intro paragraph. target phrase here. The end.'
    const { db, r2, siteId, user, path, storageKey } = await siteWithFile(v1)
    await createThread(db, r2, { siteId, filePath: path, createdBy: user, body: 'note', quote: 'target phrase', prefix: 'paragraph. ', suffix: ' here.' })
    const before = (await listThreads(db, r2, siteId, path))[0]
    expect(before.anchorStatus).toBe('anchored')

    // Simulate a redeploy that moves the quote later in the doc.
    const v2 = 'A much longer intro paragraph that pushes things down. target phrase here. The end.'
    await r2.put(storageKey, v2)
    await db.update(files).set({ contentHash: await hashContent(v2) }).where(eq(files.storageKey, storageKey))

    const after = (await listThreads(db, r2, siteId, path))[0]
    expect(after.anchorStatus).toBe('shifted')
    expect(after.start).not.toBe(before.start)
    expect(after.contentHash).toBe(await hashContent(v2))
  })

  test('reconcile-orphaned-when-text-removed: removed quote → orphaned, thread + comments kept', async () => {
    const v1 = 'Intro. delete this sentence entirely. Outro.'
    const { db, r2, siteId, user, path, storageKey } = await siteWithFile(v1)
    const { threadId } = await createThread(db, r2, { siteId, filePath: path, createdBy: user, body: 'note', quote: 'delete this sentence entirely' })
    await addComment(db, { threadId, authorId: user, body: 'a reply that must survive' })

    const v2 = 'Intro. Outro only now, the rest is gone.'
    await r2.put(storageKey, v2)
    await db.update(files).set({ contentHash: await hashContent(v2) }).where(eq(files.storageKey, storageKey))

    const [thread] = await listThreads(db, r2, siteId, path)
    expect(thread.anchorStatus).toBe('orphaned')
    expect(thread.start).toBeNull()
    expect(thread.comments.map((c) => c.body)).toEqual(['note', 'a reply that must survive'])
  })

  test('reconcile-skips-when-hash-unchanged: stored hash == current → no R2 read', async () => {
    const { db, r2, siteId, user, path } = await siteWithFile('<p>stable content fox</p>')
    await createThread(db, r2, { siteId, filePath: path, createdBy: user, body: 'note', quote: 'stable content' })
    const baseline = r2.gets()
    await listThreads(db, r2, siteId, path)
    await listThreads(db, r2, siteId, path)
    expect(r2.gets()).toBe(baseline) // zero-work gate: no further R2 reads
  })
})
