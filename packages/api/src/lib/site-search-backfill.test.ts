import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { files, sites } from '../db/schema'
import worker from '../index'
import { makeDb, makeKv, makeR2, seedFile, seedSite, seedSpace, seedUser } from '../test/harness'
import { BACKFILL_MAX_FILES, BACKFILL_SITES_PER_TICK, backfillSiteSearch, siteText } from './site-search'

async function world() {
  const db = makeDb()
  const r2 = makeR2()
  const space = await seedSpace(db, { id: 'sp', createdBy: await seedUser(db, { id: 'owner' }) })
  let n = 0
  const site = async (pages: Record<string, string>, indexed = false) => {
    const updatedAt = `2026-01-${String(++n).padStart(2, '0')}T00:00:00.000Z` // later site = newer
    const id = await seedSite(db, { spaceId: space, ownerId: 'owner', slug: `s${n}`, updatedAt })
    for (const [path, text] of Object.entries(pages)) await seedFile(db, r2, id, { path, text, mimeType: path.endsWith('.css') ? 'text/css' : 'text/html' })
    if (indexed) await db.update(sites).set({ searchIndexedAt: updatedAt }).where(eq(sites.id, id))
    return id
  }
  const page = (text: string) => ({ 'index.html': `<p>${text}</p>` })
  const tick = () => backfillSiteSearch(db, r2 as unknown as R2Bucket)
  const row = async (id: string) => (await db.all<{ body: string }>(sql`SELECT body FROM site_text WHERE siteId = ${id}`))[0]?.body ?? null
  const stamp = async (id: string) => (await db.select({ at: sites.searchIndexedAt }).from(sites).where(eq(sites.id, id)))[0]?.at ?? null
  // `onRead` runs before every R2 read, as a concurrent writer would.
  const raceRead = (onRead: () => void) => {
    const realGet = r2.get
    r2.get = ((key: string, opts?: never) => {
      onRead()
      return realGet(key, opts)
    }) as typeof r2.get
  }
  return { db, r2, site, page, tick, row, stamp, raceRead }
}

describe('backfillSiteSearch', () => {
  test('indexes unindexed sites from R2 and stamps them; an empty one is stamped too; indexed ones are left alone', async () => {
    const w = await world()
    const text = await w.site({ ...w.page('old words'), 'a.css': 'body{}' })
    const css = await w.site({ 'a.css': 'body{}' })
    const done = await w.site(w.page('new words'), true)
    await w.db.insert(siteText).values({ siteId: done, body: 'kept as is' })
    expect(await w.tick()).toBe(2)
    expect(await w.row(text)).toBe('old words')
    expect(await w.row(css)).toBeNull()
    expect(await w.stamp(css)).not.toBeNull() // nothing to index, but not retried hourly
    expect(await w.row(done)).toBe('kept as is')
    expect(await w.tick()).toBe(0)
  })

  test('a tick is bounded: at most N sites, at most M R2 reads per site; later ticks finish the rest', async () => {
    const w = await world()
    for (let i = 0; i < BACKFILL_SITES_PER_TICK + 2; i++) await w.site(w.page(`doc ${i}`))
    const wide = await w.site(Object.fromEntries(Array.from({ length: BACKFILL_MAX_FILES + 5 }, (_, i) => [`p${i}.html`, `<p>page ${i}</p>`]))) // newest: leads tick 1
    const before = w.r2.gets()
    expect(await w.tick()).toBe(BACKFILL_SITES_PER_TICK)
    expect(w.r2.gets() - before).toBeLessThanOrEqual(BACKFILL_SITES_PER_TICK * BACKFILL_MAX_FILES)
    expect((await w.row(wide))?.split('\n')).toHaveLength(BACKFILL_MAX_FILES)
    expect(await w.tick()).toBe(3)
  })

  test('a replace that lands while the tick is reading wins: the stale text is never written', async () => {
    const w = await world()
    const id = await w.site(w.page('stale text'))
    // What the owner-replace batch commits: new version, fresh row, stamp.
    w.raceRead(() => {
      void w.db.update(sites).set({ contentVersion: 1, searchIndexedAt: 'x' }).where(eq(sites.id, id)).run()
      void w.db.insert(siteText).values({ siteId: id, body: 'fresh text' }).run()
    })
    await w.tick()
    expect(await w.row(id)).toBe('fresh text')
  })

  test('an editor claim in flight (version bumped, swap not landed yet) makes the tick write nothing', async () => {
    const w = await world()
    const id = await w.site(w.page('stale text'))
    w.raceRead(() => void w.db.update(sites).set({ contentVersion: 1 }).where(eq(sites.id, id)).run())
    await w.tick()
    expect([await w.row(id), await w.stamp(id)]).toEqual([null, null]) // still queued for the swap's batch or the next tick
  })

  test('a site whose read fails stays unindexed for the next tick and does not block the others', async () => {
    const w = await world()
    const bad = await w.site(w.page('bad'))
    const good = await w.site(w.page('good'))
    const badKey = (await w.db.select({ k: files.storageKey }).from(files).where(eq(files.siteId, bad)))[0]?.k
    const realGet = w.r2.get
    w.r2.get = ((key: string, opts?: never) => (key === badKey ? Promise.reject(new Error('r2 down')) : realGet(key, opts))) as typeof w.r2.get
    expect(await w.tick()).toBe(1)
    expect([await w.row(good), await w.stamp(bad)]).toEqual(['good', null])
  })
})

describe('scheduled — search backfill wiring', () => {
  test('the hourly tick runs the backfill; the daily purge tick does not', async () => {
    const empty = async () => ({ results: [], success: true, meta: {} })
    const statement = { bind: () => statement, all: empty, run: empty, raw: async () => [] }
    const run = async (cron: string) => {
      const prepared: string[] = []
      const prepare = (q: string) => {
        prepared.push(q)
        return statement
      }
      const env = { GLANCE_DB: { withSession: () => ({ prepare, getBookmark: () => null }) }, GLANCE_SESSIONS: makeKv() } as never
      await worker.scheduled({ cron, scheduledTime: Date.now() } as never, env, { waitUntil: () => {} } as never)
      return prepared.some((q) => q.includes('"searchIndexedAt" is null'))
    }
    expect([await run('0 * * * *'), await run('0 3 * * *')]).toEqual([true, false])
  })
})
