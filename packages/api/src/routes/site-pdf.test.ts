import { describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../db/schema'
import { PdfPageNotFound, type PdfRenderRequest } from '../lib/pdf'
import { verifyToken } from '../lib/token'
import { seedFile, seedMember, seedSite, seedSpace } from '../test/harness'
import { makeRouteApp, mintUser } from '../test/route-fixtures'
import type { AppEnv } from '../types'

// GET /api/sites/:space/:site/pdf — auth and access first, then options, then the renderer. The
// renderer itself (Browser Rendering) is the PDF_RENDER seam here; it is the only fake.

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46])

async function setup(env: Partial<AppEnv['Bindings']> = {}) {
  const fixture = makeRouteApp()
  const calls: PdfRenderRequest[] = []
  const bindings = {
    ...fixture.env,
    PDF_RENDER: async (req: PdfRenderRequest) => {
      calls.push(req)
      return PDF
    },
    ...env,
  } as AppEnv['Bindings']
  await mintUser(fixture.db, fixture.kv, 'owner')
  await mintUser(fixture.db, fixture.kv, 'stranger')
  const space = await seedSpace(fixture.db, { createdBy: 'owner', slug: 'docs' })
  await seedMember(fixture.db, space, 'owner')
  const reportId = await seedSite(fixture.db, { spaceId: space, ownerId: 'owner', slug: 'report', title: 'Q3 report' })
  await seedSite(fixture.db, { spaceId: space, ownerId: 'owner', slug: 'secret', visibility: 'private' })
  // A file in a site's R2 bucket and files table, as the upload route leaves it.
  const addFile = (siteId: string, path: string, text: string) => seedFile(fixture.db, fixture.r2, siteId, { path, text })
  const addSite = (slug: string) => seedSite(fixture.db, { spaceId: space, ownerId: 'owner', slug })
  const get = (query = '', user: string | null = 'owner', site = 'report', extra: Record<string, string> = {}) =>
    fixture.app.request(`/api/sites/docs/${site}/pdf${query}`, { headers: { ...(user ? { Authorization: `Bearer tok-${user}` } : {}), ...extra } }, bindings)
  return { get, calls, db: fixture.db, reportId, addFile, addSite }
}

