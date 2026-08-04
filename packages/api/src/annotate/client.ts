// Annotate-mode client, injected into uploaded HTML when ?glance_annotate=1 (gated sites only).
// BROWSER code — excluded from the worker tsconfig and bundled to a string by
// scripts/build-annotate.ts (run `bun run build:annotate` after editing this file).
//
// Trust model (COMMENTS_PLAN constraint 1): this runs in the HOSTILE uploaded-HTML context. It
// may only OPEN UI or SUGGEST an anchor — it emits intent-only messages and computes NO persisted
// status. Paint/focus commands are accepted only from the trusted parent origin. A painted element
// anchor's selector is only ever `querySelector`'d (never eval'd).
//
// Element ("pinpoint") comments are DROPPED as a creation path (RULING): the uploaded page must
// behave exactly as its author wrote it, so this client never hovers or suggests an anchor. The one
// click it claims is a click that lands ON an existing painted anchor — an affordance the user
// asked for by opening the rail, and impossible while it's closed (nothing is painted). PAINTING an
// existing element anchor stays — those threads are already in customers' databases — and the API
// keeps accepting element creates so a stale cached bundle doesn't start failing on an old page load.
//
// Two anchor kinds are painted against the RENDERED DOM (the server no longer resolves anchors):
//   • text    — re-find the stored quote (whitespace-flexible, case-insensitive) and light it in
//               the `glance-comment` CSS Custom Highlight.
//   • element — re-resolve the stored CSS selector and lay an outline box over it, tracking
//               scroll/resize/DOM-mutation. Unresolved selectors draw nothing and are reported
//               back so the parent can flag them orphaned.
// A PAINT IS THE HIGHLIGHT: everything the parent sends is lit, and the parent sends anchors only
// while the comments rail is open (an empty paint on close clears the page). There is no hover
// command and no per-anchor lit set — badges, and the rect batches that positioned them, are gone.
// Clicking a painted anchor is what opens its thread in the rail (glance:anchor-click).

import { withAnnotateParam } from './linkRewrite'
import type { TextContext } from '../lib/anchor'
import { findRange, resolveSelector } from './locator'
import { anchorIdAtPoint, anchorRanges, type ElementAnchor, installIndexInvalidation, type TextAnchor } from './reflow'
import { installSelectionCapture, type Rect } from './selection'

type Boot = { siteId: string; filePath: string; appOrigin: string }
type PaintAnchor = { id: string; anchorType?: 'text' | 'page' | 'element'; quote?: string; selector?: string; context?: TextContext }

const boot = (window as unknown as { __GLANCE__?: Boot }).__GLANCE__

function toParent(msg: unknown): void {
  if (!boot) return
  try {
    window.parent.postMessage(msg, boot.appOrigin)
  } catch {
    /* parent gone / blocked — annotate mode stays inert */
  }
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

// --- selection capture: emit an intent the parent turns into a chip -----------------------
// The capture POLICY (which events commit a selection, when a clear is a transition) lives in
// selection.ts so it is testable; this is only the wiring. The intent always fires; the parent
// decides (review-gated) what to do with it.

installSelectionCapture({ doc: document, getSelection: () => window.getSelection(), emit: toParent })

// --- link navigation: propagate ?glance_annotate=1 across in-iframe navigation -----------
// content.ts only injects this client when the request carries ?glance_annotate=1 — relative links
// inside the uploaded page never carry it, so the NEXT page loads without us: no glance:ready, so
// the sidebar misses the navigation and the viewer's filePath goes stale (misattributing subsequent
// comments). Rewrite the href just before the browser navigates, for every same-origin, plain
// (no modifier key, no download/new-tab) left click on a link. Capture phase, so the rewrite lands
// before the page's own click handlers (if any) can act on the stale href; it never calls
// preventDefault, so ordinary navigation proceeds unmodified either way. (This used to also be
// registered after a capture-phase pinpoint-suggest handler and skip a click that one had already
// claimed via `e.defaultPrevented` — that handler is gone (element comments are no longer created
// this way), so the check is now permanently false, but harmless.)
document.addEventListener(
  'click',
  (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    const target = e.target as Element | null
    const a = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || a.hasAttribute('download')) return
    const linkTarget = a.getAttribute('target')
    if (linkTarget && linkTarget !== '_self') return
    const rewritten = withAnnotateParam(a.getAttribute('href') ?? '', document.baseURI)
    if (rewritten && rewritten !== a.href) a.href = rewritten
  },
  true,
)

