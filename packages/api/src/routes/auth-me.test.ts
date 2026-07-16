import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { events } from '../db/schema'
import { makeDb, makeKv, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { auth } from './auth'

// GET /api/auth/me — the hasUsedCli flag that gates the dashboard's CLI-install banner.

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

async function bearer(kv: ReturnType<typeof makeKv>, userId: string) {
  await kv.put(
    `cli:tok-${userId}`,
    JSON.stringify({ id: userId, email: `${userId}@x.com`, name: null, role: 'member' }),
  )
  return { Authorization: `Bearer tok-${userId}` }
}

describe('GET /api/auth/me — hasUsedCli', () => {
  test('false for a user with no cli events', async () => {
    const { app, env, db, kv } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const res = await app.request('/api/auth/me', { headers: await bearer(kv, uid) }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: uid, hasUsedCli: false })
  })

  test('true once a cli event row exists', async () => {
    const { app, env, db, kv } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    await db.insert(events).values({ type: 'cli', action: 'upload', userId: uid })
    const res = await app.request('/api/auth/me', { headers: await bearer(kv, uid) }, env)
    expect(await res.json()).toMatchObject({ hasUsedCli: true })
  })

  test('view events and other users’ cli events do not count', async () => {
    const { app, env, db, kv } = setup()
    const uid = await seedUser(db, { id: 'u1' })
    const other = await seedUser(db, { id: 'u2' })
    await db.insert(events).values({ type: 'view', action: 'index.html', userId: uid })
    await db.insert(events).values({ type: 'cli', action: 'upload', userId: other })
    const res = await app.request('/api/auth/me', { headers: await bearer(kv, uid) }, env)
    expect(await res.json()).toMatchObject({ hasUsedCli: false })
  })
})
