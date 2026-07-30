// Reflow-side policy for the annotate client: keeping the shared text index HONEST, turning the
// painted anchors into the Ranges the CSS Custom Highlight shows, and hit-testing a click against
// them. BROWSER code (it works on DOM objects) but GLOBAL-FREE: the document, the window and the
// point are all INJECTED, so the policy is unit-testable under a constructed happy-dom window with
// no global registration — the same seam locator.ts and selection.ts use. client.ts is only the
// wiring. Bundled into client.ts by scripts/build-annotate.ts; excluded from the worker tsconfig
// (DOM types).

import type { TextContext } from '../lib/anchor'
import { findRange, newEpoch, resolveSelector } from './locator'

export type TextAnchor = { id: string; quote?: string; context?: TextContext }
export type ElementAnchor = { id: string; selector: string }
export type Point = { x: number; y: number }

/** Every painted text anchor's Range, to paint into the `glance-comment` CSS Custom Highlight.
 *  A paint IS the highlight now: the parent only sends anchors while the comments rail is open, so
 *  "what is painted" and "what is lit" are the same set and there is no separate hover command to
 *  disagree with it. An anchor whose quote no longer resolves (the page changed under it) silently
 *  contributes no Range — a highlight over text that isn't there anymore is worse than none. */
export function anchorRanges(anchors: TextAnchor[], doc: Document): Range[] {
  const ranges: Range[] = []
  for (const a of anchors) {
    const range = a.quote ? findRange(a.quote, doc, a.context) : null
    if (range) ranges.push(range)
  }
  return ranges
}

const hits = (r: { top: number; left: number; width: number; height: number }, p: Point): boolean =>
  p.x >= r.left && p.x <= r.left + r.width && p.y >= r.top && p.y <= r.top + r.height

/** Which anchor (if any) a click at `point` landed on — the ONE way the page navigates to a thread
 *  now that badges are gone. A CSS Custom Highlight is paint, not DOM: it takes part in no hit
 *  testing at all, so the highlighted text has to be re-found and its client rects tested against
 *  the point by hand. A Range spanning a line break measures as SEVERAL rects, hence getClientRects
 *  rather than its bounding box (which would cover the whole indented block between two lines).
 *
 *  Text is tested before elements: a quote inside an element-anchored container is the more
 *  specific of two overlapping anchors, and the click means the one the user can actually see the
 *  highlight on. Returns null for a click anywhere else — that click is the page's own, untouched. */
export function anchorIdAtPoint(textAnchors: TextAnchor[], elementAnchors: ElementAnchor[], point: Point, doc: Document): string | null {
  for (const a of textAnchors) {
    const range = a.quote ? findRange(a.quote, doc, a.context) : null
    if (range && Array.from(range.getClientRects()).some((r) => hits(r, point))) return a.id
  }
  for (const a of elementAnchors) {
    const el = resolveSelector(a.selector, doc)
    if (el && hits(el.getBoundingClientRect(), point)) return a.id
  }
  return null
}

export type InvalidationDeps = {
  doc: Document
  win: {
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
    MutationObserver: typeof MutationObserver
  }
  /** Run after the version bump — the client re-reads (and repaints) on the next frame. */
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
