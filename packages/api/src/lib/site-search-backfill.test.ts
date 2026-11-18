import { describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { files, sites } from '../db/schema'
import worker from '../index'
import { makeDb, makeKv, makeR2, seedFile, seedSite, seedSpace, seedUser } from '../test/harness'
import { batchAll } from './d1'
import { BACKFILL_MAX_ATTEMPTS, BACKFILL_MAX_FILES, BACKFILL_SITES_PER_TICK, READ_BYTES_PER_FILE, SEARCH_SOURCE_BUDGET, backfillSiteSearch, searchRowStmts, siteText } from './site-search'

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
  const tries = async (id: string) => (await db.select({ n: sites.searchAttempts }).from(sites).where(eq(sites.id, id)))[0]?.n
  const stamp = async (id: string) => (await db.select({ at: sites.searchIndexedAt }).from(sites).where(eq(sites.id, id)))[0]?.at ?? null
  // `onRead` runs before every R2 read, as a concurrent writer would.
  const raceRead = (onRead: () => void) => {
    const realGet = r2.get
    r2.get = ((key: string, opts?: never) => {
      onRead()
      return realGet(key, opts)
    }) as typeof r2.get
  }
  // The editor upload's two steps (routes/upload.ts): the CAS claim bumps contentVersion, a later batch
  // swaps the files (fresh R2 keys for ALL of them) and rewrites the index row and stamp.
  const claim = (id: string) => db.update(sites).set({ contentVersion: sql`${sites.contentVersion} + 1` }).where(eq(sites.id, id)).run()
  const swap = async (id: string, html: string, o: { text: string | null; stamp: string | null }) => {
    const storageKey = `swapped-${id}/index.html`
    await r2.put(storageKey, html, { httpMetadata: { contentType: 'text/html' } }) // the route puts to R2 before it swaps
    await batchAll(db, [
      db.delete(files).where(eq(files.siteId, id)),
      db.insert(files).values({ id: `f-${storageKey}`, siteId: id, path: 'index.html', storageKey, mimeType: 'text/html', size: html.length, etag: null }),
      db.update(sites).set({ description: null, searchIndexedAt: o.stamp, searchAttempts: 0 }).where(eq(sites.id, id)),
      ...searchRowStmts(db, id, o.text),
    ])
  }
  // Like raceRead, but `during` runs once, before the first R2 read, and may be async.
  const raceReadOnce = (during: () => Promise<void>) => {
    const realGet = r2.get
    let fired = false
    r2.get = (async (key: string, opts?: never) => {
      if (!fired) {
        fired = true
        await during()
      }
      return realGet(key, opts)
    }) as typeof r2.get
  }
  return { db, r2, site, page, tick, row, stamp, tries, raceRead, claim, swap, raceReadOnce }
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

  test('a site with no files at all is stamped (nothing to read, nothing to gate on)', async () => {
    const w = await world()
    const id = await w.site({})
    expect(await w.tick()).toBe(1)
    expect([await w.row(id), (await w.stamp(id)) === null]).toEqual([null, false])
  })

  // The editor claim bumps contentVersion BEFORE its swap batch, so a tick that starts in between sees the
  // new version over the old files. It indexes them (they are still what is served); the swap then
  // overwrites that row and stamp, so the final state is the new content's. A guard, not a repro.
  test('a tick between an editor claim and its swap is overwritten by the swap', async () => {
    const w = await world()
    const id = await w.site(w.page('old words'))
    w.claim(id)
    await w.tick()
    expect(await w.row(id)).toBe('old words') // the files still served
    await w.swap(id, '<p>new words</p>', { text: 'new words', stamp: 'upload-stamp' })
    expect([await w.row(id), await w.stamp(id)]).toEqual(['new words', 'upload-stamp'])
  })

  // The mirror case: the swap lands while the tick is reading, and its own stamp is NULL (the upload ran
  // out of budget or its indexing failed, so it left the site for the backfill). The claim already moved
  // contentVersion, so the tick's gate still passes, and it would stamp the OLD files' text onto the new
  // content for good.
  test('a swap that lands mid-tick and left the site unstamped is not overwritten by the tick', async () => {
    const w = await world()
    const id = await w.site(w.page('old words'))
    w.claim(id)
    w.raceReadOnce(() => w.swap(id, '<p>new words</p>', { text: null, stamp: null }))
    await w.tick()
    expect([await w.row(id), await w.stamp(id)]).toEqual([null, null]) // still queued, nothing stale written
    await w.tick()
    expect([await w.row(id), await w.stamp(id) === null]).toEqual(['new words', false]) // the next tick reads the new files
  })

  test('a tick reads at most the source budget; a cut site keeps what fit, is charged only if cut alone, and its row never shrinks', async () => {
    const w = await world()
    const small = await w.site(w.page('small'))
    const pad = ' '.repeat(READ_BYTES_PER_FILE)
    const big = await w.site(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}.html`, `<p>big${i}</p>${pad}`]))) // newest: leads the queue
    await w.db.insert(siteText).values({ siteId: big, body: 'short partial row' })
    const before = w.r2.gets()
    expect(await w.tick()).toBe(1) // the budget is gone, so the older site is not touched
    expect(w.r2.gets() - before).toBe(SEARCH_SOURCE_BUDGET / READ_BYTES_PER_FILE)
    expect(await w.row(big)).toBe('big0\nbig1\nbig2\nbig3')
    expect([await w.stamp(big), await w.tries(big), await w.row(small)]).toEqual([null, 1, null])
    await w.db.update(siteText).set({ body: 'a longer partial row than a tick can build' }).where(eq(siteText.siteId, big))
    await w.tick() // `small` goes first now, and takes some of the budget `big` is cut by
    expect(await w.row(small)).toBe('small')
    expect([await w.tries(big), (await w.row(big))?.slice(0, 8)]).toEqual([1, 'a longer'])
  })

  test('a failure is not charged to content a replace swapped in while the tick was reading', async () => {
    const w = await world()
    const id = await w.site(w.page('x'))
    w.raceRead(() => {
      void w.db.update(sites).set({ contentVersion: 1 }).where(eq(sites.id, id)).run()
      throw new Error('r2 down')
    })
    await w.tick()
    expect(await w.tries(id)).toBe(0)
  })

  test('sites that keep failing stop blocking the queue: fewest attempts first, skipped after the cap', async () => {
    const w = await world()
    const good = await w.site(w.page('good')) // oldest, so behind every failing site until the order changes
    const bad = []
    for (let i = 0; i < BACKFILL_SITES_PER_TICK; i++) bad.push(await w.site(w.page(`bad ${i}`)))
    const badKeys = (await w.db.select({ k: files.storageKey }).from(files).where(inArray(files.siteId, bad))).map((r) => r.k)
    let badReads = 0
    const realGet = w.r2.get
    w.r2.get = ((key: string, opts?: never) => {
      if (!badKeys.includes(key)) return realGet(key, opts)
      badReads++
      return Promise.reject(new Error('r2 down'))
    }) as typeof w.r2.get
    await w.tick()
    expect(await w.row(good)).toBeNull() // the four newest took tick 1
    await w.tick()
    expect(await w.row(good)).toBe('good') // tick 2 starts with the site that has no failures
    for (let i = 0; i < BACKFILL_MAX_ATTEMPTS * 2; i++) await w.tick()
    expect(badReads).toBe(bad.length * BACKFILL_MAX_ATTEMPTS) // then each failing site is left alone
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
