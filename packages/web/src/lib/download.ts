// The viewer's Download dialog: the options, how they are remembered, and the three ways a download
// can happen (server PDF, plain text read out of the frame, browser print as the fallback).

export type DownloadOptions = {
  format: 'pdf' | 'text'
  /** info = A4/Letter, content reflowed into a readable column; full = wide pages, as on screen. */
  size: 'info' | 'full'
  /** theme = as designed (theme, backgrounds, current light/dark); simple = plain light print. */
  look: 'theme' | 'simple'
  paper: 'a4' | 'letter'
}

export const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = { format: 'pdf', size: 'info', look: 'theme', paper: 'a4' }

const STORAGE_KEY = 'glance:download'

const ALLOWED: { [K in keyof DownloadOptions]: readonly DownloadOptions[K][] } = {
  format: ['pdf', 'text'],
  size: ['info', 'full'],
  look: ['theme', 'simple'],
  paper: ['a4', 'letter'],
}

/** The last choices, field by field: a value that is not one of ours falls back to the default. */
export function loadDownloadOptions(): DownloadOptions {
  let saved: Partial<Record<keyof DownloadOptions, unknown>> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (parsed && typeof parsed === 'object') saved = parsed
  } catch {
    /* storage blocked or corrupt: defaults */
  }
  const pick = <K extends keyof DownloadOptions>(key: K): DownloadOptions[K] =>
    (ALLOWED[key] as readonly unknown[]).includes(saved[key]) ? (saved[key] as DownloadOptions[K]) : DEFAULT_DOWNLOAD_OPTIONS[key]
  return { format: pick('format'), size: pick('size'), look: pick('look'), paper: pick('paper') }
}

export function saveDownloadOptions(o: DownloadOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(o))
  } catch {
    /* a per-viewer convenience only */
  }
}

const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const shortcutLabel = (): string => (isApple() ? '⌘⇧S' : 'Ctrl+Shift+S')

export function isDownloadShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's'
}

type SiteRef = { spaceSlug: string; siteSlug: string }

export function pdfRequestUrl(
  site: SiteRef,
  o: DownloadOptions,
  ctx: { path: string | null; dark: boolean; themeHref: string | null },
): string {
  const q = new URLSearchParams({ size: o.size, look: o.look, paper: o.paper, scheme: ctx.dark ? 'dark' : 'light' })
  if (ctx.path) q.set('path', ctx.path)
  // A non-owner's local "View in theme": the server render never sees the client-side swap.
  if (ctx.themeHref) q.set('theme', ctx.themeHref)
  return `/api/sites/${encodeURIComponent(site.spaceSlug)}/${encodeURIComponent(site.siteSlug)}/pdf?${q}`
}

/** The server cannot make a PDF here (no Browser Rendering binding, or the render failed). */
export class PdfUnavailableError extends Error {}

export function fileBaseName(title: string | null, siteSlug: string): string {
  const printable = Array.from(title?.trim() || siteSlug, (ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch)).join('')
  const clean = printable.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.slice(0, 120) || siteSlug
}

function nameFromDisposition(header: string | null): string | null {
  const utf8 = header && /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1]
  if (!utf8) return null
  try {
    return decodeURIComponent(utf8)
  } catch {
    return null
  }
}

export async function fetchPdf(url: string, fallbackName: string): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(url, { credentials: 'include' })
  if (res.status === 501 || res.status === 502) throw new PdfUnavailableError(`PDF export unavailable (${res.status})`)
  if (res.status === 429) throw new Error('Too many PDFs just now. Try again in a minute.')
  if (!res.ok) throw new Error(`Could not make the PDF (${res.status})`)
  return { blob: await res.blob(), name: nameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName }
}

/** Asks the frame for the page's text. The frame is cross-origin, so it answers by message. */
export function requestFrameText(frame: Window | null | undefined, origin: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!frame) return reject(new Error('The page is not ready yet.'))
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('The page did not answer. Reload it and try again.'))
    }, timeoutMs)
    function onMessage(e: MessageEvent) {
      const d = e.data as { type?: string; text?: unknown } | null
      if (e.source !== frame || e.origin !== origin || d?.type !== 'glance:text-result' || typeof d.text !== 'string') return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(d.text)
    }
    window.addEventListener('message', onMessage)
    frame.postMessage({ type: 'glance:text' }, origin)
  })
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
