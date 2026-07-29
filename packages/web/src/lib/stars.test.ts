import { describe, expect, test } from 'bun:test'
import { setStar, starPath } from './stars'

// The star toggle's wire contract. The optimistic UI around it needs a renderer to test (this
// package has no component harness — see the tracker's Phase 3 gate), but WHICH request a toggle
// makes is pure and pinned here: a star is a POST and an unstar is a DELETE to the same path.

function stubFetch() {
  const calls: Array<{ url: string; method?: string }> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method })
    return Promise.resolve(
      new Response('{"starred":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }) as unknown as typeof fetch
  return calls
}

const site = { spaceSlug: 'design', siteSlug: 'q3-deck' }

describe('setStar — one path, two verbs', () => {
  test('starring POSTs and unstarring DELETEs the same star path', async () => {
    const calls = stubFetch()
    await setStar(site, true)
    await setStar(site, false)
    expect(calls).toEqual([
      { url: '/api/sites/design/q3-deck/star', method: 'POST' },
      { url: '/api/sites/design/q3-deck/star', method: 'DELETE' },
    ])
  })

  test('starPath is built from the site identity, not a pre-formatted url', () => {
    expect(starPath(site)).toBe('/api/sites/design/q3-deck/star')
  })
})