// --- overlay layer: paint element anchors ------------------------------------------------
// A single fixed, pointer-events:none container under <html> (NOT <body>, so its own mutations
// never trip the body MutationObserver). Boxes use inline styles so hostile page CSS can't hide
// them. Positions are viewport coords (getBoundingClientRect) → repaint on scroll/resize/mutation.

const ANCHOR_STYLE =
  'position:fixed;pointer-events:none;box-sizing:border-box;outline:2px solid rgba(255,170,0,.95);background:rgba(255,213,0,.18);border-radius:2px;'
// The element just pinpointed — a solid blue box that PERSISTS while the composer is open, so you
// keep seeing what you're commenting on. Element CREATION is gone (RULING, slice C2a) — today's
// viewer.tsx never sends glance:pending — but this receiver stays for backward compatibility: a
// browser tab holding an OLD cached parent bundle can still post it against this freshly-served
// client.ts, and silently drawing the box for it is strictly better than a stale sender getting an
// unhandled message. Same reasoning as the glance:pinpoint case in parseIntent.ts and the
// e.defaultPrevented check below.
const PENDING_STYLE =
  'position:fixed;pointer-events:none;box-sizing:border-box;outline:2px solid rgba(59,130,246,.95);background:rgba(59,130,246,.12);border-radius:2px;'

let overlayRoot: HTMLElement | null = null
let pendingBox: HTMLElement | null = null
let pendingSelector: string | null = null
let elementAnchors: ElementAnchor[] = []

function ensureOverlayRoot(): HTMLElement {
  if (overlayRoot?.isConnected) return overlayRoot
  const root = document.createElement('div')
  root.id = '__glance_overlay__'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;'
  document.documentElement.appendChild(root)
  overlayRoot = root
  return root
}

function place(box: HTMLElement, r: Rect): void {
  box.style.top = `${r.top}px`
  box.style.left = `${r.left}px`
  box.style.width = `${r.width}px`
  box.style.height = `${r.height}px`
}

let lastResolutionKey = ''

/** Re-resolve every element anchor and lay a box over each; report resolved vs orphaned so the
 *  parent can flag anchors whose element is gone. Runs on every reflow frame (repositioning boxes),
 *  but the resolution message is posted ONLY when the resolved/orphaned SET changes — otherwise a
 *  scroll would spam the parent with an identical message every frame. */
function reposition(): void {
  const root = ensureOverlayRoot()
  repositionPending(root)
  for (const b of Array.from(root.querySelectorAll('[data-glance-anchor]'))) b.remove()
  if (elementAnchors.length === 0) {
    lastResolutionKey = ''
    return
  }
  const resolved: string[] = []
  const orphaned: string[] = []
  for (const a of elementAnchors) {
    const el = resolveSelector(a.selector, document)
    if (!el) {
      orphaned.push(a.id)
      continue
    }
    resolved.push(a.id)
    const box = document.createElement('div')
    box.setAttribute('data-glance-anchor', a.id)
    box.style.cssText = ANCHOR_STYLE
    place(box, rectOf(el))
    root.appendChild(box)
  }
  const key = `${resolved.join(',')}|${orphaned.join(',')}`
  if (key !== lastResolutionKey) {
    lastResolutionKey = key
    toParent({ type: 'glance:pinpoint-resolved', resolved, orphaned })
  }
}

let reflowScheduled = false
function scheduleReflow(): void {
  if (reflowScheduled) return
  reflowScheduled = true
  requestAnimationFrame(() => {
    reflowScheduled = false
    reposition()
  })
}

// Watchers are installed at boot, not on the first paint: the shared text index backs
// `selectionContext` at pointerup too, on pages that have no comments yet and so are never painted.
// Which triggers end a DOM version (and why scroll is not one of them) lives in reflow.ts.
installIndexInvalidation({ doc: document, win: window, onInvalidate: scheduleReflow })
window.addEventListener('scroll', scheduleReflow, true) // capture: catch scroll on any container

function paintElements(anchors: PaintAnchor[]): void {
  elementAnchors = anchors.filter((a) => a.selector).map((a) => ({ id: a.id, selector: a.selector as string }))
  reposition()
}

/** Lay (or clear) the persistent selection box over the element the parent reports as pending. Runs
 *  inside reposition so the box tracks scroll/resize/DOM mutation like an anchor. */
function repositionPending(root: HTMLElement): void {
  const el = pendingSelector ? resolveSelector(pendingSelector, document) : null
  if (!el) {
    pendingBox?.remove()
    pendingBox = null
    return
  }
  if (!pendingBox?.isConnected) {
    pendingBox = document.createElement('div')
    pendingBox.style.cssText = PENDING_STYLE
    root.appendChild(pendingBox)
  }
  place(pendingBox, rectOf(el))
}

