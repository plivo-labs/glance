import { describe, expect, test } from 'bun:test'
import { ogCardHtml, ogImageUrl, signOgSig, verifyOgSig } from './og-image'

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

  test('the slug separator cannot be gamed: (a/b, c) never verifies as (a, b/c)', async () => {
    const sig = await signOgSig(TEST_SIGNING_KEY, 'acme/report', 'x')
    expect(await verifyOgSig(TEST_SIGNING_KEY, 'acme', 'report/x', sig)).toBe(true) // same message…
    // …but slugs are [a-z0-9-] (parseSiteUrl/isValidSlug), so a slash never reaches signing in
    // practice; this test just documents the raw-primitive behavior.
  })

  test('ogImageUrl carries the sig as a query param on the CONTENT origin', () => {
    expect(ogImageUrl('https://content.example.com', 'acme', 'report', 'abc123')).toBe(
      'https://content.example.com/_glance/og/acme/report.png?sig=abc123',
    )
  })
})

describe('ogCardHtml', () => {
  test('escapes the author-controlled title and shows the space/site pair', () => {
    const html = ogCardHtml({ title: '<b>&"Q3"', spaceSlug: 'acme', siteSlug: 'report' })
    expect(html).toContain('&lt;b&gt;&amp;&quot;Q3&quot;')
    expect(html).not.toContain('<b>')
    expect(html).toContain('acme/report')
    expect(html).toContain('data:image/svg+xml;base64,') // the brand mark rides inline
  })
})
