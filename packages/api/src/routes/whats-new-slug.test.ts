import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createPersonalSpace } from '../db/repo'
import { spaces as spacesTable } from '../db/schema'
import { isValidSlug } from '../lib/slug'
import { requireSameOrigin } from '../middleware/auth'
import { makeDb, makeKv, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { spaces } from './spaces'

const APP_URL = 'https://glance.example.com'

describe('E1 slug.reserved — whats-new is a reserved system slug', () => {
  test('isValidSlug rejects whats-new', () => {
    expect(isValidSlug('whats-new')).toBe(false)
  })

  test('POST /api/spaces { slug: "whats-new" } → 400 invalid slug', async () => {
    const db = makeDb()
    const kv = makeKv()
    const env = { APP_URL, SESSION_SECRET: 's', GLANCE_SESSIONS: kv } as unknown as AppEnv['Bindings']
    const app = new Hono<AppEnv>()
    app.use('/api/*', requireSameOrigin)
    app.use('/api/*', async (c, next) => {
      c.set('db', db)
      await next()
    })
    app.route('/api/spaces', spaces)
    await seedUser(db, { id: 'u1' })
    await kv.put('cli:tok-u1', JSON.stringify({ id: 'u1', email: 'u1@example.com', name: null, role: 'member' }))
    const res = await app.request(
      '/api/spaces',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-u1', Origin: APP_URL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'whats-new', name: 'Whats New' }),
      },
      env,
    )
    expect(res.status).toBe(400)
  })

  test('createPersonalSpace collision-avoids the reserved slug → whats-new-1', async () => {
    const db = makeDb()
    const uid = await seedUser(db, { id: 'u1' })
    await createPersonalSpace(db, uid, 'whats-new@example.com')
    const row = (await db.select({ slug: spacesTable.slug }).from(spacesTable).where(eq(spacesTable.createdBy, uid)))[0]
    expect(row.slug).toBe('whats-new-1')
  })
})
