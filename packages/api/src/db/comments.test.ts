import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { hashContent } from '../lib/anchor'
import { makeDb, makeR2, seedComment, seedFile, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import { commentThreads, files } from './schema'
import { addComment, createThread, deleteComment, listSiteThreads, listThreads, resolveThread } from './comments'

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

    const ok = await createThread(db, r2, {
      siteId,
      filePath: path,
      createdBy: user,
      body: 'look here',
      quote: 'brown fox',
    })
    expect(ok.anchorStatus).toBe('anchored')
    const [thread] = await listThreads(db, r2, siteId, path)
    expect(thread.contentHash).toBe(await hashContent(text))
    expect(thread.start).not.toBeNull()

    const gone = await createThread(db, r2, {
      siteId,
      filePath: path,
      createdBy: user,
      body: 'where?',
      quote: 'not in the document at all',
    })
    expect(gone.anchorStatus).toBe('orphaned')
  })
})

describe('addComment — flat replies', () => {
  test('reply-appends-flat-row-same-thread: reply lands on the same thread, after the opener', async () => {
    const { db, r2, siteId, user, path } = await siteWithFile('<p>hello world</p>')
    const { threadId } = await createThread(db, r2, {
      siteId,
      filePath: path,
      createdBy: user,
      body: 'opening',
      quote: 'hello',
    })
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
    const threadId = await seedThread(db, {
      siteId,
      filePath: 'index.html',
      anchorType: 'page',
      contentHash: await hashContent('<p>x</p>'),
    })
    await seedComment(db, { threadId, body: 'first', createdAt: '2026-01-01T00:00:00.000Z' })
    await seedComment(db, { threadId, body: 'third', createdAt: '2026-01-03T00:00:00.000Z' })
    await seedComment(db, { threadId, body: 'second', createdAt: '2026-01-02T00:00:00.000Z' })
    const [thread] = await listThreads(db, r2, siteId, 'index.html')
    expect(thread.comments.map((c) => c.body)).toEqual(['first', 'second', 'third'])
  })

  test('soft-delete-keeps-thread-shape: deleted comment row stays, body redacted', async () => {
    const { db, r2, siteId, user, path } = await siteWithFile('<p>hi there</p>')
    const { threadId } = await createThread(db, r2, {
      siteId,
      filePath: path,
      createdBy: user,
      body: 'keep me',
      quote: 'hi',
    })
    const replyId = await addComment(db, { threadId, authorId: user, body: 'delete me' })
    await deleteComment(db, threadId, replyId)
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
    await createThread(db, r2, {
      siteId,
      filePath: path,
      createdBy: user,
      body: 'note',
      quote: 'target phrase',
      prefix: 'paragraph. ',
      suffix: ' here.',
    })
    const before = (await listThreads(db, r2, siteId, path))[0]
    expect(before.anchorStatus).toBe('anchored')

    // Simulate a redeploy that moves the quote later in the doc.
    const v2 = 'A much longer intro paragraph that pushes things down. target phrase here. The end.'
    await r2.put(storageKey, v2)
    await db
      .update(files)
      .set({ contentHash: await hashContent(v2) })
      .where(eq(files.storageKey, storageKey))

    const after = (await listThreads(db, r2, siteId, path))[0]
    expect(after.anchorStatus).toBe('shifted')
    expect(after.start).not.toBe(before.start)
    expect(after.contentHash).toBe(await hashContent(v2))
  })

  test('reconcile-orphaned-when-text-removed: removed quote → orphaned, thread + comments kept', async () => {
    const v1 = 'Intro. delete this sentence entirely. Outro.'
    const { db, r2, siteId, user, path, storageKey } = await siteWithFile(v1)
    const { threadId } = await createThread(db, r2, {
      siteId,
      filePath: path,
      createdBy: user,
      body: 'note',
      quote: 'delete this sentence entirely',
    })
    await addComment(db, { threadId, authorId: user, body: 'a reply that must survive' })

    const v2 = 'Intro. Outro only now, the rest is gone.'
    await r2.put(storageKey, v2)
    await db
      .update(files)
      .set({ contentHash: await hashContent(v2) })
      .where(eq(files.storageKey, storageKey))

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

  test('reconcile-restores-after-same-content-reupload: orphaned file returning with identical bytes re-resolves', async () => {
    const text = 'Intro. anchor target sentence. Outro.'
    const { db, r2, siteId, user, path, storageKey } = await siteWithFile(text)
    await createThread(db, r2, {
      siteId,
      filePath: path,
      createdBy: user,
      body: 'note',
      quote: 'anchor target sentence',
    })
    expect((await listThreads(db, r2, siteId, path))[0].anchorStatus).toBe('anchored')

    // File row + object removed (deletion, or a redeploy window) → thread orphans.
    await db.delete(files).where(eq(files.siteId, siteId))
    await r2.delete(storageKey)
    const orphaned = (await listThreads(db, r2, siteId, path))[0]
    expect(orphaned.anchorStatus).toBe('orphaned')
    expect(orphaned.contentHash).toBeNull() // hash cleared so a same-bytes restore isn't skipped

    // Re-upload the SAME bytes (same hash). The thread must re-resolve, not stay stuck orphaned.
    await seedFile(db, r2, siteId, { path, text })
    const restored = (await listThreads(db, r2, siteId, path))[0]
    expect(restored.anchorStatus).toBe('anchored')
    expect(restored.start).not.toBeNull()
  })
})

/** A bare site (no files) so multi-file site-list specs can wire their own files/threads. */
async function bareSite() {
  const db = makeDb()
  const r2 = makeR2()
  const user = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: user })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: user })
  return { db, r2, user, siteId }
}

