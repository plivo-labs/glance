import { describe, expect, test } from 'bun:test'
import { makeDb, seedEvent, seedSite, seedSpace, seedUser } from '../test/harness'
import { computeSiteInsights } from './site-insights'

const NOW = new Date('2026-07-30T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

async function fixture() {
  const db = makeDb()
  const owner = await seedUser(db, { id: 'owner' })
  await seedUser(db, { id: 'u2' })
  const spaceId = await seedSpace(db, { createdBy: owner, slug: 'acme' })
  const siteId = await seedSite(db, { id: 'site', spaceId, ownerId: owner, slug: 'doc' })
  const otherId = await seedSite(db, { id: 'other', spaceId, ownerId: owner, slug: 'other' })
  return { db, siteId, otherId }
}

describe('computeSiteInsights', () => {
  test('zero-fills all 30 UTC days, oldest first, and puts views on their day', async () => {
    const { db, siteId } = await fixture()
    await seedEvent(db, { siteId, userId: 'owner', action: 'index.html', createdAt: daysAgo(0) })
    await seedEvent(db, { siteId, userId: 'owner', action: 'index.html', createdAt: daysAgo(29) })
    const r = await computeSiteInsights(db, siteId, NOW)
    expect(r.days).toBe(30)
    expect(r.series).toHaveLength(30)
    expect(r.series[0]).toEqual({ date: '2026-07-01', views: 1 })
    expect(r.series[29]).toEqual({ date: '2026-07-30', views: 1 })
    expect(r.series.slice(1, 29).every((p) => p.views === 0)).toBe(true)
    expect((await computeSiteInsights(db, 'nobody', NOW)).series.every((p) => p.views === 0)).toBe(true)
  })

  test('total counts every view, unique counts distinct signed-in viewers', async () => {
    const { db, siteId } = await fixture()
    for (const userId of ['owner', 'owner', 'owner', 'u2']) {
      await seedEvent(db, { siteId, userId, action: 'index.html', createdAt: daysAgo(1) })
    }
    const r = await computeSiteInsights(db, siteId, NOW)
    expect(r.totalViews).toBe(4)
    expect(r.uniqueViewers).toBe(2)
    expect(r.series.reduce((n, p) => n + p.views, 0)).toBe(r.totalViews)
  })

  test('splits views per path, busiest first, capped at 10', async () => {
    const { db, siteId } = await fixture()
    for (const action of ['a.html', 'b.html', 'b.html', 'c.html', 'c.html', 'c.html']) {
      await seedEvent(db, { siteId, userId: 'u2', action, createdAt: daysAgo(2) })
    }
    expect((await computeSiteInsights(db, siteId, NOW)).pages).toEqual([
      { path: 'c.html', views: 3 },
      { path: 'b.html', views: 2 },
      { path: 'a.html', views: 1 },
    ])
    for (let i = 0; i < 12; i++) await seedEvent(db, { siteId, action: `p${i}.html`, createdAt: daysAgo(2) })
    expect((await computeSiteInsights(db, siteId, NOW)).pages).toHaveLength(10)
  })

  test('ignores other sites, cli events, and views older than the window', async () => {
    const { db, siteId, otherId } = await fixture()
    await seedEvent(db, { siteId: otherId, userId: 'u2', action: 'x.html', createdAt: daysAgo(1) })
    await seedEvent(db, { siteId, type: 'cli', userId: 'u2', action: 'upload', createdAt: daysAgo(1) })
    await seedEvent(db, { siteId, userId: 'u2', action: 'old.html', createdAt: daysAgo(30) })
    const r = await computeSiteInsights(db, siteId, NOW)
    expect(r).toMatchObject({ totalViews: 0, uniqueViewers: 0, pages: [] })
  })
})
