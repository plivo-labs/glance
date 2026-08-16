import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { files, sites } from '../db/schema'
import { makeDb, makeKv, makeR2, seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import { mintKey } from '../test/route-fixtures'
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
  opts: { visibility?: string; replace?: boolean; title?: string } = {},
) {
  const fd = new FormData()
  for (const f of parts) fd.append('files', f)
  if (opts.visibility !== undefined) fd.append('visibility', opts.visibility)
  if (opts.title !== undefined) fd.append('title', opts.title)
  const query = opts.replace ? '?replace=true' : ''
  return app.request(`/api/upload/acme/${slug}${query}`, { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: fd }, env)
}

const html = (s: string, name: string) => new File([s], name, { type: 'text/html' })

// A superadmin is not a content author on someone else's site: replace would let it plant bytes
// the owner then opens, and create would let it publish into a space it doesn't belong to. Its
// custody is delete, in the admin panel.
describe('upload — a superadmin is not an editor', () => {
  async function postAs(app: Hono<AppEnv>, env: AppEnv['Bindings'], token: string, slug: string, query = '') {
    const fd = new FormData()
    fd.append('files', html('<html>2</html>', 'index.html'))
    return app.request(`/api/upload/acme/${slug}${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }, env)
  }

  test('superadmin-cannot-replace-another-owners-site: 403, and cannot create in the space either', async () => {
    const { app, env, db } = await setup()
    await postUpload(app, env, 'modme', [html('<html>1</html>', 'index.html')]) // owner creates
    const admin = await seedUser(db, { id: 'admin', email: 'admin@example.com', role: 'superadmin' })
    // superadmin is NOT the owner and NOT a member of acme
    await (env.GLANCE_SESSIONS as ReturnType<typeof makeKv>).put(
      'cli:admintok',
      JSON.stringify({ id: admin, email: 'admin@example.com', name: null, role: 'superadmin' }),
    )
    expect((await postAs(app, env, 'admintok', 'modme', '?replace=true')).status).toBe(403)
    expect((await postAs(app, env, 'admintok', 'fresh')).status).toBe(403)
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

  test('total-size-cap: a Content-Length over 100MB → 413 before the body is ever parsed', async () => {
    const { app, env, db, r2 } = await setup()
    // The body itself is tiny — the forged header alone must trip the guard, because by the time
    // any per-file check runs the whole multipart body has already been buffered in worker memory.
    const fd = new FormData()
    fd.append('files', html('<html></html>', 'index.html'))
    const res = await app.request(
      '/api/upload/acme/toobig',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'content-length': String(101 * 1024 * 1024) },
        body: fd,
      },
      env,
    )
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('upload exceeds 100MB total')
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

describe('upload — optional title on CREATE (W3-4)', () => {
  test('CREATE stores a provided title; absent → null; REPLACE leaves it untouched', async () => {
    const { app, env, db } = await setup()
    const titleOf = async (slug: string) =>
      (await db.select({ title: sites.title }).from(sites).where(eq(sites.slug, slug)).limit(1))[0]?.title

    // CREATE with a title.
    await postUpload(app, env, 'titled', [html('<html>1</html>', 'index.html')], { title: '  My Recording  ' })
    expect(await titleOf('titled')).toBe('My Recording') // trimmed

    // CREATE without a title → null.
    await postUpload(app, env, 'plain', [html('<html>1</html>', 'index.html')])
    expect(await titleOf('plain')).toBeNull()

    // REPLACE never touches the title, even when one is sent.
    await postUpload(app, env, 'titled', [html('<html>2</html>', 'index.html')], { replace: true, title: 'Changed' })
    expect(await titleOf('titled')).toBe('My Recording') // unchanged
  })
})

describe('upload — derived title from entry HTML', () => {
  const titled = (t: string) => html(`<html><head><title>${t}</title></head><body>x</body></html>`, 'index.html')
  async function siteTitle(db: Awaited<ReturnType<typeof setup>>['db'], slug: string) {
    return (await db.select({ title: sites.title }).from(sites).where(eq(sites.slug, slug)))[0]?.title
  }

  test('create without a form title derives it from the entry <title>', async () => {
    const { app, env, db } = await setup()
    expect((await postUpload(app, env, 'derived', [titled('My Report')])).status).toBe(200)
    expect(await siteTitle(db, 'derived')).toBe('My Report')
  })

  test('an explicit form title always wins over the entry <title>', async () => {
    const { app, env, db } = await setup()
    expect((await postUpload(app, env, 'explicit', [titled('From HTML')], { title: 'From Form' })).status).toBe(200)
    expect(await siteTitle(db, 'explicit')).toBe('From Form')
  })

  test('replace fills a null title but never overwrites an existing one', async () => {
    const { app, env, db } = await setup()
    // Entry HTML has no <title> → site title stays null.
    await postUpload(app, env, 'fillme', [html('<html><body>no title</body></html>', 'index.html')])
    expect(await siteTitle(db, 'fillme')).toBeNull()
    // Redeploy with a <title> → the null title is filled.
    await postUpload(app, env, 'fillme', [titled('Now Titled')], { replace: true })
    expect(await siteTitle(db, 'fillme')).toBe('Now Titled')
    // Another redeploy with a different <title> → existing title kept (never silently renamed).
    await postUpload(app, env, 'fillme', [titled('Renamed?')], { replace: true })
    expect(await siteTitle(db, 'fillme')).toBe('Now Titled')
  })

  test('multi-file site with no root index derives nothing', async () => {
    const { app, env, db } = await setup()
    const parts = [html('<title>A</title>', 'a.html'), html('<title>B</title>', 'b.html')]
    expect((await postUpload(app, env, 'noentry', parts)).status).toBe(200)
    expect(await siteTitle(db, 'noentry')).toBeNull()
  })
})

describe('upload — derived description from entry HTML', () => {
  const described = (d: string) =>
    html(`<html><head><title>T</title><meta name="description" content="${d}"></head><body>x</body></html>`, 'index.html')
  async function siteDescription(db: Awaited<ReturnType<typeof setup>>['db'], slug: string) {
    return (await db.select({ description: sites.description }).from(sites).where(eq(sites.slug, slug)))[0]?.description
  }

  test('create derives the description from the entry description meta', async () => {
    const { app, env, db } = await setup()
    expect((await postUpload(app, env, 'blurb', [described('Quarterly numbers')])).status).toBe(200)
    expect(await siteDescription(db, 'blurb')).toBe('Quarterly numbers')
  })

  test('replace OVERWRITES the description — unlike the title, it tracks the current content', async () => {
    const { app, env, db } = await setup()
    await postUpload(app, env, 'moving', [described('First blurb')])
    await postUpload(app, env, 'moving', [described('Second blurb')], { replace: true })
    expect(await siteDescription(db, 'moving')).toBe('Second blurb')
  })

  test('a redeploy whose entry dropped its description CLEARS the stale one', async () => {
    const { app, env, db } = await setup()
    await postUpload(app, env, 'cleared', [described('Was here')])
    await postUpload(app, env, 'cleared', [html('<html><head><title>T</title></head><body>x</body></html>', 'index.html')], {
      replace: true,
    })
    expect(await siteDescription(db, 'cleared')).toBeNull()
  })

  test('no HTML entry → null, and the site still uploads', async () => {
    const { app, env, db } = await setup()
    const md = new File(['# hi'], 'notes.md', { type: 'text/markdown' })
    expect((await postUpload(app, env, 'nohtml', [md])).status).toBe(200)
    expect(await siteDescription(db, 'nohtml')).toBeNull()
  })
})

describe('upload — derived title: R2 integrity + COALESCE race', () => {
  const titled = (t: string) => html(`<html><head><title>${t}</title></head><body>x</body></html>`, 'index.html')

  test('deriving the title does not consume the entry: the R2 object still holds the full HTML', async () => {
    const { app, env, db, r2 } = await setup()
    expect((await postUpload(app, env, 'intact', [titled('Intact')])).status).toBe(200)
    const key = (await db.select({ k: files.storageKey }).from(files))[0].k
    const obj = await r2.get(key)
    expect(obj && (await obj.text())).toContain('<title>Intact</title>')
  })

  test('a title set concurrently during the replace is never clobbered (COALESCE at the write)', async () => {
    const { app, env, db, r2 } = await setup()
    // Create with untitled HTML → sites.title is null.
    await postUpload(app, env, 'raceme', [html('<html><body>v1</body></html>', 'index.html')])
    // Gate R2 puts: the replace suspends AFTER reading existing.title (null) but BEFORE writing.
    const origPut = r2.put
    let releasePut: () => void = () => {}
    const gate = new Promise<void>((res) => {
      releasePut = res
    })
    let reachedPut: () => void = () => {}
    const reached = new Promise<void>((res) => {
      reachedPut = res
    })
    r2.put = async (...args: Parameters<typeof origPut>) => {
      reachedPut()
      await gate
      return origPut(...args)
    }
    const replace = postUpload(app, env, 'raceme', [titled('Derived Late')], { replace: true })
    await reached
    // Owner names the site while the upload is in flight (the PATCH-title race).
    await db.update(sites).set({ title: 'Manual Name' }).where(eq(sites.slug, 'raceme'))
    releasePut()
    expect((await replace).status).toBe(200)
    const row = (await db.select({ title: sites.title }).from(sites).where(eq(sites.slug, 'raceme')))[0]
    expect(row.title).toBe('Manual Name')
  })
})

// CASE-08 — the headline use case, and the other half of the create-not-delete ruling that
// sites-delete.test.ts pins from the deny side. A key must be able to deploy a site that does not
// exist yet; the control grant is unscopable, so no allowlist gates this the way the data grant
// gates minting. Without this case, widening S4's deny into a blanket key-denial would stay green.
describe('upload — an API key may CREATE a site', () => {
  test('CASE-08: deploying with a key creates a site that did not exist', async () => {
    const { app, env, db } = await setup()
    const secret = await mintKey(db, 'owner')

    const fd = new FormData()
    fd.append('files', html('<html>from ci</html>', 'index.html'))
    const res = await app.request(
      '/api/upload/acme/ci-made-this',
      { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: fd },
      env,
    )

    expect(res.status).toBe(200)
    expect(await db.select().from(sites).where(eq(sites.slug, 'ci-made-this'))).toHaveLength(1)
  })
})

// Request-shape pin (perf): every pre-write read (space, existing site, membership) rides ONE
// db.batch — requireAuth's user read is the only loose statement on a CREATE.
describe('upload — pre-write request shape', () => {
  test('CREATE: 1 loose (requireAuth) + fused read batch + write batch', async () => {
    const { app, env, db } = await setup()
    db.resetCounters()
    expect((await postFiles(app, env, 'shape-new', [html('<html>hi</html>', 'index.html')])).status).toBe(200)
    expect(db.counters.loose).toBe(1)
    expect(db.counters.batches).toBe(2)
  })
})
