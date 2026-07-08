// HTTP Range parsing + serving decision — pure, no Worker/DOM globals, no app imports. Shared by
// the content worker (static-file serving, second ranged R2 get) and the comments audio route
// (in-memory slice). Kept in a leaf module so neither route has to import the other's app module.

export type RangeParse =
  | { kind: 'none' } // no Range header, or a syntactically malformed spec — served in full
  | { kind: 'multi' } // comma-separated ranges — ignored (RFC 7233 §3.1), served in full
  | { kind: 'unsatisfiable' } // in-bounds-checkable but starts at/past the end, or a zero suffix
  | { kind: 'single'; start: number; end: number } // resolved, inclusive byte bounds

// Parse a `Range: bytes=...` header against a known total size. Handles a single bounded
// spec (`0-499`), open-ended (`500-`), and a suffix (`-500`, "last 500 bytes"). A
// comma-separated multi-range request is reported distinctly so the caller can serve 200
// full body (legit — we just don't implement multipart/byteranges). Anything else
// syntactically invalid is treated the same as no Range header at all, per RFC 7233 §3.1
// ("a server ... MUST ignore [an invalid] header field"); only an in-range-but-past-the-end
// request is reported as truly unsatisfiable (416 territory).
export function parseByteRange(header: string | undefined, total: number): RangeParse {
  if (!header) return { kind: 'none' }
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header)
  if (!m) return { kind: 'none' }
  const specs = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (specs.length === 0) return { kind: 'none' }
  if (specs.length > 1) return { kind: 'multi' }

  const suffix = /^-(\d+)$/.exec(specs[0])
  if (suffix) {
    const len = Number(suffix[1])
    if (len === 0 || total === 0) return { kind: 'unsatisfiable' }
    return { kind: 'single', start: Math.max(0, total - len), end: total - 1 }
  }

  const bounded = /^(\d+)-(\d*)$/.exec(specs[0])
  if (!bounded) return { kind: 'none' }
  const start = Number(bounded[1])
  const end = bounded[2] === '' ? total - 1 : Number(bounded[2])
  if (start >= total) return { kind: 'unsatisfiable' }
  if (end < start) return { kind: 'none' } // last-byte-pos < first-byte-pos: invalid, not unsatisfiable
  return { kind: 'single', start, end: Math.min(end, total - 1) }
}

export type RangeDecision =
  | { status: 200 } // serve the full body
  | { status: 416 } // unsatisfiable — content-range already set on `headers`
  | { status: 206; start: number; end: number } // serve the inclusive slice (headers set)

// Resolve a Range request to a status + the response headers it implies, MUTATING `headers` with
// content-range / content-length. The caller owns the body (a second ranged R2 get, or an
// in-memory slice) — this only makes the status/header decision both serving paths share.
export function decideRange(header: string | undefined, total: number, headers: Headers): RangeDecision {
  const parsed = parseByteRange(header, total)
  if (parsed.kind === 'unsatisfiable') {
    headers.set('content-range', `bytes */${total}`)
    return { status: 416 }
  }
  if (parsed.kind === 'single') {
    headers.set('content-range', `bytes ${parsed.start}-${parsed.end}/${total}`)
    headers.set('content-length', String(parsed.end - parsed.start + 1))
    return { status: 206, start: parsed.start, end: parsed.end }
  }
  return { status: 200 } // 'none' / 'multi' — full body
}
