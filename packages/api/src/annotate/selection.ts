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
import { selectionContext } from './locator'

export type Rect = { top: number; left: number; width: number; height: number }
export type SelectMessage = { type: 'glance:select'; quote: string; context: TextContext; rect: Rect }
export type ClearMessage = { type: 'glance:select-clear' }
/** The user touched the page — the parent should consider closing whatever popover it has open. The
 *  parent CANNOT see this for itself: clicks inside a cross-origin iframe are invisible to it. */
export type ClickAwayMessage = { type: 'glance:click-away' }
/** Escape pressed inside the iframe, forwarded for the same reason. */
export type EscapeMessage = { type: 'glance:escape' }

export type SelectionDeps = {
  doc: Document
  getSelection: () => Selection | null
  emit: (msg: SelectMessage | ClearMessage | ClickAwayMessage | EscapeMessage) => void
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
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') emit({ type: 'glance:escape' })
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
