import { describe, expect, test } from 'bun:test'
import { makeDb, seedNotification, seedUser } from '../test/harness'
import { createNotifications, listNotifications, markRead } from './notifications'

// Notifications repo over the S-D harness: batch create, recipient-scoped list (+ unread count),
// and mark-read. Pure D1 — no R2, no external calls.

describe('C1 — createNotifications inserts N rows; listNotifications returns them newest-first', () => {
  test('inserts a batch and lists newest-first', async () => {
    const db = makeDb()
    const me = await seedUser(db, { name: 'Me' })
    const actor = await seedUser(db, { name: 'Ava' })
    await createNotifications(db, [
      { recipientId: me, actorId: actor, siteLabel: 's/a', createdAt: '2026-01-01T00:00:00.000Z', snippet: 'first' },
      { recipientId: me, actorId: actor, siteLabel: 's/a', createdAt: '2026-01-02T00:00:00.000Z', snippet: 'second' },
      { recipientId: me, actorId: actor, siteLabel: 's/a', createdAt: '2026-01-03T00:00:00.000Z', snippet: 'third' },
    ])
    const { items } = await listNotifications(db, me)
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
