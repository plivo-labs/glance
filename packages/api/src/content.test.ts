import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import contentApp, { contentType, injectAnnotate, markdown, normalizePath, restOf } from './content'
import { events, sites, spaces, users } from './db/schema'
import { sanitizePath } from './lib/storage'
import { signToken, verifyToken } from './lib/token'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from './test/harness'

const secret = 'test-secret'
const userId = 'user-123'
const scope = 'sam/site'

describe('signToken / verifyToken (user-bound)', () => {
  test('valid token returns the bound userId for the right user/space/site', async () => {
    const t = await signToken(secret, userId, scope, 300)
    expect(await verifyToken(secret, scope, t)).toBe(userId)
  })
  test('wrong scope (different space/site) is rejected', async () => {
    const t = await signToken(secret, userId, scope, 300)
    expect(await verifyToken(secret, 'sam/other', t)).toBeNull()
  })
  test('expired token is rejected', async () => {
    const t = await signToken(secret, userId, scope, -1)
    expect(await verifyToken(secret, scope, t)).toBeNull()
  })
  test('token signed with a different secret is rejected', async () => {
    const t = await signToken(secret, userId, scope, 300)
    expect(await verifyToken('other-secret', scope, t)).toBeNull()
  })
  test('tampered MAC is rejected', async () => {
    const t = await signToken(secret, userId, scope, 300)
    expect(await verifyToken(secret, scope, `${t.slice(0, -2)}xx`)).toBeNull()
  })
  test('tampered userId segment is rejected (binding covers userId)', async () => {
    const t = await signToken(secret, userId, scope, 300)
    const [exp, , mac] = t.split('.')
    const forged = `${exp}.${btoa('user-999').replace(/=+$/, '')}.${mac}`
    expect(await verifyToken(secret, scope, forged)).toBeNull()
  })
  test('null / malformed tokens are rejected', async () => {
    expect(await verifyToken(secret, scope, null)).toBeNull()
    expect(await verifyToken(secret, scope, undefined)).toBeNull()
    expect(await verifyToken(secret, scope, 'garbage')).toBeNull()
    expect(await verifyToken(secret, scope, 'a.b')).toBeNull()
  })
})

