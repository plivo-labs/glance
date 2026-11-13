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

  test('file names drop path and reserved characters, and fall back to the slug', () => {
    expect(fileBaseName('Q3: plan / draft?', 'slug')).toBe('Q3 plan draft')
    expect(fileBaseName(null, 'slug')).toBe('slug')
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

  test('501 and 502 mean "print instead"; 429 is a plain message; 200 names the file from the header', async () => {
    reply(501)
    await expect(fetchPdf('/x', 'f.pdf')).rejects.toBeInstanceOf(PdfUnavailableError)
    reply(502)
    await expect(fetchPdf('/x', 'f.pdf')).rejects.toBeInstanceOf(PdfUnavailableError)
    reply(429)
    await expect(fetchPdf('/x', 'f.pdf')).rejects.toThrow(/Too many/)
    reply(200, { 'content-disposition': `attachment; filename="a.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf` })
    expect((await fetchPdf('/x', 'f.pdf')).name).toBe('Résumé.pdf')
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
