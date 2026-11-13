// The viewer's Download menu: what each format does, and the ways a download can happen (server
// PDF, text or Markdown read out of the frame, browser print as the PDF fallback).

export type DownloadFormat = 'pdf' | 'md' | 'txt'

export const DOWNLOAD_FORMATS: { format: DownloadFormat; label: string; ext: string }[] = [
  { format: 'pdf', label: 'PDF', ext: '.pdf' },
  { format: 'md', label: 'Markdown', ext: '.md' },
  { format: 'txt', label: 'Plain text', ext: '.txt' },
]

const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const shortcutLabel = (): string => (isApple() ? '⌘⇧S' : 'Ctrl+Shift+S')

export function isDownloadShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's'
}

export function pdfRequestUrl(
  site: { spaceSlug: string; siteSlug: string },
  ctx: { path: string | null; dark: boolean; themeHref: string | null },
): string {
  const q = new URLSearchParams({ scheme: ctx.dark ? 'dark' : 'light' })
  if (ctx.path) q.set('path', ctx.path)
  // A non-owner's local "View in theme": the server render never sees the client-side swap.
  if (ctx.themeHref) q.set('theme', ctx.themeHref)
  return `/api/sites/${encodeURIComponent(site.spaceSlug)}/${encodeURIComponent(site.siteSlug)}/pdf?${q}`
}

/** The server cannot make a PDF here (no Browser Rendering binding, or the render failed). */
export class PdfUnavailableError extends Error {}

export function fileBaseName(title: string | null, siteSlug: string, page: string | null = null): string {
  const clean = (s: string) =>
    Array.from(s, (ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch))
      .join('')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const base = clean(title?.trim() || siteSlug).slice(0, 120) || siteSlug
  // A sub-page of a multi-page site is named after its file, so exporting two pages never overwrites one file.
  const stem = clean((page?.split('/').pop() ?? '').replace(/\.[^.]+$/, ''))
  return stem ? `${base} - ${stem}` : base
}

export async function fetchPdf(url: string): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'include' })
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.')
  }
  if (res.status === 501 || res.status === 502) throw new PdfUnavailableError(`PDF export unavailable (${res.status})`)
  if (res.status === 401) throw new Error('Your session has ended. Sign in again to download.')
  if (res.status === 403) throw new Error('You do not have access to download this page.')
  if (res.status === 404) throw new Error('This page was not found.')
  if (res.status === 429) throw new Error('Too many PDFs just now. Try again in a minute.')
  if (!res.ok) throw new Error(`The PDF could not be made (${res.status}). Try again in a moment.`)
  return await res.blob()
}

/** Asks the frame for the page as text or Markdown. The frame is cross-origin, so it answers by message. */
export function requestFrameExport(
  frame: Window | null | undefined,
  origin: string,
  format: 'text' | 'markdown',
  timeoutMs = 4000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!frame) return reject(new Error('The page is not ready yet.'))
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('The page did not answer. Reload it and try again.'))
    }, timeoutMs)
    function onMessage(e: MessageEvent) {
      const d = e.data as { type?: string; format?: string; content?: unknown } | null
      if (e.source !== frame || e.origin !== origin || d?.type !== 'glance:export-result' || d.format !== format || typeof d.content !== 'string') return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(d.content)
    }
    window.addEventListener('message', onMessage)
    frame.postMessage({ type: 'glance:export', format }, origin)
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