describe('markdown XSS neutralization', () => {
  test('<script> blocks are escaped, not active', async () => {
    const html = await markdown.parse('# Hi\n\n<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
  test('inline event-handler HTML (<img onerror>) is escaped (inert, not a real tag)', async () => {
    const html = await markdown.parse('text <img src=x onerror=alert(1)> more')
    // The raw tag must not survive as a live element — its angle brackets are escaped, so
    // the browser sees inert text, not an <img> that can fire onerror.
    expect(html).not.toContain('<img src=x onerror')
    expect(html).toContain('&lt;img')
  })
  test('normal markdown still renders (headings, links, images, code, tables)', async () => {
    const html = await markdown.parse(
      '# Title\n\n[link](https://example.com)\n\n![alt](https://example.com/a.png)\n\n```\ncode\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    )
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<a href="https://example.com">link</a>')
    expect(html).toContain('<img src="https://example.com/a.png" alt="alt">')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('<table>')
  })
})

describe('normalizePath', () => {
  test('directory paths map to index.html', () => {
    expect(normalizePath('')).toBe('index.html')
    expect(normalizePath('docs/')).toBe('docs/index.html')
  })
  test('file paths pass through', () => {
    expect(normalizePath('a/b/page.html')).toBe('a/b/page.html')
  })
  test('rejects path traversal: .. and . segments are stripped', () => {
    expect(normalizePath('../../etc/passwd')).toBe('etc/passwd')
    expect(normalizePath('a/../../b')).toBe('a/b')
    expect(normalizePath('./a/./b')).toBe('a/b')
  })
  test('leading-slash collapses (no absolute escape)', () => {
    expect(normalizePath('/etc/passwd')).toBe('etc/passwd')
  })
})

describe('restOf', () => {
  test('skips the leading path segments and preserves a trailing slash', () => {
    expect(restOf('https://x/sp/st/docs/', 2)).toBe('docs/')
    expect(restOf('https://x/_t/tok/sp/st/a/b.html', 4)).toBe('a/b.html')
  })
  test('decodes percent-encoding', () => {
    expect(restOf('https://x/sp/st/a%20b.html', 2)).toBe('a b.html')
  })
  test('does not let encoded traversal escape once normalized', () => {
    // The WHATWG URL parser already resolves %2e%2e ("..") during parsing, and
    // normalizePath strips any residual "."/".." segments — so a traversal attempt can
    // never climb out of the site prefix, whatever the exact resolved file ends up being.
    expect(normalizePath(restOf('https://x/sp/st/%2e%2e/secret', 2))).not.toContain('..')
  })
})

describe('sanitizePath (upload-time R2 key hardening)', () => {
  test('strips .. and . segments', () => {
    expect(sanitizePath('../../etc/passwd')).toBe('etc/passwd')
    expect(sanitizePath('a/./b/../c')).toBe('a/b/c')
  })
  test('collapses leading slash (no absolute paths)', () => {
    expect(sanitizePath('/etc/passwd')).toBe('etc/passwd')
  })
  test('normalizes backslashes and drops empty segments', () => {
    expect(sanitizePath('a\\b\\c')).toBe('a/b/c')
    expect(sanitizePath('a//b')).toBe('a/b')
  })
})

describe('content 404s carry Cache-Control: no-store', () => {
  // Mount the real content app under a wrapper that injects the in-memory harness db, so
  // serve()'s D1 reads run against real SQLite. The two cases here return BEFORE any R2
  // access, so no GLANCE_FILES mock is needed (S-D only).
  function setup() {
    const db = makeDb()
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('db', db)
      await next()
    })
    app.route('/', contentApp)
    return { app, db, env: { APP_URL: 'https://glance.example.com', CONTENT_TOKEN_SECRET: secret } }
  }

  test('content-missing-site-404-no-store: unknown space/site → 404 + no-store, before any R2 access', async () => {
    const { app, env } = setup()
    const res = await app.request('/nope/nope/', {}, env)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('content-missing-file-404-no-store: gated site, zero files → 404 + no-store, before R2.get', async () => {
    const { app, db, env } = setup()
    await db.insert(users).values({ id: 'u1', email: 'o@example.com', role: 'member' })
    await db.insert(spaces).values({ id: 's1', slug: 'sam', name: 'Sam', type: 'personal', createdBy: 'u1' })
    await db
      .insert(sites)
      .values({ id: 'site1', spaceId: 's1', slug: 'site', visibility: 'team', status: 'active', ownerId: 'u1' })
    const token = await signToken(secret, 'u1', 'sam/site', 300)
    const res = await app.request(`/_t/${token}/sam/site/`, {}, env)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('directory listing fallback (no index.html)', () => {
  function setup() {
    const db = makeDb()
    const r2 = makeR2()
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('db', db)
      await next()
    })
    app.route('/', contentApp)
    return { app, db, r2, env: { APP_URL: 'https://glance.example.com', CONTENT_TOKEN_SECRET: secret, GLANCE_FILES: r2 } }
  }

  // Seed sam/site (gated `team` tier) owned by u1 and return a content token bound to that owner.
  async function gatedSite(db: ReturnType<typeof makeDb>) {
    const uid = await seedUser(db, { id: 'u1' })
    const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team' })
    const token = await signToken(secret, uid, 'sam/site', 300)
    return { siteId, token }
  }

  test('multi-file site with no root index.html → 200 navigable listing, not a bare 404', async () => {
    const { app, db, r2, env } = setup()
    const { siteId, token } = await gatedSite(db)
    await seedFile(db, r2, siteId, { path: 'home.html', text: '<p>hi</p>' })
    await seedFile(db, r2, siteId, { path: 'assets/app.js', text: 'x', mimeType: 'text/javascript' })

    const res = await app.request(`/_t/${token}/sam/site/`, {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.text()
    expect(body).toContain('No <code>index.html')
    // Links point at the app viewer route (URL updates) and break out of the iframe (target=_top).
    expect(body).toContain('href="https://glance.example.com/sam/site/home.html" target="_top"')
    expect(body).toContain('href="https://glance.example.com/sam/site/assets/app.js" target="_top"')
  })

  test('single-file site still serves the lone file at the root (fallback preserved)', async () => {
    const { app, db, r2, env } = setup()
    const { siteId, token } = await gatedSite(db)
    await seedFile(db, r2, siteId, { path: 'report.html', text: '<h1>Report</h1>' })

    const res = await app.request(`/_t/${token}/sam/site/`, {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>Report</h1>')
  })
})

describe('view analytics (page-view events)', () => {
  function setup() {
    const db = makeDb()
    const r2 = makeR2()
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('db', db)
      await next()
    })
    app.route('/', contentApp)
    return { app, db, r2, env: { APP_URL: 'https://glance.example.com', CONTENT_TOKEN_SECRET: secret, GLANCE_FILES: r2 } }
  }

  async function gatedSite(db: ReturnType<typeof makeDb>) {
    const uid = await seedUser(db, { id: 'u1' })
    const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team' })
    const token = await signToken(secret, uid, 'sam/site', 300)
    return { uid, siteId, token }
  }

  test('serving an HTML page records one view attributed to the viewer + site', async () => {
    const { app, db, r2, env } = setup()
    const { uid, siteId, token } = await gatedSite(db)
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<h1>hi</h1>' })

    await app.request(`/_t/${token}/sam/site/`, {}, env)

    const rows = await db.select().from(events)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'view', action: 'index.html', userId: uid, siteId, siteLabel: 'sam/site' })
  })

  test('sub-resources (css/js/images) do NOT record a view — only page loads count', async () => {
    const { app, db, r2, env } = setup()
    const { siteId, token } = await gatedSite(db)
    await seedFile(db, r2, siteId, { path: 'app.css', text: 'body{}', mimeType: 'text/css' })

    await app.request(`/_t/${token}/sam/site/app.css`, {}, env)

    expect(await db.select().from(events)).toHaveLength(0)
  })

  test('a forbidden (anonymous, untokened) request records no view', async () => {
    const { app, db, r2, env } = setup()
    const { siteId } = await gatedSite(db)
    await seedFile(db, r2, siteId, { path: 'index.html', text: '<h1>hi</h1>' })

    const res = await app.request('/sam/site/', {}, env)
    expect(res.status).toBe(403)
    expect(await db.select().from(events)).toHaveLength(0)
  })
})

describe('contentType', () => {
  test('textual types pin charset=utf-8 (no latin-1 mojibake)', () => {
    expect(contentType('index.html', null)).toBe('text/html; charset=utf-8')
    expect(contentType('app.js', null)).toBe('text/javascript; charset=utf-8')
    expect(contentType('data.json', null)).toBe('application/json; charset=utf-8')
    expect(contentType('logo.svg', null)).toBe('image/svg+xml; charset=utf-8')
    expect(contentType('notes.txt', null)).toBe('text/plain; charset=utf-8')
  })
  test('binary types are left untouched', () => {
    expect(contentType('photo.png', null)).toBe('image/png')
    expect(contentType('font.woff2', null)).toBe('font/woff2')
    expect(contentType('blob', null)).toBe('application/octet-stream')
  })
  test('falls back to the stored type (charset-pinned when textual)', () => {
    expect(contentType('weird.ext', 'text/csv')).toBe('text/csv; charset=utf-8')
    expect(contentType('weird.ext', 'application/zip')).toBe('application/zip')
  })
})

describe('injectAnnotate replacement safety (#46: $-specials in filePath stay verbatim)', () => {
  test('$&, $$, $1 in the payload are inserted byte-for-byte, not interpreted as replacement specials', () => {
    // A String.prototype.replace with a STRING replacement would expand $& → the matched '</body>'
    // and $$ → '$', corrupting the user-controlled path. The replacement FUNCTION inserts it verbatim.
    const html = '<html><head></head><body><p>x</p></body></html>'
    const out = injectAnnotate(html, {
      siteId: 's1',
      filePath: 'weird$&$$$1name.html',
      appOrigin: 'https://glance.example.com',
    })
    expect(out).toContain('"filePath":"weird$&$$$1name.html"')
    // Still anchored before </body> (the preferred injection point), not the append fallback.
    expect(out.indexOf('window.__GLANCE__=')).toBeLessThan(out.indexOf('</body>'))
  })

  test('no </body>/</head> → appends after the document, keeping any leading doctype first (no quirks flip)', () => {
    const html = '<!doctype html><p>bare</p>'
    const out = injectAnnotate(html, { siteId: 's1', filePath: 'a.html', appOrigin: 'https://glance.example.com' })
    expect(out.startsWith('<!doctype html>')).toBe(true)
    expect(out).toContain('window.__GLANCE__=')
    expect(out.indexOf('<p>bare</p>')).toBeLessThan(out.indexOf('window.__GLANCE__='))
  })
})

describe('gated file serving: cache-control, conditional 304, archive-through-checkAccess', () => {
  function setup() {
    const db = makeDb()
    const r2 = makeR2()
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('db', db)
      await next()
    })
    app.route('/', contentApp)
    return { app, db, r2, env: { APP_URL: 'https://glance.example.com', CONTENT_TOKEN_SECRET: secret, GLANCE_FILES: r2 } }
  }

  // Seed sam/site (gated `team` tier) owned by `owner` with one index.html, returning a bound token.
  async function seedServable(
    db: ReturnType<typeof makeDb>,
    r2: ReturnType<typeof makeR2>,
    o: { role?: 'member' | 'superadmin'; status?: 'active' | 'archived'; text?: string } = {},
  ) {
    const uid = await seedUser(db, { id: 'u1', role: o.role ?? 'member' })
    const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
    const siteId = await seedSite(db, {
      spaceId: sp,
      ownerId: uid,
      slug: 'site',
      visibility: 'team',
      status: o.status ?? 'active',
    })
    await seedFile(db, r2, siteId, { path: 'index.html', text: o.text ?? '<h1>hi</h1>' })
    const token = await signToken(secret, uid, 'sam/site', 300)
    return { uid, siteId, token }
  }

  test('gated response carries Cache-Control: private, no-cache (shared/proxy caches never retain private bytes)', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await seedServable(db, r2)
    const res = await app.request(`/_t/${token}/sam/site/`, {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
  })

  test('If-None-Match matching the ETag → 304 with an empty body and the caching headers preserved', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await seedServable(db, r2)
    const first = await app.request(`/_t/${token}/sam/site/`, {}, env)
    const etag = first.headers.get('etag')
    expect(etag).not.toBeNull()

    const revalidate = await app.request(`/_t/${token}/sam/site/`, { headers: { 'if-none-match': etag as string } }, env)
    expect(revalidate.status).toBe(304)
    expect(revalidate.headers.get('etag')).toBe(etag)
    expect(revalidate.headers.get('cache-control')).toBe('private, no-cache')
    expect(await revalidate.text()).toBe('')
  })

  test('a stale/non-matching If-None-Match streams the body (200, not 304)', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await seedServable(db, r2)
    const res = await app.request(`/_t/${token}/sam/site/`, { headers: { 'if-none-match': '"stale"' } }, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>hi</h1>')
  })

  test('superadmin views an ARCHIVED site (archive routed through checkAccess, not a blanket early 410)', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await seedServable(db, r2, { role: 'superadmin', status: 'archived', text: '<h1>archived</h1>' })
    const res = await app.request(`/_t/${token}/sam/site/`, {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>archived</h1>')
  })

  test('non-superadmin gets 410 on an archived site (single-source-of-truth archive rule holds)', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await seedServable(db, r2, { role: 'member', status: 'archived' })
    const res = await app.request(`/_t/${token}/sam/site/`, {}, env)
    expect(res.status).toBe(410)
  })
})