describe('listSiteThreads — site-wide listing + reconciliation', () => {
  test('site-list-mixed-files: returns every thread ordered by (filePath, createdAt)', async () => {
    const { db, r2, siteId } = await bareSite()
    await seedFile(db, r2, siteId, { path: 'a.html', text: '<p>alpha content</p>' })
    await seedFile(db, r2, siteId, { path: 'b.html', text: '<p>bravo content</p>' })
    // Page threads (no reconcile needed); createdAt set explicitly so secondary sort is provable.
    await seedThread(db, { id: 'tb1', siteId, filePath: 'b.html', anchorType: 'page' })
    await seedThread(db, { id: 'ta1', siteId, filePath: 'a.html', anchorType: 'page' })
    await seedThread(db, { id: 'tb2', siteId, filePath: 'b.html', anchorType: 'page' })
    // a.html's thread has the LATEST createdAt, yet sorts first → filePath is primary.
    await db.update(commentThreads).set({ createdAt: '2026-01-09T00:00:00.000Z' }).where(eq(commentThreads.id, 'ta1'))
    await db.update(commentThreads).set({ createdAt: '2026-01-02T00:00:00.000Z' }).where(eq(commentThreads.id, 'tb1'))
    await db.update(commentThreads).set({ createdAt: '2026-01-01T00:00:00.000Z' }).where(eq(commentThreads.id, 'tb2'))

    const threads = await listSiteThreads(db, r2, siteId)
    expect(threads.map((t) => t.id)).toEqual(['ta1', 'tb2', 'tb1'])
    expect(threads.map((t) => t.filePath)).toEqual(['a.html', 'b.html', 'b.html'])
  })

  test('site-list-unchanged-hashes-zero-r2: repeated site lists do no further R2 reads', async () => {
    const { db, r2, user, siteId } = await bareSite()
    await seedFile(db, r2, siteId, { path: 'a.html', text: '<p>alpha stable content</p>' })
    await seedFile(db, r2, siteId, { path: 'b.html', text: '<p>bravo stable content</p>' })
    await createThread(db, r2, { siteId, filePath: 'a.html', createdBy: user, body: 'na', quote: 'alpha stable' })
    await createThread(db, r2, { siteId, filePath: 'b.html', createdBy: user, body: 'nb', quote: 'bravo stable' })

    await listSiteThreads(db, r2, siteId) // baseline warm
    const baseline = r2.gets()
    await listSiteThreads(db, r2, siteId)
    await listSiteThreads(db, r2, siteId)
    expect(r2.gets()).toBe(baseline) // multi-file zero-work gate
  })

  test('site-list-changed-file-reads-once-isolated: only the changed file is read + reconciled', async () => {
    const { db, r2, user, siteId } = await bareSite()
    const aText = 'Intro a. alpha target phrase here. End a.'
    const keyA = await seedFile(db, r2, siteId, { path: 'a.html', text: aText })
    await seedFile(db, r2, siteId, { path: 'b.html', text: 'Intro b. bravo target phrase here. End b.' })
    await createThread(db, r2, {
      siteId,
      filePath: 'a.html',
      createdBy: user,
      body: 'na',
      quote: 'alpha target phrase',
    })
    await createThread(db, r2, {
      siteId,
      filePath: 'b.html',
      createdBy: user,
      body: 'nb',
      quote: 'bravo target phrase',
    })
    await listSiteThreads(db, r2, siteId) // warm both

    // Change ONLY a.html's bytes + hash.
    const aV2 = 'A much longer intro a that pushes things down. alpha target phrase here. End a.'
    await r2.put(keyA, aV2)
    await db
      .update(files)
      .set({ contentHash: await hashContent(aV2) })
      .where(eq(files.storageKey, keyA))

    const before = r2.gets()
    const threads = await listSiteThreads(db, r2, siteId)
    expect(r2.gets()).toBe(before + 1) // exactly one extra read — a.html only

    const a = threads.find((t) => t.filePath === 'a.html')!
    const b = threads.find((t) => t.filePath === 'b.html')!
    expect(a.anchorStatus).toBe('shifted')
    expect(a.contentHash).toBe(await hashContent(aV2))
    expect(b.anchorStatus).toBe('anchored') // untouched: hash unchanged → not stale → not read
  })

  test('site-list-missing-file-orphans-no-delete: thread for an absent file orphans, comments kept', async () => {
    const { db, r2, siteId } = await bareSite()
    await seedFile(db, r2, siteId, { path: 'present.html', text: '<p>present content</p>' })
    const ghost = await seedThread(db, {
      siteId,
      filePath: 'ghost.html',
      anchorType: 'text',
      anchor: { quote: 'ghost quote', prefix: '', suffix: '' },
      quote: 'ghost quote',
      contentHash: 'deadbeef',
      anchorStatus: 'anchored',
      start: 0,
      end: 11,
    })
    await seedComment(db, { threadId: ghost, body: 'survives' })

    const threads = await listSiteThreads(db, r2, siteId)
    const t = threads.find((x) => x.filePath === 'ghost.html')!
    expect(t.anchorStatus).toBe('orphaned')
    expect(t.start).toBeNull()
    expect(t.comments.map((c) => c.body)).toEqual(['survives']) // never deleted
  })

  test('site-list-same-bytes-restore-reanchors: restoring identical bytes re-anchors an orphan', async () => {
    const { db, r2, user, siteId } = await bareSite()
    const text = 'Intro. anchor target sentence. Outro.'
    const key = await seedFile(db, r2, siteId, { path: 'index.html', text })
    await createThread(db, r2, {
      siteId,
      filePath: 'index.html',
      createdBy: user,
      body: 'note',
      quote: 'anchor target sentence',
    })
    expect((await listSiteThreads(db, r2, siteId))[0].anchorStatus).toBe('anchored')

    await db.delete(files).where(eq(files.siteId, siteId))
    await r2.delete(key)
    const orphaned = (await listSiteThreads(db, r2, siteId))[0]
    expect(orphaned.anchorStatus).toBe('orphaned')
    expect(orphaned.contentHash).toBeNull()

    await seedFile(db, r2, siteId, { path: 'index.html', text })
    const restored = (await listSiteThreads(db, r2, siteId))[0]
    expect(restored.anchorStatus).toBe('anchored')
    expect(restored.start).not.toBeNull()
  })
})

