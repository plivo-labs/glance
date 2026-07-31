import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { generateApiKey, hashApiKey } from '../lib/api-key'
import { createSession } from '../lib/session'
import { makeDb, makeKv, seedApiKey, seedUser } from '../test/harness'
import type { AppEnv, SessionUser } from '../types'
import { auth } from './auth'

// POST /api/auth/logout — cookie logout, CLI-Bearer logout, and (the gap this file pins) a
// key-authenticated logout, which must NOT report success for a revocation it did not perform.

function setup() {
  const db = makeDb()
  const kv = makeKv()
  const env = {
    APP_URL: 'https://glance.example.com',
    SESSION_SECRET: 'sess-secret',
    GLANCE_SESSIONS: kv,
  } as unknown as AppEnv['Bindings']
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/auth', auth)
  return { app, env, db, kv }
}

async function sessionCookie(app: Hono<AppEnv>, env: AppEnv['Bindings'], user: SessionUser) {
  app.get('/login', async (c) => {
    await createSession(c, user)
    return c.text('ok')
  })
  const res = await app.request('/login', {}, env)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

describe('POST /api/auth/logout', () => {
  test('characterization: cookie logout returns { ok: true } and the cookie no longer authenticates', async () => {
    const { app, db, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const cookie = await sessionCookie(app, env, { id: uid, email: 'u1@x.com', name: null, role: 'member' })

    const before = await app.request('/api/auth/me', { headers: { Cookie: cookie } }, env)
    expect(before.status).toBe(200)

    const res = await app.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const after = await app.request('/api/auth/me', { headers: { Cookie: cookie } }, env)
    expect(after.status).toBe(401)
  })

  test('characterization: CLI-Bearer logout returns { ok: true } and the KV token is really gone', async () => {
    const { app, kv, env } = setup()
    const uid = 'u1'
    await kv.put(`cli:tok-${uid}`, JSON.stringify({ id: uid, email: 'u1@x.com', name: null, role: 'member' }))
    await kv.put(`cli_index:${uid}:tok-${uid}`, '')

    const res = await app.request(
      '/api/auth/logout',
      { method: 'POST', headers: { Authorization: `Bearer tok-${uid}` } },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(kv.store.has(`cli:tok-${uid}`)).toBe(false)

    const after = await app.request(
      '/api/auth/me',
      { headers: { Authorization: `Bearer tok-${uid}` } },
      env,
    )
    expect(after.status).toBe(401)
  })

  test('CASE-17: a key-authenticated logout does not report success, and the key still authenticates afterwards', async () => {
    const { app, db, env } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const secret = generateApiKey()
    await seedApiKey(db, { userId: uid, hash: await hashApiKey(secret) })

    const res = await app.request(
      '/api/auth/logout',
      { method: 'POST', headers: { Authorization: `Bearer ${secret}` } },
      env,
    )
    // Must not report success — a key is not a session, and logout did not revoke it. Asserted
    // as the exact status, not `not.toBe(200)`: the latter stays green if this ever degrades
    // into a 500, which is a crash rather than the deliberate refusal this route now returns.
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).not.toBe(true)
    expect(JSON.stringify(body).toLowerCase()).toContain('keys screen')

    // Not revoked here — the key must still authenticate.
    const after = await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${secret}` } }, env)
    expect(after.status).toBe(200)
  })
})
