// Pure element-locator helpers for the annotate client. BROWSER code (operates on DOM nodes) but
// GLOBAL-FREE: every function takes the node/root it works on, so it is unit-testable under a
// constructed DOM (happy-dom) with NO global registration. Bundled into client.ts by
// scripts/build-annotate.ts; excluded from the worker tsconfig (uses DOM types).
//
// A comment can anchor to a whole element (chart/table/image). The hostile iframe SUGGESTS a CSS
// selector (computeSelector); the trusted painter re-finds it (resolveSelector). Selectors are
// STRUCTURAL — a nearest-unique-id anchor plus `tag:nth-of-type(k)` child steps — so they survive
// across redeploys AS LONG AS the DOM shape is stable. A removed node resolves to null (orphaned);
// a sibling shifted into its slot resolves to the WRONG node — which is why we also capture a
// textFallback + preview describing the element (describeElement).

const PREVIEW_MAX = 120
const FALLBACK_MAX = 400

/** A comment should anchor to a specific element, not the page shell. An element whose box fills
 *  (nearly) the whole viewport in BOTH dimensions is a layout wrapper — hovering the empty padding
 *  around the real content lands on it, and outlining it reads as "the whole site is selected".
 *  Treat such elements, like <html>/<body>, as non-anchorable. Pure: takes plain dimensions so the
 *  client can feed it a getBoundingClientRect + window size. */
const PAGE_COVER = 0.9
export function isPageSpanning(rect: { width: number; height: number }, viewport: { width: number; height: number }): boolean {
  return rect.width >= viewport.width * PAGE_COVER && rect.height >= viewport.height * PAGE_COVER
}

/** 1-based index of `el` among its same-tag element siblings (for `:nth-of-type`). */
function nthOfType(el: Element): number {
  let i = 1
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++
  return i
}

/** An `[id="…"]` selector. The attribute form avoids a CSS.escape dependency and handles arbitrary
 *  (even CSS-illegal) ids from uploaded HTML; only `"` and `\` need escaping. */
function idSelector(id: string): string {
  return `[id="${id.replace(/(["\\])/g, '\\$1')}"]`
}

/** True when `id` identifies EXACTLY ONE element in the node's document — only then is it a safe,
 *  unambiguous anchor. */
function isUniqueId(el: Element): boolean {
  if (!el.id) return false
  const doc = el.ownerDocument
  if (!doc) return false
  try {
    return doc.querySelectorAll(idSelector(el.id)).length === 1
  } catch {
    return false
  }
}

/** Build a structural selector for `el`: descend from the nearest unique-id ancestor (or the
 *  body/html root) via `tag:nth-of-type(k)` child steps. Deterministic; round-trips through
 *  resolveSelector on an unchanged DOM. */
export function computeSelector(el: Element): string {
  const parts: string[] = []
  for (let node: Element | null = el; node && node.nodeType === 1; node = node.parentElement) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') {
      parts.unshift(tag)
      break
    }
    if (isUniqueId(node)) {
      parts.unshift(idSelector(node.id))
      break
    }
    parts.unshift(`${tag}:nth-of-type(${nthOfType(node)})`)
  }
  return parts.join(' > ')
}

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

/** Describe an element for the composer + the orphaned fallback: its tag, a short human preview
 *  (aria-label / alt / title / text / tag, in that order), and a bounded text fallback. Pure. */
export function describeElement(el: Element): { tag: string; preview: string; textFallback: string } {
  const tag = el.tagName.toLowerCase()
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const labelled = el.getAttribute?.('aria-label') || el.getAttribute?.('alt') || el.getAttribute?.('title') || ''
  const preview = (labelled || text || tag).trim().slice(0, PREVIEW_MAX)
  return { tag, preview, textFallback: text.slice(0, FALLBACK_MAX) }
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
const NON_RENDERED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE'])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
export function findRange(quote: string, doc: Document): Range | null {
  const tokens = quote.split(' ').filter(Boolean).map(escapeRegExp)
  if (tokens.length === 0 || !doc.body) return null
  const re = new RegExp(tokens.join('\\s*'), 'i')

  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT, {
    acceptNode: (n) => (isRenderedText(n as Text) ? FILTER_ACCEPT : FILTER_REJECT),
  })
  const segs: { node: Text; start: number }[] = []
  let acc = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    // Fold NFKC (only) so both sides match on the same axis; whitespace flex is the `\s*` join above.
    // Offsets stay in this folded space — a per-node NFKC length delta is clamped below, never thrown.
    segs.push({ node: t, start: acc.length })
    acc += t.data.normalize('NFKC')
  }
  const m = re.exec(acc)
  if (!m) return null
  const lo = m.index
  const hi = m.index + m[0].length
  const at = (pos: number): [Text, number] | null => {
    for (let i = segs.length - 1; i >= 0; i--) if (pos >= segs[i].start) return [segs[i].node, Math.min(pos - segs[i].start, segs[i].node.data.length)]
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
