import { afterEach, describe, expect, test } from 'bun:test'
import { fetchPdf, fileBaseName, isDownloadShortcut, PdfUnavailableError, pdfRequestUrl, requestFrameExport } from './download'

describe('pdfRequestUrl / isDownloadShortcut / fileBaseName', () => {
  test('the request carries the scheme, and path and theme only when there are some', () => {
    const site = { spaceSlug: 'a b', siteSlug: 'site' }
    expect(pdfRequestUrl(site, { path: null, dark: false, themeHref: null })).toBe('/api/sites/a%20b/site/pdf?scheme=light')
    const full = new URL(pdfRequestUrl(site, { path: 'docs/x.html', dark: true, themeHref: '/_glance/theme/kapow.css' }), 'http://x')
    expect([full.searchParams.get('scheme'), full.searchParams.get('path'), full.searchParams.get('theme')]).toEqual(['dark', 'docs/x.html', '/_glance/theme/kapow.css'])
  })

  test('only Cmd/Ctrl+Shift+S is the shortcut', () => {
    const k = (o: object) => isDownloadShortcut({ key: 's', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o })
    expect(k({ metaKey: true, shiftKey: true, key: 'S' })).toBe(true)
    expect(k({ ctrlKey: true, shiftKey: true })).toBe(true)
    expect([k({ metaKey: true }), k({ shiftKey: true }), k({ metaKey: true, shiftKey: true, altKey: true })]).toEqual([false, false, false])
  })

  test('file names drop path and reserved characters, fall back to the slug, and name a sub-page after its file', () => {
    expect(fileBaseName('Q3: plan / draft?', 'slug')).toBe('Q3 plan draft')
    expect(fileBaseName(null, 'slug')).toBe('slug')
    expect(fileBaseName('Handbook', 'slug', 'docs/setup guide.html')).toBe('Handbook - setup guide')
  })
})

describe('fetchPdf', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const reply = (status: number, headers: Record<string, string> = {}) => {
    globalThis.fetch = (async () => new Response(status === 200 ? 'pdf' : '{}', { status, headers })) as typeof fetch
  }

  test('501 and 502 mean "print instead"; every other failure says what happened and what to do', async () => {
    for (const status of [501, 502]) {
      reply(status)
      await expect(fetchPdf('/x')).rejects.toBeInstanceOf(PdfUnavailableError)
    }
    for (const [status, message] of [[401, /Sign in again/], [403, /do not have access/], [404, /not found/], [429, /Too many/], [500, /Try again/]] as const) {
      reply(status)
      await expect(fetchPdf('/x')).rejects.toThrow(message)
    }
    globalThis.fetch = (async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    await expect(fetchPdf('/x')).rejects.toThrow(/Check your connection/)
  })

  test('a 200 is the PDF bytes', async () => {
    reply(200)
    expect(await (await fetchPdf('/x')).text()).toBe('pdf')
  })
})

describe('requestFrameExport', () => {
  const frame = () => {
    const posted: unknown[] = []
    return { posted, win: { postMessage: (m: unknown) => posted.push(m) } as unknown as Window }
  }
  const answer = (source: unknown, origin: string, format: string, content: string) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'glance:export-result', format, content }, origin, source: source as MessageEventSource }))

  test('asks for the format and resolves with that frame\'s own answer, ignoring another origin, source or format', async () => {
    const { posted, win } = frame()
    const pending = requestFrameExport(win, 'https://content.example.com', 'markdown')
    expect(posted).toEqual([{ type: 'glance:export', format: 'markdown' }])
    answer(win, 'https://evil.example.com', 'markdown', 'spoofed')
    answer(frame().win, 'https://content.example.com', 'markdown', 'other frame')
    answer(win, 'https://content.example.com', 'text', 'wrong format')
    answer(win, 'https://content.example.com', 'markdown', '# the page')
    expect(await pending).toBe('# the page')
  })

  test('rejects when the frame never answers, and when there is no frame', async () => {
    await expect(requestFrameExport(frame().win, 'https://content.example.com', 'text', 20)).rejects.toThrow(/did not answer/)
    await expect(requestFrameExport(null, 'https://content.example.com', 'text')).rejects.toThrow(/not ready/)
  })
})