describe('GET /api/sites/:space/:site/pdf', () => {
  test('renders through the content URL with a short token for the caller, and names the file', async () => {
    const { get, calls } = await setup()
    const res = await get('?scheme=dark&path=notes/a.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('filename="Q3 report.pdf"')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF)

    const [call] = calls
    const [, , token, ...rest] = new URL(call?.url ?? '').pathname.split('/')
    expect(rest.join('/')).toBe('docs/report/notes/a.html')
    expect(await verifyToken('content-secret', 'docs/report', token)).toBe('owner')
    expect(call?.plan).toMatchObject({ width: '210mm', scheme: 'dark' })
    expect(call?.title).toBe('Q3 report')
    // Links inside the PDF are re-pointed from the tokened origin (a relative link can climb out of
    // the site) to the viewer.
    expect(call?.linkRewrite).toEqual({ from: `${new URL(call?.url ?? '').origin}/_t/${token}/`, to: 'https://glance.example.com/' })
  })

  test('anonymous is 401, a stranger on a private site 403, a missing site 404, and none of them render', async () => {
    const { get, calls } = await setup()
    expect((await get('', null)).status).toBe(401)
    expect((await get('', 'stranger', 'secret')).status).toBe(403)
    expect((await get('', 'owner', 'nope')).status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  test('a cookie request from another site is refused before it can start a render', async () => {
    const { get, calls } = await setup()
    const cookie = { Cookie: '__Host-glance_session=x' }
    expect((await get('', 'owner', 'report', { ...cookie, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await get('', 'owner', 'report', cookie)).status).toBe(403)
    expect(calls).toHaveLength(0)
    expect((await get('', 'owner', 'report', { ...cookie, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)
  })

  test('the cross-site rule does not turn the no-renderer 501 into a 403', async () => {
    const { get } = await setup({ PDF_RENDER: undefined })
    expect((await get('', 'owner', 'report', { Cookie: '__Host-glance_session=x' })).status).toBe(501)
  })

  test('a bad option or path is a 400 before any render', async () => {
    const { get, calls } = await setup()
    for (const q of ['?scheme=sepia', '?path=../x.html', '?path=logo.png', '?theme=https://evil.example.com/x.css']) {
      expect((await get(q)).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  test('no renderer is 501 (the web app prints instead), a rate-limited caller 429, a failed render 502', async () => {
    expect((await (await setup({ PDF_RENDER: undefined })).get()).status).toBe(501)

    const limited = await setup({ PDF_LIMITER: { limit: async () => ({ success: false }) } })
    expect((await limited.get()).status).toBe(429)
    expect(limited.calls).toHaveLength(0)

    const broken = await setup({ PDF_RENDER: async () => Promise.reject(new Error('browser down')) })
    expect((await broken.get()).status).toBe(502)
  })

  test('a page that is not in the site is a 404, not a render failure', async () => {
    const missing = await setup({ PDF_RENDER: async () => Promise.reject(new PdfPageNotFound('gone')) })
    expect((await missing.get('?path=nope.html')).status).toBe(404)
  })

  // The headless render has no Glance app around the page, so the glance.db SDK (a broker that needs
  // the parent viewer frame) is never there: such a page is a 501, which the viewer turns into the
  // browser's print dialog, before any render is started.
  test('a page that uses glance.db is a 501 before any render, in any spelling of the SDK', async () => {
    const spellings = [
      '<script>glance.db.collection("votes").list()</script>',
      '<script>window.glance?.db.collection("votes")</script>',
      '<script>const db = glance["db"]</script>',
      '<script src="/_glance/db.js"></script>',
      '<script>window.__GLANCE_DB__ = {}</script>',
    ]
    for (const [i, html] of spellings.entries()) {
      const { get, calls, reportId, addFile } = await setup()
      await addFile(reportId, 'index.html', `<html><body>${html}</body></html>`)
      const res = await get()
      expect([i, res.status]).toEqual([i, 501])
      expect(((await res.json()) as { error: string }).error).toContain('glance.db')
      expect(calls).toHaveLength(0)
    }
  })

  test('a page without it still renders, prose about a glance included', async () => {
    const { get, calls, reportId, addFile } = await setup()
    await addFile(reportId, 'index.html', '<html><body><p>Take a quick glance at the numbers.</p></body></html>')
    expect((await get()).status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  test('the page asked for is the one judged: a sibling that uses glance.db does not stop another page', async () => {
    const { get, calls, reportId, addFile } = await setup()
    await addFile(reportId, 'index.html', '<html><body>plain</body></html>')
    await addFile(reportId, 'live/votes.html', '<script>glance.db.collection("votes")</script>')
    expect((await get('')).status).toBe(200)
    expect((await get('?path=live/votes.html')).status).toBe(501)
    expect(calls).toHaveLength(1)
  })

  test('the entry page is judged at the root when it is a lone uploaded file, not index.html', async () => {
    const { get, calls, addSite, addFile } = await setup()
    await addFile(await addSite('solo'), 'poll.html', '<script>glance.db.collection("votes")</script>')
    expect((await get('', 'owner', 'solo')).status).toBe(501)
    expect(calls).toHaveLength(0)
  })

  test('a site that holds glance.db documents prints too, as its script may live in a file of its own', async () => {
    const { get, calls, db, reportId, addFile } = await setup()
    await addFile(reportId, 'index.html', '<html><body><script src="app.js"></script></body></html>')
    expect((await get()).status).toBe(200)
    await db.update(sites).set({ docCount: 3 }).where(eq(sites.id, reportId))
    expect((await get()).status).toBe(501)
    expect(calls).toHaveLength(1)
  })

  test('a print-only page does not use up the rate limit', async () => {
    const limiter = { PDF_LIMITER: { limit: async () => ({ success: false }) } }
    const limited = await setup(limiter)
    await limited.addFile(limited.reportId, 'index.html', '<script>glance.db.collection("votes")</script>')
    expect((await limited.get()).status).toBe(501)
    await limited.addFile(limited.reportId, 'plain.html', '<p>plain</p>')
    expect((await limited.get('?path=plain.html')).status).toBe(429)
  })

  test('a failed render never logs the token, and a PDF that still carries it is refused', async () => {
    const logged: string[] = []
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)))
    try {
      const failing = await setup({ PDF_RENDER: async (req) => Promise.reject(new Error(`net::ERR_ABORTED at ${req.url}`)) })
      expect((await failing.get()).status).toBe(502)

      let token = ''
      const leaky = await setup({
        PDF_RENDER: async (req) => {
          token = new URL(req.url).pathname.split('/')[2] as string
          return new TextEncoder().encode(`%PDF /URI (${req.url})`)
        },
      })
      const res = await leaky.get()
      expect([res.status, res.headers.get('content-type')]).toEqual([502, 'application/json'])
      expect(token).not.toBe('')
      expect(logged.length).toBeGreaterThan(0)
      expect(logged.join('')).not.toContain(token)
    } finally {
      spy.mockRestore()
    }
  })
})
