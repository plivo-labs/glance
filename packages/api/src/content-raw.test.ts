import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import contentApp from './content'
import { signToken } from './lib/token'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from './test/harness'

// Phase 3 / S12 — raw source mode. `glance read --pull` needs the .md SOURCE to round-trip a site,
// but a bare GET of a .md renders it to HTML. On the gated path, ?raw=1 streams the stored bytes
// verbatim (no markdown render, no annotate injection).

const secret = 'ct-secret'
const MD = '# about\n\nsome *source* text\n'

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

async function gatedMd(db: ReturnType<typeof makeDb>, r2: ReturnType<typeof makeR2>) {
  const uid = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team' })
  await seedFile(db, r2, siteId, { path: 'about.md', text: MD, mimeType: 'text/markdown' })
  const token = await signToken(secret, uid, 'sam/site', 300)
  return token
}

describe('content ?raw=1 — raw markdown source', () => {
  test('content.raw.md.source: GET .md?raw=1 streams the raw bytes, not rendered HTML', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedMd(db, r2)
    const res = await app.request(`/_t/${token}/sam/site/about.md?raw=1`, {}, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe(MD)
    expect(body).not.toContain('<h1>')
  })

  test('content.md.rendered.pin: GET .md WITHOUT raw still renders to HTML (unchanged)', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedMd(db, r2)
    const res = await app.request(`/_t/${token}/sam/site/about.md`, {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('<h1>about</h1>')
  })
})
