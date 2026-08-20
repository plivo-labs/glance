import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import contentApp, { themeHrefFor } from './content'
import { sites } from './db/schema'
import { signToken } from './lib/token'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from './test/harness'
import { THEME_CSS, THEMES_VERSION } from './themes/css'
import { THEME_FONTS } from './themes/fonts'

// Design themes at serve time: a themed site's HTML gets ONE injected <link> to
// /_glance/theme/<slug>.css (end of <head> so it wins cascade-order ties), the stored bytes are
// never mutated (?raw=1 is verbatim), and the HTML etag folds in the theme identity so a PATCH
// theme switch can never 304 into the old skin.

const tokenKey = 'test-secret'

function setup() {
  const db = makeDb()
  const r2 = makeR2()
  const env = {
    APP_URL: 'https://glance.example.com',
    CONTENT_TOKEN_SECRET: tokenKey,
    GLANCE_FILES: r2,
  } as unknown as Parameters<typeof contentApp.request>[2]
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/', contentApp)
  return { db, r2, env, app }
}

async function themedSite(
  db: ReturnType<typeof makeDb>,
  r2: ReturnType<typeof makeR2>,
  file: { path: string; text: string; mimeType?: string },
  theme: string | null = 'broadsheet',
) {
  const uid = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team', theme })
  await seedFile(db, r2, siteId, file)
  const token = await signToken(tokenKey, uid, 'sam/site', 300)
  return { uid, siteId, token }
}

// id="glance-theme" makes the link addressable by the annotate client's glance:theme
// handler (viewer-local override) — pinned here so a rename breaks loudly.
const themeLink = (slug: string) => `<link id="glance-theme" rel="stylesheet" href="/_glance/theme/${slug}.css?v=${THEMES_VERSION}">`

describe('themeHrefFor', () => {
  test('registry slug → versioned href; null/unknown → null', () => {
    expect(themeHrefFor('broadsheet')).toBe(`/_glance/theme/broadsheet.css?v=${THEMES_VERSION}`)
    expect(themeHrefFor(null)).toBeNull()
    // A slug retired from the registry may still sit on an old row — fail OPEN to unthemed.
    expect(themeHrefFor('retired-theme')).toBeNull()
  })
})

describe('/_glance/theme/fonts/:file.woff2 (issue #155 — vendored, first-party)', () => {
  test('serves every bundled font immutable as font/woff2; unknown files 404', async () => {
    const { app, env } = setup()
    const files = Object.keys(THEME_FONTS)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const res = await app.request(`/_glance/theme/fonts/${file}`, {}, env)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('font/woff2')
      expect(res.headers.get('cache-control')).toContain('immutable')
      // WOFF2 magic bytes: 'wOF2' — proves the base64 round-trip decodes to a real font.
      const head = new Uint8Array((await res.arrayBuffer()).slice(0, 4))
      expect(String.fromCharCode(...head)).toBe('wOF2')
    }
    expect((await app.request('/_glance/theme/fonts/nope.woff2', {}, env)).status).toBe(404)
  })

  test('every font URL referenced by theme CSS resolves to a bundled font', () => {
    for (const [slug, css] of Object.entries(THEME_CSS)) {
      for (const m of css.matchAll(/\/_glance\/theme\/fonts\/([a-z0-9-]+\.woff2)/g)) {
        expect(THEME_FONTS[m[1]], `${slug} references missing font ${m[1]}`).toBeDefined()
      }
      // And no theme may reach out to Google (the whole point of #155).
      expect(css).not.toContain('googleapis')
      expect(css).not.toContain('gstatic')
    }
  })
})

describe('/_glance/theme/:slug.css', () => {
  test('serves every registry stylesheet immutable, 404s unknown slugs', async () => {
    const { app, env } = setup()
    for (const slug of Object.keys(THEME_CSS)) {
      const res = await app.request(`/_glance/theme/${slug}.css`, {}, env)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/css')
      expect(res.headers.get('cache-control')).toContain('immutable')
      expect(await res.text()).toBe(THEME_CSS[slug])
    }
    expect((await app.request('/_glance/theme/nope.css', {}, env)).status).toBe(404)
  })
})

