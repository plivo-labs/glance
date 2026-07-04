import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { files } from '../db/schema'
import { makeDb, makeKv, makeR2, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { upload } from './upload'

// Upload rejects duplicate paths before any R2 write — closing the blind-insert gap that would
// otherwise 500 post-constraint.

const APP_URL = 'https://glance.example.com'

async function setup() {
  const db = makeDb()
  const kv = makeKv()
  const r2 = makeR2()
  const owner = await seedUser(db, { id: 'owner' })
  const sp = await seedSpace(db, { createdBy: owner, slug: 'acme' })
  await seedMember(db, sp, owner)
  await kv.put('cli:tok', JSON.stringify({ id: owner, email: 'owner@example.com', name: null, role: 'member' }))

  const env = {
    APP_URL,
    SESSION_SECRET: 'sess',
    GLANCE_SESSIONS: kv,
    GLANCE_FILES: r2,
  } as unknown as AppEnv['Bindings']

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/upload', upload)
  return { app, env, db, r2 }
}

function postFiles(app: Hono<AppEnv>, env: AppEnv['Bindings'], slug: string, parts: File[], query = '') {
  const fd = new FormData()
  for (const f of parts) fd.append('files', f)
  return app.request(`/api/upload/acme/${slug}${query}`, { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: fd }, env)
}

describe('upload — duplicate-path guard', () => {
  test('upload-rejects-duplicate-path: collapsing paths → 400 before any R2 write, no rows', async () => {
    const { app, env, db, r2 } = await setup()
    // 'a/b.html' and 'a\b.html' both sanitize to 'a/b.html'.
    const res = await postFiles(app, env, 'dup', [
      new File(['<html>1</html>'], 'a/b.html', { type: 'text/html' }),
      new File(['<html>2</html>'], 'a\\b.html', { type: 'text/html' }),
    ])
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('duplicate path')
    expect(await db.select().from(files)).toHaveLength(0) // nothing inserted
    expect(r2.store.size).toBe(0) // nothing committed to R2
  })

  test('unique-siteId-path-enforced: a second row with the same (siteId, path) is rejected', async () => {
    const { db } = await setup()
    const owner = await seedUser(db)
    const sp = await seedSpace(db, { createdBy: owner })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: owner })
    await db.insert(files).values({ id: 'f1', siteId, path: 'p.html', storageKey: 'k1/p.html', contentHash: null })
    let threw = false
    try {
      await db.insert(files).values({ id: 'f2', siteId, path: 'p.html', storageKey: 'k2/p.html', contentHash: null })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