/** Parent tells us which element is pending (has an open composer), or null to clear. */
function setPending(selector: string | null): void {
  pendingSelector = selector
  reposition()
}

// --- painting text anchors (the CSS Custom Highlight) --------------------------------------

const supportsHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS

let textAnchors: TextAnchor[] = []

/** Apply a computed Range set to the registered Highlight — the one place client.ts touches
 *  CSS.highlights, shared verbatim by paintTexts and highlight below so neither can decide its own
 *  highlight independently of what reflow.ts computed. An empty result DELETES the registered
 *  Highlight rather than setting an empty one — CSS leaves a registered empty Highlight painting
 *  nothing but still resident, which is observably different from no highlight at all (e.g. to
 *  devtools/extensions inspecting registered highlights), so "nothing to show" must mean "not
 *  registered". */
function applyRanges(ranges: Range[]): void {
  if (!supportsHighlight) return
  if (ranges.length === 0) CSS.highlights.delete('glance-comment')
  else CSS.highlights.set('glance-comment', new Highlight(...ranges))
}

/** Record which anchors exist (for the click hit-test) and light every one of them. The parent
 *  sends anchors only while the comments rail is open and an EMPTY list when it closes, so the
 *  page is marked up exactly as long as the panel that explains the markup is on screen. */
function paintTexts(anchors: PaintAnchor[]): void {
  textAnchors = anchors.filter((a) => a.quote)
  applyRanges(anchorRanges(textAnchors, document))
}

// --- clicking a painted anchor -----------------------------------------------------------
// The page→rail direction. Capture phase, and a hit SWALLOWS the click: a highlighted quote inside
// a link must open its thread, not navigate away, and stopPropagation is what keeps the page's own
// handlers from acting on it either. (The link-rewrite handler above is registered first and so
// still runs — it only edits the href, never navigates, so preventDefault here still wins.)
// A MISS is left completely untouched, and with the rail closed nothing is painted at all, so
// nothing can hit and the uploaded page behaves exactly as its author wrote it.

document.addEventListener(
  'click',
  (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    if (textAnchors.length === 0 && elementAnchors.length === 0) return
    const id = anchorIdAtPoint(textAnchors, elementAnchors, { x: e.clientX, y: e.clientY }, document)
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    toParent({ type: 'glance:anchor-click', id })
  },
  true,
)

// --- command dispatch (parent-driven) ----------------------------------------------------

function paint(anchors: PaintAnchor[]): void {
  paintTexts(anchors.filter((a) => a.anchorType !== 'element'))
  paintElements(anchors.filter((a) => a.anchorType === 'element'))
}

function focus(target: { quote?: string; selector?: string; context?: TextContext }): void {
  if (target.selector) {
    resolveSelector(target.selector, document)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  // Same context as paint uses — otherwise focusing a thread on the second occurrence of a repeated
  // quote would scroll to the first, away from its own highlight.
  if (target.quote)
    findRange(target.quote, document, target.context)?.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// Paint/focus commands are trusted ONLY from the parent app origin (the inverse of the hostile-
// iframe rule: here the parent is the trusted side). A stray `glance:mode` or `glance:highlight`
// from a stale cached bundle (the parent no longer sends either) falls through unmatched below and
// is ignored.
window.addEventListener('message', (e: MessageEvent) => {
  if (!boot || e.origin !== boot.appOrigin) return
  const d = e.data as { type?: string; anchors?: PaintAnchor[]; quote?: string; selector?: string; context?: TextContext }
  if (d?.type === 'glance:paint' && Array.isArray(d.anchors)) paint(d.anchors)
  else if (d?.type === 'glance:focus') focus({ quote: d.quote, selector: d.selector, context: d.context })
  else if (d?.type === 'glance:pending') setPending(typeof d.selector === 'string' ? d.selector : null)
  // Print/Save-as-PDF: the viewer iframe is cross-origin, so the parent can't call
  // iframe.contentWindow.print() itself (SecurityError) — it asks, and the page prints in its own
  // realm with the browser's native dialog (the user picks "Save as PDF" there). Full fidelity:
  // the page's own renderer does the layout, including the injected theme stylesheet.
  else if (d?.type === 'glance:print') window.print()
})

// Boot handshake: tell the parent which file is mounted (intent-only; parent re-validates).
if (boot) toParent({ type: 'glance:ready', filePath: boot.filePath })
