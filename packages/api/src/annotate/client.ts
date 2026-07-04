// Annotate-mode client, injected into uploaded HTML when ?glance_annotate=1 (gated sites only).
// BROWSER code — excluded from the worker tsconfig and bundled to a string by
// scripts/build-annotate.ts (run `bun run build:annotate` after editing this file).
//
// Trust model (COMMENTS_PLAN constraint 1): this runs in the HOSTILE uploaded-HTML context. It
// may only OPEN UI or SUGGEST an anchor — it emits intent-only messages and computes NO persisted
// status. Paint/mode/focus commands are accepted only from the trusted parent origin. A suggested
// element selector is only ever `querySelector`'d (never eval'd).
//
// Two anchor kinds are painted against the RENDERED DOM (the server no longer resolves anchors):
//   • text    — re-find the stored quote (whitespace-flexible, case-insensitive) → CSS Highlight.
//   • element — re-resolve the stored CSS selector → an absolutely-positioned overlay box that
//               tracks scroll/resize/DOM-mutation. Unresolved selectors aren't painted and are
//               reported back so the parent can flag them orphaned.

import { computeSelector, describeElement, isPageSpanning, resolveSelector } from './locator'

type Boot = { siteId: string; filePath: string; appOrigin: string }
type Mode = 'read' | 'annotate'
type PaintAnchor = { id: string; anchorType?: 'text' | 'page' | 'element'; quote?: string; selector?: string }
type Rect = { top: number; left: number; width: number; height: number }

const DEBOUNCE = 150

const boot = (window as unknown as { __GLANCE__?: Boot }).__GLANCE__

let mode: Mode = 'read'

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

// --- selection capture: emit an intent the parent turns into a composer ------------------
// Text capture always fires; the parent decides (review-gated) whether to open a composer.

function captureSelection(): void {
  const sel = window.getSelection()
  const quote = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.toString().trim() : ''
  if (!sel || !quote) {
    toParent({ type: 'glance:select-clear' })
    return
  }
  const box = sel.getRangeAt(0).getBoundingClientRect()
  toParent({ type: 'glance:select', quote, rect: { top: box.top, left: box.left, width: box.width, height: box.height } })
}

let debounceTimer = 0
document.addEventListener('selectionchange', () => {
  clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(captureSelection, DEBOUNCE)
})

// --- annotate mode: hover-outline + click → suggest an element anchor ---------------------
// Only active in 'annotate' mode. A live text selection wins over an element click, so quoting a
// paragraph still works. The overlay layer is pointer-events:none, so it is never the click target.

function isAnnotatable(el: Element | null): el is Element {
  if (el?.nodeType !== 1) return false
  if (overlayRoot?.contains(el)) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'html' || tag === 'body') return false
  // A page-spanning wrapper is the empty-padding fallback target, not a real anchor — skip it so
  // hovering the gaps between blocks never outlines the whole site.
  const r = el.getBoundingClientRect()
  return !isPageSpanning(r, { width: window.innerWidth, height: window.innerHeight })
}

document.addEventListener('mousemove', (e) => {
  if (mode !== 'annotate') return
  const el = e.target as Element | null
  if (isAnnotatable(el)) drawHover(el)
  else clearHover()
})

// The hover box lives in the iframe, so moving the pointer out to the parent (rail/composer) fires
// no further mousemove to clear it. Drop it when the pointer leaves the document so no stray outline
// lingers while you type a comment.
document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget) clearHover()
})

document.addEventListener(
  'click',
  (e) => {
    if (mode !== 'annotate') return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim()) return // let the text selection win
    const el = e.target as Element | null
    if (!isAnnotatable(el)) return
    e.preventDefault()
    e.stopPropagation()
    const { tag, preview, textFallback } = describeElement(el)
    toParent({ type: 'glance:pinpoint', selector: computeSelector(el), tag, preview, textFallback, rect: rectOf(el) })
  },
  true, // capture phase: suggest the anchor before the page's own handlers can swallow the click
)

// --- overlay layer: paint element anchors + the hover outline ----------------------------
// A single fixed, pointer-events:none container under <html> (NOT <body>, so its own mutations
// never trip the body MutationObserver). Boxes use inline styles so hostile page CSS can't hide
// them. Positions are viewport coords (getBoundingClientRect) → repaint on scroll/resize/mutation.

const ANCHOR_STYLE =
  'position:fixed;pointer-events:none;box-sizing:border-box;outline:2px solid rgba(255,170,0,.95);background:rgba(255,213,0,.18);border-radius:2px;'
