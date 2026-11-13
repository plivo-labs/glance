import { describe, expect, test } from 'bun:test'
import { verifyToken } from '../lib/token'
import type { PdfRenderRequest } from '../lib/pdf'
import { seedMember, seedSite, seedSpace } from '../test/harness'
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
  await seedSite(fixture.db, { spaceId: space, ownerId: 'owner', slug: 'report', title: 'Q3 report' })
  await seedSite(fixture.db, { spaceId: space, ownerId: 'owner', slug: 'secret', visibility: 'private' })
  const get = (query = '', user: string | null = 'owner', site = 'report') =>
    fixture.app.request(`/api/sites/docs/${site}/pdf${query}`, { headers: user ? { Authorization: `Bearer tok-${user}` } : {} }, bindings)
  return { get, calls }
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
    // Links inside the PDF are re-pointed from the tokened URL to the viewer URL.
    expect(call?.linkRewrite).toEqual({ from: `${new URL(call?.url ?? '').origin}/_t/${token}/docs/report/`, to: 'https://glance.example.com/docs/report/' })
  })

  test('anonymous is 401, a stranger on a private site 403, a missing site 404, and none of them render', async () => {
    const { get, calls } = await setup()
    expect((await get('', null)).status).toBe(401)
    expect((await get('', 'stranger', 'secret')).status).toBe(403)
    expect((await get('', 'owner', 'nope')).status).toBe(404)
    expect(calls).toHaveLength(0)
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
})
