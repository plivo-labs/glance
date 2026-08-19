// The viewer's text-comment popover lifecycle (slice A1) — a pure reducer, unit-tested; the
// component only renders what it says. No React, no DOM, no side effects.

import type { TextContext } from '@/lib/comments'
import type { DOMRectLike } from '@/lib/parseIntent'

/** Where a chip/composer is pinned: the selected text plus the rect the iframe reported for it. */
export interface Anchor {
  quote: string
  context?: TextContext
  rect: DOMRectLike
  /** The selection's enclosing element's text — extra context handed to the AI on "Ask". */
  blockText?: string
}

export interface PopoverState {
  /** The "comment on this" affordance for the CURRENT selection; null = no live selection. */
  chip: Anchor | null
  composer: { id: number; anchor: Anchor } | null
  /** The in-flight write, tagged with the composer id it was started from. */
  saving: { id: number } | null
  /** The "Ask AI about the selection" panel — shares the `seq` clock with `composer` (an ask and a
   *  composer never share an id, but neither needs its own). Unlike a composer, an open ask is NOT
   *  re-anchored or closed by a later 'select' (see that case): the user may keep reading an answer
   *  while selecting new text for their next question. */
  ask: { id: number; anchor: Anchor } | null
  /** Monotonic composer id clock: never rewound, and no two composers share an id. A save is
   * tagged with the id of the composer that started it, so retrying a failed write reuses that
   * id by design — the tag identifies the composer, not the attempt. */
  seq: number
}

export type PopoverEvent =
  /** The iframe reported a committed selection. `dirty` = the open composer has typed text. */
  | { type: 'select'; anchor: Anchor; dirty: boolean }
  /** The iframe reported the selection went away. */
  | { type: 'clear' }
  /** The user clicked the chip. */
  | { type: 'activate' }
  /** `C` pressed on a live selection inside the iframe (#117). Same outcome as 'activate' in the
   *  one state the binding exists for, and inert everywhere else — see the case below. */
  | { type: 'commentKey' }
  /** The user clicked "Ask" on the chip. */
  | { type: 'askActivate' }
  /** The ask keyboard shortcut fired inside the iframe. Same one-state contract as `commentKey`. */
  | { type: 'askKey' }
  /** A pointerdown inside the iframe / outside the popover. */
  | { type: 'clickAway'; dirty: boolean }
  /** Explicit teardown: Escape or Cancel. */
  | { type: 'dismiss' }
  /** The composer began a write. */
  | { type: 'submit' }
  /** That write finished. `id` is the composer id it was started from. */
  | { type: 'saveSettled'; id: number; ok: boolean }

export function initialPopover(): PopoverState {
  return { chip: null, composer: null, saving: null, ask: null, seq: 0 }
}

