// S2+S3 — the storage-serving tail of content serve(): a Range request costs ONE ranged R2
// get (no full+ranged double get), and full-200 reads of immutable objects go through the
// workers Cache API (keyed by the encoded storageKey; live D1 auth ALWAYS precedes any byte
// work). Pins first (T2.5 — writable pre-fix), then the op-count specs.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { storageCacheKey } from './content'
import { events, files, siteUserShares, sites, users } from './db/schema'
import { type FileSpec, mintToken, setup, teamSite } from './test/content-fixtures'
import { seedFile, seedMember, seedSite, seedSpace, seedUser, seedUserShare } from './test/harness'

const BODY = '0123456789ABCDEF' // 16 bytes — easy to reason about offsets

type Setup = ReturnType<typeof setup>

/** One flat snapshot of every byte-op counter (R2 kinds + cache), for exact `===` deltas. */
function ops(s: Setup) {
  const o = s.r2.ops()
  const c = s.caches.counters
  return { full: o.full, ranged: o.ranged, head: o.head, matches: c.matches, puts: c.puts, hits: c.hits, misses: c.misses }
}
type Ops = ReturnType<typeof ops>
const diff = (before: Ops, after: Ops): Ops =>
  Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k as keyof Ops]])) as Ops

/** Byte-op delta produced by a single request. */
async function opsOf(s: Setup, request: () => Promise<unknown>): Promise<Ops> {
  const before = ops(s)
  await request()
  return diff(before, ops(s))
}

// Exact op shapes, named once and reused (tight `toEqual` — every counter pinned).
const NO_OPS: Ops = { full: 0, ranged: 0, head: 0, matches: 0, puts: 0, hits: 0, misses: 0 }
const ONE_RANGED: Ops = { ...NO_OPS, ranged: 1 } // satisfiable Range, size known: ONE ranged get, cache untouched
const HEAD_ONLY: Ops = { ...NO_OPS, head: 1 } // etag resolved by a head probe, zero body bytes
const COLD_FULL: Ops = { ...NO_OPS, full: 1, matches: 1, misses: 1, puts: 1 } // cache miss → one full get + warm
const WARM_HIT: Ops = { ...NO_OPS, matches: 1, hits: 1 } // served from cache, zero R2
const RAW_FULL: Ops = { ...NO_OPS, full: 1 } // raw=1: direct full get, cache never touched

const get = (s: Setup, token: string, path: string, headers: Record<string, string> = {}) =>
  s.app.request(`/_t/${token}/sp/site/${path}`, { headers }, s.env)

const etagOf = (s: Setup, storageKey: string) => s.r2.store.get(storageKey)?.httpEtag as string

