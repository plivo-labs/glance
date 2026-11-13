// Options and page-size plan for server-side PDF export. Pure on purpose: the browser work lives in
// pdf-render.ts (puppeteer), so this file and its tests never load it.

export type PdfSize = 'info' | 'full'
export type PdfLook = 'theme' | 'simple'
export type PdfPaper = 'a4' | 'letter'
export type PdfScheme = 'light' | 'dark'

export type PdfOptions = {
  size: PdfSize
  look: PdfLook
  paper: PdfPaper
  scheme: PdfScheme
  /** The viewer-LOCAL theme override (a non-owner's "View in theme"), applied on top of the page. */
  themeHref: string | null
}

export type PdfPlan = {
  /** Layout width (CSS px) the page is loaded at. */
  viewportWidth: number
  width: string
  height: string
  margin: { top: string; right: string; bottom: string; left: string }
  media: 'screen' | 'print'
  scheme: PdfScheme
  printBackground: boolean
}

export type PdfRenderRequest = { url: string; plan: PdfPlan; themeHref: string | null }

const PAPER = {
  a4: { widthMm: 210, heightMm: 297, margin: '15mm', contentPx: 680 },
  letter: { widthMm: 215.9, heightMm: 279.4, margin: '0.6in', contentPx: 701 },
} as const

/** Original-size pages are this wide: the desktop layout, cut into pages with the paper's ratio. */
const FULL_WIDTH_PX = 1280

/** Same shape the annotate client accepts for a viewer theme override (annotate/client.ts). */
const THEME_HREF = /^\/_glance\/theme\/[a-z0-9-]+\.css(\?v=[a-z0-9]+)?$/

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T | null =>
  value === undefined || value === '' ? fallback : ((allowed as readonly string[]).includes(value) ? (value as T) : null)

/** Strict: an unknown value is a 400, never a silent default (a typo must not change the output). */
export function parsePdfQuery(q: Record<string, string | undefined>): PdfOptions | { error: string } {
  const size = oneOf(q.size, ['info', 'full'], 'info')
  const look = oneOf(q.look, ['theme', 'simple'], 'theme')
  const paper = oneOf(q.paper, ['a4', 'letter'], 'a4')
  const scheme = oneOf(q.scheme, ['light', 'dark'], 'light')
  if (!size) return { error: 'size must be info or full' }
  if (!look) return { error: 'look must be theme or simple' }
  if (!paper) return { error: 'paper must be a4 or letter' }
  if (!scheme) return { error: 'scheme must be light or dark' }
  if (q.theme && !THEME_HREF.test(q.theme)) return { error: 'theme is not a theme stylesheet' }
  return { size, look, paper, scheme, themeHref: q.theme || null }
}

export function pdfPlan(o: PdfOptions): PdfPlan {
  const p = PAPER[o.paper]
  // "As designed" keeps the screen styles, backgrounds and the viewer's light/dark. "Simple" is the
  // browser's plain print rendering: print styles, light, no backgrounds.
  const look =
    o.look === 'theme'
      ? { media: 'screen' as const, scheme: o.scheme, printBackground: true }
      : { media: 'print' as const, scheme: 'light' as const, printBackground: false }
  if (o.size === 'full') {
    return {
      ...look,
      viewportWidth: FULL_WIDTH_PX,
      width: `${FULL_WIDTH_PX}px`,
      height: `${Math.round((FULL_WIDTH_PX * p.heightMm) / p.widthMm)}px`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    }
  }
  return {
    ...look,
    viewportWidth: p.contentPx,
    width: `${p.widthMm}mm`,
    height: `${p.heightMm}mm`,
    margin: { top: p.margin, right: p.margin, bottom: p.margin, left: p.margin },
  }
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
