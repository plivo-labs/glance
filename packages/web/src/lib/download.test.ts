import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  fetchPdf,
  fileBaseName,
  isDownloadShortcut,
  loadDownloadOptions,
  PdfUnavailableError,
  pdfRequestUrl,
  requestFrameText,
  saveDownloadOptions,
} from './download'

beforeEach(() => localStorage.clear())

describe('remembered options', () => {
  test('round-trips, and a bad value falls back field by field', () => {
    saveDownloadOptions({ format: 'text', size: 'full', look: 'simple', paper: 'letter' })
    expect(loadDownloadOptions()).toEqual({ format: 'text', size: 'full', look: 'simple', paper: 'letter' })
    localStorage.setItem('glance:download', JSON.stringify({ format: 'docx', size: 'full' }))
    expect(loadDownloadOptions()).toEqual({ ...DEFAULT_DOWNLOAD_OPTIONS, size: 'full' })
    localStorage.setItem('glance:download', '{not json')
    expect(loadDownloadOptions()).toEqual(DEFAULT_DOWNLOAD_OPTIONS)
  })
})

describe('pdfRequestUrl / isDownloadShortcut / fileBaseName', () => {
  test('the request carries the choices, and path and theme only when there are some', () => {
    const site = { spaceSlug: 'a b', siteSlug: 'site' }
    const bare = pdfRequestUrl(site, DEFAULT_DOWNLOAD_OPTIONS, { path: null, dark: false, themeHref: null })
    expect(bare).toBe('/api/sites/a%20b/site/pdf?size=info&look=theme&paper=a4&scheme=light')
    const full = new URL(pdfRequestUrl(site, DEFAULT_DOWNLOAD_OPTIONS, { path: 'docs/x.html', dark: true, themeHref: '/_glance/theme/kapow.css' }), 'http://x')
    expect(full.searchParams.get('path')).toBe('docs/x.html')
    expect(full.searchParams.get('theme')).toBe('/_glance/theme/kapow.css')
    expect(full.searchParams.get('scheme')).toBe('dark')
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

describe('requestFrameText', () => {
  const frame = () => {
    const posted: unknown[] = []
    return { posted, win: { postMessage: (m: unknown) => posted.push(m) } as unknown as Window }
  }
  const answer = (source: unknown, origin: string, text: string) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'glance:text-result', text }, origin, source: source as MessageEventSource }))

  test('resolves with the frame\'s own answer and ignores another origin or source', async () => {
    const { posted, win } = frame()
    const pending = requestFrameText(win, 'https://content.example.com')
    expect(posted).toEqual([{ type: 'glance:text' }])
    answer(win, 'https://evil.example.com', 'spoofed')
    answer(frame().win, 'https://content.example.com', 'other frame')
    answer(win, 'https://content.example.com', 'the page text')
    expect(await pending).toBe('the page text')
  })

  test('rejects when the frame never answers, and when there is no frame', async () => {
    await expect(requestFrameText(frame().win, 'https://content.example.com', 20)).rejects.toThrow(/did not answer/)
    await expect(requestFrameText(null, 'https://content.example.com')).rejects.toThrow(/not ready/)
  })
})
