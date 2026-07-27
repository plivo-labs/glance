import { describe, expect, test } from 'bun:test'
import { type OgCard, signOgSig } from './lib/og-image'
import { type Setup, setup } from './test/content-fixtures'
import { seedSite, seedSpace, seedUser } from './test/harness'

// The signed unfurl-image route on the CONTENT worker. The fixture env's CONTENT_TOKEN_SECRET is
// 'test-secret' (the same secret the main worker signs with); the real renderer is never
// exercised here — OG_RENDER is the env DI seam (like SLACK_FETCH), so these tests prove the
// signature gate and the site resolution, not satori.

const SECRET = 'test-secret'

/** Recording OG_RENDER: captures the card each render was asked for. */
function fakeRender() {
  const cards: OgCard[] = []
  const render = async (card: OgCard) => {
    cards.push(card)
    return new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
  }
  return { render, cards }
}

async function seedReport(s: Setup, o: { title?: string | null; status?: 'active' | 'archived' } = {}) {
  const owner = await seedUser(s.db)
  const spaceId = await seedSpace(s.db, { createdBy: owner, slug: 'acme' })
  await seedSite(s.db, {
    spaceId,
    ownerId: owner,
    slug: 'report',
    title: o.title === undefined ? 'Q3 Report' : o.title,
    status: o.status ?? 'active',
  })
}

const get = (s: Setup, path: string, render: (card: OgCard) => Promise<Response>) =>
  s.app.request(path, {}, { ...(s.env as object), OG_RENDER: render } as Parameters<typeof s.app.request>[2])

describe('GET /_glance/og/:space/:site.png', () => {
  test('a correctly signed URL renders the card for that site', async () => {
    const s = setup()
    await seedReport(s)
    const { render, cards } = fakeRender()
    const sig = await signOgSig(SECRET, 'acme', 'report')
    const res = await get(s, `/_glance/og/acme/report.png?sig=${sig}`, render)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('public')
    expect(cards).toEqual([{ title: 'Q3 Report', spaceSlug: 'acme', siteSlug: 'report' }])
  })

  test('a missing or malformed signature is an opaque 404 — no render, no existence signal', async () => {
    const s = setup()
    await seedReport(s)
    const { render, cards } = fakeRender()
    expect((await get(s, '/_glance/og/acme/report.png', render)).status).toBe(404)
    expect((await get(s, '/_glance/og/acme/report.png?sig=deadbeef', render)).status).toBe(404)
    expect(cards).toHaveLength(0)
  })

  test("a TAMPERED signature (another site's valid sig) never verifies", async () => {
    const s = setup()
    await seedReport(s)
    const { render, cards } = fakeRender()
    // Valid for acme/other-site — replayed against acme/report it must fail.
    const stolen = await signOgSig(SECRET, 'acme', 'other-site')
    expect((await get(s, `/_glance/og/acme/report.png?sig=${stolen}`, render)).status).toBe(404)
    expect(cards).toHaveLength(0)
  })

  test('a signed URL for a site that no longer exists (or was archived) stops serving', async () => {
    const missing = setup()
    await seedReport(missing)
    const { render, cards } = fakeRender()
    const gone = await signOgSig(SECRET, 'acme', 'deleted-site')
    expect((await get(missing, `/_glance/og/acme/deleted-site.png?sig=${gone}`, render)).status).toBe(404)

    const archived = setup()
    await seedReport(archived, { status: 'archived' })
    const sig = await signOgSig(SECRET, 'acme', 'report')
    expect((await get(archived, `/_glance/og/acme/report.png?sig=${sig}`, render)).status).toBe(404)
    expect(cards).toHaveLength(0)
  })

  test('a titleless site falls back to its slug on the card', async () => {
    const s = setup()
    await seedReport(s, { title: null })
    const { render, cards } = fakeRender()
    const sig = await signOgSig(SECRET, 'acme', 'report')
    await get(s, `/_glance/og/acme/report.png?sig=${sig}`, render)
    expect(cards[0]?.title).toBe('report')
  })
})
