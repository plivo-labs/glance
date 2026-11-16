// Options and page plan for server-side PDF export. Pure on purpose: the browser work lives in
// pdf-render.ts (puppeteer), so this file and its tests never load it.

export type PdfScheme = 'light' | 'dark'

export type PdfOptions = {
  scheme: PdfScheme
  /** The viewer-LOCAL theme override (a non-owner's "View in theme"), applied on top of the page. */
  themeHref: string | null
}

export type PdfPlan = {
  /** Layout width (CSS px) the page is loaded at: A4 less its margins. */
  viewportWidth: number
  width: string
  height: string
  margin: { top: string; right: string; bottom: string; left: string }
  scheme: PdfScheme
}

/**
 * `linkRewrite.from` is the tokened content origin (`<content>/_t/<token>/`); every link under it,
 * in this site or a sibling one, is re-pointed at `to` (`<app>/`) before printing, because a PDF
 * keeps its links and the token is a credential.
 */
export type PdfRenderRequest = {
  url: string
  plan: PdfPlan
  themeHref: string | null
  linkRewrite: { from: string; to: string }
  /** Named in the PDF when the page has no <title> of its own. */
  title: string
}

/** Same shape the annotate client accepts for a viewer theme override (annotate/client.ts). */
const THEME_HREF = /^\/_glance\/theme\/[a-z0-9-]+\.css(\?v=[a-z0-9]+)?$/

/** Strict: an unknown value is a 400, never a silent default (a typo must not change the output). */
export function parsePdfQuery(q: Record<string, string | undefined>): PdfOptions | { error: string } {
  const scheme = q.scheme === undefined || q.scheme === '' ? 'light' : q.scheme
  if (scheme !== 'light' && scheme !== 'dark') return { error: 'scheme must be light or dark' }
  if (q.theme && !THEME_HREF.test(q.theme)) return { error: 'theme is not a theme stylesheet' }
  return { scheme, themeHref: q.theme || null }
}

// One format: A4 portrait, 15mm margins, the page's own screen styles and backgrounds (as designed)
// in the viewer's light/dark. 680px is the 180mm of content width.
export function pdfPlan(o: PdfOptions): PdfPlan {
  const margin = '15mm'
  return { viewportWidth: 680, width: '210mm', height: '297mm', margin: { top: margin, right: margin, bottom: margin, left: margin }, scheme: o.scheme }
}

/**
 * Browser-side script (a string: this package compiles without the DOM lib) that re-points every
 * link under `from` at `to` before the page is printed. HTML and SVG `<a>` alike, resolved against
 * the page the way the browser would. A jump to a target that exists in this very page stays a
 * jump (the PDF keeps it as an internal link); anything else, a self-link included, is rewritten
 * because Chrome writes it into the PDF as an external URI. One odd link never fails the render.
 */
export function rewriteLinksScript(from: string, to: string): string {
  return `(() => {
  const FROM = ${JSON.stringify(from)}, TO = ${JSON.stringify(to)}
  const here = location.href.split('#')[0]
  const base = document.baseURI
  const target = (hash) => {
    let id = hash.slice(1)
    try { id = decodeURIComponent(id) } catch (e) {}
    return id !== '' && (document.getElementById(id) !== null || document.getElementsByName(id).length > 0)
  }
  for (const a of document.querySelectorAll('a')) {
    try {
      const attr = a.hasAttribute('href') ? 'href' : 'xlink:href'
      const raw = a.getAttribute(attr)
      if (raw === null) continue
      const u = new URL(raw, base)
      if (u.href.split('#')[0] === here && target(u.hash)) continue
      if (u.href.startsWith(FROM)) a.setAttribute(attr, TO + u.href.slice(FROM.length))
    } catch (e) {}
  }
  return true
})()`
}

/**
 * Browser-side script: a page with no <title> is printed with its own URL as the PDF's title, and
 * that URL carries the token. Give it the site's title instead.
 */
export function titleScript(title: string): string {
  return `(() => { if (document.title.trim() === '') document.title = ${JSON.stringify(title)}; return true })()`
}

/** The content token out of a message that may quote a content URL (a failed navigation does). */
export const redactToken = (message: string): string => message.replace(/\/_t\/[^/\s]+\//g, '/_t/<redacted>/')

const startsWith = (bytes: Uint8Array, at: number, needle: number[]): boolean => needle.every((b, j) => bytes[at + j] === b)

/** True when the token (ASCII) appears anywhere in the bytes. A PDF's link and metadata strings are plain text. */
export function containsToken(bytes: Uint8Array, token: string): boolean {
  const needle = Array.from(token, (ch) => ch.charCodeAt(0))
  if (needle.length === 0) return false
  for (let i = bytes.indexOf(needle[0] as number); i !== -1 && i + needle.length <= bytes.length; i = bytes.indexOf(needle[0] as number, i + 1)) {
    if (startsWith(bytes, i, needle)) return true
  }
  return false
}

const DOC_EXT = /\.(html?|md|markdown)$/i

/** Control characters become spaces (a header or a path must never carry them). */
const stripControls = (s: string): string => Array.from(s, (ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch)).join('')

/**
 * The file to render, as the encoded URL suffix under the site root ('' = the site's entry page).
 * Null = refuse: only documents print to a PDF, and a path never climbs out of the site.
 */
export function pdfPagePath(raw: string | undefined): string | null {
  if (!raw) return ''
  const segments = raw.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || stripControls(s) !== s)) return null
  if (!DOC_EXT.test(segments[segments.length - 1] as string)) return null
  return segments.map(encodeURIComponent).join('/')
}

/** `Content-Disposition` value: a plain ASCII fallback plus the UTF-8 name for browsers that read it. */
export function pdfDisposition(title: string | null, siteSlug: string): string {
  const base = stripControls(title?.trim() || siteSlug).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || siteSlug
  const ascii = base.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, '')
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(base)}.pdf`
}
