export const TEXT_CAP = 40_000

export type EntryFile = { path: string; mimeType: string | null }
export type Extracted = { ok: true; text: string; truncated: boolean } | { ok: false; reason: string }

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_CAP) return { text, truncated: false }
  let capped = text.slice(0, TEXT_CAP)
  if (/[\uD800-\uDBFF]$/.test(capped)) capped = capped.slice(0, -1)
  return { text: capped, truncated: true }
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

export async function extractText(entry: EntryFile, body: string): Promise<Extracted> {
  if (!isSupportedEntry(entry)) {
    return { ok: false, reason: 'unsupported' }
  }

  if (/\.(md|markdown)$/i.test(entry.path)) {
    return extracted(body)
  }

  // HTMLRewriter handlers observe the input stream, so a collector on the stripping rewriter
  // would still receive removed script/style/noscript text; pass 1 strips, then pass 2 collects.
  const stripped = ['script', 'style', 'noscript']
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
