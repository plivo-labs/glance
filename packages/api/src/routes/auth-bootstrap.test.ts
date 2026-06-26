import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { users } from '../db/schema'
import { makeDb, makeKv } from '../test/harness'
import type { AppEnv } from '../types'
import { auth } from './auth'

const APP_URL = 'https://glance.example.com'
const TOKEN = 'the-bootstrap-token'

function setup(overrides: Partial<AppEnv['Bindings']> = {}) {
  const db = makeDb()
  const kv = makeKv()
  const env = {
    APP_URL,
    SESSION_SECRET: 'sess-secret',
    SUPERADMIN_EMAIL: 'owner@example.com',
    BOOTSTRAP_TOKEN: TOKEN,
    GLANCE_SESSIONS: kv,
    ...overrides,
  } as unknown as AppEnv['Bindings']

  // Mirror index.ts wiring minus the real D1 withDb: inject the in-memory db.
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/auth', auth)
  return { app, env, db, kv }
}

const sameOrigin = { Origin: APP_URL, 'Content-Type': 'application/json' }

function post(app: Hono<AppEnv>, env: AppEnv['Bindings'], body: unknown, headers: Record<string, string> = sameOrigin) {
  return app.request('/api/auth/bootstrap', { method: 'POST', headers, body: JSON.stringify(body) }, env)
}

describe('POST /api/auth/bootstrap', () => {
  test('route-cross-origin-post-403: foreign Origin & no session cookie → 403 (own check)', async () => {
    const { app, env } = setup()
    const res = await post(app, env, { token: TOKEN }, { Origin: 'https://evil.com', 'Content-Type': 'application/json' })
    expect(res.status).toBe(403)
  })

  test('route-success-mints-session-and-superadmin: 200 + session cookie + superadmin googleId null', async () => {
    const { app, env, db } = setup()
    const res = await post(app, env, { token: TOKEN })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').toContain('glance_session=')

    const rows = await db.select().from(users).where(eq(users.email, 'owner@example.com'))
    expect(rows[0]?.role).toBe('superadmin')
    expect(rows[0]?.googleId).toBeNull()
  })

  test('route-token-from-body-only: token in query string is ignored → 401', async () => {
    const { app, env } = setup()
    const res = await app.request(
      `/api/auth/bootstrap?token=${TOKEN}`,
      { method: 'POST', headers: sameOrigin, body: JSON.stringify({}) },
      env,
    )
    expect(res.status).toBe(401)
  })

  test('inert without a configured token → 404', async () => {
    const { app, env } = setup({ BOOTSTRAP_TOKEN: undefined })
    const res = await post(app, env, { token: 'whatever' })
    expect(res.status).toBe(404)
  })

  test('different superadmin already exists → 410', async () => {
    const { app, env, db } = setup()
    await db.insert(users).values({ id: 'x', email: 'someone@else.com', role: 'superadmin' })
    const res = await post(app, env, { token: TOKEN })
    expect(res.status).toBe(410)
  })

  test('route-rate-limited-after-N-fails: repeated bad tokens from one IP → 429', async () => {
    const { app, env } = setup()
    const headers = { ...sameOrigin, 'CF-Connecting-IP': '5.5.5.5' }
    let last = 0
    for (let i = 0; i < 6; i++) {
      last = (await post(app, env, { token: 'wrong' }, headers)).status
    }
    expect(last).toBe(429)
  })
})
