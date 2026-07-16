import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  makeDb,
  seedComment,
  seedMember,
  seedNotification,
  seedSite,
  seedSpace,
  seedThread,
  seedUser,
} from '../test/harness'
import { createNotifications, listNotifications, markRead, resolveCommentAudience } from './notifications'
import { comments } from './schema'

// Notifications repo over the S-D harness: batch create, recipient-scoped list (+ unread count),
// and mark-read. Pure D1 — no R2, no external calls.

describe('C1 — createNotifications inserts N rows; listNotifications returns them newest-first', () => {
  test('inserts a batch and lists newest-first', async () => {
    const db = makeDb()
    const me = await seedUser(db, { name: 'Me' })
    const actor = await seedUser(db, { name: 'Ava' })
    await createNotifications(db, [
      { recipientId: me, type: 'mention', actorId: actor, siteLabel: 's/a', snippet: 'first' },
      { recipientId: me, type: 'mention', actorId: actor, siteLabel: 's/a', snippet: 'second' },
      { recipientId: me, type: 'mention', actorId: actor, siteLabel: 's/a', snippet: 'third' },
    ])
    // The single multi-values insert gives these rows the same millisecond timestamp; newest-first
    // is therefore made deterministic by listNotifications' rowid-desc tiebreaker.
    const { items } = await listNotifications(db, me)
    expect(new Set(items.map((n) => n.createdAt)).size).toBe(1)
    expect(items.map((n) => n.snippet)).toEqual(['third', 'second', 'first'])
    expect(items[0].type).toBe('mention')
    expect(items[0].actorName).toBe('Ava')
    expect(items[0].read).toBe(false)
  })

  test('empty batch is a no-op', async () => {
    const db = makeDb()
    const me = await seedUser(db)
    await createNotifications(db, [])
    const { items, unreadCount } = await listNotifications(db, me)
    expect(items).toEqual([])
    expect(unreadCount).toBe(0)
  })

  test('ten recipients stay under D1 bind limits via two inserts in one batch', async () => {
    const db = makeDb()
    const recipients: string[] = []
    for (let i = 0; i < 10; i++) recipients.push(await seedUser(db))
    db.resetCounters()

    await createNotifications(
      db,
      recipients.map((recipientId) => ({ recipientId, type: 'comment' })),
    )

    expect(db.counters).toEqual({ batches: 1, loose: 0, batchStmts: 2, insert: 2, update: 0, delete: 0 })
    const listed = await Promise.all(recipients.map((recipientId) => listNotifications(db, recipientId)))
    expect(listed.every(({ items }) => items.length === 1)).toBe(true)
  })
})

describe('C2 — unreadCount counts only readAt IS NULL', () => {
  test('read rows are excluded from the count but not the list', async () => {
    const db = makeDb()
    const me = await seedUser(db)
    await seedNotification(db, { recipientId: me, readAt: null })
    await seedNotification(db, { recipientId: me, readAt: null })
    await seedNotification(db, { recipientId: me, readAt: '2026-01-01T00:00:00.000Z' })
    const { items, unreadCount } = await listNotifications(db, me)
    expect(items.length).toBe(3)
    expect(unreadCount).toBe(2)
  })
})

describe('C3 — markRead clears all (default) or one (by id)', () => {
  test('markRead(userId) flips every unread row to read', async () => {
    const db = makeDb()
    const me = await seedUser(db)
    await seedNotification(db, { recipientId: me })
    await seedNotification(db, { recipientId: me })
    await markRead(db, me)
    const { unreadCount } = await listNotifications(db, me)
    expect(unreadCount).toBe(0)
  })

  test('markRead(userId, [id]) flips only that row', async () => {
    const db = makeDb()
    const me = await seedUser(db)
    const a = await seedNotification(db, { recipientId: me, id: 'nt-a' })
    await seedNotification(db, { recipientId: me, id: 'nt-b' })
    await markRead(db, me, [a])
    const { items, unreadCount } = await listNotifications(db, me)
    expect(unreadCount).toBe(1)
    expect(items.find((n) => n.id === 'nt-a')?.read).toBe(true)
    expect(items.find((n) => n.id === 'nt-b')?.read).toBe(false)
  })
})

describe('C4 — list/markRead are recipient-scoped', () => {
  test('list returns only the caller rows', async () => {
    const db = makeDb()
    const me = await seedUser(db)
    const other = await seedUser(db)
    await seedNotification(db, { recipientId: me })
    await seedNotification(db, { recipientId: other })
    const mine = await listNotifications(db, me)
    expect(mine.items.length).toBe(1)
    expect(mine.unreadCount).toBe(1)
  })

  test('markRead never touches another user rows', async () => {
    const db = makeDb()
    const me = await seedUser(db)
    const other = await seedUser(db)
    const theirs = await seedNotification(db, { recipientId: other, id: 'nt-theirs' })
    await markRead(db, me) // default-all, but scoped to me
    await markRead(db, me, [theirs]) // even naming their id must not cross the boundary
    const { unreadCount } = await listNotifications(db, other)
    expect(unreadCount).toBe(1)
  })
})

describe('comment audience stays within D1 bind limits', () => {
  test('resolves one hundred member participants in bounded access-fact statements', async () => {
    const db = makeDb()
    const ownerId = await seedUser(db)
    const spaceId = await seedSpace(db, { createdBy: ownerId })
    const siteId = await seedSite(db, { spaceId, ownerId, visibility: 'members' })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: ownerId })
    const participants: string[] = []
    for (let i = 0; i < 100; i++) {
      const participant = await seedUser(db)
      participants.push(participant)
      await seedMember(db, spaceId, participant)
      await seedComment(db, { threadId, authorId: participant })
    }

    const audience = await resolveCommentAudience(
      db,
      { id: siteId, spaceId, ownerId, visibility: 'members', status: 'active' },
      { threadId, isReply: true, exclude: new Set([ownerId]) },
    )

    expect(new Set(audience)).toEqual(new Set(participants))
  })
})

describe('S1 — createNotifications persists type comment + commentId; comment delete nulls commentId', () => {
  test('S1 — createNotifications persists type comment + commentId; comment delete nulls commentId', async () => {
    const db = makeDb()
    const me = await seedUser(db, { name: 'Me' })
    const actor = await seedUser(db, { name: 'Ava' })
    const spaceId = await seedSpace(db, { createdBy: actor })
    const siteId = await seedSite(db, { spaceId, ownerId: actor })
    const threadId = await seedThread(db, { siteId, filePath: 'index.html', createdBy: actor })
    const commentId = await seedComment(db, { threadId, authorId: actor, body: 'hey' })
    await createNotifications(db, [
      {
        recipientId: me,
        type: 'comment',
        actorId: actor,
        siteId,
        siteLabel: 'sp/site',
        threadId,
        commentId,
        snippet: 'hey',
      },
    ])
    const { items } = await listNotifications(db, me)
    expect(items[0].type).toBe('comment')
    expect(items[0].commentId).toBe(commentId)

    await db.delete(comments).where(eq(comments.id, commentId))
    const after = await listNotifications(db, me)
    expect(after.items.length).toBe(1)
    expect(after.items[0].commentId).toBeNull()
  })
})
