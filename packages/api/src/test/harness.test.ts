// S0 harness-seam spec: the perf work (S1 access-facts batch, S2/S3 range+cache serving,
// T8.2 bind-cap red) asserts on op COUNTS and an interleaved op TIMELINE. This file pins
// the harness contracts those steps rely on: R2 true-byte model + etag rotation + onlyIf,
// a Cache-API mock, D1 statement/batch counters, and the D1 100-bound-parameter cap.
import { describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { sites, spaces, users } from '../db/schema'
import { makeCaches, makeDb, makeR2, makeRecorder, seedSite, seedSpace, seedUser } from './harness'

describe('T0.1 makeR2 byte model', () => {
  test('binary put + ranged get slice BYTES; size is always the full byte length', async () => {
    const r2 = makeR2()
    await r2.put('bin', new Uint8Array([0, 127, 128, 255]))
    const obj = await r2.get('bin', { range: { offset: 2, length: 2 } })
    if (!obj || !('body' in obj)) throw new Error('expected a body-bearing object')
    expect([...new Uint8Array(await obj.arrayBuffer())]).toEqual([128, 255])
    expect(obj.size).toBe(4) // full object size, matching real R2Object.size
  })

  test('string put stores UTF-8 bytes: size is encoded length, ranged text() decodes the slice', async () => {
    const r2 = makeR2()
    await r2.put('txt', 'aé') // 'a' = 1 byte, 'é' = 2 bytes
    const full = await r2.get('txt')
    if (!full || !('body' in full)) throw new Error('expected a body-bearing object')
    expect(full.size).toBe(3)
    expect(await full.text()).toBe('aé')
    const sliced = await r2.get('txt', { range: { offset: 1, length: 2 } })
    if (!sliced || !('text' in sliced)) throw new Error('expected a body-bearing object')
    expect(await sliced.text()).toBe('é')
    expect(sliced.size).toBe(3)
  })

  test('httpEtag rotates on every put of the same key and stays quoted', async () => {
    const r2 = makeR2()
    await r2.put('k', 'v1')
    const first = await r2.get('k')
    await r2.put('k', 'v2')
    const second = await r2.get('k')
    if (!first || !second) throw new Error('expected objects')
    expect(first.httpEtag).not.toBe(second.httpEtag)
    expect(first.httpEtag).toMatch(/^".*"$/)
    expect(second.httpEtag).toMatch(/^".*"$/)
  })

  test('head() exposes size/httpEtag/httpMetadata but NO body/text/arrayBuffer', async () => {
    const r2 = makeR2()
    await r2.put('h', 'abc', { httpMetadata: { contentType: 'text/plain' } })
    const head = await r2.head('h')
    if (!head) throw new Error('expected a head object')
    expect(head.size).toBe(3)
    expect(head.httpEtag).toMatch(/^".*"$/)
    expect(head.httpMetadata).toEqual({ contentType: 'text/plain' })
    expect('body' in head).toBe(false)
    expect('text' in head).toBe(false)
    expect('arrayBuffer' in head).toBe(false)
    expect(await r2.head('missing')).toBeNull()
  })

  test('onlyIf: current etag serves the body; stale etag resolves to a body-LESS object (R2Object, not R2ObjectBody)', async () => {
    const r2 = makeR2()
    await r2.put('g', 'v1')
    const stale = (await r2.get('g'))?.httpEtag as string
    await r2.put('g', 'v2')
    const current = (await r2.get('g'))?.httpEtag as string

    const hit = await r2.get('g', { onlyIf: { etagMatches: current } })
    if (!hit || !('text' in hit)) throw new Error('expected a body-bearing object')
    expect(await hit.text()).toBe('v2')

    const miss = await r2.get('g', { onlyIf: { etagMatches: stale } })
    if (!miss) throw new Error('expected a body-less object, not null')
    expect(miss.httpEtag).toBe(current)
    expect(miss.size).toBe(2)
    expect('body' in miss).toBe(false)
    expect('text' in miss).toBe(false)
    expect('arrayBuffer' in miss).toBe(false)

    // real-R2 tolerance: weak (W/) and unquoted forms, plus string-array conditions
    const weak = await r2.get('g', { onlyIf: { etagMatches: `W/${current}` } })
    expect(weak && 'text' in weak).toBe(true)
    const unquoted = await r2.get('g', { onlyIf: { etagMatches: current.slice(1, -1) } })
    expect(unquoted && 'text' in unquoted).toBe(true)
    const arr = await r2.get('g', { onlyIf: { etagDoesNotMatch: [stale, '"other"'] } })
    expect(arr && 'text' in arr).toBe(true)
  })

  test('per-kind op counters are exact and the legacy gets() total still works', async () => {
    const r2 = makeR2()
    await r2.put('bin', new Uint8Array([0, 127, 128, 255]))
    await r2.put('txt', 'aé')
    await r2.get('bin', { range: { offset: 2, length: 2 } }) // ranged 1
    await r2.get('txt') // full 1
    await r2.get('txt', { range: { offset: 1, length: 2 } }) // ranged 2
    const etag = (await r2.get('txt'))?.httpEtag as string // full 2
    await r2.head('txt') // head 1
    await r2.get('txt', { onlyIf: { etagMatches: etag } }) // onlyIf 1
    expect(r2.ops()).toEqual({ full: 2, ranged: 2, head: 1, onlyIf: 1 })
    expect(r2.gets()).toBe(5) // every get() call — full + ranged + onlyIf; head is not a get
  })
})

describe('T0.2 makeCaches Cache-API mock', () => {
  test('put stores a clone (caller body stays readable) and match serves a fresh Response every time', async () => {
    const caches = makeCaches()
    const original = new Response('x', { status: 200, headers: { 'content-type': 'text/plain' } })
    await caches.default.put('https://example.com/x', original)
    expect(await original.text()).toBe('x') // put must not consume the caller's body

    const m1 = await caches.default.match('https://example.com/x')
    const m2 = await caches.default.match(new Request('https://example.com/x'))
    if (!m1 || !m2) throw new Error('expected cache hits')
    expect(await m1.text()).toBe('x')
    expect(await m2.text()).toBe('x')
    expect(m1.headers.get('content-type')).toBe('text/plain')
    expect(caches.counters).toEqual({ matches: 2, puts: 1, hits: 2, misses: 0 })
  })

  test('miss returns undefined and counts; delete evicts', async () => {
    const caches = makeCaches()
    expect(await caches.default.match('https://example.com/none')).toBeUndefined()
    await caches.default.put('https://example.com/y', new Response('y'))
    expect(await caches.default.delete('https://example.com/y')).toBe(true)
    expect(await caches.default.match('https://example.com/y')).toBeUndefined()
    expect(caches.counters).toEqual({ matches: 2, puts: 1, hits: 0, misses: 2 })
  })

  test('failNextMatch/failNextPut reject exactly once (attempt still counted); reset() zeroes everything', async () => {
    const caches = makeCaches()
    await caches.default.put('https://example.com/z', new Response('z'))

    caches.failNextMatch(new Error('match boom'))
    await expect(caches.default.match('https://example.com/z')).rejects.toThrow('match boom')
    const after = await caches.default.match('https://example.com/z') // failure is one-shot
    expect(after && (await after.text())).toBe('z')

    caches.failNextPut(new Error('put boom'))
    await expect(caches.default.put('https://example.com/w', new Response('w'))).rejects.toThrow('put boom')
    await caches.default.put('https://example.com/w', new Response('w')) // one-shot again
    expect(caches.counters).toEqual({ matches: 2, puts: 3, hits: 1, misses: 0 })

    caches.reset()
    expect(caches.counters).toEqual({ matches: 0, puts: 0, hits: 0, misses: 0 })
    expect(await caches.default.match('https://example.com/z')).toBeUndefined() // store cleared too
  })
})

describe('T0.3 makeDb D1 counters + shared recorder timeline', () => {
  test('loose statements vs batches: exact counts, seeds excluded via resetCounters()', async () => {
    const db = makeDb()
    await seedUser(db)
    await seedUser(db)
    expect(db.counters.loose).toBe(2) // seeds ARE observed…
    db.resetCounters() // …and excluded from here on

    await db.select().from(users)
    expect(db.counters.loose).toBe(1)
    expect(db.counters.batches).toBe(0)
    expect(db.counters.batchStmts).toBe(0)

    await db.batch([db.select().from(users), db.select().from(users)] as never)
    expect(db.counters.batches).toBe(1)
    expect(db.counters.batchStmts).toBe(2)
    expect(db.counters.loose).toBe(1) // batch statements never leak into loose
  })

  test('write kinds counted by SQL verb', async () => {
    const db = makeDb()
    db.resetCounters() // exclude nothing yet, but pin the zero start
    const uid = await seedUser(db) // 1 insert
    await db.update(users).set({ name: 'renamed' }).where(eq(users.id, uid))
    await db.delete(users).where(eq(users.id, uid))
    expect(db.counters.insert).toBe(1)
    expect(db.counters.update).toBe(1)
    expect(db.counters.delete).toBe(1)
    expect(db.counters.loose).toBe(3)
  })

  test('one recorder interleaves d1 + r2 + cache ops into a single ordered timeline', async () => {
    const recorder = makeRecorder()
    const db = makeDb(recorder)
    const r2 = makeR2(recorder)
    const caches = makeCaches(recorder)
    await seedUser(db)
    await r2.put('site/index.html', '<html></html>')
    recorder.resetCounters() // drop seed noise (timeline + counters)

    await db.select().from(users)
    await r2.get('site/index.html')
    await caches.default.put('https://example.com/p', new Response('p'))
    await db.batch([db.select().from(users), db.select().from(users)] as never)
    await caches.default.match('https://example.com/p')
    const uid2 = await seedUser(db)
    await db.update(users).set({ name: 'x' }).where(eq(users.id, uid2))
    await db.delete(users).where(eq(users.id, uid2))

    expect(recorder.timeline).toEqual([
      'd1:stmt',
      'r2:full',
      'cache:put',
      'd1:batch',
      'd1:stmt',
      'd1:stmt',
      'cache:match',
      'd1:stmt:insert',
      'd1:stmt:update',
      'd1:stmt:delete',
    ])
    expect(recorder.counters['d1:batch']).toBe(1)
    expect(recorder.counters['d1:stmt']).toBe(3)
  })
})

describe('T0.5 D1 batch result-name guard', () => {
  // Real D1 `.batch()` returns rows as NAME-KEYED objects; drizzle's d1 driver rebuilds the row
  // array via Object.keys (d1ToRawMapping), so duplicate result names collapse and shift every
  // later field. Loose queries are immune (the d1 driver runs them through stmt.raw(), positional).
  test('a batched two-table select with colliding result names throws', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const spId = await seedSpace(db, { createdBy: uid })
    await seedSite(db, { spaceId: spId, ownerId: uid })
    const collide = db
      .select({ spaceSlug: spaces.slug, slug: sites.slug })
      .from(sites)
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    await expect(db.batch([collide] as never)).rejects.toThrow(/result-name collision.*"slug"/s)
  })

  test('the same shape with one side aliased passes', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const spId = await seedSpace(db, { createdBy: uid })
    await seedSite(db, { spaceId: spId, ownerId: uid })
    const aliased = db
      .select({ spaceSlug: sql<string>`${spaces.slug}`.as('spaceSlug'), slug: sites.slug })
      .from(sites)
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    const [rows] = (await db.batch([aliased] as never)) as [{ spaceSlug: string; slug: string }[]]
    expect(rows.length).toBe(1)
    expect(rows[0].spaceSlug).toBe(spId) // seed defaults slug to the id
  })

  test('a batched unaliased expression column throws; aliased passes', async () => {
    const db = makeDb()
    await seedUser(db)
    const bare = db.select({ count: sql<number>`count(*)` }).from(users)
    await expect(db.batch([bare] as never)).rejects.toThrow(/unaliased expression/i)
    const aliased = db.select({ count: sql<number>`count(*)`.as('count') }).from(users)
    const [rows] = (await db.batch([aliased] as never)) as [{ count: number }[]]
    expect(rows[0].count).toBe(1)
  })

  test('a LOOSE statement with duplicate result names does NOT throw (real D1 maps loose queries positionally via raw())', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    const spId = await seedSpace(db, { createdBy: uid })
    await seedSite(db, { spaceId: spId, ownerId: uid })
    const rows = await db
      .select({ spaceSlug: spaces.slug, slug: sites.slug })
      .from(sites)
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    expect(rows.length).toBe(1)
    expect(rows[0].spaceSlug).toBe(spId)
  })

  test('batched writes and single-table selects stay unaffected', async () => {
    const db = makeDb()
    const uid = await seedUser(db)
    await db.batch([
      db.insert(users).values({ id: 'g-1', email: 'g1@example.com', name: null, role: 'member' }),
      db.select().from(users).where(eq(users.id, uid)),
    ] as never)
    expect(db.counters.batchStmts).toBeGreaterThanOrEqual(2)
  })
})

describe('T0.4 bind-cap adapter (D1 100-bound-parameter limit)', () => {
  test('a statement binding 101 values rejects with the count and the cap; 100 passes', async () => {
    const db = makeDb()
    const over = Array.from({ length: 101 }, (_, i) => `id-${i}`)
    // drizzle builders are thenables, not Promises — resolve into one for .rejects
    await expect((async () => db.select().from(users).where(inArray(users.id, over)))()).rejects.toThrow(
      /101.*100|100.*101/,
    )
    const atCap = Array.from({ length: 100 }, (_, i) => `id-${i}`)
    expect(await db.select().from(users).where(inArray(users.id, atCap))).toEqual([])
  })
})
