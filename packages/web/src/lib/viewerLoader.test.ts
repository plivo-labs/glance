import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { api, ApiError } from './api'
import { comments, type Thread } from './comments'
import type { ViewerSite } from './types'
import { loadViewer, PREFETCH_FAILED } from './viewerLoader'

// T11.5 — the viewer loader contract: resolves on site meta alone (comments prefetch pending),
// 401 → login redirect, meta failure → NO prefetch issued, prefetch rejection is benign. NOTE:
// this suite mocks the api seam — it can't prove real network/iframe interleaving; the G4
// real-browser smoke covers that.

const site = (indexPath: string): ViewerSite => ({
  id: 's1',
  spaceSlug: 'me',
  siteSlug: 'demo',
  title: 'Demo',
  visibility: 'private',
  status: 'active',
  isOwner: true,
  contentUrl: 'https://content.test/me/demo/',
  indexPath,
})

const request = () => new Request('https://app.test/me/demo?review=1')
const argsFor = (sitePath = '') => ({ space: 'me', site: 'demo', sitePath, request: request() })

const spies: { mockRestore(): void }[] = []
const stubMeta = (result: ViewerSite | Promise<ViewerSite>) => {
  const s = spyOn(api, 'get').mockReturnValue(Promise.resolve(result) as Promise<unknown>)
  spies.push(s)
  return s
}
const stubMetaError = (err: unknown) => {
  const s = spyOn(api, 'get').mockReturnValue(Promise.reject(err))
  spies.push(s)
  return s
}
const stubList = (impl: () => Promise<Thread[]>) => {
  const s = spyOn(comments, 'list').mockImplementation(impl)
  spies.push(s)
  return s
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

describe('loadViewer', () => {
  test('resolves on site meta while commentsPromise is still pending (iframe never waits)', async () => {
    stubMeta(site('index.html'))
    const list = stubList(() => new Promise<Thread[]>(() => {})) // never settles
    const data = await loadViewer(argsFor()) // ← already resolved though the prefetch is not
    expect(data.site.siteSlug).toBe('demo')
    expect(data.entryPath).toBe('index.html')
    expect(list).toHaveBeenCalledWith(data.site, 'index.html')
    const probe = await Promise.race([data.commentsPromise, Promise.resolve('still-pending')])
    expect(probe).toBe('still-pending')
  })

  test('splat is resolved through resolveEntryPath before prefetching', async () => {
    stubMeta(site('index.html'))
    const list = stubList(() => Promise.resolve([]))
    const data = await loadViewer(argsFor('docs/'))
    expect(data.entryPath).toBe('docs/index.html')
    expect(list).toHaveBeenCalledWith(data.site, 'docs/index.html')
  })

  test("indexPath '' at the root → NO prefetch, comments.list never called", async () => {
    stubMeta(site(''))
    const list = stubList(() => Promise.resolve([]))
    const data = await loadViewer(argsFor())
    expect(data.entryPath).toBeNull()
    expect(data.commentsPromise).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  test('meta 401 → toLogin redirect preserving the current location', async () => {
    stubMetaError(new ApiError(401, 'unauthorized'))
    const list = stubList(() => Promise.resolve([]))
    let thrown: unknown
    try {
      await loadViewer(argsFor())
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Response)
    const res = thrown as Response
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/login?next=${encodeURIComponent('/me/demo?review=1')}`)
    expect(list).not.toHaveBeenCalled()
  })

  test.each([403, 404, 410])('meta %i rethrows to the ErrorBoundary with NO prefetch issued', async (status) => {
    const err = new ApiError(status, 'nope')
    stubMetaError(err)
    const list = stubList(() => Promise.resolve([]))
    await expect(loadViewer(argsFor())).rejects.toBe(err)
    expect(list).not.toHaveBeenCalled()
  })

  test('prefetch rejection never rejects the loader — commentsPromise settles to PREFETCH_FAILED', async () => {
    stubMeta(site('index.html'))
    stubList(() => Promise.reject(new ApiError(500, 'kaboom')))
    const data = await loadViewer(argsFor()) // ← loader itself resolved fine
    expect(data.entryPath).toBe('index.html')
    // the promise RESOLVES (to the sentinel) — no rejection can ever go unhandled
    expect(await data.commentsPromise).toBe(PREFETCH_FAILED)
  })
})
