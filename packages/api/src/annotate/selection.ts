// Selection-capture policy for the annotate client. BROWSER code (it works on DOM objects) but
// GLOBAL-FREE: the document, the selection getter and the emitter are all INJECTED, so the policy is
// unit-testable under a constructed happy-dom window with no global registration — the same seam
// locator.ts uses. client.ts is only the wiring. Bundled into client.ts by scripts/build-annotate.ts;
// excluded from the worker tsconfig (uses DOM types).
//
// WHY NOT `selectionchange`: it fires CONTINUOUSLY while a drag is in progress — "the start or end
// boundary point of a selected range moves" (MDN) is one of its trigger conditions — so ANY capture
// hung off it, debounced or not, lands MID-DRAG. The parent reacts to a select intent by opening UI,
// that steals focus, and on touch a focus steal tears down the native selection handles the user is
// still dragging: the capture destroys the very selection it is trying to read. So a select intent is
// emitted only from events that mean the selection is COMMITTED — the pointer came back up, or a
// selection-moving key came back up. At that moment the selection is already final: a drag extends it
// as the pointer moves, and pointerup precedes even the compatibility mouseup/click.
//
// `selectionchange` IS still listened to, but as a CLEAR-ONLY channel: it is what tells us promptly
// that a selection went away — a click elsewhere, or the pointerdown that begins the NEXT drag,
// collapses the old one — so the parent can retire a stale chip. It can never open a composer.

import type { TextContext } from '../lib/anchor'
import { NON_RENDERED_TAGS, selectionContext } from './locator'

export type Rect = { top: number; left: number; width: number; height: number }
export type SelectMessage = {
  type: 'glance:select'
  quote: string
  context: TextContext
  rect: Rect
  /** The visible text of the selection's enclosing block element — the "context" an AI answer about
   *  the selection gets. Always the whole block, never the whole page: a paragraph is enough to
   *  disambiguate the quote, and the page could be arbitrarily large. Omitted when empty. */
  blockText?: string
}
export type ClearMessage = { type: 'glance:select-clear' }
/** The user touched the page — the parent should consider closing whatever popover it has open. The
 *  parent CANNOT see this for itself: clicks inside a cross-origin iframe are invisible to it. */
export type ClickAwayMessage = { type: 'glance:click-away' }
/** Escape pressed inside the iframe, forwarded for the same reason. */
export type EscapeMessage = { type: 'glance:escape' }
/** `C` pressed while a selection is live: "comment on this", the keyboard's route to what clicking
 *  the chip does. Payload-free INTENT, deliberately fired liberally — this realm cannot see whether
 *  the parent still has a chip on screen (it may have dismissed one on click-away or Escape while
 *  the selection survived here), so the parent's reducer is the authority on whether it means
 *  anything. See commentPopover.ts's 'commentKey'. */
export type CommentKeyMessage = { type: 'glance:comment-key' }
/** `A` pressed while a selection is live: "ask AI about this", the same keyboard route as the
 *  comment key. Payload-free INTENT, fired under the identical gate — this realm can't see whether
 *  the parent still has UI open for the selection, so the parent's reducer is the authority. */
export type AskKeyMessage = { type: 'glance:ask-key' }

export type SelectionDeps = {
  doc: Document
  getSelection: () => Selection | null
  emit: (
    msg: SelectMessage | ClearMessage | ClickAwayMessage | EscapeMessage | CommentKeyMessage | AskKeyMessage,
  ) => void
}

/** Keys a keyup commits on. A BARE keyup is too wide: it would re-walk the whole document text index
 *  (selectionContext) on every keystroke and re-emit the chip while someone types into a form on the
 *  page. Only caret-moving keys can build a selection without a pointer (Shift extends, plain
 *  collapses) — plus select-all — so those are the only ones that can carry a commit. Nothing is lost
 *  on the clear side: a keystroke that types OVER a selection collapses it, and the selectionchange
 *  channel below retires the chip regardless of which key did it. */
const SELECTION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

function isSelectionKey(e: KeyboardEvent): boolean {
  return SELECTION_KEYS.has(e.key) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')
}

/** A bare letter key, no modifiers: ⌘/^/⌥ are reserved for the browser (copy, select-all, ...) and
 *  stealing one of those chords would break the most common thing anyone does with a selection.
 *  Shift is allowed through — capital is the same key press. Shared by every single-letter intent
 *  below so the modifier check lives in exactly one place. */
const bareKey = (e: KeyboardEvent, key: string): boolean =>
  e.key.toLowerCase() === key && !e.ctrlKey && !e.metaKey && !e.altKey

// Block-level tags a selection's context is bounded to — see nearestBlockText.
const BLOCK_TAGS = new Set([
  'P',
  'LI',
  'TD',
  'TH',
  'DD',
  'DT',
  'BLOCKQUOTE',
  'PRE',
  'FIGCAPTION',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SECTION',
  'ARTICLE',
  'DIV',
])
const BLOCK_TEXT_LIMIT = 2000

/** The enclosing block's text for a committed range: walk up from the range's common ancestor (a
 *  text node's parent, since a text node itself is never a block) to the nearest block-level
 *  element, falling back to the whole body if none is found. This is deliberately the WHOLE element,
 *  not a snippet around the quote — it's the context an AI answer about the selection gets, and an
 *  answer needs the paragraph, not a truncated fragment of it. */
