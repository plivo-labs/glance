import { describe, expect, test } from 'bun:test'
import { makeDb, seedComment, seedEvent, seedFile, seedSite, seedSpace, seedThread, seedUser } from '../test/harness'
import { computeStats } from './stats'

// A fixed "now" so window math is deterministic. Days are UTC.
const NOW = new Date('2026-07-03T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

async function fixture() {
  const db = makeDb()
  const u1 = await seedUser(db, { id: 'u1' })
  const u2 = await seedUser(db, { id: 'u2' })
  const sp = await seedSpace(db, { createdBy: u1, slug: 'acme' })
  const siteA = await seedSite(db, { id: 'siteA', spaceId: sp, ownerId: u1, slug: 'a' })
  const siteB = await seedSite(db, { id: 'siteB', spaceId: sp, ownerId: u1, slug: 'b' })
  return { db, u1, u2, sp, siteA, siteB }
}

describe('computeStats totals', () => {
  test('counts users, sites, files, storage bytes, live comments', async () => {
    const { db, siteA } = await fixture()
    await seedFile(db, null, siteA, { path: 'a.html', text: 'hello' }) // size 5
    await seedFile(db, null, siteA, { path: 'b.html', text: 'hi' }) // size 2
    const th = await seedThread(db, { siteId: siteA, filePath: 'a.html' })
    await seedComment(db, { threadId: th, body: 'live' })
    await seedComment(db, { threadId: th, body: 'gone', deletedAt: daysAgo(1) }) // soft-deleted → excluded

    const s = await computeStats(db, NOW)
    expect(s.totals.users).toBe(2)
    expect(s.totals.sites).toBe(2)
    expect(s.totals.files).toBe(2)
    expect(s.totals.storageBytes).toBe(7)
    expect(s.totals.comments).toBe(1) // soft-deleted not counted
  })

  test('views vs cli events, and unique viewers (distinct userId)', async () => {
    const { db, u1, u2, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, siteLabel: 'acme/a' })
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, siteLabel: 'acme/a' })
    await seedEvent(db, { type: 'view', userId: u2, siteId: siteA, siteLabel: 'acme/a' })
    await seedEvent(db, { type: 'cli', action: 'upload', userId: u1, cliVersion: '1.0.0' })

    const s = await computeStats(db, NOW)
    expect(s.totals.views).toBe(3)
    expect(s.totals.cliInvocations).toBe(1)
    expect(s.totals.uniqueViewers).toBe(2) // u1 counted once
  })
})

describe('computeStats window + series', () => {
  test('activeViewers30d excludes viewers outside the window', async () => {
    const { db, u1, u2, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(2) }) // in window
    await seedEvent(db, { type: 'view', userId: u2, siteId: siteA, createdAt: daysAgo(40) }) // out of window

    const s = await computeStats(db, NOW)
    expect(s.activeViewers30d).toBe(1)
  })

  test('series has 30 zero-filled days, oldest first, with counts landing on the right day', async () => {
    const { db, u1, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(0) })
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(0) })
    await seedEvent(db, { type: 'cli', action: 'upload', userId: u1, createdAt: daysAgo(5) })

    const s = await computeStats(db, NOW)
    expect(s.series).toHaveLength(30)
    expect(s.series[0].date < s.series[29].date).toBe(true) // oldest → newest
    expect(s.series[29].date).toBe('2026-07-03') // today
    expect(s.series[29].views).toBe(2)
    expect(s.series[24].cli).toBe(1) // 5 days ago = index 24
  })
})

describe('computeStats topSites', () => {
  test('ranks sites by view count within the window', async () => {
    const { db, u1, siteA, siteB } = await fixture()
    for (let i = 0; i < 3; i++) await seedEvent(db, { type: 'view', userId: u1, siteId: siteB, siteLabel: 'acme/b' })
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, siteLabel: 'acme/a' })

    const s = await computeStats(db, NOW)
    expect(s.topSites[0]).toMatchObject({ siteId: siteB, siteLabel: 'acme/b', views: 3 })
    expect(s.topSites[1]).toMatchObject({ siteId: siteA, siteLabel: 'acme/a', views: 1 })
  })
})
