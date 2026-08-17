// Pure element-locator helpers for the annotate client. BROWSER code (operates on DOM nodes) but
// GLOBAL-FREE: every function takes the node/root it works on, so it is unit-testable under a
// constructed DOM (happy-dom) with NO global registration. Bundled into client.ts by
// scripts/build-annotate.ts; excluded from the worker tsconfig (uses DOM types).
//
// Element anchors are no longer CREATED (the capture path is gone — RULING, slice C2a), but threads
// already holding one still paint, so the re-finder stays: resolveSelector takes the STRUCTURAL
// selector stored back when it was suggested — a nearest-unique-id anchor plus `tag:nth-of-type(k)`
// child steps — and looks it up in today's DOM. A removed node resolves to null and the parent flags
// the thread orphaned; the selector-BUILDING half (and the element description that went with it)
// died with the capture path.

import { TEXT_CONTEXT_LIMIT, collapseWhitespace, type TextContext } from '../lib/anchor'

/** Re-find a suggested selector under `root`. Untrusted input is only ever `querySelector`'d (never
 *  eval'd); a malformed selector or a missing target both yield null. */
export function resolveSelector(selector: string, root: ParentNode): Element | null {
  if (!selector) return null
  try {
    return root.querySelector(selector)
  } catch {
    return null
  }
}

// --- text-quote anchoring ---------------------------------------------------------------------
// Re-find a stored comment quote in the RENDERED DOM and return a Range for the CSS Custom Highlight
// painter. Kept here (not in client.ts) so it is global-free and unit-testable under happy-dom.

// The WHATWG NodeFilter constants, as literals — the bundle runs in a real browser (where the
// `NodeFilter` global exists) but the unit tests drive this under happy-dom, which does NOT register
// `NodeFilter` globally. These numeric values are fixed by the DOM spec.
const SHOW_TEXT = 0x4
const FILTER_ACCEPT = 1
const FILTER_REJECT = 2

// Text inside these never renders (or isn't laid-out content), so a quote whose words happen to also
// appear there — most often an inline chart-data <script> — must not anchor to it.
export const NON_RENDERED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE'])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- text context: which OCCURRENCE of a repeated quote was selected --------------------------
// The quote alone can't identify itself when the same words appear more than once — `findRange`
// would always paint the first. We also store a bounded slice of the text on either side, captured
// at selection time, and re-find the occurrence that best reproduces it. Both sides are optional:
// a thread stored before this existed (or one selected at the very start/end of a document) simply
// scores every occurrence equally and keeps the first, which is what it has always resolved to.

/** Raw chars read per side before collapsing whitespace. Collapsing only ever shortens, so reading
 *  twice the stored cap still yields at least TEXT_CONTEXT_LIMIT of comparable text. */
const CONTEXT_WINDOW = TEXT_CONTEXT_LIMIT * 2

type TextIndex = { acc: string; segs: { node: Text; start: number; end: number; folded: boolean }[] }

/** Walk every RENDERED text node once and concatenate it (NFKC-folded), remembering where each node
 *  landed. One index serves both re-finding a quote and capturing a selection's context, so the two
 *  can never disagree about what the document says. */
function buildTextIndex(doc: Document): TextIndex {
  const segs: TextIndex['segs'] = []
  let acc = ''
  if (!doc.body) return { acc, segs }
  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT, {
    acceptNode: (n) => (isRenderedText(n as Text) ? FILTER_ACCEPT : FILTER_REJECT),
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    // Fold NFKC (only) so both sides match on the same axis; whitespace flex is the `\s*` join in
    // findRange. Offsets stay in this folded space.
    const data = t.data.normalize('NFKC')
    segs.push({ node: t, start: acc.length, end: acc.length + data.length, folded: data !== t.data })
    acc += data
  }
  return { acc, segs }
}

// The index is IDENTICAL for every read until the document changes, but painting N anchors calls
// findRange N times — so it is built once per DOM VERSION and shared. The version is owned by the
// CALLER: this file installs no observer and reads no global. reflow.ts decides which events end a
// version (DOM mutation incl. characterData, and resize — the index holds only RENDERED text, which
// is a layout verdict; NOT scroll). One slot, because a page has one document.
let epoch = 0
let cached: { doc: Document; epoch: number; index: TextIndex } | null = null

/** The shared index for `doc` at the current DOM version, built on first read and reused after. */
export function sharedTextIndex(doc: Document): TextIndex {
  if (cached && cached.doc === doc && cached.epoch === epoch) return cached.index
  const index = buildTextIndex(doc)
  cached = { doc, epoch, index }
  return index
}

/** The DOM changed: the next read rebuilds. Returns the new version so the caller can tag anything
 *  it measured under it (a rect batch consumed asynchronously by the parent). */
export function newEpoch(): number {
  return ++epoch
}

/** The version the shared index currently describes. */
export function currentEpoch(): number {
  return epoch
}