describe('theme injection into served HTML', () => {
  test("themed site: exactly one <link>, at the END of <head> (after the page's own styles)", async () => {
    const { app, db, r2, env } = setup()
    const html = '<html><head><title>t</title><style>body{color:red}</style></head><body><p>hi</p></body></html>'
    const { token } = await themedSite(db, r2, { path: 'index.html', text: html })

    const body = await (await app.request(`/_t/${token}/sam/site/`, {}, env)).text()
    const link = themeLink('broadsheet')
    expect(body).toContain(link)
    expect(body.split(link).length - 1).toBe(1)
    // Cascade-order contract: the injected link comes AFTER the page's own <style>.
    expect(body.indexOf(link)).toBeGreaterThan(body.indexOf('<style>'))
    expect(body.indexOf(link)).toBeLessThan(body.indexOf('</head>'))
  })

  test('unthemed site: byte-identical serve, no theme link', async () => {
    const { app, db, r2, env } = setup()
    const html = '<html><head></head><body><p>hi</p></body></html>'
    const { token } = await themedSite(db, r2, { path: 'index.html', text: html }, null)

    const body = await (await app.request(`/_t/${token}/sam/site/`, {}, env)).text()
    expect(body).toBe(html)
  })

  test('?raw=1 streams the stored bytes verbatim — a pull round-trips byte-identically', async () => {
    const { app, db, r2, env } = setup()
    const html = '<html><head></head><body><p>hi</p></body></html>'
    const { token } = await themedSite(db, r2, { path: 'index.html', text: html })

    const body = await (await app.request(`/_t/${token}/sam/site/index.html?raw=1`, {}, env)).text()
    expect(body).toBe(html)
  })

  test('headless document still gets the link (appended at document end)', async () => {
    const { app, db, r2, env } = setup()
    const html = '<p>no head here</p>'
    const { token } = await themedSite(db, r2, { path: 'index.html', text: html })

    const body = await (await app.request(`/_t/${token}/sam/site/`, {}, env)).text()
    expect(body.startsWith('<p>no head here</p>')).toBe(true)
    expect(body).toContain(themeLink('broadsheet'))
  })

  test('annotate mode: theme link AND annotate client both present', async () => {
    const { app, db, r2, env } = setup()
    const html = '<html><head></head><body><p>hi</p></body></html>'
    const { token } = await themedSite(db, r2, { path: 'index.html', text: html })

    const body = await (await app.request(`/_t/${token}/sam/site/?glance_annotate=1`, {}, env)).text()
    expect(body).toContain(themeLink('broadsheet'))
    expect(body).toContain('<script src="/_glance/annotate.js')
  })

  test('a row carrying a retired/unknown slug serves unthemed (no dead link)', async () => {
    const { app, db, r2, env } = setup()
    const html = '<html><head></head><body><p>hi</p></body></html>'
    const { token } = await themedSite(db, r2, { path: 'index.html', text: html }, 'retired-theme')

    const body = await (await app.request(`/_t/${token}/sam/site/`, {}, env)).text()
    expect(body).toBe(html)
  })

  test('non-HTML files on a themed site stream unchanged', async () => {
    const { app, db, r2, env } = setup()
    const css = 'body { margin: 0 }'
    const { token } = await themedSite(db, r2, { path: 'app.css', text: css, mimeType: 'text/css' })

    const res = await app.request(`/_t/${token}/sam/site/app.css`, {}, env)
    expect(await res.text()).toBe(css)
  })

  test('rendered markdown gets the link and a CSP that stays first-party (issue #155)', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await themedSite(db, r2, { path: 'doc.md', text: '# hello' })

    const res = await app.request(`/_t/${token}/sam/site/doc.md`, {}, env)
    const body = await res.text()
    expect(body).toContain(themeLink('broadsheet'))
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("font-src 'self'")
    // Fonts are vendored (issue #155): NO third-party origin may appear in a themed CSP.
    expect(csp).not.toContain('googleapis')
    expect(csp).not.toContain('gstatic')
    expect(csp).toContain("script-src 'none'")
  })

  test('unthemed markdown keeps the strict baseline CSP', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await themedSite(db, r2, { path: 'doc.md', text: '# hello' }, null)

    const res = await app.request(`/_t/${token}/sam/site/doc.md`, {}, env)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("style-src 'unsafe-inline'")
    expect(csp).not.toContain('fonts.googleapis.com')
  })
})

describe('themed HTML etag', () => {
  test('folds in the theme identity; a theme switch invalidates a held 304 validator', async () => {
    const { app, db, r2, env } = setup()
    const html = '<html><head></head><body><p>hi</p></body></html>'
    const { siteId, token } = await themedSite(db, r2, { path: 'index.html', text: html })

    const first = await app.request(`/_t/${token}/sam/site/`, {}, env)
    const themedEtag = first.headers.get('etag') ?? ''
    expect(themedEtag).toContain('broadsheet')

    // Revalidation with the themed etag → 304 while the theme is unchanged.
    const revalidate = await app.request(`/_t/${token}/sam/site/`, { headers: { 'if-none-match': themedEtag } }, env)
    expect(revalidate.status).toBe(304)

    // Switch the theme (the PATCH path) — the held validator must MISS so the new skin serves.
    await db.update(sites).set({ theme: 'plivo' }).where(eq(sites.id, siteId))
    const after = await app.request(`/_t/${token}/sam/site/`, { headers: { 'if-none-match': themedEtag } }, env)
    expect(after.status).toBe(200)
    expect(await after.text()).toContain(themeLink('plivo'))

    // Clearing the theme also invalidates (plain etag ≠ themed etag).
    await db.update(sites).set({ theme: null }).where(eq(sites.id, siteId))
    const cleared = await app.request(`/_t/${token}/sam/site/`, { headers: { 'if-none-match': themedEtag } }, env)
    expect(cleared.status).toBe(200)
    expect(await cleared.text()).toBe(html)
  })

  test('non-HTML files keep the raw object etag even on a themed site', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await themedSite(db, r2, { path: 'app.css', text: 'body{}', mimeType: 'text/css' })

    const res = await app.request(`/_t/${token}/sam/site/app.css`, {}, env)
    expect(res.headers.get('etag') ?? '').not.toContain('broadsheet')
  })
})
