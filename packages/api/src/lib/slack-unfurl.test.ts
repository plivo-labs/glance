import { describe, expect, test } from 'bun:test'
import { countingKv } from '../test/harness'
import {
  buildUnfurlAttachment,
  parseSiteUrl,
  postUnfurl,
  relativeTime,
  type SlackAttachment,
  type UnfurlCard,
} from './slack-unfurl'
import type { SlackHttpDeps } from './slack'

// The chat.unfurl POST body postUnfurl assembles: a target discriminant plus the per-URL card map.
type PostedUnfurlBody = {
  unfurl_id?: string
  source?: string
  channel?: string
  ts?: string
  unfurls: Record<string, SlackAttachment>
}

const APP = 'https://glance.example.com'

const depsWith = (fetchImpl: typeof fetch) =>
  ({ kv: countingKv(), token: 'xoxb-test', fetchImpl }) as unknown as SlackHttpDeps

describe('parseSiteUrl', () => {
  test('returns the space and site slugs a URL points at, ignoring path tail, query, and fragment', () => {
    const expected = { spaceSlug: 'acme', siteSlug: 'report' }
    expect(parseSiteUrl(`${APP}/acme/report`, APP)).toEqual(expected)
    expect(parseSiteUrl(`${APP}/acme/report/docs/page.html`, APP)).toEqual(expected)
    expect(parseSiteUrl(`${APP}/acme/report?review=1#c1`, APP)).toEqual(expected)
    expect(parseSiteUrl(`${APP}/acme/report/`, APP)).toEqual(expected)
  })

  test('rejects any other origin — a look-alike host must never resolve against our data', () => {
    expect(parseSiteUrl('https://glance.evil.com/acme/report', APP)).toBeNull()
    expect(parseSiteUrl('http://glance.example.com/acme/report', APP)).toBeNull() // scheme is part of origin
    expect(parseSiteUrl('https://glance.example.com.evil.com/acme/report', APP)).toBeNull()
  })

  test('rejects non-site paths: too few segments and reserved first segments', () => {
    expect(parseSiteUrl(`${APP}/`, APP)).toBeNull()
    expect(parseSiteUrl(`${APP}/dashboard`, APP)).toBeNull()
    expect(parseSiteUrl(`${APP}/api/sites/acme/report`, APP)).toBeNull()
    expect(parseSiteUrl(`${APP}/assets/index-abc.js`, APP)).toBeNull()
    expect(parseSiteUrl('not a url', APP)).toBeNull()
  })
})

describe('relativeTime', () => {
  const NOW = Date.parse('2026-07-27T12:00:00Z')
  const at = (iso: string) => relativeTime(iso, NOW)

  test('picks the coarsest unit that fits', () => {
    expect(at('2026-07-27T11:59:30Z')).toBe('just now')
    expect(at('2026-07-27T11:55:00Z')).toBe('5 minutes ago')
    expect(at('2026-07-27T09:00:00Z')).toBe('3 hours ago')
    expect(at('2026-07-24T12:00:00Z')).toBe('3 days ago')
    expect(at('2026-05-20T12:00:00Z')).toBe('2 months ago')
    expect(at('2024-07-01T12:00:00Z')).toBe('2 years ago')
  })

  test('singular units, future skew clamps to "just now", garbage yields null', () => {
    expect(at('2026-07-27T10:59:00Z')).toBe('1 hour ago')
    expect(at('2026-07-26T11:00:00Z')).toBe('1 day ago')
    expect(at('2026-07-28T12:00:00Z')).toBe('just now') // clock skew, never "in 1 day"
    expect(at('not-a-date')).toBeNull()
  })
})

describe('buildUnfurlAttachment', () => {
  const NOW = Date.parse('2026-07-27T12:00:00Z')
  const card: UnfurlCard = {
    title: 'Q3 Report',
    spaceSlug: 'acme',
    siteSlug: 'report',
    description: 'How the numbers moved',
    updatedAt: '2026-07-24T12:00:00Z',
  }
  const build = (over: Partial<UnfurlCard>) => buildUnfurlAttachment({ ...card, ...over }, `${APP}/acme/report`, NOW)

  test('a legacy-style attachment (NOT blocks — an image block always renders full-width): linked title, blurb, footer with freshness', () => {
    expect(build({})).toEqual({
      title: 'Q3 Report',
      title_link: `${APP}/acme/report`,
      text: 'How the numbers moved',
      footer: 'Glance · acme/report · Updated 3 days ago',
    })
  })

  test('falls back to the slug when the site has no title, and drops the blurb when absent', () => {
    const attachment = build({ title: null, description: null })
    expect(attachment.title).toBe('report')
    expect(attachment).not.toHaveProperty('text')
  })

  test('an unparseable updatedAt drops the freshness clause, not the card', () => {
    expect(build({ updatedAt: 'garbage' }).footer).toBe('Glance · acme/report')
  })

  test('an imageUrl rides as the attachment image_url (400px-capped by Slack), absent otherwise', () => {
    expect(build({ imageUrl: `${APP}/api/og/acme/report.png?sig=abc` }).image_url).toBe(
      `${APP}/api/og/acme/report.png?sig=abc`,
    )
    expect(build({})).not.toHaveProperty('image_url')
  })

  test('escapes mrkdwn metacharacters in the author-controlled title and description', () => {
    const attachment = build({ title: '<script>&x', description: 'a > b & c < d' })
    expect(attachment.title).toBe('&lt;script&gt;&amp;x')
    expect(attachment.text).toBe('a &gt; b &amp; c &lt; d')
  })
})

describe('postUnfurl', () => {
  const unfurls = { [`${APP}/acme/report`]: { title: 'Q3', title_link: `${APP}/acme/report`, footer: 'Glance' } }

  /** Capture the JSON body chat.unfurl was called with (null when it was never called). */
  function capture() {
    let body: PostedUnfurlBody | null = null
    const deps = depsWith(async (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body))
      return Response.json({ ok: true })
    })
    return { deps, body: () => body }
  }

  test('addresses the message by unfurl_id + source when present, keyed by the pasted URL', async () => {
    const { deps, body } = capture()
    await postUnfurl(deps, { unfurl_id: 'C1.1', source: 'conversations_history', channel: 'C1', message_ts: '1.2' }, unfurls)
    expect(body()).toMatchObject({ unfurl_id: 'C1.1', source: 'conversations_history' })
    // Exclusive with the channel+ts form — Slack gets one addressing scheme, not both.
    expect(body()?.channel).toBeUndefined()
    expect(Object.keys(body()?.unfurls as object)).toEqual([`${APP}/acme/report`])
  })

  test('falls back to channel + ts when the event carries no unfurl_id', async () => {
    const { deps, body } = capture()
    await postUnfurl(deps, { channel: 'C123', message_ts: '1.2' }, unfurls)
    expect(body()).toMatchObject({ channel: 'C123', ts: '1.2' })
    expect(body()?.unfurl_id).toBeUndefined()
  })

  test('no cards → zero HTTP; a failing post never throws', async () => {
    const { deps, body } = capture()
    await postUnfurl(deps, { unfurl_id: 'C1.1' }, {})
    expect(body()).toBeNull()
    await postUnfurl(
      depsWith(() => {
        throw new Error('network')
      }),
      { unfurl_id: 'C1.1' },
      unfurls,
    )
  })
})
