import { describe, expect, test } from 'bun:test'
import { siteSummaries, sites } from '../db/schema'
import { PROMPT_VERSION, WORKERS_MODEL } from '../lib/summarize'
import { auth, makeRouteApp, mintUser, type RouteApp } from '../test/route-fixtures'
import {
  seedFile,
  seedGroupShare,
  seedMember,
  seedSite,
  seedSpace,
  seedUserShare,
} from '../test/harness'
import type { AppEnv } from '../types'
import { eq } from 'drizzle-orm'

const url = '/api/sites/acme/doc/summary'
const generatedAt = '2026-01-02T03:04:05.000Z'

const seedSummary = (db: RouteApp['db'], siteId: string, overrides: Partial<typeof siteSummaries.$inferInsert> = {}) =>
  db.insert(siteSummaries).values({
    siteId,
    summary: 'Stored summary',
    contentVersion: 0,
    promptVersion: PROMPT_VERSION,
    provider: 'workers',
    model: WORKERS_MODEL,
    truncated: false,
    updatedAt: generatedAt,
    ...overrides,
  })

const okLimiter = { limit: async () => ({ success: true }) }
const bindings = (env: RouteApp['env'], overrides: Record<string, unknown>) =>
  ({ ...env, ...overrides }) as unknown as AppEnv['Bindings']

async function seedApp(userId: string, siteOverrides: Partial<typeof sites.$inferInsert> = {}) {
  const route = makeRouteApp()
  const user = await mintUser(route.db, route.kv, userId)
  const spaceId = await seedSpace(route.db, { createdBy: user, slug: 'acme' })
  const siteId = await seedSite(route.db, { spaceId, ownerId: user, slug: 'doc', ...siteOverrides })
  return { ...route, user, spaceId, siteId }
}

const countingAi = (
  response: string,
  onCall: (model: unknown, input: unknown) => void = () => {},
) => ({
  run: async (model: unknown, input: unknown) => {
    onCall(model, input)
    return { response }
  },
})

const countingLimiter = (
  success: boolean,
  onCall: (input: { key: string }) => void = () => {},
) => ({
  limit: async (input: { key: string }) => {
    onCall(input)
    return { success }
  },
})

