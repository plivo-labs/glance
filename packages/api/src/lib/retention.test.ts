import { describe, expect, test } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { events, notifications, purgedEventCounts } from '../db/schema'
import { makeDb, seedEvent, seedNotification, seedUser } from '../test/harness'
import { cachedStats } from './stats'
import { EVENTS_RETENTION_DAYS, READ_NOTIFICATIONS_RETENTION_DAYS, purgeRetention } from './retention'

const NOW = new Date('2026-08-18T12:00:00.000Z')
const defer = (p: Promise<unknown>) => p.then(() => undefined)
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

describe('purgeRetention', () => {
  test('deletes events older than the retention window, keeps young ones', async () => {
    const db = makeDb()
    const old = await seedEvent(db, { type: 'view', createdAt: daysAgo(EVENTS_RETENTION_DAYS + 1) })
    const young = await seedEvent(db, { type: 'view', createdAt: daysAgo(EVENTS_RETENTION_DAYS - 1) })
    const oldCli = await seedEvent(db, { type: 'cli', action: 'upload', createdAt: daysAgo(EVENTS_RETENTION_DAYS + 1) })

    await purgeRetention(db, NOW)

    const remaining = await db.select({ id: events.id }).from(events)
    const ids = remaining.map((r) => r.id).sort()
    expect(ids).toEqual([young].sort())
    expect(ids).not.toContain(old)
    expect(ids).not.toContain(oldCli)
  })

  test('deletes READ notifications older than 30 days, keeps young reads and ALL unread', async () => {
    const db = makeDb()
    const u = await seedUser(db)
    const oldRead = await seedNotification(db, {
      recipientId: u,
      readAt: daysAgo(READ_NOTIFICATIONS_RETENTION_DAYS + 1),
      createdAt: daysAgo(READ_NOTIFICATIONS_RETENTION_DAYS + 1),
    })
    const youngRead = await seedNotification(db, {
      recipientId: u,
      readAt: daysAgo(1),
      createdAt: daysAgo(READ_NOTIFICATIONS_RETENTION_DAYS - 1),
    })
    const oldUnread = await seedNotification(db, {
      recipientId: u,
      readAt: null,
      createdAt: daysAgo(READ_NOTIFICATIONS_RETENTION_DAYS + 100),
    })

    await purgeRetention(db, NOW)

    const remaining = await db.select({ id: notifications.id }).from(notifications)
    const ids = remaining.map((r) => r.id)
    expect(ids).not.toContain(oldRead)
    expect(ids).toContain(youngRead)
    expect(ids).toContain(oldUnread) // unread survives regardless of age
  })

  test('all-time totals.views is unchanged by a purge — doomed rows are folded into purgedEventCounts', async () => {
    const db = makeDb()
    const u = await seedUser(db)
    await seedEvent(db, { type: 'view', userId: u, createdAt: daysAgo(EVENTS_RETENTION_DAYS + 10) })
    await seedEvent(db, { type: 'view', userId: u, createdAt: daysAgo(EVENTS_RETENTION_DAYS + 5) })
    await seedEvent(db, { type: 'view', userId: u, createdAt: daysAgo(1) })

    const before = await cachedStats(null, db, defer, NOW)
    expect(before.totals.views).toBe(3)

    await purgeRetention(db, NOW)

    const after = await cachedStats(null, db, defer, NOW)
    expect(after.totals.views).toBe(3) // preserved despite 2 rows being physically deleted

    const remainingEvents = await db.select({ n: count() }).from(events).where(eq(events.type, 'view'))
    expect(Number(remainingEvents[0]?.n ?? 0)).toBe(1) // only the young row survives

    const purged = await db
      .select({ n: purgedEventCounts.count })
      .from(purgedEventCounts)
      .where(eq(purgedEventCounts.type, 'view'))
    expect(Number(purged[0]?.n ?? 0)).toBe(2)
  })

  test('running the purge twice accumulates the counter instead of overwriting it', async () => {
    const db = makeDb()
    await seedEvent(db, { type: 'view', createdAt: daysAgo(EVENTS_RETENTION_DAYS + 1) })
    await purgeRetention(db, NOW)

    await seedEvent(db, { type: 'view', createdAt: daysAgo(EVENTS_RETENTION_DAYS + 1) })
    await purgeRetention(db, NOW)

    const purged = await db
      .select({ n: purgedEventCounts.count })
      .from(purgedEventCounts)
      .where(eq(purgedEventCounts.type, 'view'))
    expect(Number(purged[0]?.n ?? 0)).toBe(2)
  })
})
