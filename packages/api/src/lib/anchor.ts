// Pure anchoring core — no DOM, no network. The single shared owner of `normalizeText`,
// used by BOTH upload hashing (Step 2) and the server-side reconciler (Step 8), and by
// `createThread` to resolve a selection over trusted R2 bytes (Step 7). All offsets are in
// NORMALIZED document coordinates (`normalizeText(doc)`), never raw-source or rendered-DOM
// offsets — the trust boundary is that resolution is computed here over trusted text only.
//
// v1 scope (honest limitation): resolves over the normalized static HTML *source* text. For
// reports/decks/generated HTML rendered ≈ source, so it works; JS-generated DOM degrades to
// `suggested`/`orphaned`. Element/region + DOM-rendered anchoring is v2.

export type AnchorStatus = 'anchored' | 'shifted' | 'suggested' | 'orphaned'

/** A stored anchor: the selected text plus a bounded slice of its surrounding context. */
export interface Anchor {
  quote: string // normalized exact selection text
  prefix: string // normalized context immediately before the quote (≤ CONTEXT_LEN)
  suffix: string // normalized context immediately after the quote (≤ CONTEXT_LEN)
}

/** Where (and how confidently) an anchor resolves in a document. `start`/`end` index into
 *  `normalizeText(docText)`; both are null iff `orphaned`. */
export interface Resolution {
  status: AnchorStatus
  start: number | null
  end: number | null
}

const CONTEXT_LEN = 64
// A best fuzzy match must clear this similarity (1 - edits/len) to be offered as `suggested`.
const FUZZY_THRESHOLD = 0.75
const MAX_FUZZY_QUOTE = 512
const MAX_FUZZY_CANDIDATES = 50
// Among repeated exact matches, the best context score must beat the runner-up by at least
// this many characters to be a confident pick; otherwise we degrade to `suggested` rather
// than silently choosing wrong (the false-positive guard).
const CONTEXT_MARGIN = 2

/** Whitespace + unicode fold WITHOUT trimming: NFKC folds compatibility forms (ligatures,
 *  NBSP, full-width) and composes accents; whitespace runs collapse to one space. Boundary
 *  whitespace is preserved so prefix/suffix stay aligned to the gap around the quote. */
function fold(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ')
}

/** Whitespace + unicode fold so formatting-only edits still match. `fold` + trim ends. The
 *  ONE normalizer for whole documents and quotes — every hash and every resolve goes through
 *  it, so upload hashing and the reconciler agree byte-for-byte. */
export function normalizeText(s: string): string {
  return fold(s).trim()
}

/** Content digest used by the reconcile gate: SHA-256 over the NORMALIZED text, so two
 *  bodies that differ only in formatting/whitespace hash equal and skip needless re-anchoring.
 *  The single shared hasher — upload (Step 2) and the reconciler (Step 8) must agree. */
export async function hashContent(text: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeText(text))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Build a stored anchor from a raw selection. The quote is trimmed (selections don't carry
 *  edge whitespace into the exact match); prefix/suffix keep their boundary space so they
 *  align to the document gap around the quote. Context is bounded so the anchor stays small. */
export function buildAnchor(input: { quote: string; prefix?: string; suffix?: string }): Anchor {
  return {
    quote: normalizeText(input.quote),
    prefix: fold(input.prefix ?? '').slice(-CONTEXT_LEN),
    suffix: fold(input.suffix ?? '').slice(0, CONTEXT_LEN),
  }
}

const ORPHANED: Resolution = { status: 'orphaned', start: null, end: null }

/**
 * Resolve an anchor against a document, returning a status + offsets. The re-anchor ladder:
 *   - exact, unique (and not moved vs `prior`)        → `anchored`
 *   - exact, but relocated vs `prior` / context-picked among repeats at a new spot → `shifted`
 *   - repeats with no decisive context, or a fuzzy near-match ≥ threshold           → `suggested`
 *   - nothing close                                                                 → `orphaned`
 *
 * `prior` (the offsets persisted from the last resolution) is what distinguishes `anchored`
 * from `shifted`: at create time there is no prior, so a confident match is `anchored`; at
 * reconcile time a confident match whose offset moved is `shifted`.
 */
export function resolveAnchor(anchor: Anchor, docText: string, prior?: { start: number; end: number }): Resolution {
  const doc = normalizeText(docText)
  const quote = anchor.quote
  if (!quote) return ORPHANED

  const exact = allIndexes(doc, quote)

  if (exact.length === 1) {
    const start = exact[0]
    return confident(start, quote.length, prior)
  }

  if (exact.length > 1) {
    const ranked = exact
      .map((start) => ({ start, score: contextScore(doc, start, quote.length, anchor) }))
      .sort((a, b) => b.score - a.score)
    const decisive = ranked[0].score > 0 && ranked[0].score - ranked[1].score >= CONTEXT_MARGIN
    if (decisive) return confident(ranked[0].start, quote.length, prior)
    // Ambiguous: repeats with weak/absent context — offer the best guess, but flag it so a
    // human confirms. Never report `anchored`/`shifted` on a pick we can't stand behind.
    return { status: 'suggested', start: ranked[0].start, end: ranked[0].start + quote.length }
  }

  const fz = bestFuzzy(doc, quote)
  if (fz && fz.score >= FUZZY_THRESHOLD) return { status: 'suggested', start: fz.start, end: fz.end }
  return ORPHANED
}

