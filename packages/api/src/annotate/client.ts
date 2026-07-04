// Annotate-mode client, injected into uploaded HTML when ?glance_annotate=1 (gated sites only).
// BROWSER code — excluded from the worker tsconfig and bundled to a string by
// scripts/build-annotate.ts (run `bun run build:annotate` after editing this file).
//
// Trust model (COMMENTS_PLAN constraint 1): this runs in the HOSTILE uploaded-HTML context. It
// may only OPEN UI or SUGGEST an anchor — it emits intent-only messages and computes NO
// persisted status. Paint instructions are accepted only from the trusted parent origin. All
// anchor resolution that matters happens server-side; this is thin glue.
//
// Anchors are located by re-finding the quote TEXT in the rendered DOM. This is the SINGLE source
// of paintability — the server no longer resolves anchors. Matching is whitespace-FLEXIBLE (tokens
// may be separated by any run of whitespace OR none, since adjacent text nodes across block/inline
// element boundaries concatenate with no separator) and case-insensitive (CSS text-transform can
// uppercase rendered text vs. its source node). A quote it can't locate simply isn't highlighted.

type Boot = { siteId: string; filePath: string; appOrigin: string }
type PaintAnchor = { id: string; quote: string }

const DEBOUNCE = 150

const boot = (window as unknown as { __GLANCE__?: Boot }).__GLANCE__

function toParent(msg: unknown): void {
  if (!boot) return
  try {
    window.parent.postMessage(msg, boot.appOrigin)
  } catch {
    /* parent gone / blocked — annotate mode stays inert */
  }
}

// --- selection capture: emit an intent the parent turns into a composer ------------------

function captureSelection(): void {
  const sel = window.getSelection()
  const quote = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.toString().trim() : ''
  if (!sel || !quote) {
    toParent({ type: 'glance:select-clear' })
    return
  }
  const box = sel.getRangeAt(0).getBoundingClientRect()
  toParent({
    type: 'glance:select',
    quote,
    rect: { top: box.top, left: box.left, width: box.width, height: box.height },
  })
}

let debounceTimer = 0
document.addEventListener('selectionchange', () => {
  clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(captureSelection, DEBOUNCE)
})

// --- painting existing anchors (parent-driven) -------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Locate an anchor quote in the rendered DOM, whitespace-flexibly, and return a Range. The
 *  stored quote is whitespace-normalized, so we match its tokens across ANY run of whitespace the
 *  rendered text may use — including none, since text nodes across element boundaries concatenate
 *  with no separator. Case-insensitive to survive CSS text-transform. Null if not found. */
function findRange(quote: string): Range | null {
  const tokens = quote.split(' ').filter(Boolean).map(escapeRegExp)
  if (tokens.length === 0) return null
  const re = new RegExp(tokens.join('\\s*'), 'i')

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const segs: { node: Text; start: number }[] = []
  let acc = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    segs.push({ node: t, start: acc.length })
    acc += t.data
  }
  const m = re.exec(acc)
  if (!m) return null
  const lo = m.index
  const hi = m.index + m[0].length
  const at = (pos: number): [Text, number] | null => {
    for (let i = segs.length - 1; i >= 0; i--) if (pos >= segs[i].start) return [segs[i].node, pos - segs[i].start]
    return null
  }
  const s = at(lo)
  const e = at(hi)
  if (!s || !e) return null
  const range = document.createRange()
  range.setStart(s[0], s[1])
  range.setEnd(e[0], e[1])
  return range
}

const supportsHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS

function paint(anchors: PaintAnchor[]): void {
  if (!supportsHighlight) return // span-wrap fallback is intentionally omitted in v1
  const highlight = new Highlight()
  for (const a of anchors) {
    const range = findRange(a.quote)
    if (range) highlight.add(range)
  }
  CSS.highlights.set('glance-comment', highlight)
}

function focus(quote: string): void {
  const range = findRange(quote)
  range?.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// Paint/focus commands are trusted ONLY from the parent app origin (the inverse direction from
// the hostile-iframe rule: here the parent is the trusted side).
window.addEventListener('message', (e: MessageEvent) => {
  if (!boot || e.origin !== boot.appOrigin) return
  const d = e.data as { type?: string; anchors?: PaintAnchor[]; quote?: string }
  if (d?.type === 'glance:paint' && Array.isArray(d.anchors)) paint(d.anchors)
  else if (d?.type === 'glance:focus' && typeof d.quote === 'string') focus(d.quote)
})

// Boot handshake: tell the parent which file is mounted (intent-only; parent re-validates).
if (boot) toParent({ type: 'glance:ready', filePath: boot.filePath })
