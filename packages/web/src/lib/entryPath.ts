// Entry-path resolution for the viewer's comments PREFETCH (S11) — pure, unit-tested.
//
// MIRRORS the content worker's normalizePath (packages/api/src/content.ts) — same segment
// cleaning, same directory → index.html mapping. The web can't import api code, so this is a
// hand-kept mirror, same pairing convention as lib/audio.ts's AUDIO_EXTENSIONS. If the server's
// normalizePath changes, this must change with it.
//
// This is only a PREDICTION of the file the iframe will land on: the prefetch it keys stays
// provisional until the iframe's glance:ready confirms the real path (see lib/prefetchArbiter).

// Exact mirror of content.ts normalizePath: drop empty/'.'/'..' segments; '' or a trailing '/'
// is a directory request and maps to its index.html.
function normalizeContentPath(rest: string): string {
  const isDir = rest === '' || rest.endsWith('/')
  const cleaned = rest
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
  if (isDir || cleaned === '') return cleaned ? `${cleaned}/index.html` : 'index.html'
  return cleaned
}

/** The file the content worker will serve for this viewer URL — the prefetch key.
 *  - non-empty splat → the server-normalized path ('docs/' → 'docs/index.html', dot/.. segs dropped)
 *  - root ('' splat) → the API's already-resolved indexPath (root index.html OR the lone-file
 *    fallback, e.g. 'recording.webm')
 *  - root with indexPath '' → null: NEVER guess 'index.html' — the site meta gave us no root
 *    entry, and guessing could fetch comments for a file the site doesn't have. */
export function resolveEntryPath(sitePath: string, indexPath: string): string | null {
  if (sitePath !== '') return normalizeContentPath(sitePath)
  return indexPath === '' ? null : indexPath
}
