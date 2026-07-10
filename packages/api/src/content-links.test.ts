import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import contentApp, { isExternalHref } from './content'
import { signToken } from './lib/token'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from './test/harness'

// External links (to another origin) in served HTML are rewritten to open in a new tab
// (target=_blank + rel=noopener); same-site / relative links are left alone. Paired with the
// viewer iframe's allow-popups-to-escape-sandbox so the tab actually opens un-sandboxed.

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

async function gatedSite(
  db: ReturnType<typeof makeDb>,
  r2: ReturnType<typeof makeR2>,
  file: { path: string; text: string; mimeType?: string },
) {
  const uid = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team' })
  await seedFile(db, r2, siteId, file)
  const token = await signToken(tokenKey, uid, 'sam/site', 300)
  return { uid, siteId, token }
}

describe('isExternalHref', () => {
  const base = 'https://content.example.com'
  test('absolute URL to another origin is external', () => {
    expect(isExternalHref('https://slack.com/x', base)).toBe(true)
    expect(isExternalHref('http://other.org', base)).toBe(true)
  })
  test('same-origin absolute URL is internal', () => {
    expect(isExternalHref('https://content.example.com/page.html', base)).toBe(false)
  })
  test('relative / root-relative / fragment are internal', () => {
    expect(isExternalHref('page.html', base)).toBe(false)
    expect(isExternalHref('/docs/a.html', base)).toBe(false)
    expect(isExternalHref('#section', base)).toBe(false)
  })
  test('non-http(s) schemes (mailto, tel) are left untouched', () => {
    expect(isExternalHref('mailto:a@b.com', base)).toBe(false)
    expect(isExternalHref('tel:+123', base)).toBe(false)
  })
  test('protocol-relative to another host is external', () => {
    expect(isExternalHref('//slack.com/x', base)).toBe(true)
  })
})

describe('external-link rewrite in served HTML', () => {
  test('external link → target=_blank + rel=noopener; internal/fragment/mailto untouched', async () => {
    const { app, db, r2, env } = setup()
    const html =
      '<html><body>' +
      '<a href="https://slack.com/x">ext</a>' +
      '<a href="page.html">int</a>' +
      '<a href="#top">frag</a>' +
      '<a href="mailto:a@b.com">mail</a>' +
      '</body></html>'
    const { token } = await gatedSite(db, r2, { path: 'index.html', text: html })

    const body = await (await app.request(`/_t/${token}/sam/site/`, {}, env)).text()

    // the external anchor gains target + rel
    expect(body).toMatch(/<a href="https:\/\/slack\.com\/x" target="_blank" rel="noopener noreferrer">/)
    // internal / fragment / mailto keep exactly one anchor each and never get a target
    expect(body).toContain('<a href="page.html">int</a>')
    expect(body).toContain('<a href="#top">frag</a>')
    expect(body).toContain('<a href="mailto:a@b.com">mail</a>')
    expect((body.match(/target="_blank"/g) ?? []).length).toBe(1)
  })

  test('rewrite also applies under annotate mode (external gets target, annotate still injected)', async () => {
    const { app, db, r2, env } = setup()
    const html = '<html><body><a href="https://example.org/">ext</a></body></html>'
    const { token } = await gatedSite(db, r2, { path: 'index.html', text: html })

    const body = await (await app.request(`/_t/${token}/sam/site/?glance_annotate=1`, {}, env)).text()
    expect(body).toContain('<script src="/_glance/annotate.js')
    expect(body).toMatch(/<a href="https:\/\/example\.org\/" target="_blank" rel="noopener noreferrer">/)
  })

  test('rewrite applies to rendered markdown links', async () => {
    const { app, db, r2, env } = setup()
    const md = '[ext](https://slack.com/x) and [int](page.html)'
    const { token } = await gatedSite(db, r2, { path: 'doc.md', text: md })

    const body = await (await app.request(`/_t/${token}/sam/site/doc.md`, {}, env)).text()
    expect(body).toMatch(/href="https:\/\/slack\.com\/x" target="_blank" rel="noopener noreferrer"/)
    expect(body).not.toMatch(/href="page\.html"[^>]*target="_blank"/)
  })

  test('non-HTML file (audio) is streamed unchanged', async () => {
    const { app, db, r2, env } = setup()
    const bytes = 'RIFF....WAVEfake-audio-bytes'
    const { token } = await gatedSite(db, r2, { path: 'clip.wav', text: bytes, mimeType: 'audio/wav' })

    const res = await app.request(`/_t/${token}/sam/site/clip.wav`, {}, env)
    expect(await res.text()).toBe(bytes)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })

  test('directory-listing app links keep target=_top (not rewritten to _blank)', async () => {
    const { app, db, r2, env } = setup()
    // Two files, no index.html at root → directory listing is served (its own shell, not user HTML).
    const uid = await seedUser(db, { id: 'u1' })
    const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
    const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team' })
    await seedFile(db, r2, siteId, { path: 'a.html', text: '<p>a</p>' })
    await seedFile(db, r2, siteId, { path: 'b.html', text: '<p>b</p>' })
    const token = await signToken(tokenKey, uid, 'sam/site', 300)

    const body = await (await app.request(`/_t/${token}/sam/site/`, {}, env)).text()
    expect(body).toContain('target="_top"')
    expect(body).not.toContain('target="_blank"')
  })
})