/** True when a text node is rendered, anchorable content: no SCRIPT/STYLE/NOSCRIPT/TEXTAREA/TEMPLATE
 *  ancestor, and a parent that occupies layout (`getClientRects` is empty for a `display:none`
 *  subtree in a real browser). happy-dom reports rects for everything, so the rect check never
 *  over-rejects under test — the tag filter carries the covered behavior. */
function isRenderedText(node: Text): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) if (NON_RENDERED_TAGS.has(el.tagName)) return false
  const parent = node.parentElement
  return !!parent && parent.getClientRects().length > 0
}

/** Locate an anchor quote in the rendered DOM, whitespace-flexibly, and return a Range. The stored
 *  quote is NFKC-folded + whitespace-collapsed (`lib/anchor` normalizeText), so we (1) NFKC-fold the
 *  DOM text to match on the SAME axis (else a ligature/NBSP/full-width mismatch fails to anchor), and
 *  (2) match its tokens across ANY run of whitespace (`\s*`, including none). Case-insensitive to
 *  survive CSS text-transform. Only RENDERED text is walked (see isRenderedText), so the FIRST match
 *  is inside visible content — a quote that also appears in a <script> anchors to the visible one.
 *  Null if absent. */
export function findRange(quote: string, doc: Document, context?: TextContext): Range | null {
  const tokens = quote.split(' ').filter(Boolean).map(escapeRegExp)
  if (tokens.length === 0 || !doc.body) return null
  const re = new RegExp(tokens.join('\\s*'), 'gi')

  const { acc, segs } = sharedTextIndex(doc)
  // EVERY occurrence, not just the first: an identical quote can appear many times (a repeated
  // table cell, a nav label, a boilerplate sentence) and `context` is what tells them apart.
  const hits: [number, number][] = []
  for (let m = re.exec(acc); m; m = re.exec(acc)) hits.push([m.index, m.index + m[0].length])
  if (hits.length === 0) return null
  const hit = bestHit(hits, acc, context)
  if (!hit) return null
  const [lo, hi] = hit

  const at = (pos: number): [Text, number] | null => {
    for (let i = segs.length - 1; i >= 0; i--) if (pos >= segs[i].start) return [segs[i].node, rawOffset(segs[i], pos - segs[i].start)]
    return null
  }
  const s = at(lo)
  const e = at(hi)
  if (!s || !e) return null
  const range = doc.createRange()
  range.setStart(s[0], s[1])
  range.setEnd(e[0], e[1])
  return range
}

/** An offset inside a seg, folded-index space → the RAW offset a Range needs. The two spaces drift
 *  INSIDE any node NFKC changed, in BOTH directions: an expanding char (ﬁ → fi) makes the folded
 *  offset run past the character it names, a composing one (e + ◌́ → é) leaves it short — and a raw
 *  offset past `data.length` is an IndexSizeError, not a clamp. So for a folded node walk raw
 *  prefixes for the shortest one whose folded length reaches `pos`, re-folding exactly the way
 *  `offsetOf` does in the other direction so the two can't disagree. Untouched nodes (nearly all of
 *  them) are index-identical and skip the scan. */
function rawOffset(seg: TextIndex['segs'][number], pos: number): number {
  // Clamped, because the index describes a DOM VERSION and the caller may read it one beat after the
  // text moved on: a MutationObserver delivers its records in a microtask, so an in-place write
  // followed by a re-find in the SAME task still sees the old offsets. Past `data.length` that is an
  // IndexSizeError out of `range.setStart` — thrown inside a paint or a rAF, uncaught, killing
  // painting AND badge emission for the rest of the session. A clamped (briefly wrong) position is
  // repaired by the very next epoch; a thrown one never is.
  if (!seg.folded) return Math.min(pos, seg.node.data.length)
  const raw = seg.node.data
  let k = 0
  while (k < raw.length && raw.slice(0, k).normalize('NFKC').length < pos) k++
  return k
}

/** Score every occurrence by how much of the stored context it reproduces and take the best; ties
 *  when there's nothing to compare (no context stored, or only ONE occurrence exists) keep the
 *  EARLIEST hit, which is exactly the pre-context behaviour every already-stored thread was anchored
 *  under. But when the quote is genuinely ambiguous (2+ hits) AND a context WAS stored AND it
 *  reproduces NOTHING at any occurrence (best score 0 everywhere), hits[0] would be a silent guess —
 *  a redeploy that both duplicates a sentence and rewrites its surroundings would confidently badge
 *  text its author never selected. Return null instead so the caller orphans the anchor (rail-only)
 *  rather than mispoint it. */