/** A match we can stand behind: `anchored` unless `prior` says its offset moved (`shifted`). */
function confident(start: number, len: number, prior?: { start: number; end: number }): Resolution {
  const moved = prior !== undefined && start !== prior.start
  return { status: moved ? 'shifted' : 'anchored', start, end: start + len }
}

/** All start indexes of `needle` in `haystack` (non-overlapping left-to-right). */
function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    out.push(at)
    from = at + needle.length
  }
  return out
}

/** How well the text around a candidate match agrees with the anchor's prefix/suffix:
 *  matching trailing chars before + matching leading chars after. Higher = better. */
function contextScore(doc: string, start: number, qlen: number, anchor: Anchor): number {
  const before = doc.slice(Math.max(0, start - anchor.prefix.length), start)
  const after = doc.slice(start + qlen, start + qlen + anchor.suffix.length)
  return commonSuffixLen(before, anchor.prefix) + commonPrefixLen(after, anchor.suffix)
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

// --- bounded fuzzy fallback -------------------------------------------------------------
// Minimal in-house approximate substring match (no new dep). Locate candidate regions via a
// distinctive probe token (exact), then run a local substring edit-distance DP in a window
// around each candidate. Bounded by probe count + quote length, so it stays cheap even on a
// large document. (`diff-match-patch` is the documented fallback if this proves too weak.)

function bestFuzzy(doc: string, quote: string): { start: number; end: number; score: number } | null {
  const q = quote.length > MAX_FUZZY_QUOTE ? quote.slice(0, MAX_FUZZY_QUOTE) : quote
  const probe = longestToken(q)
  if (!probe) return null
  const probeOffset = q.indexOf(probe)
  let best: { start: number; end: number; score: number } | null = null
  let from = 0
  for (let seen = 0; seen < MAX_FUZZY_CANDIDATES; seen++) {
    const at = doc.indexOf(probe, from)
    if (at < 0) break
    from = at + 1
    const center = at - probeOffset
    const winStart = Math.max(0, center - q.length)
    const winEnd = Math.min(doc.length, center + 2 * q.length)
    const local = substringEditMatch(doc.slice(winStart, winEnd), q)
    if (!local) continue
    const score = 1 - local.dist / q.length
    if (!best || score > best.score) best = { start: winStart + local.start, end: winStart + local.end, score }
  }
  return best
}

/** Longest run of word characters in `s` (≥ 3 chars), used as a cheap exact probe. */
function longestToken(s: string): string | null {
  let best = ''
  for (const tok of s.split(/[^\p{L}\p{N}]+/u)) if (tok.length > best.length) best = tok
  return best.length >= 3 ? best : null
}

/** Edit distance of `pattern` to its best-matching substring of `text`, with that substring's
 *  [start, end). Classic substring (a.k.a. "fitting") alignment: leading/trailing text is free;
 *  origin pointers recover the start. O(text·pattern) time, O(text) space. */
function substringEditMatch(text: string, pattern: string): { dist: number; start: number; end: number } | null {
  const n = text.length
  const m = pattern.length
  if (m === 0) return null
  let prevDist = new Array<number>(n + 1).fill(0)
  let prevFrom = Array.from({ length: n + 1 }, (_, j) => j) // empty pattern matches empty substring at j
  let curDist = new Array<number>(n + 1).fill(0)
  let curFrom = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    curDist[0] = i
    curFrom[0] = 0
    for (let j = 1; j <= n; j++) {
      const sub = prevDist[j - 1] + (pattern[i - 1] === text[j - 1] ? 0 : 1)
      const del = prevDist[j] + 1 // skip a pattern char
      const ins = curDist[j - 1] + 1 // skip a text char
      if (sub <= del && sub <= ins) {
        curDist[j] = sub
        curFrom[j] = prevFrom[j - 1]
      } else if (del <= ins) {
        curDist[j] = del
        curFrom[j] = prevFrom[j]
      } else {
        curDist[j] = ins
        curFrom[j] = curFrom[j - 1]
      }
    }
    ;[prevDist, curDist] = [curDist, prevDist]
    ;[prevFrom, curFrom] = [curFrom, prevFrom]
  }
  let bestEnd = 0
  for (let j = 1; j <= n; j++) if (prevDist[j] < prevDist[bestEnd]) bestEnd = j
  return { dist: prevDist[bestEnd], start: prevFrom[bestEnd], end: bestEnd }
}