const HOVER_STYLE =
  'position:fixed;pointer-events:none;box-sizing:border-box;outline:2px dashed rgba(59,130,246,.95);background:rgba(59,130,246,.12);border-radius:2px;'
// The element just pinpointed — a solid (not dashed) blue box that PERSISTS while the composer is
// open, so you keep seeing what you're commenting on after the transient hover box is gone.
const PENDING_STYLE =
  'position:fixed;pointer-events:none;box-sizing:border-box;outline:2px solid rgba(59,130,246,.95);background:rgba(59,130,246,.12);border-radius:2px;'

let overlayRoot: HTMLElement | null = null
let hoverBox: HTMLElement | null = null
let pendingBox: HTMLElement | null = null
let pendingSelector: string | null = null
let elementAnchors: { id: string; selector: string }[] = []

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

function drawHover(el: Element): void {
  const root = ensureOverlayRoot()
  if (!hoverBox?.isConnected) {
    hoverBox = document.createElement('div')
    hoverBox.style.cssText = HOVER_STYLE
    root.appendChild(hoverBox)
  }
  place(hoverBox, rectOf(el))
}

function clearHover(): void {
  hoverBox?.remove()
  hoverBox = null
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

let watching = false
function ensureReflowWatchers(): void {
  if (watching) return
  watching = true
  window.addEventListener('scroll', scheduleReflow, true) // capture: catch scroll on any container
  window.addEventListener('resize', scheduleReflow)
  new MutationObserver(scheduleReflow).observe(document.body, { subtree: true, childList: true, attributes: true })
}

function paintElements(anchors: PaintAnchor[]): void {
  elementAnchors = anchors.filter((a) => a.selector).map((a) => ({ id: a.id, selector: a.selector as string }))
  if (elementAnchors.length > 0) ensureReflowWatchers()
  reposition()
}

/** Lay (or clear) the persistent selection box over the element the parent reports as pending. Runs
 *  inside reposition so the box tracks scroll/resize/DOM mutation like an anchor. Separate from the
 *  hover box (which follows the cursor) so the outline survives after you move off to the composer. */
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

/** Parent tells us which element is pending (just pinpointed / has an open composer), or null to
 *  clear. Outlives the hover box so the selection stays visible while you type. */
function setPending(selector: string | null): void {
  pendingSelector = selector
  if (selector) ensureReflowWatchers()
  reposition()
}

// --- painting text anchors (CSS Custom Highlight) ----------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Locate an anchor quote in the rendered DOM, whitespace-flexibly, and return a Range. The stored
 *  quote is whitespace-normalized, so we match its tokens across ANY run of whitespace the rendered
 *  text may use — including none. Case-insensitive to survive CSS text-transform. Null if absent. */
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

function paintTexts(anchors: PaintAnchor[]): void {
  if (!supportsHighlight) return // span-wrap fallback is intentionally omitted in v1
  const highlight = new Highlight()
  for (const a of anchors) {
    if (!a.quote) continue
    const range = findRange(a.quote)
    if (range) highlight.add(range)
  }
  CSS.highlights.set('glance-comment', highlight)
}

// --- command dispatch (parent-driven) ----------------------------------------------------

function paint(anchors: PaintAnchor[]): void {
  paintTexts(anchors.filter((a) => a.anchorType !== 'element'))
  paintElements(anchors.filter((a) => a.anchorType === 'element'))
}

function focus(target: { quote?: string; selector?: string }): void {
  if (target.selector) {
    resolveSelector(target.selector, document)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  if (target.quote) findRange(target.quote)?.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function setMode(next: Mode): void {
  mode = next
  if (next !== 'annotate') clearHover()
}

// Paint/mode/focus commands are trusted ONLY from the parent app origin (the inverse of the
// hostile-iframe rule: here the parent is the trusted side).
window.addEventListener('message', (e: MessageEvent) => {
  if (!boot || e.origin !== boot.appOrigin) return
  const d = e.data as { type?: string; anchors?: PaintAnchor[]; quote?: string; selector?: string; mode?: Mode }
  if (d?.type === 'glance:paint' && Array.isArray(d.anchors)) paint(d.anchors)
  else if (d?.type === 'glance:focus') focus({ quote: d.quote, selector: d.selector })
  else if (d?.type === 'glance:mode' && (d.mode === 'read' || d.mode === 'annotate')) setMode(d.mode)
  else if (d?.type === 'glance:pending') setPending(typeof d.selector === 'string' ? d.selector : null)
})

// Boot handshake: tell the parent which file is mounted (intent-only; parent re-validates).
if (boot) toParent({ type: 'glance:ready', filePath: boot.filePath })
