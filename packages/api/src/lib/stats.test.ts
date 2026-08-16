import { describe, expect, test } from 'bun:test'
import {
  countingKv,
  makeDb,
  seedComment,
  seedEvent,
  seedFile,
  seedSite,
  seedSpace,
  seedThread,
  seedUser,
} from '../test/harness'
import {
  STATS_CACHE_KEY,
  STATS_CACHE_SECONDS,
  STATS_STALE_FACTOR,
  STATS_TOTALS_CACHE_KEY,
  STATS_TOTALS_CACHE_SECONDS,
  cachedStats,
} from './stats'

// A fixed "now" so window math is deterministic. Days are UTC.
const NOW = new Date('2026-07-03T12:00:00.000Z')
const defer = (p: Promise<unknown>) => p.then(() => undefined)
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

describe('stats totals', () => {
  test('counts users, sites, files, storage bytes, live comments', async () => {
    const { db, siteA } = await fixture()
    await seedFile(db, null, siteA, { path: 'a.html', text: 'hello' }) // size 5
    await seedFile(db, null, siteA, { path: 'b.html', text: 'hi' }) // size 2
    const th = await seedThread(db, { siteId: siteA, filePath: 'a.html' })
    await seedComment(db, { threadId: th, body: 'live' })
    await seedComment(db, { threadId: th, body: 'gone', deletedAt: daysAgo(1) }) // soft-deleted → excluded

    const s = await cachedStats(null, db, defer, NOW)
    expect(s.totals.users).toBe(2)
    expect(s.totals.sites).toBe(2)
    expect(s.totals.files).toBe(2)
    expect(s.totals.storageBytes).toBe(7)
    expect(s.totals.comments).toBe(1) // soft-deleted not counted
  })

  test('cli events never inflate views, and unique viewers counts a user once', async () => {
    const { db, u1, u2, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, siteLabel: 'acme/a' })
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, siteLabel: 'acme/a' })
    await seedEvent(db, { type: 'view', userId: u2, siteId: siteA, siteLabel: 'acme/a' })
    // A cli row is still WRITTEN (auth's hasUsedCli probe reads one) — it must not be counted here.
    await seedEvent(db, { type: 'cli', action: 'upload', userId: u1, cliVersion: '1.0.0' })

    const s = await cachedStats(null, db, defer, NOW)
    expect(s.totals.views).toBe(3)
    expect(s.totals.uniqueViewers).toBe(2) // u1 counted once
    // The CLI rollups were dropped: they cost 40% of the dashboard's D1 rows for two unused figures.
    expect('cliInvocations' in s.totals).toBe(false)
  })
})

describe('stats window + series', () => {
  test('activeViewers30d excludes viewers outside the window', async () => {
    const { db, u1, u2, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(2) }) // in window
    await seedEvent(db, { type: 'view', userId: u2, siteId: siteA, createdAt: daysAgo(40) }) // out of window

    const s = await cachedStats(null, db, defer, NOW)
    expect(s.activeViewers30d).toBe(1)
  })

  test('series has 30 zero-filled days, oldest first, with counts landing on the right day', async () => {
    const { db, u1, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(0) })
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(0) })
    await seedEvent(db, { type: 'cli', action: 'upload', userId: u1, createdAt: daysAgo(5) })

    const s = await cachedStats(null, db, defer, NOW)
    expect(s.series).toHaveLength(30)
    expect(s.series[0].date < s.series[29].date).toBe(true) // oldest → newest
    expect(s.series[29].date).toBe('2026-07-03') // today
    expect(s.series[29].views).toBe(2)
    // 5 days ago (index 24) saw ONLY a cli event — no series line may pick it up.
    expect(s.series[24]).toMatchObject({ views: 0, signups: 0, sites: 0, comments: 0 })
    expect('cli' in s.series[24]).toBe(false)
  })
})

describe('stats topSites', () => {
  test('ranks sites by view count within the window', async () => {
    const { db, u1, siteA, siteB } = await fixture()
    for (let i = 0; i < 3; i++) await seedEvent(db, { type: 'view', userId: u1, siteId: siteB, siteLabel: 'acme/b' })
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, siteLabel: 'acme/a' })

    const s = await cachedStats(null, db, defer, NOW)
    expect(s.topSites[0]).toMatchObject({ siteId: siteB, siteLabel: 'acme/b', views: 3 })
    expect(s.topSites[1]).toMatchObject({ siteId: siteA, siteLabel: 'acme/a', views: 1 })
  })
})

