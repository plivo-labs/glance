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
