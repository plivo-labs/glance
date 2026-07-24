export const TEXT_CAP = 40_000
export const TITLE_CAP = 200

export type EntryFile = { path: string; mimeType: string | null }
export type Extracted = { ok: true; text: string; truncated: boolean } | { ok: false; reason: string }

function cap(text: string, limit = TEXT_CAP): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  let capped = text.slice(0, limit)
  if (/[\uD800-\uDBFF]$/.test(capped)) capped = capped.slice(0, -1)
  return { text: capped, truncated: true }
}

// Surrogate-safe truncation for site titles (form-supplied or derived) — a plain slice can end on
// an unpaired high surrogate when the boundary lands inside an emoji.
export function capTitle(text: string): string {
  return cap(text, TITLE_CAP).text
}

function extracted(text: string): Extracted {
  if (!text.trim()) return { ok: false, reason: 'empty' }
  return { ok: true, ...cap(text) }
}

// The file the root URL ('' splat) actually serves, mirroring the content worker's root
// resolution (content.ts): an explicit index.html wins, else a lone uploaded file is served at
// the root, else '' (a multi-file site with no index shows the directory listing). The viewer
// reads this so a single-file audio site picks the native player at its root URL — not just at
// the explicit `/…/recording.webm` path — and anchors comments to the same resolved path either way.
export function resolveIndexPath(paths: string[]): string {
  if (paths.includes('index.html')) return 'index.html'
  return paths.length === 1 ? paths[0] : ''
}

export function pickEntry<T extends EntryFile>(files: T[]): T | null {
  const path = resolveIndexPath(files.map((file) => file.path))
  return files.find((file) => file.path === path) ?? null
}

export function isSupportedEntry(entry: EntryFile): boolean {
  return /\.(md|markdown)$/i.test(entry.path) || /\.html?$/i.test(entry.path) || entry.mimeType === 'text/html'
}

// HTMLRewriter text chunks carry RAW source text — entities are NOT decoded ('&amp;' arrives as
// '&amp;'). Derived titles render as plain text in the app, so decode numeric references plus the
// named entities that actually occur in titles; anything unknown is left as-is rather than guessed.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  bull: '•',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  rarr: '→',
  larr: '←',
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name] ?? match
    const code = dec ? Number(dec) : Number.parseInt(hex, 16)
    return code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

// The entry document's <title>, for the site's display title when the uploader didn't name it.
// HTML only — a markdown entry has no <title>. Takes the FIRST title in document order that is
// not an <svg>/<template> accessibility/inert title. NOT `head > title`: a streaming rewriter
// never sees an implied <head>, and headless fragments (a file starting at <style>/<h1>) are
// common among agent-generated uploads — the bare selector plus exclusion covers both.
// The body streams through the rewriter and only title chunks are retained, so a 20MB entry is
// never buffered. Whitespace-collapsed, trimmed, entity-decoded, capped; empty/absent → null.
export async function extractHtmlTitle(entry: EntryFile, body: Blob | string): Promise<string | null> {
  if (!(/\.html?$/i.test(entry.path) || entry.mimeType === 'text/html')) return null
  // Handlers on the same element fire in registration order, so the exclusion selectors run
  // before the bare 'title' handler and can flag the element it is about to see.
  let excluded = false
  let taking = false
  let done = false
  const chunks: string[] = []
  const rewriter = new HTMLRewriter()
  for (const selector of ['svg title', 'template title']) {
    rewriter.on(selector, {
      element() {
        excluded = true
      },
    })
  }
  const transformed = rewriter
    .on('title', {
      element() {
        taking = !done && !excluded
        if (taking) done = true
        excluded = false
      },
      text(text) {
        if (taking) chunks.push(text.text)
      },
    })
    .transform(new Response(body))
  // Drain without collecting the rewritten output (Response.text() would rebuild the whole body).
  const reader = transformed.body?.getReader()
  if (reader) while (!(await reader.read()).done) {}
  const title = decodeEntities(chunks.join('')).replace(/\s+/g, ' ').trim()
  return title ? capTitle(title) : null
}

export async function extractText(entry: EntryFile, body: string): Promise<Extracted> {
  if (!isSupportedEntry(entry)) {
    return { ok: false, reason: 'unsupported' }
  }

  if (/\.(md|markdown)$/i.test(entry.path)) {
    return extracted(body)
  }

  // HTMLRewriter handlers observe the input stream, so a collector on the stripping rewriter
  // would still receive removed text; pass 1 strips, then pass 2 collects. Hidden containers are
  // stripped too — invisible text must not crowd the visible content out of the TEXT_CAP.
  const stripped = ['script', 'style', 'noscript', 'template', '*[hidden]', '*[aria-hidden="true"]']
    .reduce(
      (rewriter, tag) =>
        rewriter.on(tag, {
          element(element) {
            element.remove()
          },
        }),
      new HTMLRewriter(),
    )
    .transform(new Response(body))
  const chunks: string[] = []
  const transformed = new HTMLRewriter()
    .onDocument({
      text(text) {
        chunks.push(text.text)
      },
    })
    .transform(stripped)
  await transformed.text()

  return extracted(chunks.join('').replace(/\s+/g, ' ').trim())
}
