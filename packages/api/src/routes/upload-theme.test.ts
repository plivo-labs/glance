import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { sites } from '../db/schema'
import { makeDb, makeKv, makeR2, seedMember, seedSpace, seedUser } from '../test/harness'
import type { AppEnv } from '../types'
import { upload } from './upload'

// The `theme` form field mirrors visibility's create/replace split: CREATE applies it (absent →
// unthemed), REPLACE only touches sites.theme when explicitly sent — an agent's plain redeploy
// must never strip a theme picked in the UI. 'none'/'' clears; unknown slugs 400 before any write.

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

function post(
  app: Hono<AppEnv>,
  env: AppEnv['Bindings'],
  slug: string,
  opts: { theme?: string; replace?: boolean } = {},
) {
  const fd = new FormData()
  fd.append('files', new File(['<html><body>hi</body></html>'], 'index.html', { type: 'text/html' }))
  if (opts.theme !== undefined) fd.append('theme', opts.theme)
  const query = opts.replace ? '?replace=true' : ''
  return app.request(
    `/api/upload/acme/${slug}${query}`,
    { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: fd },
    env,
  )
}

const themeOf = async (db: ReturnType<typeof makeDb>, slug: string) =>
  (await db.select({ theme: sites.theme }).from(sites).where(eq(sites.slug, slug)))[0]?.theme

describe('upload theme field', () => {
  test('create with a registry theme stores it; absent stores null', async () => {
    const { app, env, db } = await setup()
    expect((await post(app, env, 'themed', { theme: 'plivo' })).status).toBe(200)
    expect(await themeOf(db, 'themed')).toBe('plivo')

    expect((await post(app, env, 'plain')).status).toBe(200)
    expect(await themeOf(db, 'plain')).toBeNull()
  })

  test('unknown theme → 400 before any write (no site row created)', async () => {
    const { app, env, db, r2 } = await setup()
    const res = await post(app, env, 'bad', { theme: 'clippy' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('unknown theme')
    expect(await themeOf(db, 'bad')).toBeUndefined()
    expect(r2.store.size).toBe(0)
  })

  test('replace without the field keeps the current theme; with it, switches; none clears', async () => {
    const { app, env, db } = await setup()
    await post(app, env, 'site', { theme: 'matrix' })

    // Plain redeploy (the agent loop): theme untouched.
    expect((await post(app, env, 'site', { replace: true })).status).toBe(200)
    expect(await themeOf(db, 'site')).toBe('matrix')

    // Explicit switch on replace.
    expect((await post(app, env, 'site', { replace: true, theme: 'academic' })).status).toBe(200)
    expect(await themeOf(db, 'site')).toBe('academic')

    // Explicit clear.
    expect((await post(app, env, 'site', { replace: true, theme: 'none' })).status).toBe(200)
    expect(await themeOf(db, 'site')).toBeNull()
  })

  test("empty string and 'default' clear like none (the page's own design)", async () => {
    const { app, env, db } = await setup()
    await post(app, env, 'site', { theme: 'synthwave' })
    expect((await post(app, env, 'site', { replace: true, theme: '' })).status).toBe(200)
    expect(await themeOf(db, 'site')).toBeNull()

    await post(app, env, 'site', { replace: true, theme: 'cyberpunk' })
    expect((await post(app, env, 'site', { replace: true, theme: 'default' })).status).toBe(200)
    expect(await themeOf(db, 'site')).toBeNull()
  })
})