describe('author legibility — display name resolution', () => {
  test('author-name-preferred-over-email: comment.author is the user name', async () => {
    const { db, r2, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'au1', name: 'Ada Lovelace', email: 'ada@example.com' })
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>hello there world</p>' })
    await createThread(db, r2, { siteId, filePath: 'index.html', createdBy: author, body: 'hi', quote: 'hello' })
    const [thread] = await listThreads(db, r2, siteId, 'index.html')
    expect(thread.comments[0].author).toBe('Ada Lovelace')
  })

  test('author-falls-back-to-email: name null → author is the email', async () => {
    const { db, r2, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'au2', name: null, email: 'noname@example.com' })
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>hello there world</p>' })
    await createThread(db, r2, { siteId, filePath: 'index.html', createdBy: author, body: 'hi', quote: 'hello' })
    const [thread] = await listThreads(db, r2, siteId, 'index.html')
    expect(thread.comments[0].author).toBe('noname@example.com')
  })

  test('author-null-when-id-null: a comment with no authorId resolves to null', async () => {
    const { db, r2, siteId } = await bareSite()
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>x</p>' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    await seedComment(db, { threadId, body: 'anon', authorId: null })
    const [thread] = await listThreads(db, r2, siteId, 'index.html')
    expect(thread.comments[0].author).toBeNull()
  })

  test('author-null-when-user-missing: dangling authorId resolves to null without throwing', async () => {
    const { db, r2, siteId } = await bareSite()
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>x</p>' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', anchorType: 'page' })
    // FK-off harness lets us reference a user that was never inserted.
    await seedComment(db, { threadId, body: 'ghost author', authorId: 'u-does-not-exist' })
    const [thread] = await listThreads(db, r2, siteId, 'index.html')
    expect(thread.comments[0].author).toBeNull()
  })

  test('author-retained-on-soft-delete: deleted comment redacts body but keeps author', async () => {
    const { db, r2, siteId } = await bareSite()
    const author = await seedUser(db, { id: 'au3', name: 'Grace Hopper', email: 'grace@example.com' })
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>hello there</p>' })
    const { threadId } = await createThread(db, r2, {
      siteId,
      filePath: 'index.html',
      createdBy: author,
      body: 'keep',
      quote: 'hello',
    })
    const replyId = await addComment(db, { threadId, authorId: author, body: 'delete me' })
    await deleteComment(db, threadId, replyId)
    const [thread] = await listThreads(db, r2, siteId, 'index.html')
    const del = thread.comments.find((c) => c.id === replyId)!
    expect(del.body).toBeNull()
    expect(del.author).toBe('Grace Hopper')
  })

  test('thread-createdBy-resolvedBy-names: both actors resolve, raw ids retained', async () => {
    const { db, r2, siteId } = await bareSite()
    const creator = await seedUser(db, { id: 'creator1', name: 'Creator One', email: 'c1@example.com' })
    const resolver = await seedUser(db, { id: 'resolver1', name: null, email: 'resolver@example.com' })
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>hello there</p>' })
    const { threadId } = await createThread(db, r2, {
      siteId,
      filePath: 'index.html',
      createdBy: creator,
      body: 'hi',
      quote: 'hello',
    })
    await resolveThread(db, threadId, resolver)
    const [thread] = await listThreads(db, r2, siteId, 'index.html')
    expect(thread.createdByName).toBe('Creator One')
    expect(thread.resolvedByName).toBe('resolver@example.com') // name null → email
    expect(thread.createdBy).toBe('creator1')
    expect(thread.resolvedBy).toBe('resolver1')
  })
})
