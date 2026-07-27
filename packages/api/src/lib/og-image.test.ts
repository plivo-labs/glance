import { describe, expect, test } from 'bun:test'
import { ogCardHtml, signedOgImageUrl, signOgSig, verifyOgSig } from './og-image'

const TEST_SIGNING_KEY = 'not-a-real-og-secret'

describe('og signature', () => {
  test('sign → verify roundtrips; hex output is URL-safe as-is', async () => {
    const sig = await signOgSig(TEST_SIGNING_KEY, 'acme', 'report')
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    expect(await verifyOgSig(TEST_SIGNING_KEY, 'acme', 'report', sig)).toBe(true)
  })

  test('any moved part breaks verification: sig, slugs, secret', async () => {
    const sig = await signOgSig(TEST_SIGNING_KEY, 'acme', 'report')
    expect(await verifyOgSig(TEST_SIGNING_KEY, 'acme', 'report', sig.replace(/^./, 'f'))).toBe(false)
    expect(await verifyOgSig(TEST_SIGNING_KEY, 'acme', 'other', sig)).toBe(false)
    expect(await verifyOgSig(TEST_SIGNING_KEY, 'other', 'report', sig)).toBe(false)
    expect(await verifyOgSig('another-secret', 'acme', 'report', sig)).toBe(false)
    expect(await verifyOgSig(TEST_SIGNING_KEY, 'acme', 'report', '')).toBe(false)
  })

  test("the raw MAC message is separator-AMBIGUOUS — (a/b, c) and (a, b/c) sign identically — which is safe only because slugs are [a-z0-9-] (parseSiteUrl/isValidSlug) and can never contain '/'", async () => {
    const sig = await signOgSig(TEST_SIGNING_KEY, 'acme/report', 'x')
    expect(await verifyOgSig(TEST_SIGNING_KEY, 'acme', 'report/x', sig)).toBe(true)
  })

  test('signedOgImageUrl mints the sig as a query param on the CONTENT origin', async () => {
    const sig = await signOgSig(TEST_SIGNING_KEY, 'acme', 'report')
    expect(await signedOgImageUrl(TEST_SIGNING_KEY, 'https://content.example.com', 'acme', 'report')).toBe(
      `https://content.example.com/_glance/og/acme/report.png?sig=${sig}&v=3`,
    )
  })
})

describe('ogCardHtml', () => {
  test('neutralizes markup in the author-controlled title WITHOUT entities (workers-og never decodes them — &amp; would render literally)', () => {
    const html = ogCardHtml({ title: '<b>&"Q3"', spaceSlug: 'acme', siteSlug: 'report' })
    expect(html).toContain('‹b›&"Q3"') // angle-quote lookalikes; & and " stay raw
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('&amp;')
    expect(html).toContain('acme/report')
    expect(html).toContain('data:image/svg+xml;base64,') // the brand mark rides inline
  })

  test('the title span carries satori line-clamp so overlong titles ellipsize at three lines', () => {
    const html = ogCardHtml({ title: 'Q3 Report', spaceSlug: 'acme', siteSlug: 'report' })
    // Needs display:block on the same span — satori only clamps block text containers.
    expect(html).toMatch(/display:block;line-clamp:3;[^"]*">Q3 Report</)
  })
})
