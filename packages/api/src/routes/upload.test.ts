import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { files, sites } from '../db/schema'
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

// Like postFiles but lets a test set the `visibility` form field (omitted entirely when undefined,
// so the "field absent" path stays exercisable) and flip on ?replace=true.
function postUpload(
  app: Hono<AppEnv>,
  env: AppEnv['Bindings'],
  slug: string,
  parts: File[],
  opts: { visibility?: string; replace?: boolean } = {},
) {
  const fd = new FormData()
  for (const f of parts) fd.append('files', f)
  if (opts.visibility !== undefined) fd.append('visibility', opts.visibility)
  const query = opts.replace ? '?replace=true' : ''
  return app.request(`/api/upload/acme/${slug}${query}`, { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: fd }, env)
}

const html = (s: string, name: string) => new File([s], name, { type: 'text/html' })

describe('upload — superadmin moderation', () => {
  async function postAs(app: Hono<AppEnv>, env: AppEnv['Bindings'], token: string, slug: string, query = '') {
    const fd = new FormData()
    fd.append('files', html('<html>2</html>', 'index.html'))
    return app.request(`/api/upload/acme/${slug}${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }, env)
  }

  test('superadmin-can-replace-another-owners-site: bypasses membership + ownership', async () => {
    const { app, env, db } = await setup()
    await postUpload(app, env, 'modme', [html('<html>1</html>', 'index.html')]) // owner creates
    const admin = await seedUser(db, { id: 'admin', email: 'admin@example.com', role: 'superadmin' })
    // superadmin is NOT the owner and NOT a member of acme
    await (env.GLANCE_SESSIONS as ReturnType<typeof makeKv>).put(
      'cli:admintok',
      JSON.stringify({ id: admin, email: 'admin@example.com', name: null, role: 'superadmin' }),
    )
    expect((await postAs(app, env, 'admintok', 'modme', '?replace=true')).status).toBe(200)
  })

  test('non-member-cannot-replace: a plain member outside the space is still 403', async () => {
    const { app, env, db } = await setup()
    await postUpload(app, env, 'guarded', [html('<html>1</html>', 'index.html')])
    const other = await seedUser(db, { id: 'other', email: 'other@example.com', role: 'member' })
    await (env.GLANCE_SESSIONS as ReturnType<typeof makeKv>).put(
      'cli:othertok',
      JSON.stringify({ id: other, email: 'other@example.com', name: null, role: 'member' }),
    )
    expect((await postAs(app, env, 'othertok', 'guarded', '?replace=true')).status).toBe(403)
  })
})

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

describe('upload — visibility on replace', () => {
  test('replace-with-visibility-updates-tier: re-upload choosing private flips the site off team', async () => {
    const { app, env, db } = await setup()
    // CREATE with no visibility field → defaults to team.
    const created = await postUpload(app, env, 'vis', [html('<html>1</html>', 'index.html')])
    expect(created.status).toBe(200)
    expect((await db.select().from(sites).where(eq(sites.slug, 'vis')))[0].visibility).toBe('team')

    // REPLACE, explicitly picking private → the site row must move to private (the discarded-on-replace bug).
    const replaced = await postUpload(app, env, 'vis', [html('<html>2</html>', 'index.html')], {
      visibility: 'private',
      replace: true,
    })
    expect(replaced.status).toBe(200)
    expect((await db.select().from(sites).where(eq(sites.slug, 'vis')))[0].visibility).toBe('private')
  })

  test('replace-without-visibility-keeps-tier: an absent field preserves the existing visibility', async () => {
    const { app, env, db } = await setup()
    await postUpload(app, env, 'keep', [html('<html>1</html>', 'index.html')], { visibility: 'members' })
    expect((await db.select().from(sites).where(eq(sites.slug, 'keep')))[0].visibility).toBe('members')

    // REPLACE with NO visibility field → tier is untouched.
    const replaced = await postUpload(app, env, 'keep', [html('<html>2</html>', 'index.html')], { replace: true })
    expect(replaced.status).toBe(200)
    expect((await db.select().from(sites).where(eq(sites.slug, 'keep')))[0].visibility).toBe('members')
  })
})

describe('upload — DoS caps (before any R2 write)', () => {
  test('file-count-cap: > MAX_FILE_COUNT files → 400, nothing written', async () => {
    const { app, env, db, r2 } = await setup()
    const parts = Array.from({ length: 201 }, (_, i) => html('<html></html>', `f${i}.html`))
    const res = await postFiles(app, env, 'toomany', parts)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('too many files')
    expect(await db.select().from(files)).toHaveLength(0)
    expect(r2.store.size).toBe(0)
  })

  test('oversized-key-cap: a storage key over 1024 bytes → 400, nothing written', async () => {
    const { app, env, db, r2 } = await setup()
    // prefix (36-byte uuid + '/') + this path blows past R2's 1024-byte key limit.
    const res = await postFiles(app, env, 'bigkey', [html('<html></html>', `${'a'.repeat(1100)}.html`)])
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('storage key too long')
    expect(await db.select().from(files)).toHaveLength(0)
    expect(r2.store.size).toBe(0)
  })
})

describe('upload — put-loop cleanup', () => {
  test('put-failure-purges-written-objects: a mid-loop R2 throw leaves no orphans and no rows', async () => {
    const { app, env, db, r2 } = await setup()
    // Fail the put for one object; the siblings that DID write must be deleted on the way out.
    const failing = {
      ...r2,
      put: async (key: string, value: string | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }) => {
        if (key.endsWith('/b.html')) throw new Error('r2 down')
        return r2.put(key, value, opts)
      },
    }
    const res = await postFiles(app, { ...env, GLANCE_FILES: failing } as unknown as AppEnv['Bindings'], 'boom', [
      html('<html>a</html>', 'a.html'),
      html('<html>b</html>', 'b.html'),
      html('<html>c</html>', 'c.html'),
    ])
    expect(res.status).toBe(500) // rethrow surfaces as a 500, not a false 200
    expect(await db.select().from(files)).toHaveLength(0) // batch never ran
    expect(r2.store.size).toBe(0) // every attempted key reclaimed — no orphans
  })
})
