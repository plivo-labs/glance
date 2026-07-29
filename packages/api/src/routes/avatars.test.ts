import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { makeDb, makeKv, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { avatars } from './avatars'

// GET /api/avatars/:userId — the same-origin photo proxy. What matters here: an authenticated
// caller only ever gets IMAGE bytes, the worker only ever fetches a googleusercontent host, and
// every miss is a 404 (the signal the client turns into initials) rather than an error page.

const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocABC=s96-c'

function setup() {
  const db = makeDb()
  const kv = makeKv()
  const env = { APP_URL: 'https://glance.example.com', SESSION_SECRET: 's', GLANCE_SESSIONS: kv } as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/avatars', avatars)
  return { app, env, db, kv }
}

async function bearer(kv: ReturnType<typeof makeKv>, userId: string) {
  await kv.put(
    `cli:tok-${userId}`,
    JSON.stringify({ id: userId, email: `${userId}@x.com`, name: null, role: 'member' }),
  )
  return { Authorization: `Bearer tok-${userId}` }
}

/** Stand in for the upstream Google fetch, recording every URL the worker asks for. */
const realFetch = globalThis.fetch
function stubFetch(response: Response | Error): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    if (response instanceof Error) throw response
    return response.clone()
  }) as typeof fetch
  return calls
}
const imageResponse = (type = 'image/jpeg', bytes = new Uint8Array([1, 2, 3])) =>
  new Response(bytes, { headers: { 'content-type': type, 'content-length': String(bytes.length) } })

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('GET /api/avatars/:userId', () => {
  test('proxies the stored photo as image bytes, cached and same-origin', async () => {
    const { app, env, db, kv } = setup()
    const uid = await seedUser(db, { id: 'u1', avatarUrl: PHOTO })
    const calls = stubFetch(imageResponse())

    const res = await app.request(`/api/avatars/${uid}`, { headers: await bearer(kv, uid) }, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toContain('private')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    // Thumbnail-sized, and never a URL the browser was told about.
    expect(calls).toEqual(['https://lh3.googleusercontent.com/a/ACg8ocABC=s96-c'])
  })

  test('404s for a user with no photo — the fallback-to-initials signal', async () => {
    const { app, env, db, kv } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const calls = stubFetch(imageResponse())

    const res = await app.request(`/api/avatars/${uid}`, { headers: await bearer(kv, uid) }, env)

    expect(res.status).toBe(404)
    expect(calls).toEqual([]) // nothing to fetch → no upstream request at all
  })

  test('404s for an unknown user id (no enumeration difference)', async () => {
    const { app, env, db, kv } = setup()
    const uid = await seedUser(db, { id: 'u1', avatarUrl: PHOTO })
    stubFetch(imageResponse())

    const res = await app.request('/api/avatars/nobody', { headers: await bearer(kv, uid) }, env)

    expect(res.status).toBe(404)
  })

  test('re-pins the host at fetch time: a poisoned stored URL is never fetched', async () => {
    const { app, env, db, kv } = setup()
    const uid = await seedUser(db, { id: 'u1', avatarUrl: 'http://169.254.169.254/latest/meta-data/' })
    const calls = stubFetch(imageResponse())

    const res = await app.request(`/api/avatars/${uid}`, { headers: await bearer(kv, uid) }, env)

    expect(res.status).toBe(404)
    expect(calls).toEqual([])
  })

  test('404s when upstream returns a non-image, an oversized body, or an error', async () => {
    const { app, env, db, kv } = setup()
    const uid = await seedUser(db, { id: 'u1', avatarUrl: PHOTO })
    const headers = await bearer(kv, uid)

    stubFetch(new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } }))
    expect((await app.request(`/api/avatars/${uid}`, { headers }, env)).status).toBe(404)

    stubFetch(
      new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/png', 'content-length': String(3 * 1024 * 1024) },
      }),
    )
    expect((await app.request(`/api/avatars/${uid}`, { headers }, env)).status).toBe(404)

    stubFetch(new Response('nope', { status: 500, headers: { 'content-type': 'image/png' } }))
    expect((await app.request(`/api/avatars/${uid}`, { headers }, env)).status).toBe(404)

    stubFetch(new Error('network down'))
    expect((await app.request(`/api/avatars/${uid}`, { headers }, env)).status).toBe(404)
  })

  test('requires auth — an anonymous caller gets no photo', async () => {
    const { app, env, db } = setup()
    const uid = await seedUser(db, { id: 'u1', avatarUrl: PHOTO })
    const calls = stubFetch(imageResponse())

    const res = await app.request(`/api/avatars/${uid}`, {}, env)

    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })
})