function nearestBlockText(range: Range, doc: Document): string | undefined {
  // 3 === Node.TEXT_NODE, as a literal: happy-dom (the unit-test DOM) doesn't register the `Node`
  // global, same reasoning as the NodeFilter constants in locator.ts.
  const start = range.commonAncestorContainer
  let el: Element | null = start.nodeType === 3 ? start.parentElement : (start as Element)
  while (el && el !== doc.body && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement
  const collapsed = visibleText(el ?? doc.body)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BLOCK_TEXT_LIMIT)
  return collapsed || undefined
}

/** textContent minus locator.ts's NON_RENDERED_TAGS: glance pages are single-file HTML with inline
 *  <script>/<style> in the body, and a wrapper DIV (or the doc.body fallback) reached above would
 *  otherwise ship JS/CSS source as the AI's "passage" — crowding the real paragraph out of the
 *  2000-char cap. Collection stops early once enough raw text is in hand: whitespace collapsing
 *  only ever shrinks, so 2× the cap of raw chars always covers the post-collapse limit. */
function visibleText(root: Element): string {
  let out = ''
  const walk = (node: Node): boolean => {
    if (out.length >= BLOCK_TEXT_LIMIT * 2) return false
    if (node.nodeType === 3) {
      out += node.nodeValue ?? ''
      return true
    }
    if (NON_RENDERED_TAGS.has((node as Element).tagName)) return true
    for (let child = node.firstChild; child; child = child.nextSibling) if (!walk(child)) return false
    return true
  }
  walk(root)
  return out
}

/** Is the keystroke going INTO a field on the hosted page? The chip gate below is normally enough
 *  (focusing a field collapses the page selection, which retires the chip) — but a contenteditable
 *  reports its selection through `window.getSelection()` like any other, so there the chip and a
 *  live cursor genuinely coexist, and `c` is a character the author is typing. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

/** Wire the capture onto `doc` and return a dispose that unwires it completely. */
export function installSelectionCapture({ doc, getSelection, emit }: SelectionDeps): () => void {
  // Whether the parent currently believes there is a selection. The clear is a TRANSITION, not a
  // state report: one click fires several selectionchange events and every one of them sees the same
  // empty selection, so without this the parent would be spammed with identical clears.
  let hadSelection = false

  const liveQuote = (sel: Selection | null): string =>
    sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.toString().trim() : ''

  const clearIfGone = (): void => {
    if (!hadSelection || liveQuote(getSelection())) return
    hadSelection = false
    emit({ type: 'glance:select-clear' })
  }

  /** The selection is committed: hand the parent the chip intent, or retire the chip it has. */
  const commit = (): void => {
    const sel = getSelection()
    const quote = liveQuote(sel)
    if (!sel || !quote) {
      clearIfGone()
      return
    }
    hadSelection = true
    const range = sel.getRangeAt(0)
    const box = range.getBoundingClientRect()
    // The text on either side, captured NOW: the quote alone can't say which occurrence of a
    // repeated phrase the user meant, and by paint time the selection is long gone.
    emit({
      type: 'glance:select',
      quote,
      context: selectionContext(range, doc),
      rect: { top: box.top, left: box.left, width: box.width, height: box.height },
      blockText: nearestBlockText(range, doc),
    })
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    if (isSelectionKey(e)) commit()
  }

  /** Fires on EVERY pointerdown, including the one that begins the next drag-selection: pointerdown
   *  precedes the pointerup that commits, so an ordinary drag emits click-away THEN select, in that
   *  order, and the parent must tolerate it. That is intended — this is a raw signal, and the PARENT
   *  decides whether it should close anything. */
  const onClickAway = (): void => emit({ type: 'glance:click-away' })

  // keydown, not keyup: Escape must reach the parent BEFORE the page's own handlers act on it. No
  // drag-commit concern here, so nothing is gained by waiting for the key to come back up.
  //
  // `c` and `a` ride the same handler, gated on `hadSelection` — the parent was told there is
  // something to act on and has not been told otherwise. That gate is what keeps this from being a
  // key grabber: with no selection outstanding, `c`/`a` are just letters on someone else's page.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') emit({ type: 'glance:escape' })
    else if (hadSelection && bareKey(e, 'c') && !isEditableTarget(e.target)) emit({ type: 'glance:comment-key' })
    else if (hadSelection && bareKey(e, 'a') && !isEditableTarget(e.target)) emit({ type: 'glance:ask-key' })
  }

  doc.addEventListener('pointerup', commit)
  doc.addEventListener('keyup', onKeyUp)
  doc.addEventListener('selectionchange', clearIfGone)
  doc.addEventListener('pointerdown', onClickAway)
  doc.addEventListener('keydown', onKeyDown)

  return () => {
    doc.removeEventListener('pointerup', commit)
    doc.removeEventListener('keyup', onKeyUp)
    doc.removeEventListener('selectionchange', clearIfGone)
    doc.removeEventListener('pointerdown', onClickAway)
    doc.removeEventListener('keydown', onKeyDown)
  }
}
