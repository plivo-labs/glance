// Reflow-side policy for the annotate client: keeping the shared text index HONEST, and turning the
// painted text anchors into an epoch-tagged rect batch the parent draws badges from. BROWSER code
// (it works on DOM objects) but GLOBAL-FREE: the document, the window and the emitter are all
// INJECTED, so the policy is unit-testable under a constructed happy-dom window with no global
// registration — the same seam locator.ts and selection.ts use. client.ts is only the wiring.
// Bundled into client.ts by scripts/build-annotate.ts; excluded from the worker tsconfig (DOM types).

import type { TextContext } from '../lib/anchor'
import { currentEpoch, findRange, newEpoch } from './locator'
import type { Rect } from './selection'

export type TextAnchor = { id: string; quote?: string; context?: TextContext }
export type AnchorRect = { id: string; rect: Rect }
export type RectsMessage = { type: 'glance:anchor-rects'; epoch: number; rects: AnchorRect[] }

/** A measurement a badge can actually be placed against, or null. Geometry carries no position in
 *  two ways, and BOTH must be dropped rather than passed on. A non-finite edge never comes out of a
 *  real getBoundingClientRect, but it is what the parent has to be able to trust it will never see
 *  (its own parseIntent would coerce a NaN to 0). A ZERO-AREA box does happen constantly: it is what
 *  a collapsed range measures, and what any range inside a display:none subtree measures. Emit it
 *  and the badge parks at (0,0) in the page corner, pointing at nothing. */
export function measurableRect(r: { top: number; left: number; width: number; height: number }): Rect | null {
  const rect = { top: r.top, left: r.left, width: r.width, height: r.height }
  if (![rect.top, rect.left, rect.width, rect.height].every((n) => Number.isFinite(n))) return null
  return rect.width > 0 || rect.height > 0 ? rect : null
}

/** Where each text anchor currently sits. The epoch tags the index VERSION the rects were measured
 *  under: a batch is consumed asynchronously by the parent, and one that lands after the DOM moved on
 *  describes positions that no longer exist, so the parent drops it. An anchor that no longer
 *  re-finds — or whose range has no real geometry — contributes no rect, which is how the parent
 *  learns to remove its badge. */
export function textRectBatch(anchors: TextAnchor[], doc: Document): RectsMessage {
  const rects: AnchorRect[] = []
  for (const a of anchors) {
    // All of these re-finds share ONE text index per DOM version, so this is a regex scan per
    // anchor, not a full document walk per anchor.
    const range = a.quote ? findRange(a.quote, doc, a.context) : null
    const rect = range && measurableRect(range.getBoundingClientRect())
    if (rect) rects.push({ id: a.id, rect })
  }
  return { type: 'glance:anchor-rects', epoch: currentEpoch(), rects }
}

/** The Ranges to paint into the `glance-comment` CSS Custom Highlight RIGHT NOW — the hover/focus
 *  set the parent asks for, in the order it asks for it, never the full anchor list. Painting every
 *  anchor unconditionally (the bug this replaces) marks up every commented sentence on the page
 *  PERMANENTLY; the ruling is that the highlight is a hover affordance, so the parent must be able
 *  to ask for exactly the ids it wants lit and nothing else. An id with no matching anchor, or an
 *  anchor whose quote no longer resolves (the page changed under it), silently contributes no
 *  Range — same drop rule as textRectBatch, for the same reason: a badge/highlight for text that
 *  isn't there anymore is worse than no highlight. */
export function highlightRanges(anchors: TextAnchor[], ids: string[], doc: Document): Range[] {
  const byId = new Map(anchors.map((a) => [a.id, a]))
  const ranges: Range[] = []
  for (const id of ids) {
    const anchor = byId.get(id)
    const range = anchor?.quote ? findRange(anchor.quote, doc, anchor.context) : null
    if (range) ranges.push(range)
  }
  return ranges
}

/** What a `glance:paint` command decides for the highlight, and nothing else: record the anchors
 *  (for `textRectBatch` to place badges from) and hand back ZERO Ranges, always. `paintTexts` in
 *  client.ts calls this and applies whatever it returns verbatim, never computing its own Ranges —
 *  client.test.ts drives that wiring for real (happy-dom has no CSS Custom Highlight API, so it
 *  can't be exercised HERE) and is what actually catches the persistent-markup bug this file's
 *  header describes: this function alone being pinned to always-empty proves nothing if client.ts
 *  is free to bypass it, which is exactly what survived until that test existed. */
export function paintTextAnchors(anchors: TextAnchor[]): { anchors: TextAnchor[]; ranges: Range[] } {
  return { anchors, ranges: [] }
}

/** Emit a batch on every reflow frame. Deliberately NOT guarded by a change key the way
 *  `glance:pinpoint-resolved` is: rects move on EVERY scroll frame and the badges have to follow, so
 *  a "only when the SET changes" guard would freeze them at their first position. The one thing
 *  suppressed is the ENDLESS empty batch — the first empty one matters (it is what clears the last
 *  badge when the final text anchor is unpainted or stops resolving), but after it a page with no
 *  text anchors must not post a message every frame for the rest of the session. */
export function createRectEmitter(emit: (msg: RectsMessage) => void): (anchors: TextAnchor[], doc: Document) => void {
  let lastCount = 0
  return (anchors, doc) => {
    const batch = textRectBatch(anchors, doc)
    if (batch.rects.length === 0 && lastCount === 0) return
    lastCount = batch.rects.length
    emit(batch)
  }
}

export type InvalidationDeps = {
  doc: Document
  win: {
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
    MutationObserver: typeof MutationObserver
  }
  /** Run after the version bump — the client re-reads (and re-emits) on the next frame. */
  onInvalidate: () => void
}

/** Keep the shared text index honest. It is built once per DOM VERSION, so something has to say when
 *  that version ended, and getting the trigger SET wrong fails silently rather than loudly: a stale
 *  index re-finds a quote at an offset the live text no longer has.
 *
 *  • characterData — a framework rewriting a text node IN PLACE (`node.data = …`: a React/Vue text
 *    update, a counter, a clock) changes what the document says without touching its structure.
 *    childList alone misses every one of them.
 *  • attributes — a class toggle is how a display:none subtree appears and disappears, and the index
 *    holds only RENDERED text.
 *  • resize — the same reveal with no DOM change at all: a media query brings mobile-only markup into
 *    layout, and "is this text rendered" is a LAYOUT verdict (isRenderedText reads client rects).
 *
 *  Scroll is deliberately absent: it moves nothing into or out of layout, and rebuilding the index
 *  on every scroll frame is the exact cost this cache exists to remove.
 *
 *  Installed at BOOT, not on the first paint: `selectionContext` reads the same shared index at
 *  pointerup, on pages that have no comments yet and are therefore never painted. */
export function installIndexInvalidation({ doc, win, onInvalidate }: InvalidationDeps): () => void {
  const invalidate = (): void => {
    newEpoch()
    onInvalidate()
  }
  const observer = new win.MutationObserver(invalidate)
  if (doc.body) observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true })
  win.addEventListener('resize', invalidate)
  return () => {
    observer.disconnect()
    win.removeEventListener('resize', invalidate)
  }
}
