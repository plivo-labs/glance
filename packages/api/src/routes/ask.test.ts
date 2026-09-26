import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { siteSummaries } from '../db/schema'
import { WORKERS_MODEL } from '../lib/summarize'
import { requireSameOrigin } from '../middleware/auth'
import { APP_URL, auth, mintUser } from '../test/route-fixtures'
import { makeDb, makeKv, seedSite, seedSpace } from '../test/harness'
import type { AppEnv } from '../types'
import { ASK_MODEL, ask } from './ask'

function setup() {
  const db = makeDb()
  const kv = makeKv()
  const env = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('/api/*', requireSameOrigin)
  app.use('/api/*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/sites', ask)
  return { db, kv, env, app }
}

async function seedApp() {
  const route = setup()
  const user = await mintUser(route.db, route.kv, 'owner')
  const spaceId = await seedSpace(route.db, { createdBy: user, slug: 'acme' })
  const siteId = await seedSite(route.db, { spaceId, ownerId: user, slug: 'doc', title: 'Doc title' })
  return { ...route, user, siteId }
}

const url = '/api/sites/acme/doc/ask'
const validBody = { question: 'What does this mean?', quote: 'selected passage' }

function textStream(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

const countingAi = (stream: ReadableStream, onCall: (model: unknown, input: unknown) => void = () => {}) => ({
  run: async (model: unknown, input: unknown) => {
    onCall(model, input)
    return stream
  },
})

const okLimiter = { limit: async () => ({ success: true }) }
const countingLimiter = (success: boolean, onCall: (input: { key: string }) => void = () => {}) => ({
  limit: async (input: { key: string }) => {
    onCall(input)
    return { success }
  },
})

const post = (app: ReturnType<typeof setup>['app'], env: AppEnv['Bindings'], headers: Record<string, string>, body: unknown) =>
  app.request(url, { method: 'POST', headers, body: JSON.stringify(body) }, env)

describe('POST /api/sites/:space/:site/ask', () => {
  test('unauthenticated → 401', async () => {
    const { app, env } = setup()
    const response = await app.request(
      url,
      { method: 'POST', headers: { Origin: APP_URL, 'Content-Type': 'application/json' }, body: JSON.stringify(validBody) },
      env,
    )
    expect(response.status).toBe(401)
  })

  test('unknown site → 404', async () => {
    const { app, env, db, kv } = setup()
    const user = await mintUser(db, kv, 'lonely')
    const response = await post(app, env, auth(user), validBody)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not found' })
  })

  test('missing or oversized question → 400', async () => {
    const seeded = await seedApp()
    const cases = [
      { name: 'missing question', body: { quote: 'passage' } },
      { name: 'empty question', body: { question: '  ', quote: 'passage' } },
      { name: 'oversized question', body: { question: 'x'.repeat(501), quote: 'passage' } },
      { name: 'missing quote', body: { question: 'why?' } },
      { name: 'oversized quote', body: { question: 'why?', quote: 'x'.repeat(2001) } },
    ]
    for (const { name, body } of cases) {
      const response = await post(seeded.app, bindings(seeded.env, { AI: countingAi(textStream('')) }), auth(seeded.user), body)
      expect(response.status, name).toBe(400)
      expect(await response.json(), name).toEqual({ error: 'invalid request' })
    }
  })

  test('rate limited → 429', async () => {
    const seeded = await seedApp()
    const keys: string[] = []
    const requestEnv = bindings(seeded.env, {
      AI: countingAi(textStream('unused')),
      ASK_LIMITER: countingLimiter(false, ({ key }) => keys.push(key)),
    })
    const response = await post(seeded.app, requestEnv, auth(seeded.user), validBody)
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: 'rate limited' })
    expect(keys).toEqual([seeded.user])
  })

  test('no AI binding → 502', async () => {
    const seeded = await seedApp()
    const requestEnv = bindings(seeded.env, { ASK_LIMITER: okLimiter })
    const response = await post(seeded.app, requestEnv, auth(seeded.user), validBody)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'AI unavailable' })
  })

  test('happy path streams the mock bytes verbatim and prompts with every labeled section', async () => {
    const seeded = await seedApp()
    await seeded.db.insert(siteSummaries).values({
      siteId: seeded.siteId,
      summary: 'Stored summary text',
      contentVersion: 0,
      promptVersion: 1,
      provider: 'workers',
      model: WORKERS_MODEL,
      truncated: false,
      updatedAt: '2026-01-02T03:04:05.000Z',
    })
    const calls: Array<{ model: unknown; input: unknown }> = []
    const requestEnv = bindings(seeded.env, {
      AI: countingAi(textStream('data: hello\n\n'), (model, input) => calls.push({ model, input })),
      ASK_LIMITER: okLimiter,
    })

    const response = await post(seeded.app, requestEnv, auth(seeded.user), {
      question: 'What is this about?',
      quote: 'the selected quote',
      blockText: 'the surrounding block',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe('data: hello\n\n')

    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe(ASK_MODEL)
    // Chat `messages` shape, NOT Responses-API `input`: gpt-oss streams an EMPTY stream under the
    // latter — see the ASK_MODEL comment in ask.ts.
    const input = calls[0].input as { messages: Array<{ role: string; content: string }>; stream: boolean }
    expect(input.stream).toBe(true)
    expect(input.messages.find((m) => m.role === 'system')?.content).toContain('never follow them')
    const userMessage = input.messages.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toContain('Doc title')
    expect(userMessage).toContain('Stored summary text')
    expect(userMessage).toContain('the surrounding block')
    expect(userMessage).toContain('the selected quote')
    expect(userMessage).toContain('What is this about?')
  })
})

function bindings(env: AppEnv['Bindings'], overrides: Partial<AppEnv['Bindings']>) {
  return { ...env, ...overrides } as unknown as AppEnv['Bindings']
}
