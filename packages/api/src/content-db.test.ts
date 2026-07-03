import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { injectDb } from './content'
import contentApp from './content'
import { GLANCE_DB_JS } from './glancedb/bundle'
import { signToken } from './lib/token'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from './test/harness'

// glance.db SDK injection (broker mode). The injected page gets an API surface and the app
// origin to talk to — NEVER a token, space/site pair, or any credential material.

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

async function gatedSite(db: ReturnType<typeof makeDb>, r2: ReturnType<typeof makeR2>, text: string) {
  const uid = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team' })
  await seedFile(db, r2, siteId, { path: 'index.html', text })
  return signToken(tokenKey, uid, 'sam/site', 300)
}

const HTML = '<html><head><title>Doc</title></head><body><p>Hello.</p></body></html>'

describe('glance.db SDK asset', () => {
  test('GET /_glance/db.js → the built client, immutable-cached', async () => {
    const { app, env } = setup()
    const res = await app.request('/_glance/db.js', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe(GLANCE_DB_JS)
  })
})

describe('glance.db injection', () => {
  test('gated HTML + flag → boot global + sync script in <head>, before page content', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    const body = await (await app.request(`/_t/${token}/sam/site/?glance_annotate=1`, {}, env)).text()
    expect(body).toContain('window.__GLANCE_DB__=')
    expect(body).toContain('<script src="/_glance/db.js')
    // Synchronous + in head: the SDK must exist before any page script runs.
    expect(body.indexOf('/_glance/db.js')).toBeLessThan(body.indexOf('<body'))
    expect(body).not.toContain('/_glance/db.js?v=undefined')
  })

  test('boot payload carries ONLY the app origin — no token, no site identity', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    const body = await (await app.request(`/_t/${token}/sam/site/?glance_annotate=1`, {}, env)).text()
    const boot = body.match(/window\.__GLANCE_DB__=(\{[^<]*?\})</)?.[1]
    expect(boot).toBeDefined()
    expect(JSON.parse(boot as string)).toEqual({ appOrigin: 'https://glance.example.com' })
  })

  test('without the flag the bytes stay raw', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    const body = await (await app.request(`/_t/${token}/sam/site/`, {}, env)).text()
    expect(body).toBe(HTML)
  })

  test('injectDb falls back sanely when the page has no <head>', () => {
    expect(injectDb('<body class="x"><p>hi</p></body>', 'https://a.example')).toMatch(/<body class="x"><script>window\.__GLANCE_DB__=/)
    expect(injectDb('<p>bare fragment</p>', 'https://a.example')).toMatch(/^<script>window\.__GLANCE_DB__=/)
  })
})