describe('cachedStats', () => {
  /** `now` shifted by whole seconds — the knob every staleness test turns. */
  const plus = (seconds: number) => new Date(NOW.getTime() + seconds * 1000)
  const stampOf = (kv: { store: Map<string, string> }, key: string) =>
    JSON.parse(kv.store.get(key) as string).at as number

  test('miss computes and warms BOTH halves; hit serves them with ZERO D1 statements', async () => {
    const { db, u1, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, siteLabel: 'acme/a' })
    const kv = countingKv()

    db.resetCounters()
    const first = await cachedStats(kv, db, defer, NOW)
    expect(first.totals.views).toBe(1)
    expect(kv.ops().put).toBe(2) // totals + window, written separately
    // Each entry MUST carry a server-side expiry — without it a stale rollup lives forever. The
    // hard expiry is the SOFT ttl × the stale factor: the window past which stale stops being served.
    expect(kv.ttls.get(STATS_CACHE_KEY)).toBe(STATS_CACHE_SECONDS * STATS_STALE_FACTOR)
    expect(kv.ttls.get(STATS_TOTALS_CACHE_KEY)).toBe(STATS_TOTALS_CACHE_SECONDS * STATS_STALE_FACTOR)
    expect(db.counters.loose + db.counters.batchStmts).toBeGreaterThan(0)

    // A view landing between the two calls must NOT show up — that staleness is the point.
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, siteLabel: 'acme/a' })
    db.resetCounters()
    const second = await cachedStats(kv, db, defer, NOW)
    expect(second).toEqual(first)
    expect(db.counters.loose + db.counters.batchStmts).toBe(0)
  })

  test('past the soft TTL the window serves STALE, then the background refresh lands', async () => {
    const { db, u1, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(0) })
    const kv = countingKv()
    expect((await cachedStats(kv, db, defer, NOW)).series[29].views).toBe(1)

    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(0) })
    const later = plus(STATS_CACHE_SECONDS + 1)
    // The stale call is the one that must NOT block: it hands back the old number...
    expect((await cachedStats(kv, db, defer, later)).series[29].views).toBe(1)
    // ...and the deferred recompute it kicked off is what the NEXT caller sees.
    expect((await cachedStats(kv, db, defer, later)).series[29].views).toBe(2)
  })

  test('a stale window does NOT drag the all-time totals along — the whole point of the split', async () => {
    const { db, u1, siteA } = await fixture()
    await seedEvent(db, { type: 'view', userId: u1, siteId: siteA, createdAt: daysAgo(0) })
    const kv = countingKv()
    await cachedStats(kv, db, defer, NOW)
    expect(stampOf(kv, STATS_TOTALS_CACHE_KEY)).toBe(NOW.getTime())

    // A new user lands, then the WINDOW ttl lapses while the TOTALS ttl still has ~23h left.
    await seedUser(db, { id: 'u3' })
    const later = plus(STATS_CACHE_SECONDS + 1)
    await cachedStats(kv, db, defer, later)
    const after = await cachedStats(kv, db, defer, later)

    expect(after.totals.users).toBe(2) // u3 not counted: the expensive half was never rescanned
    expect(stampOf(kv, STATS_TOTALS_CACHE_KEY)).toBe(NOW.getTime()) // never rewritten
    expect(stampOf(kv, STATS_CACHE_KEY)).toBe(later.getTime()) // the cheap half did refresh
  })

  test('past its own soft TTL the totals half refreshes too', async () => {
    const { db } = await fixture()
    const kv = countingKv()
    expect((await cachedStats(kv, db, defer, NOW)).totals.users).toBe(2)

    await seedUser(db, { id: 'u3' })
    const nextDay = plus(STATS_TOTALS_CACHE_SECONDS + 1)
    expect((await cachedStats(kv, db, defer, nextDay)).totals.users).toBe(2) // stale served
    expect((await cachedStats(kv, db, defer, nextDay)).totals.users).toBe(3) // refresh landed
  })

  test('a pre-v3 payload with no {at,v} envelope is a miss, not a crash', async () => {
    const { db } = await fixture()
    const kv = countingKv()
    // Exactly what `stats:admin:v2` held: a bare serialized Stats, no stamp to age it by.
    await kv.put(STATS_CACHE_KEY, JSON.stringify({ totals: { users: 99 }, series: [] }), {})
    const stats = await cachedStats(kv, db, defer, NOW)
    expect(stats.totals.users).toBe(2)
    expect(stats.series).toHaveLength(30)
  })

  test('a read that throws still serves fresh stats', async () => {
    const { db } = await fixture()
    const kv = { get: () => Promise.reject(new Error('kv down')), put: () => Promise.resolve() }
    const stats = await cachedStats(kv, db, defer)
    expect(stats.totals.users).toBe(2)
  })

  test('a corrupt entry is a miss, not a 500', async () => {
    const { db } = await fixture()
    const kv = countingKv()
    await kv.put(STATS_CACHE_KEY, 'not json{', {})
    const stats = await cachedStats(kv, db, defer)
    expect(stats.totals.users).toBe(2)
  })

  test('a failed warm never surfaces — the caller still gets stats', async () => {
    const { db } = await fixture()
    const kv = countingKv()
    kv.failNextPut(new Error('kv write failed'))
    const stats = await cachedStats(kv, db, defer)
    expect(stats.totals.sites).toBe(2)
  })

  test('no cache binding computes every call', async () => {
    const { db } = await fixture()
    const stats = await cachedStats(null, db, defer)
    expect(stats.totals.sites).toBe(2)
  })
})
