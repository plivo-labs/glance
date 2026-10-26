import { describe, expect, test } from 'bun:test'
import worker from './index'
import { STATS_CACHE_KEY, STATS_TOTALS_CACHE_KEY } from './lib/stats'
import { makeKv } from './test/harness'

// Composition-level checks against the real worker export (routes registered before the /api/*
// guards need no DB, so a minimal env suffices). Exercised through `worker.fetch` — the handler
// production actually invokes — not a Hono test helper.
const ENV = { CONTENT_URL: 'https://content.example.com', APP_URL: 'https://glance.example.com' } as never

describe('shared-backend routes on the root app', () => {
  test('/api/glance.js serves the built SDK with the global CSP applied', async () => {
    const res = await worker.fetch(new Request('https://glance.example.com/api/glance.js'), ENV)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
    const body = await res.text()
    expect(body).toContain('glance:db-hello') // broker transport present
    expect(body).toContain('__GLANCE_DB__')
  })

  test('no demo page ships (deleted — rebuilt broker-side in Phase 2)', async () => {
    const res = await worker.fetch(new Request('https://glance.example.com/api/glance-demo'), ENV)
    expect(res.status).not.toBe(200)
  })
})

describe('scheduled — hourly synthetic stats visitor (issue #102, Option A)', () => {
  test('a cron tick on a cold KV warms BOTH stats halves', async () => {
    // A D1 binding shaped like client.test.ts's: enough for drizzle to run the stat scans and
    // return empty rows — the spec here is the KV writes, not the numbers.
    const statement = {
      bind: () => statement,
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
    }
    const kv = makeKv()
    const env = {
      GLANCE_DB: { withSession: () => ({ prepare: () => statement, getBookmark: () => null }) },
      GLANCE_SESSIONS: kv,
    } as never

    expect(typeof worker.scheduled).toBe('function')
    await worker.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() } as never, env, {
      waitUntil: () => {},
    } as never)

    expect(kv.store.has(STATS_CACHE_KEY)).toBe(true)
    expect(kv.store.has(STATS_TOTALS_CACHE_KEY)).toBe(true)
  })
})

describe('scheduled — daily retention purge (issue #82)', () => {
  test('the daily cron runs the purge, not the stats visitor', async () => {
    const statement = {
      bind: () => statement,
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
    }
    const kv = makeKv()
    const env = {
      GLANCE_DB: { withSession: () => ({ prepare: () => statement, getBookmark: () => null }) },
      GLANCE_SESSIONS: kv,
    } as never

    await worker.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() } as never, env, {
      waitUntil: () => {},
    } as never)

    // The purge branch returns before ever touching the stats KV.
    expect(kv.store.has(STATS_CACHE_KEY)).toBe(false)
    expect(kv.store.has(STATS_TOTALS_CACHE_KEY)).toBe(false)
  })
})

describe('WRITE_FREEZE maintenance switch', () => {
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
  }
  const envWith = (freeze?: string) =>
    ({
      ...(ENV as object),
      DATA_TOKEN_SECRET: 'data-secret',
      GLANCE_DB: { withSession: () => ({ prepare: () => statement, getBookmark: () => null }) },
      GLANCE_SESSIONS: makeKv(),
      ...(freeze === undefined ? {} : { WRITE_FREEZE: freeze }),
    }) as never
  const call = (method: string, path: string, env: never) =>
    worker.fetch(new Request(`https://glance.example.com${path}`, { method }), env)
  const writes = [
    ['POST', '/api/sites/acme/deck/star'],
    ['POST', '/api/_data/acme/deck/collections/todos'],
    ['GET', '/api/auth/callback'],
    ['GET', '/api/auth/oidc/callback'],
  ] as const

  test.each(writes)('frozen: %s %s → 503 + Retry-After', async (method, path) => {
    const res = await call(method, path, envWith('1'))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('300')
    expect(await res.json()).toEqual({ error: 'maintenance' })
  })

  test('frozen: a read route, a data-plane preflight, and the data-token mint pass', async () => {
    expect((await call('GET', '/api/health', envWith('1'))).status).toBe(200)
    expect((await call('OPTIONS', '/api/_data/acme/deck/collections/todos', envWith('1'))).status).toBe(204)
    // Unauthenticated, so the route's own requireAuth answers — the freeze let it through.
    expect((await call('POST', '/api/data-token/acme/deck', envWith('1'))).status).toBe(401)
  })

  for (const freeze of [undefined, '0']) {
    // Reaches the route's own auth/404 handling instead (4xx), never the freeze.
    test.each(writes)(`WRITE_FREEZE=${freeze}: %s %s is not frozen`, async (method, path) => {
      const res = await call(method, path, envWith(freeze))
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    })
  }
})
