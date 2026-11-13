import { describe, expect, test } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { events, notifications, purgedEventCounts, siteVersionFiles, siteVersions } from '../db/schema'
import { makeDb, makeR2, seedEvent, seedNotification, seedSite, seedSpace, seedUser } from '../test/harness'
import { cachedStats } from './stats'
import {
  EVENTS_RETENTION_DAYS,
  READ_NOTIFICATIONS_RETENTION_DAYS,
  SITE_VERSIONS_KEEP,
  SITE_VERSIONS_RETENTION_DAYS,
  purgeRetention,
  purgeSiteVersions,
} from './retention'

const NOW = new Date('2026-08-18T12:00:00.000Z')
const defer = (p: Promise<unknown>) => p.then(() => undefined)
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

describe('purgeRetention', () => {
  test('deletes old view events, keeps young ones and ALL cli events', async () => {
    const db = makeDb()
    const old = await seedEvent(db, { type: 'view', createdAt: daysAgo(EVENTS_RETENTION_DAYS + 1) })
    const young = await seedEvent(db, { type: 'view', createdAt: daysAgo(EVENTS_RETENTION_DAYS - 1) })
    // cli rows survive any age: /me's hasUsedCli EXISTS probe reads them (purge unblocks with #85).
    const oldCli = await seedEvent(db, { type: 'cli', action: 'upload', createdAt: daysAgo(EVENTS_RETENTION_DAYS + 1) })

    await purgeRetention(db, NOW)

    const remaining = await db.select({ id: events.id }).from(events)
    const ids = remaining.map((r) => r.id).sort()
    expect(ids).toEqual([young, oldCli].sort())
    expect(ids).not.toContain(old)
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

describe('purgeSiteVersions', () => {
  // Two sites, so every spec also proves the ranking is per site. Each version owns one R2 object.
  async function setup() {
    const db = makeDb()
    const r2 = makeR2()
    const u = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: u })
    const a = await seedSite(db, { spaceId: sp, ownerId: u })
    const b = await seedSite(db, { spaceId: sp, ownerId: u })
    const version = async (siteId: string, n: number, createdAt: string) => {
      const id = `${siteId}-v${n}`
      await r2.put(`k/${id}`, 'x')
      await db.insert(siteVersions).values({ id, siteId, version: n, createdAt, fileCount: 1, totalSize: 1 })
      await db.insert(siteVersionFiles).values({ versionId: id, path: 'index.html', storageKey: `k/${id}` })
      return id
    }
    const survivors = async () => (await db.select({ id: siteVersions.id }).from(siteVersions)).map((r) => r.id).sort()
    return { db, r2, a, b, version, survivors }
  }

  test('count: keeps the newest 10 per site and deletes the rest with their R2 objects', async () => {
    const { db, r2, a, b, version, survivors } = await setup()
    const all: string[] = []
    for (let n = 1; n <= SITE_VERSIONS_KEEP + 2; n++) all.push(await version(a, n, daysAgo(20 - n))) // all young
    const other = await version(b, 1, daysAgo(1))

    await purgeSiteVersions(db, r2 as unknown as R2Bucket, NOW)

    expect(await survivors()).toEqual([...all.slice(2), other].sort()) // the two OLDEST of site a are gone
    expect([...r2.store.keys()].sort()).toEqual([...all.slice(2), other].map((id) => `k/${id}`).sort())
    // The file rows cascaded with their versions.
    expect(await db.select().from(siteVersionFiles)).toHaveLength(SITE_VERSIONS_KEEP + 1)
  })

  test('age: deletes versions older than 30 days even when the site is under the count cap', async () => {
    const { db, r2, a, b, version, survivors } = await setup()
    const old = await version(a, 1, daysAgo(SITE_VERSIONS_RETENTION_DAYS + 1))
    const young = await version(a, 2, daysAgo(SITE_VERSIONS_RETENTION_DAYS - 1))
    const lone = await version(b, 1, daysAgo(SITE_VERSIONS_RETENTION_DAYS + 5)) // site b's ONLY version

    await purgeSiteVersions(db, r2 as unknown as R2Bucket, NOW)

    expect(await survivors()).toEqual([young])
    expect(await r2.get(`k/${old}`)).toBeNull()
    expect(await r2.get(`k/${lone}`)).toBeNull()
    expect(await r2.get(`k/${young}`)).not.toBeNull()
  })

  test('a backlog larger than one pass (and the 100-bind cap) is drained across passes', async () => {
    const { db, r2, a, version, survivors } = await setup()
    for (let n = 1; n <= 100; n++) await version(a, n, daysAgo(SITE_VERSIONS_RETENTION_DAYS + 1))

    await purgeSiteVersions(db, r2 as unknown as R2Bucket, NOW)

    expect(await survivors()).toEqual([])
    expect(r2.store.size).toBe(0)
  })

  test('a failing R2 delete keeps the rows, so the next run retries instead of orphaning the objects', async () => {
    const { db, r2, a, version, survivors } = await setup()
    const old = await version(a, 1, daysAgo(SITE_VERSIONS_RETENTION_DAYS + 1))
    const failing = { ...r2, delete: () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket

    await expect(purgeSiteVersions(db, failing, NOW)).rejects.toThrow('r2 down')
    expect(await survivors()).toEqual([old])

    await purgeSiteVersions(db, r2 as unknown as R2Bucket, NOW)
    expect(await survivors()).toEqual([])
    expect(r2.store.size).toBe(0)
  })
})