function bestHit(hits: [number, number][], acc: string, context?: TextContext): [number, number] | null {
  const wantPrefix = collapseWhitespace(context?.prefix ?? '').toLowerCase()
  const wantSuffix = collapseWhitespace(context?.suffix ?? '').toLowerCase()
  // A context whose ONLY content is the boundary whitespace (e.g. { prefix: ' ', suffix: ' ' }, or a
  // context.prefix/suffix that came through untrimmed) carries no positional information at all — it
  // must read as "no context stored", not as a context that happens to score 0 everywhere. Deciding
  // this on the TRIMMED value (not the raw, still-truthy ' ') is what keeps such a thread on the same
  // first-match behaviour a pre-context thread has always had, instead of being ORPHANED below.
  if (!wantPrefix.trim() && !wantSuffix.trim()) return hits[0]
  let best = hits[0]
  let bestScore = -1
  for (const hit of hits) {
    const before = collapseWhitespace(acc.slice(Math.max(0, hit[0] - CONTEXT_WINDOW), hit[0])).toLowerCase()
    const after = collapseWhitespace(acc.slice(hit[1], hit[1] + CONTEXT_WINDOW)).toLowerCase()
    // Score across the boundary whitespace, not ON it. `selectionContext` always hands back a prefix
    // ending in a space and a suffix starting with one (the separator it snapped inward over between
    // the quote and its neighbour) — and so does the real DOM text either side of ANY occurrence. Left
    // untrimmed, that shared space alone is worth 1 point per side: a context that reproduces nothing
    // else still scores 2 (not the 0 the orphan check below looks for), so the guard could never fire
    // for real data. trimEnd/trimStart drop only that one always-shared character; a genuine match
    // loses nothing it didn't already have to spare, and a dead one finally shows its true score of 0.
    const score = commonSuffixLen(before.trimEnd(), wantPrefix.trimEnd()) + commonPrefixLen(after.trimStart(), wantSuffix.trimStart())
    if (score > bestScore) {
      bestScore = score
      best = hit
    }
  }
  if (hits.length > 1 && bestScore === 0) return null
  return best
}

const commonPrefixLen = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

const commonSuffixLen = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/** The text surrounding a live selection, for storing alongside the quote. Read from the SAME
 *  filtered index the painter matches against, so a <script> sitting next to the selection can
 *  never poison the context (and thus never steer a later re-find).
 *
 *  The boundaries are snapped INWARD over whitespace first, because the quote stored beside this
 *  context is TRIMMED (`normalizeText`) while the range is not: a drag — or a Chrome double-click,
 *  which routinely grabs the adjacent space — hands us edges one character outside the quote. Slice
 *  from those and the space separating the quote from its neighbour lands on the wrong side of the
 *  cut, so at paint time `bestHit` compares a prefix ending "…Beta lead" against a `before` ending
 *  "…Beta lead " — no shared character, EVERY occurrence scores 0, and the first one wins. That is
 *  first-occurrence painting again, i.e. the whole feature silently off for most real selections. */
export function selectionContext(range: Range, doc: Document): TextContext {
  const { acc, segs } = sharedTextIndex(doc)
  let lo = offsetOf(segs, range.startContainer, range.startOffset, 'start')
  let hi = offsetOf(segs, range.endContainer, range.endOffset, 'end')
  if (lo === null || hi === null) return { prefix: '', suffix: '' }
  while (lo < hi && /\s/.test(acc[lo])) lo++
  while (hi > lo && /\s/.test(acc[hi - 1])) hi--
  return {
    prefix: collapseWhitespace(acc.slice(Math.max(0, lo - CONTEXT_WINDOW), lo)).slice(-TEXT_CONTEXT_LIMIT),
    suffix: collapseWhitespace(acc.slice(hi, hi + CONTEXT_WINDOW)).slice(0, TEXT_CONTEXT_LIMIT),
  }
}

/** A range boundary (node + raw offset) → its offset in the folded index. The node's own text is
 *  NFKC-folded up to the boundary so the delta a ligature/full-width char introduces is exact,
 *  not clamped. For an element boundary, `offset` indexes CHILD NODES, so START resolves to the
 *  first indexed text at-or-after that child and END to the last indexed text before it — dropping
 *  `offset` would put an END boundary before the quote and swallow it into the suffix. When the
 *  chosen side holds no indexed text the other side's edge is used: the skipped children contribute
 *  nothing to the index, so it is the SAME position — which is also why an ordered range can never
 *  come back with its end before its start, and why `selectionContext` needs no crossing guard. */
function offsetOf(segs: TextIndex['segs'], node: Node, offset: number, side: 'start' | 'end'): number | null {
  const seg = segs.find((s) => s.node === node)
  if (seg) return seg.start + seg.node.data.slice(0, offset).normalize('NFKC').length
  const children = Array.from(node.childNodes)
  const before = children.slice(0, offset)
  const after = children.slice(offset)
  const contains = (roots: Node[], text: Text): boolean => roots.some((root) => root === text || root.contains?.(text))
  const next = segs.find((s) => contains(after, s.node))
  let previous: TextIndex['segs'][number] | undefined
  for (let i = segs.length - 1; i >= 0; i--) {
    if (contains(before, segs[i].node)) {
      previous = segs[i]
      break
    }
  }
  return side === 'start' ? (next?.start ?? previous?.end ?? null) : (previous?.end ?? next?.start ?? null)
}
