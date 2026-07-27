import { beforeEach, describe, expect, test } from 'bun:test'
import { __resetDbBookmark, api, BOOKMARK_HEADER, captureDbBookmark } from './api'

// D1 session bookmark threading (issue #79): the API echoes the newest bookmark it saw on a
// response header; sending it back anchors the server's next D1 session so a user reads
// their own prior writes even when the read lands on a replica.

function stubFetch(headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json', ...headers } }),
    )
  }) as unknown as typeof fetch
  return calls
}

const sentBookmark = (call: { init?: RequestInit }) =>
  (call.init?.headers as Record<string, string> | undefined)?.[BOOKMARK_HEADER]

describe('api — D1 bookmark round-trip', () => {
  beforeEach(__resetDbBookmark)

  test('first request sends no bookmark header', async () => {
    const calls = stubFetch()
    await api.get('/api/spaces')
    expect(sentBookmark(calls[0])).toBeUndefined()
  })

  test('a response bookmark is echoed on the next request', async () => {
    const calls = stubFetch({ [BOOKMARK_HEADER]: 'bm-1' })
    await api.post('/api/spaces', { name: 'x' })
    await api.get('/api/spaces')
    expect(sentBookmark(calls[1])).toBe('bm-1')
  })

  test('captureDbBookmark (XHR upload seam) feeds the next request; null is a no-op', async () => {
    const calls = stubFetch()
    captureDbBookmark('bm-upload')
    captureDbBookmark(null)
    await api.get('/api/sites')
    expect(sentBookmark(calls[0])).toBe('bm-upload')
  })

  test('a response without a bookmark keeps the last one', async () => {
    let calls = stubFetch({ [BOOKMARK_HEADER]: 'bm-1' })
    await api.get('/api/a')
    calls = stubFetch()
    await api.get('/api/b')
    await api.get('/api/c')
    expect(sentBookmark(calls[1])).toBe('bm-1')
  })
})