describe('site summary routes', () => {
  test('C16 GET returns exact row/provider states and computes both stale dimensions', async () => {
    const cases = [
      { name: 'no row + provider', provider: true, expected: { status: 'none', stale: false, currentVersion: 7 } },
      {
        name: 'no row + no provider',
        provider: false,
        expected: { status: 'unavailable', stale: false, currentVersion: 7 },
      },
      { name: 'ready + provider', provider: true, rowVersion: 7, rowPrompt: PROMPT_VERSION, stale: false },
      { name: 'ready + no provider', provider: false, rowVersion: 7, rowPrompt: PROMPT_VERSION, stale: false },
      { name: 'content mismatch', provider: true, rowVersion: 6, rowPrompt: PROMPT_VERSION, stale: true },
      { name: 'prompt mismatch', provider: true, rowVersion: 7, rowPrompt: PROMPT_VERSION - 1, stale: true },
    ] as const

    for (const scenario of cases) {
      const { app, env, db, user: owner, siteId } = await seedApp(`owner-${scenario.name.replaceAll(' ', '-')}`)
      await db.update(sites).set({ contentVersion: 7 }).where(eq(sites.id, siteId))

      if ('rowVersion' in scenario) {
        await seedSummary(db, siteId, {
          contentVersion: scenario.rowVersion,
          promptVersion: scenario.rowPrompt,
          generatedBy: owner,
        })
      }

      const requestEnv = bindings(
        env,
        scenario.provider ? { AI: countingAi('unused') } : {},
      )
      const response = await app.request(url, { headers: auth(owner) }, requestEnv)
      expect(response.status, scenario.name).toBe(200)

      const expected =
        'expected' in scenario
          ? scenario.expected
          : {
              status: 'ready',
              stale: scenario.stale,
              currentVersion: 7,
              summary: 'Stored summary',
              meta: {
                provider: 'workers',
                model: WORKERS_MODEL,
                forVersion: scenario.rowVersion,
                generatedAt,
                truncated: false,
              },
            }
      expect(await response.json(), scenario.name).toEqual(expected)
    }
  })

  test('C17 cold POST extracts visible text, generates, persists provenance, and returns ready', async () => {
    const { app, env, db, r2, user: poster, siteId } = await seedApp('poster')
    await db.update(sites).set({ contentVersion: 3 }).where(eq(sites.id, siteId))
    await seedFile(db, r2, siteId, {
      path: 'index.html',
      text: '<main><h1>Visible title</h1><p>Visible body</p><script>LEAK_MARKER()</script></main>',
    })

    const calls: Array<{ model: unknown; input: unknown }> = []
    const requestEnv = bindings(env, {
      AI: countingAi('Generated summary', (model, input) => calls.push({ model, input })),
      SUMMARY_LIMITER: okLimiter,
    })

    const response = await app.request(
      url,
      { method: 'POST', headers: auth(poster), body: '{}' },
      requestEnv,
    )
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe(WORKERS_MODEL)
    const messages = (calls[0].input as { messages: Array<{ role: string; content: string }> }).messages
    const modelText = messages.find((message) => message.role === 'user')?.content
    expect(modelText).toContain('Visible title')
    expect(modelText).toContain('Visible body')
    expect(modelText).not.toContain('LEAK_MARKER')
    expect(modelText).not.toContain('<')

    const body = (await response.json()) as {
      status: string
      stale: boolean
      currentVersion: number
      summary: string
      meta: { provider: string; model: string; forVersion: number; generatedAt: string; truncated: boolean }
    }
    expect(body).toEqual({
      status: 'ready',
      stale: false,
      currentVersion: 3,
      summary: 'Generated summary',
      meta: {
        provider: 'workers',
        model: WORKERS_MODEL,
        forVersion: 3,
        generatedAt: body.meta.generatedAt,
        truncated: false,
      },
    })
    const [stored] = await db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    expect(stored).toMatchObject({
      siteId,
      summary: 'Generated summary',
      contentVersion: 3,
      promptVersion: PROMPT_VERSION,
      provider: 'workers',
      model: WORKERS_MODEL,
      generatedBy: poster,
      truncated: false,
      updatedAt: body.meta.generatedAt,
    })
  })

  test('C18 a fresh cached POST is economically free and returns the stored ready response', async () => {
    const { app, env, db, r2, user: poster, siteId } = await seedApp('cache-poster')
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<p>Cache me once.</p>' })
    let aiCalls = 0
    let limiterCalls = 0
    const requestEnv = bindings(env, {
      AI: countingAi('Summary 1', () => aiCalls++),
      SUMMARY_LIMITER: countingLimiter(true, () => limiterCalls++),
    })

    const first = await app.request(url, { method: 'POST', headers: auth(poster), body: '{}' }, requestEnv)
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    const r2Before = r2.gets()
    limiterCalls = 0
    db.resetCounters()

    const cached = await app.request(url, { method: 'POST', headers: auth(poster), body: '{}' }, requestEnv)
    expect(cached.status).toBe(200)
    expect(await cached.json()).toEqual(firstBody)
    expect(aiCalls).toBe(1)
    expect(r2.gets() - r2Before).toBe(0)
    expect(limiterCalls).toBe(0)
    expect(db.counters.insert).toBe(0)
    expect(db.counters.update).toBe(0)
  })

  test('C24 access matrix allows every access tier and gates denials before side effects', async () => {
    const allowedSetups: Array<{
      name: string
      setup: () => Promise<{
        app: ReturnType<typeof makeRouteApp>['app']
        env: AppEnv['Bindings']
        user: string
      }>
    }> = [
      {
        name: 'space member',
        setup: async () => {
          const { app, env, db, kv, spaceId } = await seedApp('member-owner', { visibility: 'members' })
          const user = await mintUser(db, kv, 'space-member')
          await seedMember(db, spaceId, user)
          return { app, env, user }
        },
      },
      {
        name: 'team user',
        setup: async () => {
          const { app, env, db, kv } = await seedApp('team-owner', { visibility: 'team' })
          const user = await mintUser(db, kv, 'team-user')
          return { app, env, user }
        },
      },
      {
        name: 'direct share',
        setup: async () => {
          const { app, env, db, kv, siteId } = await seedApp('direct-owner', { visibility: 'private' })
          const user = await mintUser(db, kv, 'direct-viewer')
          await seedUserShare(db, siteId, user)
          return { app, env, user }
        },
      },
      {
        name: 'group share',
        setup: async () => {
          const { app, env, db, kv, user: owner, siteId } = await seedApp('group-owner', { visibility: 'private' })
          const user = await mintUser(db, kv, 'group-viewer')
          const group = await seedSpace(db, { createdBy: owner, slug: 'viewers', type: 'group' })
          await seedMember(db, group, user)
          await seedGroupShare(db, siteId, group)
          return { app, env, user }
        },
      },
      {
        name: 'superadmin archived bypass',
        setup: async () => {
          const { app, env, db, kv } = await seedApp('super-owner', { visibility: 'private', status: 'archived' })
          const user = await mintUser(db, kv, 'root', { role: 'superadmin' })
          return { app, env, user }
        },
      },
    ]

    for (const allowed of allowedSetups) {
      const { app, env, user } = await allowed.setup()
      const response = await app.request(url, { headers: auth(user) }, env)
      expect(response.status, allowed.name).toBe(200)
    }

    const denialSetups: Array<{
      name: string
      expectedStatus: number
      expectedBody: { error: string }
      setup: () => Promise<{
        route: ReturnType<typeof makeRouteApp>
        headers?: Record<string, string>
      }>
    }> = [
      {
        name: 'private outsider',
        expectedStatus: 403,
        expectedBody: { error: 'forbidden' },
        setup: async () => {
          const route = await seedApp('private-owner', { visibility: 'private' })
          const outsider = await mintUser(route.db, route.kv, 'private-outsider')
          return { route, headers: auth(outsider) }
        },
      },
      {
        name: 'missing site',
        expectedStatus: 404,
        expectedBody: { error: 'not found' },
        setup: async () => {
          const route = makeRouteApp()
          const user = await mintUser(route.db, route.kv, 'missing-user')
          return { route, headers: auth(user) }
        },
      },
      {
        name: 'archived site',
        expectedStatus: 410,
        expectedBody: { error: 'forbidden' },
        setup: async () => {
          const route = await seedApp('archived-owner', { status: 'archived' })
          return { route, headers: auth(route.user) }
        },
      },
      {
        name: 'unauthenticated',
        expectedStatus: 401,
        expectedBody: { error: 'unauthorized' },
        setup: async () => {
          const route = await seedApp('unauth-owner')
          return { route }
        },
      },
      {
        name: 'same slug in another space is isolated',
        expectedStatus: 403,
        expectedBody: { error: 'forbidden' },
        setup: async () => {
          const route = await seedApp('isolation-owner', { visibility: 'private' })
          const owner = route.user
          const outsider = await mintUser(route.db, route.kv, 'isolation-outsider')
          const other = await seedSpace(route.db, { createdBy: owner, slug: 'other' })
          await seedSite(route.db, { spaceId: other, ownerId: outsider, slug: 'doc', visibility: 'team' })
          return { route, headers: auth(outsider) }
        },
      },
    ]

    for (const denial of denialSetups) {
      const { route, headers } = await denial.setup()
      let aiCalls = 0
      let limiterCalls = 0
      const requestEnv = bindings(route.env, {
        AI: countingAi('unused', () => aiCalls++),
        SUMMARY_LIMITER: countingLimiter(true, () => limiterCalls++),
      })
      const r2Before = route.r2.gets()
      route.db.resetCounters()
      const response = await route.app.request(
        url,
        { method: 'POST', ...(headers ? { headers, body: '{}' } : {}) },
        requestEnv,
      )
      expect(response.status, denial.name).toBe(denial.expectedStatus)
      expect(await response.json(), denial.name).toEqual(denial.expectedBody)
      expect(aiCalls, denial.name).toBe(0)
      expect(route.r2.gets() - r2Before, denial.name).toBe(0)
      expect(limiterCalls, denial.name).toBe(0)
      expect(route.db.counters.insert + route.db.counters.update + route.db.counters.delete, denial.name).toBe(0)
    }
  })

  test('C26 nothing-to-summarize cases return 422 with exact R2 counts and no AI', async () => {
    const cases = [
      { name: 'zero files', expectedR2: 0, seed: async () => {} },
      {
        name: 'multi-file without root index',
        expectedR2: 0,
        seed: async (db: ReturnType<typeof makeRouteApp>['db'], r2: ReturnType<typeof makeRouteApp>['r2'], siteId: string) => {
          await seedFile(db, r2, siteId, { path: 'about.html', text: '<p>about</p>' })
          await seedFile(db, r2, siteId, { path: 'docs/index.html', text: '<p>docs</p>' })
        },
      },
      {
        name: 'unsupported root entry',
        expectedR2: 0,
        seed: async (db: ReturnType<typeof makeRouteApp>['db'], r2: ReturnType<typeof makeRouteApp>['r2'], siteId: string) => {
          await seedFile(db, r2, siteId, { path: 'app.js', mimeType: 'text/javascript', text: 'alert(1)' })
        },
      },
      {
        name: 'missing R2 object',
        expectedR2: 1,
        seed: async (db: ReturnType<typeof makeRouteApp>['db'], _r2: ReturnType<typeof makeRouteApp>['r2'], siteId: string) => {
          await seedFile(db, null, siteId, { path: 'index.html', text: '<p>missing</p>' })
        },
      },
    ]

    for (const scenario of cases) {
      const seeded = await seedApp(`poster-${scenario.name.replaceAll(' ', '-')}`)
      const { user: poster, siteId } = seeded
      const route = seeded
      await scenario.seed(route.db, route.r2, siteId)
      let aiCalls = 0
      const requestEnv = bindings(route.env, {
        AI: countingAi('unused', () => aiCalls++),
        SUMMARY_LIMITER: okLimiter,
      })
      const r2Before = route.r2.gets()

      const response = await route.app.request(
        url,
        { method: 'POST', headers: auth(poster), body: '{}' },
        requestEnv,
      )
      expect(response.status, scenario.name).toBe(422)
      expect(await response.json(), scenario.name).toEqual({ error: 'nothing to summarize' })
      expect(route.r2.gets() - r2Before, scenario.name).toBe(scenario.expectedR2)
      expect(aiCalls, scenario.name).toBe(0)
    }
  })

  test('C28 generation failure leaves a good row byte-identical and creates no cold row', async () => {
    const seeded = await seedApp('failure-poster')
    const { user: poster, siteId } = seeded
    await seedFile(seeded.db, seeded.r2, siteId, { path: 'index.html', text: '<p>good source</p>' })
    await seedSummary(seeded.db, siteId, {
      summary: 'Keep this summary',
      generatedBy: poster,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    const [before] = await seeded.db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    const failingEnv = bindings(seeded.env, {
      AI: { run: async () => Promise.reject(new Error('provider down')) },
      SUMMARY_LIMITER: okLimiter,
    })

    const forced = await seeded.app.request(
      url,
      { method: 'POST', headers: auth(poster), body: JSON.stringify({ force: true }) },
      failingEnv,
    )
    expect(forced.status).toBe(502)
    expect(await forced.json()).toEqual({ error: 'generation failed', retryable: true })
    const [after] = await seeded.db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    expect(after).toEqual(before)

    const cold = await seedApp('cold-failure-poster')
    const { user: coldPoster, siteId: coldSite } = cold
    await seedFile(cold.db, cold.r2, coldSite, { path: 'index.html', text: '<p>cold source</p>' })
    const coldEnv = bindings(cold.env, {
      AI: { run: async () => Promise.reject(new Error('provider down')) },
      SUMMARY_LIMITER: okLimiter,
    })
    const failed = await cold.app.request(
      url,
      { method: 'POST', headers: auth(coldPoster), body: '{}' },
      coldEnv,
    )
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: 'generation failed', retryable: true })
    expect(await cold.db.$count(siteSummaries)).toBe(0)
    const get = await cold.app.request(url, { headers: auth(coldPoster) }, coldEnv)
    expect(await get.json()).toEqual({ status: 'none', stale: false, currentVersion: 0 })
  })

  test('C29 limiter keys generation attempts by user id and never charges a cache hit', async () => {
    const cold = await seedApp('limited-poster')
    const { user: poster, siteId } = cold
    await seedFile(cold.db, cold.r2, siteId, { path: 'index.html', text: '<p>never read</p>' })
    const keys: string[] = []
    let aiCalls = 0
    const deniedEnv = bindings(cold.env, {
      AI: countingAi('unused', () => aiCalls++),
      SUMMARY_LIMITER: countingLimiter(false, ({ key }) => keys.push(key)),
    })
    const r2Before = cold.r2.gets()
    cold.db.resetCounters()
    const denied = await cold.app.request(
      url,
      { method: 'POST', headers: auth(poster), body: '{}' },
      deniedEnv,
    )
    expect(denied.status).toBe(429)
    expect(await denied.json()).toEqual({ error: 'rate limited' })
    expect(keys).toEqual([poster])
    expect(aiCalls).toBe(0)
    expect(cold.r2.gets() - r2Before).toBe(0)
    expect(cold.db.counters.insert + cold.db.counters.update + cold.db.counters.delete).toBe(0)

    const cached = await seedApp('cached-poster')
    const { user: cachedPoster, siteId: cachedSite } = cached
    await seedSummary(cached.db, cachedSite, { summary: 'Already ready', generatedBy: cachedPoster })
    let cacheLimiterCalls = 0
    const cachedEnv = bindings(cached.env, {
      AI: countingAi('unused'),
      SUMMARY_LIMITER: countingLimiter(false, () => cacheLimiterCalls++),
    })
    const response = await cached.app.request(
      url,
      { method: 'POST', headers: auth(cachedPoster), body: '{}' },
      cachedEnv,
    )
    expect(response.status).toBe(200)
    expect(cacheLimiterCalls).toBe(0)
  })

  test('C20 a content-version bump serves stale text until POST regenerates the new version', async () => {
    const route = await seedApp('content-poster')
    const { user: poster, siteId } = route
    await seedFile(route.db, route.r2, siteId, { path: 'index.html', text: '<p>new content</p>' })
    await seedSummary(route.db, siteId, { summary: 'Old text', generatedBy: poster })
    await route.db.update(sites).set({ contentVersion: 1 }).where(eq(sites.id, siteId))
    const requestEnv = bindings(route.env, {
      AI: countingAi('New text'),
      SUMMARY_LIMITER: okLimiter,
    })

    const stale = await route.app.request(url, { headers: auth(poster) }, requestEnv)
    expect(await stale.json()).toEqual({
      status: 'ready',
      stale: true,
      currentVersion: 1,
      summary: 'Old text',
      meta: {
        provider: 'workers',
        model: WORKERS_MODEL,
        forVersion: 0,
        generatedAt,
        truncated: false,
      },
    })
    const regenerated = await route.app.request(
      url,
      { method: 'POST', headers: auth(poster), body: '{}' },
      requestEnv,
    )
    const regeneratedBody = (await regenerated.json()) as { meta: { forVersion: number }; stale: boolean }
    expect(regenerated.status).toBe(200)
    expect(regeneratedBody.meta.forVersion).toBe(1)
    expect(regeneratedBody.stale).toBe(false)
  })

  test('C21 a prompt-version mismatch is stale and regeneration stamps the current prompt', async () => {
    const route = await seedApp('prompt-poster')
    const { user: poster, siteId } = route
    await seedFile(route.db, route.r2, siteId, { path: 'index.html', text: '<p>prompt source</p>' })
    await seedSummary(route.db, siteId, {
      summary: 'Old prompt text',
      promptVersion: PROMPT_VERSION - 1,
      generatedBy: poster,
    })
    const requestEnv = bindings(route.env, {
      AI: countingAi('Current prompt text'),
      SUMMARY_LIMITER: okLimiter,
    })

    const stale = await route.app.request(url, { headers: auth(poster) }, requestEnv)
    expect((await stale.json()).stale).toBe(true)
    const regenerated = await route.app.request(
      url,
      { method: 'POST', headers: auth(poster), body: '{}' },
      requestEnv,
    )
    expect(regenerated.status).toBe(200)
    const [stored] = await route.db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    expect(stored.promptVersion).toBe(PROMPT_VERSION)
  })

  test('C19 force regenerates a fresh row exactly once and changes summary plus updatedAt', async () => {
    const route = await seedApp('force-poster')
    const { user: poster, siteId } = route
    await seedFile(route.db, route.r2, siteId, { path: 'index.html', text: '<p>force source</p>' })
    await seedSummary(route.db, siteId, { summary: 'Before force', generatedBy: poster })
    let aiCalls = 0
    const requestEnv = bindings(route.env, {
      AI: countingAi('After force', () => aiCalls++),
      SUMMARY_LIMITER: okLimiter,
    })
    const response = await route.app.request(
      url,
      { method: 'POST', headers: auth(poster), body: JSON.stringify({ force: true }) },
      requestEnv,
    )
    expect(response.status).toBe(200)
    expect(aiCalls).toBe(1)
    const [stored] = await route.db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    expect(stored.summary).toBe('After force')
    expect(stored.updatedAt).not.toBe(generatedAt)
  })

  test('C25 cookie-authenticated foreign-origin POST is rejected by the global CSRF guard', async () => {
    const { app, env } = makeRouteApp()
    const response = await app.request(
      url,
      {
        method: 'POST',
        headers: {
          cookie: 'glance_session=x',
          Origin: 'https://evil.example.com',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
      env,
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'csrf' })
  })

  test('C27 no provider returns unavailable before R2/limiter while GET still serves a ready row', async () => {
    const cold = await seedApp('no-provider-poster')
    const { user: poster, siteId } = cold
    await seedFile(cold.db, cold.r2, siteId, { path: 'index.html', text: '<p>must not read</p>' })
    let limiterCalls = 0
    const noProviderEnv = bindings(cold.env, {
      SUMMARY_LIMITER: countingLimiter(true, () => limiterCalls++),
    })
    const r2Before = cold.r2.gets()
    const unavailable = await cold.app.request(
      url,
      { method: 'POST', headers: auth(poster), body: '{}' },
      noProviderEnv,
    )
    expect(unavailable.status).toBe(200)
    expect(await unavailable.json()).toEqual({ status: 'unavailable', stale: false, currentVersion: 0 })
    expect(cold.r2.gets() - r2Before).toBe(0)
    expect(limiterCalls).toBe(0)

    await seedSummary(cold.db, siteId, { summary: 'Available from storage', generatedBy: poster })
    const ready = await cold.app.request(url, { headers: auth(poster) }, noProviderEnv)
    expect(await ready.json()).toEqual({
      status: 'ready',
      stale: false,
      currentVersion: 0,
      summary: 'Available from storage',
      meta: {
        provider: 'workers',
        model: WORKERS_MODEL,
        forVersion: 0,
        generatedAt,
        truncated: false,
      },
    })
  })

  test('C22 generation stamps the version read before AI and a mid-flight bump makes GET stale', async () => {
    const route = await seedApp('race-poster')
    const { user: poster, siteId } = route
    await route.db.update(sites).set({ contentVersion: 4 }).where(eq(sites.id, siteId))
    await seedFile(route.db, route.r2, siteId, { path: 'index.html', text: '<p>race source</p>' })
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const aiEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const requestEnv = bindings(route.env, {
      AI: {
        run: async () => {
          entered()
          await paused
          return { response: 'Race summary' }
        },
      },
      SUMMARY_LIMITER: okLimiter,
    })

    const pending = route.app.request(
      url,
      { method: 'POST', headers: auth(poster), body: '{}' },
      requestEnv,
    )
    await aiEntered
    await route.db.update(sites).set({ contentVersion: 5 }).where(eq(sites.id, siteId))
    release()
    const generated = await pending
    expect(generated.status).toBe(200)
    const [stored] = await route.db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    expect(stored.contentVersion).toBe(4)
    const followUp = await route.app.request(url, { headers: auth(poster) }, requestEnv)
    const followUpBody = (await followUp.json()) as { stale: boolean; currentVersion: number; meta: { forVersion: number } }
    expect(followUpBody.stale).toBe(true)
    expect(followUpBody.currentVersion).toBe(5)
    expect(followUpBody.meta.forVersion).toBe(4)
  })

  test('C23 concurrent cold POSTs converge on one coherent last-write-wins row', async () => {
    const route = await seedApp('concurrent-owner', { visibility: 'team' })
    const { user: owner, siteId } = route
    const other = await mintUser(route.db, route.kv, 'concurrent-other')
    await route.db.update(sites).set({ contentVersion: 9 }).where(eq(sites.id, siteId))
    await seedFile(route.db, route.r2, siteId, { path: 'index.html', text: '<p>concurrent source</p>' })
    let entered = 0
    let release!: () => void
    let bothEntered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      bothEntered = resolve
    })
    const requestEnv = bindings(route.env, {
      AI: {
        run: async () => {
          entered++
          if (entered === 2) bothEntered()
          await gate
          return { response: 'Same concurrent summary' }
        },
      },
      SUMMARY_LIMITER: okLimiter,
    })
    const first = route.app.request(url, { method: 'POST', headers: auth(owner), body: '{}' }, requestEnv)
    const second = route.app.request(url, { method: 'POST', headers: auth(other), body: '{}' }, requestEnv)
    await ready
    release()
    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(await route.db.$count(siteSummaries)).toBe(1)
    const [winner] = await route.db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    expect(winner).toMatchObject({
      siteId,
      summary: 'Same concurrent summary',
      contentVersion: 9,
      promptVersion: PROMPT_VERSION,
      provider: 'workers',
      model: WORKERS_MODEL,
      truncated: false,
    })
    expect([owner, other]).toContain(winner.generatedBy)
  })
})