export function stepPopover(state: PopoverState, event: PopoverEvent): PopoverState {
  switch (event.type) {
    case 'select': {
      // A selection only ever offers a chip. Opening a composer on select would hijack plain
      // select-to-copy, so the composer is opened by an explicit 'activate' and nothing else.
      const chip = event.anchor
      // `ask` is deliberately left untouched here — unlike the composer, an open answer panel is
      // not a draft the user could lose, it is a reference the user may want to keep reading while
      // selecting the NEXT quote to ask about. So a 'select' neither re-anchors it (it is not
      // "about" the new selection) nor closes it (only an explicit dismiss does that).
      // A typed draft outlives the selection that started it: re-anchoring it to text the user
      // just happened to highlight would silently attach the comment to the wrong quote. A clean
      // composer has nothing to lose, so it follows the selection.
      if (state.composer === null || event.dirty) return { ...state, chip }
      return { ...state, chip, composer: { ...state.composer, anchor: chip } }
    }

    case 'clear':
      // Clicking the chip collapses the iframe selection, so a 'clear' ALWAYS trails an 'activate'.
      // It may therefore only ever retire the chip — closing the composer here would make the chip
      // unclickable.
      return { ...state, chip: null }

    case 'activate': {
      if (state.chip === null) return state // nothing to anchor to
      // Clicking the chip is explicit intent to comment on THIS selection, so it mints a fresh
      // composer even when one is already open — including a dirty one, whose draft the UI drops
      // with the id change. Rule 2 shields a draft from an INCIDENTAL selection, not from a click.
      // It also closes `ask`: an explicit click is a decision to comment now, and the two panels
      // are mutually exclusive — only one popover shows at a time.
      const seq = state.seq + 1
      return { ...state, seq, composer: { id: seq, anchor: state.chip }, ask: null }
    }

    case 'commentKey': {
      // THE binding lives in exactly one state: a chip is offered and neither a composer nor an ask
      // panel is open. The iframe fires this whenever it has a selection — it cannot see the popover
      // state, which the parent may have retired on click-away or Escape — so the narrowing happens
      // here, in the one place that knows. Refusing it while a composer is open is what makes the
      // binding safe rather than a keystroke thief: that is the only state in which a text field of
      // ours has focus, and there `c` is a letter the user is typing, not a command. The `ask` gate
      // is the same rule applied to the newer panel — symmetry with its composer gate.
      if (state.chip === null || state.composer !== null || state.ask !== null) return state
      const seq = state.seq + 1
      return { ...state, seq, composer: { id: seq, anchor: state.chip } }
    }

    case 'askActivate': {
      if (state.chip === null) return state // nothing to anchor to
      // Mirrors 'activate': an explicit click on "Ask" is explicit intent, so it mints a fresh ask
      // panel and CLOSES any composer — even a dirty one. The same rule that lets 'activate' drop a
      // dirty draft applies here: an explicit click outranks an unfinished draft the user has not
      // committed to.
      const seq = state.seq + 1
      return { ...state, seq, ask: { id: seq, anchor: state.chip }, composer: null }
    }

    case 'askKey': {
      // Mirrors 'commentKey': fires only when a chip is offered and neither panel is already open.
      if (state.chip === null || state.composer !== null || state.ask !== null) return state
      const seq = state.seq + 1
      return { ...state, seq, ask: { id: seq, anchor: state.chip } }
    }

    case 'clickAway':
      // DELIBERATE ASYMMETRY vs 'dismiss': a click-away is ambiguous. The same pointerdown in the
      // iframe is how the user starts the NEXT drag-selection, so treating it as "close" would
      // throw away a typed draft on the way to picking the quote it belongs to — the same loss
      // rule 2 forbids on select. A clean composer has nothing to lose, so it closes — and so does
      // `ask`, which never has a draft to lose in the first place.
      return event.dirty ? state : { ...state, chip: null, composer: null, ask: null }

    case 'dismiss':
      // Escape / Cancel is unambiguous user intent: tear the whole popover down.
      return { ...state, chip: null, composer: null, ask: null }

    case 'submit':
      // Snapshot the CURRENT composer id so a settle can be matched against whatever is open when
      // it lands — writes are slow enough for the user to move on to another selection.
      return state.composer === null ? state : { ...state, saving: { id: state.composer.id } }

    case 'saveSettled': {
      if (state.saving === null || state.saving.id !== event.id) return state // stale/unknown: inert
      const cleared: PopoverState = { ...state, saving: null }
      // A failure closes NOTHING — the draft lives in the Composer component, so leaving it open is
      // what makes the write retryable. If the composer is already gone (or is a newer one), the
      // settle is nothing but a spinner switch-off.
      if (!event.ok || state.composer?.id !== event.id) return cleared
      // A success closes the composer it was started from, and retires the chip ONLY when the chip
      // is still that composer's own anchor — the quote that now HAS a comment, so offering to
      // comment on it again is stale. Identity, not equality: a chip the user has since moved to
      // another selection is a newer affordance and none of this write's business (the same rule
      // that keeps a late success from disturbing a newer composer).
      return { ...cleared, composer: null, chip: state.chip === state.composer.anchor ? null : state.chip }
    }
  }
}