// ---------------------------------------------------------------------------------------------
// T2.5 [pin — writable today] rangeable boundaries: all non-HTML files range; HTML never does;
// markdown and ?raw=1 return BEFORE range handling (a Range header on them is ignored).
// ---------------------------------------------------------------------------------------------
describe('T2.5 rangeable pins', () => {
  const binary = (path: string): FileSpec => ({ path, text: BODY, mimeType: 'application/octet-stream' })

  test.each(['report.pdf', 'style.css', 'img.png'])('%s advertises accept-ranges and honors 206', async (path) => {
    const s = setup()
    const { token } = await teamSite(s, [binary(path)])
    const full = await get(s, token, path)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    const res = await get(s, token, path, { range: 'bytes=0-3' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-3/${BODY.length}`)
    expect(await res.text()).toBe('0123')
  })

  test('uppercase .HTML is NOT rangeable: no accept-ranges, Range ignored, 200 full body', async () => {
    const s = setup()
    const { token } = await teamSite(s, [{ path: 'PAGE.HTML', text: '<h1>hi</h1>' }])
    const res = await get(s, token, 'PAGE.HTML', { range: 'bytes=0-3' })
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBeNull()
    expect(res.headers.get('content-range')).toBeNull()
    expect(await res.text()).toBe('<h1>hi</h1>')
  })

  test('markdown returns before range handling: Range on a .md is ignored (200 rendered)', async () => {
    const s = setup()
    const { token } = await teamSite(s, [{ path: 'doc.md', text: '# Title', mimeType: 'text/markdown' }])
    const res = await get(s, token, 'doc.md', { range: 'bytes=0-3' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-range')).toBeNull()
    expect(res.headers.get('accept-ranges')).toBeNull()
    expect(await res.text()).toContain('<h1>Title</h1>')
  })

  test('?raw=1 returns before range handling: Range ignored, verbatim bytes', async () => {
    const s = setup()
    const { token } = await teamSite(s, [{ path: 'doc.md', text: '# Title', mimeType: 'text/markdown' }])
    const res = await get(s, token, 'doc.md?raw=1', { range: 'bytes=0-3' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-range')).toBeNull()
    expect(await res.text()).toBe('# Title')
  })
})

// ---------------------------------------------------------------------------------------------
// T2.1 [red pre-S2] Range + non-null D1 size: exactly ONE ranged R2 get — never a full get.
// ---------------------------------------------------------------------------------------------
describe('T2.1 single ranged get when D1 knows the size', () => {
  test('bytes=2-5 → 206 slice, etag from the ranged object, ops = exactly one ranged get', async () => {
    const s = setup()
    const { token, keys } = await teamSite(s, [{ path: 'song.mp3', text: BODY, mimeType: 'application/octet-stream' }])
    const before = ops(s)
    const res = await get(s, token, 'song.mp3', { range: 'bytes=2-5' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 2-5/${BODY.length}`)
    expect(res.headers.get('content-length')).toBe('4')
    expect(res.headers.get('etag')).toBe(etagOf(s, keys[0]))
    expect(await res.text()).toBe('2345')
    expect(diff(before, ops(s))).toEqual(ONE_RANGED)
  })

  test('suffix bytes=-4 → 206 tail slice, still exactly one ranged get', async () => {
    const s = setup()
    const { token } = await teamSite(s, [{ path: 'song.mp3', text: BODY, mimeType: 'application/octet-stream' }])
    const before = ops(s)
    const res = await get(s, token, 'song.mp3', { range: 'bytes=-4' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 12-15/${BODY.length}`)
    expect(await res.text()).toBe('CDEF')
    expect(diff(before, ops(s))).toEqual(ONE_RANGED)
  })
})

// ---------------------------------------------------------------------------------------------
// T2.2 416s resolve their etag via ONE head() probe — zero body bytes move.
// ---------------------------------------------------------------------------------------------
describe('T2.2 unsatisfiable ranges: 416 + etag via head probe', () => {
  const mp3 = (text: string): FileSpec => ({ path: 'song.mp3', text, mimeType: 'application/octet-stream' })

  test.each([`bytes=${BODY.length}-`, 'bytes=-0'])('%s → 416 with etag + Content-Range bytes */N', async (range) => {
    const s = setup()
    const { token, keys } = await teamSite(s, [mp3(BODY)])
    const before = ops(s)
    const res = await get(s, token, 'song.mp3', { range })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${BODY.length}`)
    expect(res.headers.get('etag')).toBe(etagOf(s, keys[0]))
    expect(await res.text()).toBe('')
    expect(diff(before, ops(s))).toEqual(HEAD_ONLY)
  })

  test('zero-byte object (size 0 in D1, empty R2 object): any Range → 416, never falsy-skipped', async () => {
    const s = setup()
    const { token, keys } = await teamSite(s, [mp3('')])
    const before = ops(s)
    const res = await get(s, token, 'song.mp3', { range: 'bytes=0-' })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */0')
    expect(res.headers.get('etag')).toBe(etagOf(s, keys[0]))
    expect(diff(before, ops(s))).toEqual(HEAD_ONLY)
  })
})

// ---------------------------------------------------------------------------------------------
// T2.3 legacy rows with size NULL in D1 fall back to full-get-first (full supplies total+etag,
// then the ranged get — exactly today's double-get shape, but ONLY on this rare path).
// ---------------------------------------------------------------------------------------------
describe('T2.3 null-size D1 row: full-get fallback', () => {
  test('legacy row 206 costs full+ranged; a sized row in the same site keeps fullGets===0', async () => {
    const s = setup()
    const { token, siteId, keys } = await teamSite(s, [
      { path: 'sized.bin', text: BODY, mimeType: 'application/octet-stream' },
    ])
    // Pre-size-column row: inserted by hand because seedFile always stamps a real size.
    await s.db.insert(files).values({
      id: 'legacy-file',
      siteId,
      path: 'legacy.bin',
      storageKey: 'legacy/legacy.bin',
      mimeType: 'application/octet-stream',
      size: null,
    })
    await s.r2.put('legacy/legacy.bin', BODY)
    s.recorder.resetCounters()

    const before = ops(s)
    const res = await get(s, token, 'legacy.bin', { range: 'bytes=0-3' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-3/${BODY.length}`)
    expect(await res.text()).toBe('0123')
    // Documented fallback cost: ONE full get (total + etag) THEN one ranged get; cache untouched.
    expect(diff(before, ops(s))).toEqual({ ...NO_OPS, full: 1, ranged: 1 })

    // The sized row through the very same route keeps the modern shape: zero full gets.
    const sizedBefore = ops(s)
    const sized = await get(s, token, 'sized.bin', { range: 'bytes=0-3' })
    expect(sized.status).toBe(206)
    expect(sized.headers.get('etag')).toBe(etagOf(s, keys[0]))
    expect(diff(sizedBefore, ops(s))).toEqual(ONE_RANGED)
  })
})

// ---------------------------------------------------------------------------------------------
// T2.4 conditionals with exact op counts.
// ---------------------------------------------------------------------------------------------
describe('T2.4 conditional requests', () => {
  const mp3: FileSpec = { path: 'song.mp3', text: BODY, mimeType: 'application/octet-stream' }

  test('If-None-Match match beats Range: 304, zero full/ranged/cache reads (one head allowed)', async () => {
    const s = setup()
    const { token, keys } = await teamSite(s, [mp3])
    const before = ops(s)
    const res = await get(s, token, 'song.mp3', { 'if-none-match': etagOf(s, keys[0]), range: 'bytes=0-1' })
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe(etagOf(s, keys[0]))
    expect(await res.text()).toBe('')
    expect(diff(before, ops(s))).toEqual(HEAD_ONLY)
  })

  test('stale If-Range → full 200 body, no slice headers (ops: the ranged probe + the full get)', async () => {
    const s = setup()
    const { token } = await teamSite(s, [mp3])
    const before = ops(s)
    const res = await get(s, token, 'song.mp3', { range: 'bytes=0-1', 'if-range': '"stale-etag"' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(BODY)
    expect(res.headers.get('content-range')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    // Documented: staleness is only detectable from the ranged get's etag, so this rare path
    // costs ranged + full. The cache stays untouched (Range-carrying request).
    expect(diff(before, ops(s))).toEqual({ ...NO_OPS, ranged: 1, full: 1 })
  })

  test('matching If-Range → single ranged 206', async () => {
    const s = setup()
    const { token, keys } = await teamSite(s, [mp3])
    const before = ops(s)
    const res = await get(s, token, 'song.mp3', { range: 'bytes=0-1', 'if-range': etagOf(s, keys[0]) })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('01')
    expect(diff(before, ops(s))).toEqual(ONE_RANGED)
  })

  test('multi-range → full 200 body via one direct full get (cache bypassed)', async () => {
    const s = setup()
    const { token } = await teamSite(s, [mp3])
    const before = ops(s)
    const res = await get(s, token, 'song.mp3', { range: 'bytes=0-1,4-5' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(BODY)
    expect(diff(before, ops(s))).toEqual({ ...NO_OPS, full: 1 })
  })
})

// ---------------------------------------------------------------------------------------------
// T2.6 missing R2 object → 404; site replace mints a NEW storageKey, so the old cache entry is
// simply unreachable — fresh bytes are always served without any invalidation.
// ---------------------------------------------------------------------------------------------
describe('T2.6 missing object and site-replace key rotation', () => {
  test('cold cache + D1 row + missing R2 object → 404 no-store (miss then the failed full get)', async () => {
    const s = setup()
    const { token, siteId } = await teamSite(s, [])
    await seedFile(s.db, null, siteId, { path: 'index.html', text: 'never-stored' }) // row only, NO R2 object
    const before = ops(s)
    const res = await get(s, token, 'index.html')
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(diff(before, ops(s))).toEqual({ ...NO_OPS, matches: 1, misses: 1, full: 1 })
  })

  test('site replace: new storageKey serves fresh bytes; the old entry is never matched', async () => {
    const s = setup()
    const { token, siteId } = await teamSite(s, [
      { path: 'index.html', text: '<p>OLD</p>', storageKey: 'k1/index.html' },
    ])
    const warm = await get(s, token, 'index.html')
    expect(await warm.text()).toBe('<p>OLD</p>')
    expect(s.caches.store.has(storageCacheKey('k1/index.html'))).toBe(true)

    // Replace simulation: the row is re-pointed at a NEW immutable key with new bytes.
    await s.db.delete(files).where(eq(files.siteId, siteId))
    await seedFile(s.db, s.r2, siteId, { path: 'index.html', text: '<p>NEW</p>', storageKey: 'k2/index.html' })

    const before = ops(s)
    const fresh = await get(s, token, 'index.html')
    expect(fresh.status).toBe(200)
    expect(await fresh.text()).toBe('<p>NEW</p>')
    expect(diff(before, ops(s))).toEqual(COLD_FULL) // a MISS on the new key — the old entry never matched

    const again = await get(s, token, 'index.html')
    expect(await again.text()).toBe('<p>NEW</p>')
    expect(diff(before, ops(s))).toEqual({ ...COLD_FULL, matches: 2, hits: 1 })
    // Both keys coexist; the stale one is simply unreachable (no invalidation needed, ever).
    expect(s.caches.store.size).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------
// T3.1 the cache is shared ACROSS users (bytes are keyed by storageKey, not viewer): B's
// authorized read after A's warm costs zero R2 ops and serves identical bytes/headers.
// ---------------------------------------------------------------------------------------------
describe('T3.1 cross-user cache share', () => {
  test('A warms (1 full + 1 put, body intact); B hits (0 R2), identical etag/type/body', async () => {
    const s = setup()
    const { token: tokenA } = await teamSite(s, [{ path: 'style.css', text: 'body{margin:0}', mimeType: 'text/css' }])
    const userB = await seedUser(s.db)
    const tokenB = await mintToken(userB, 'sp/site')

    const beforeA = ops(s)
    const resA = await get(s, tokenA, 'style.css')
    expect(resA.status).toBe(200)
    expect(await resA.text()).toBe('body{margin:0}') // the tee'd warm never eats the client body
    expect(diff(beforeA, ops(s))).toEqual(COLD_FULL)

    const beforeB = ops(s)
    const resB = await get(s, tokenB, 'style.css')
    expect(resB.status).toBe(200)
    expect(await resB.text()).toBe('body{margin:0}')
    expect(resB.headers.get('etag')).toBe(resA.headers.get('etag'))
    expect(resB.headers.get('content-type')).toBe(resA.headers.get('content-type'))
    expect(diff(beforeB, ops(s))).toEqual(WARM_HIT)
  })
})

// ---------------------------------------------------------------------------------------------
// T3.2 Range requests bypass the cache entirely, and non-200 responses never warm it.
// ---------------------------------------------------------------------------------------------
describe('T3.2 warm cache + Range/conditional: cache bypassed, never re-warmed', () => {
  test('warm cache + Range → 0 cache reads, exactly 1 ranged R2; 304/416 never cache.put', async () => {
    const s = setup()
    const { token, keys } = await teamSite(s, [{ path: 'song.mp3', text: BODY, mimeType: 'application/octet-stream' }])
    expect(await opsOf(s, () => get(s, token, 'song.mp3'))).toEqual(COLD_FULL) // warm it

    const beforeRange = ops(s)
    const ranged = await get(s, token, 'song.mp3', { range: 'bytes=0-3' })
    expect(ranged.status).toBe(206)
    expect(await ranged.text()).toBe('0123')
    expect(diff(beforeRange, ops(s))).toEqual(ONE_RANGED) // 0 matches, 0 puts

    const before304 = ops(s)
    expect((await get(s, token, 'song.mp3', { 'if-none-match': etagOf(s, keys[0]) })).status).toBe(304)
    expect(diff(before304, ops(s))).toEqual(HEAD_ONLY) // no put on a 304

    const before416 = ops(s)
    expect((await get(s, token, 'song.mp3', { range: 'bytes=99-' })).status).toBe(416)
    expect(diff(before416, ops(s))).toEqual(HEAD_ONLY) // no put on a 416
  })
})

// ---------------------------------------------------------------------------------------------
// T3.3 stored-entry headers are cacheable while the client keeps private/no-cache; cache
// failures (match throw, put reject) degrade to plain R2 serving — never an error.
// ---------------------------------------------------------------------------------------------
describe('T3.3 stored entry headers + cache fault tolerance', () => {
  const css: FileSpec = { path: 'style.css', text: 'body{margin:0}', mimeType: 'text/css' }

  test('stored entry carries immutable cache headers + the R2 etag; client stays private, no-cache', async () => {
    const s = setup()
    const { token, keys } = await teamSite(s, [css])
    const res = await get(s, token, 'style.css')
    expect(res.headers.get('cache-control')).toBe('private, no-cache')

    const entry = s.caches.store.get(storageCacheKey(keys[0]))
    expect(entry).toBeDefined()
    const stored = new Headers(entry?.headers)
    expect(stored.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(stored.get('etag')).toBe(etagOf(s, keys[0]))
    expect(stored.get('content-type')).toBe('text/css; charset=utf-8')
  })

  test('cache.put rejection → client still 200 with intact bytes; the next request re-warms', async () => {
    const s = setup()
    const { token } = await teamSite(s, [css])
    s.caches.failNextPut(new Error('put boom'))
    const before = ops(s)
    const res = await get(s, token, 'style.css')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('body{margin:0}')
    expect(diff(before, ops(s))).toEqual(COLD_FULL) // the failed put attempt IS counted
    expect(s.caches.store.size).toBe(0) // nothing landed

    expect(await opsOf(s, () => get(s, token, 'style.css'))).toEqual(COLD_FULL) // re-warm works
    expect(await opsOf(s, () => get(s, token, 'style.css'))).toEqual(WARM_HIT)
  })

  test('cache.match throwing → R2 fallback, still 200', async () => {
    const s = setup()
    const { token } = await teamSite(s, [css])
    await get(s, token, 'style.css') // warm
    s.caches.failNextMatch(new Error('match boom'))
    const before = ops(s)
    const res = await get(s, token, 'style.css')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('body{margin:0}')
    // The throwing match is counted (neither hit nor miss), then R2 serves and re-puts.
    expect(diff(before, ops(s))).toEqual({ ...NO_OPS, matches: 1, full: 1, puts: 1 })
  })
})

// ---------------------------------------------------------------------------------------------
// T3.4 collision-prone storageKeys served through the real route: per-segment encoding keeps
// every entry distinct — no cross-serve, ever.
// ---------------------------------------------------------------------------------------------
describe('T3.4 collision-prone storageKeys stay distinct in the cache', () => {
  const cases: { path: string; storageKey: string; text: string }[] = [
    { path: 'p1.bin', storageKey: 'a#b/x', text: 'BYTES-HASH' },
    { path: 'p2.bin', storageKey: 'a%23b/x', text: 'BYTES-PREENCODED' },
    { path: 'p3.bin', storageKey: 'ünï/cödé', text: 'BYTES-UNICODE' },
    { path: 'p4.bin', storageKey: 'q?k/x', text: 'BYTES-QMARK' },
  ]

  test("'a#b/x' vs 'a%23b/x', unicode, '?' → distinct bodies AND distinct cache entries", async () => {
    const s = setup()
    const { token } = await teamSite(
      s,
      cases.map((c) => ({ ...c, mimeType: 'application/octet-stream' })),
    )
    for (const c of cases) {
      const before = ops(s)
      const cold = await get(s, token, c.path)
      expect(await cold.text()).toBe(c.text)
      expect(diff(before, ops(s))).toEqual(COLD_FULL)
    }
    expect(s.caches.store.size).toBe(cases.length) // nothing merged
    for (const c of cases) {
      const before = ops(s)
      const warmRes = await get(s, token, c.path)
      expect(await warmRes.text()).toBe(c.text) // each hit serves ITS OWN bytes
      expect(diff(before, ops(s))).toEqual(WARM_HIT)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// T3.5 live D1 auth ALWAYS precedes the cache: after a revoke/archive/user-delete, the denied
// hit performs ZERO cache reads and ZERO R2 ops even though the entry is warm.
// ---------------------------------------------------------------------------------------------
describe('T3.5 warm-then-revoke: denials never touch warm bytes', () => {
  test('revoked direct share → 403, zero cache/R2 ops on the denied hit', async () => {
    const s = setup()
    const owner = await seedUser(s.db)
    const viewer = await seedUser(s.db)
    const sp = await seedSpace(s.db, { createdBy: owner, slug: 'sp' })
    await seedMember(s.db, sp, owner)
    const siteId = await seedSite(s.db, { spaceId: sp, ownerId: owner, slug: 'site', visibility: 'private' })
    await seedUserShare(s.db, siteId, viewer)
    await seedFile(s.db, s.r2, siteId, { path: 'index.html', text: '<p>secret</p>' })
    const token = await mintToken(viewer, 'sp/site')
    s.recorder.resetCounters()

    expect((await get(s, token, 'index.html')).status).toBe(200) // warm
    await s.db.delete(siteUserShares).where(eq(siteUserShares.siteId, siteId))
    const before = ops(s)
    expect((await get(s, token, 'index.html')).status).toBe(403)
    expect(diff(before, ops(s))).toEqual(NO_OPS)
  })

  test('archived site → 410, zero cache/R2 ops on the denied hit', async () => {
    const s = setup()
    const { token, siteId } = await teamSite(s, [{ path: 'index.html', text: '<p>x</p>' }])
    expect((await get(s, token, 'index.html')).status).toBe(200) // warm
    await s.db.update(sites).set({ status: 'archived' }).where(eq(sites.id, siteId))
    const before = ops(s)
    expect((await get(s, token, 'index.html')).status).toBe(410)
    expect(diff(before, ops(s))).toEqual(NO_OPS)
  })

  test('deleted user → 403, zero cache/R2 ops on the denied hit', async () => {
    const s = setup()
    const { token, viewer } = await teamSite(s, [{ path: 'index.html', text: '<p>x</p>' }])
    expect((await get(s, token, 'index.html')).status).toBe(200) // warm
    await s.db.delete(users).where(eq(users.id, viewer))
    const before = ops(s)
    expect((await get(s, token, 'index.html')).status).toBe(403)
    expect(diff(before, ops(s))).toEqual(NO_OPS)
  })
})

// ---------------------------------------------------------------------------------------------
// T3.6 transforms operate on the raw bytes wherever they came from: R2 (cold) and cache (warm)
// produce byte-identical responses; raw=1 never touches the cache and records no view; cached
// HTML/markdown serves still record exactly one view per request.
// ---------------------------------------------------------------------------------------------
describe('T3.6 per-transform byte identity (cold R2 vs warm cache)', () => {
  const viewCount = async (s: Setup) => (await s.db.select().from(events)).length

  test('markdown render: cold vs warm bytes identical; one view per request', async () => {
    const s = setup()
    const { token } = await teamSite(s, [
      { path: 'doc.md', text: '# Title\n\n[ext](https://slack.com/x)', mimeType: 'text/markdown' },
    ])
    const before = ops(s)
    const cold = await (await get(s, token, 'doc.md')).text()
    expect(diff(before, ops(s))).toEqual(COLD_FULL)
    const warmBefore = ops(s)
    const warm = await (await get(s, token, 'doc.md')).text()
    expect(diff(warmBefore, ops(s))).toEqual(WARM_HIT)
    expect(warm).toBe(cold)
    expect(cold).toContain('<h1>Title</h1>')
    expect(cold).toContain('target="_blank"') // external-link rewrite intact on both sources
    expect(await viewCount(s)).toBe(2)
  })

  test('annotate inject: cold vs warm bytes identical', async () => {
    const s = setup()
    const { token } = await teamSite(s, [
      { path: 'index.html', text: '<html><head></head><body><p>x</p></body></html>' },
    ])
    const before = ops(s)
    const cold = await (await get(s, token, 'index.html?glance_annotate=1')).text()
    expect(diff(before, ops(s))).toEqual(COLD_FULL)
    const warmBefore = ops(s)
    const warm = await (await get(s, token, 'index.html?glance_annotate=1')).text()
    expect(diff(warmBefore, ops(s))).toEqual(WARM_HIT)
    expect(warm).toBe(cold)
    expect(cold).toContain('window.__GLANCE__=')
  })

  test('plain-HTML link rewrite: cold vs warm bytes identical; one view per request', async () => {
    const s = setup()
    const { token } = await teamSite(s, [
      { path: 'index.html', text: '<html><body><a href="https://slack.com/x">e</a></body></html>' },
    ])
    const before = ops(s)
    const coldRes = await get(s, token, 'index.html')
    const cold = await coldRes.text()
    expect(diff(before, ops(s))).toEqual(COLD_FULL)
    const warmBefore = ops(s)
    const warmRes = await get(s, token, 'index.html')
    const warm = await warmRes.text()
    expect(diff(warmBefore, ops(s))).toEqual(WARM_HIT)
    expect(warm).toBe(cold)
    expect(cold).toContain('target="_blank" rel="noopener noreferrer"')
    expect(warmRes.headers.get('etag')).toBe(coldRes.headers.get('etag')) // etag survives the cache hop
    expect(await viewCount(s)).toBe(2) // cached serve still records exactly one view per request
  })

  test('?raw=1 never reads or warms the cache and records no view — even when the entry is warm', async () => {
    const s = setup()
    const { token } = await teamSite(s, [{ path: 'doc.md', text: '# Title', mimeType: 'text/markdown' }])
    const before = ops(s)
    expect(await (await get(s, token, 'doc.md?raw=1')).text()).toBe('# Title')
    expect(diff(before, ops(s))).toEqual(RAW_FULL) // direct full get, cache untouched
    expect(await viewCount(s)).toBe(0)

    await get(s, token, 'doc.md') // warm the raw bytes via the render path
    const warmBefore = ops(s)
    expect(await (await get(s, token, 'doc.md?raw=1')).text()).toBe('# Title')
    expect(diff(warmBefore, ops(s))).toEqual(RAW_FULL) // STILL bypasses the warm entry
    expect(await viewCount(s)).toBe(1) // only the render counted
  })
})
