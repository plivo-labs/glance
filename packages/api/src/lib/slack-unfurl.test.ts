import { describe, expect, test } from 'bun:test'
import { countingKv } from '../test/harness'
import { buildUnfurlBlocks, parseSiteUrl, postUnfurl } from './slack-unfurl'
import type { SlackHttpDeps } from './slack'

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

describe('buildUnfurlBlocks', () => {
  const site = { title: 'Q3 Report', description: 'How the numbers moved', slug: 'report' }

  test('links the title and includes the blurb plus a context line', () => {
    const json = JSON.stringify(buildUnfurlBlocks(site, 'acme', `${APP}/acme/report`))
    expect(json).toContain(`<${APP}/acme/report|Q3 Report>`)
    expect(json).toContain('How the numbers moved')
    expect(json).toContain('acme/report')
  })

  test('falls back to the slug when the site has no title, and drops the blurb when absent', () => {
    const blocks = buildUnfurlBlocks({ ...site, title: null, description: null }, 'acme', `${APP}/acme/report`)
    expect(JSON.stringify(blocks)).toContain('|report>')
    expect(blocks).toHaveLength(2) // title section + context, no description section
  })

  test('escapes mrkdwn metacharacters in the author-controlled title and description', () => {
    const json = JSON.stringify(
      buildUnfurlBlocks({ ...site, title: '<script>&x', description: 'a > b & c < d' }, 'acme', `${APP}/acme/report`),
    )
    expect(json).toContain('&lt;script&gt;&amp;x')
    expect(json).toContain('a &gt; b &amp; c &lt; d')
    expect(json).not.toContain('<script>')
  })
})

describe('postUnfurl', () => {
  const unfurls = { [`${APP}/acme/report`]: { blocks: [{ type: 'section' }] } }

  /** Capture the JSON body chat.unfurl was called with (null when it was never called). */
  function capture() {
    let body: Record<string, unknown> | null = null
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
