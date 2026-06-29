import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ANNOTATE_JS } from './annotate/bundle'
import contentApp from './content'
import { signToken } from './lib/token'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from './test/harness'

// Phase 3: annotate-mode injection in the content worker. The flag grants nothing (access
// checks are unchanged); it only transforms gated HTML. Driven via app.request against the
// real content app with the harness db + R2 mock.

const tokenKey = 'test-secret'

function setup() {
  const db = makeDb()
  const r2 = makeR2()
  const env = { APP_URL: 'https://glance.example.com', CONTENT_TOKEN_SECRET: tokenKey, GLANCE_FILES: r2 } as unknown as Parameters<typeof contentApp.request>[2]
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/', contentApp)
  return { db, r2, env, app }
}

/** Seed sam/site with one file; returns a gated URL builder bound to a fresh token. */
async function gatedSite(
  db: ReturnType<typeof makeDb>,
  r2: ReturnType<typeof makeR2>,
  file: { path: string; text: string; mimeType?: string },
  visibility: 'team' | 'members' | 'private' = 'team',
) {
  const uid = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility })
  await seedFile(db, r2, siteId, file)
  const token = await signToken(tokenKey, uid, 'sam/site', 300)
  return { uid, siteId, token }
}

const HTML = '<html><head><title>Doc</title></head><body><p>The quick brown fox.</p></body></html>'

describe('annotate assets', () => {
  test('annotate-route-before-catchall: GET /_glance/annotate.js → 200 js, not a site lookup', async () => {
    const { app, env } = setup()
    const res = await app.request('/_glance/annotate.js', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toBe(ANNOTATE_JS)
  })
})

describe('annotate injection', () => {
  test('inject-only-with-flag-and-html: gated HTML + flag injects; without the flag bytes are raw', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await gatedSite(db, r2, { path: 'index.html', text: HTML })

    const injected = await (await app.request(`/_t/${token}/sam/site/?glance_annotate=1`, {}, env)).text()
    expect(injected).toContain('<script src="/_glance/annotate.js')
    expect(injected).toContain('window.__GLANCE__=')

    const raw = await app.request(`/_t/${token}/sam/site/`, {}, env)
    const rawBody = await raw.text()
    expect(rawBody).toBe(HTML)
    expect(raw.headers.get('etag')).not.toBeNull()
  })

  test('boot-payload-carries-resolved-path: single-file fallback → payload path = resolved files.path', async () => {
    const { app, db, r2, env } = setup()
    // Only report.html exists; root request falls back to it. Payload must carry report.html.
    const { token } = await gatedSite(db, r2, { path: 'report.html', text: HTML })
    const body = await (await app.request(`/_t/${token}/sam/site/?glance_annotate=1`, {}, env)).text()
    expect(body).toContain('"filePath":"report.html"')
    expect(body).toContain('"siteId":')
  })

  test('inject-drops-etag: annotated response drops the ETag and is not cached', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await gatedSite(db, r2, { path: 'index.html', text: HTML })
    const res = await app.request(`/_t/${token}/sam/site/?glance_annotate=1`, {}, env)
    expect(res.headers.get('etag')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('markdown-not-injected: markdown keeps script-src none, no annotate script', async () => {
    const { app, db, r2, env } = setup()
    const { token } = await gatedSite(db, r2, { path: 'index.md', text: '# Title\n\nbody', mimeType: 'text/markdown' })
    const res = await app.request(`/_t/${token}/sam/site/?glance_annotate=1`, {}, env)
    const body = await res.text()
    expect(body).not.toContain('/_glance/annotate.js')
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'")
  })

  test('untokened-serve-forbidden: anonymous request → 403 (no public tier), nothing injected', async () => {
    const { app, db, r2, env } = setup()
    await gatedSite(db, r2, { path: 'index.html', text: HTML })
    const res = await app.request('/sam/site/?glance_annotate=1', {}, env)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('__GLANCE__')
  })
})
