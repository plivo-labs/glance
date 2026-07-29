// The viewer's text-comment popover lifecycle (slice A1) — a pure reducer, unit-tested; the
// component only renders what it says. No React, no DOM, no side effects.

import type { TextContext } from '@/lib/comments'
import type { DOMRectLike } from '@/lib/parseIntent'

/** Where a chip/composer is pinned: the selected text plus the rect the iframe reported for it. */
export interface Anchor {
  quote: string
  context?: TextContext
  rect: DOMRectLike
}

export interface PopoverState {
  /** The "comment on this" affordance for the CURRENT selection; null = no live selection. */
  chip: Anchor | null
  composer: { id: number; anchor: Anchor } | null
  /** The in-flight write, tagged with the composer id it was started from. */
  saving: { id: number } | null
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
  /** A pointerdown inside the iframe / outside the popover. */
  | { type: 'clickAway'; dirty: boolean }
  /** Explicit teardown: Escape or Cancel. */
  | { type: 'dismiss' }
  /** The composer began a write. */
  | { type: 'submit' }
  /** That write finished. `id` is the composer id it was started from. */
  | { type: 'saveSettled'; id: number; ok: boolean }

export function initialPopover(): PopoverState {
  return { chip: null, composer: null, saving: null, seq: 0 }
}

export function stepPopover(state: PopoverState, event: PopoverEvent): PopoverState {
  switch (event.type) {
    case 'select': {
      // A selection only ever offers a chip. Opening a composer on select would hijack plain
      // select-to-copy, so the composer is opened by an explicit 'activate' and nothing else.
      const chip = event.anchor
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
      const seq = state.seq + 1
      return { ...state, seq, composer: { id: seq, anchor: state.chip } }
    }

    case 'clickAway':
      // DELIBERATE ASYMMETRY vs 'dismiss': a click-away is ambiguous. The same pointerdown in the
      // iframe is how the user starts the NEXT drag-selection, so treating it as "close" would
      // throw away a typed draft on the way to picking the quote it belongs to — the same loss
      // rule 2 forbids on select. A clean composer has nothing to lose, so it closes.
      return event.dirty ? state : { ...state, chip: null, composer: null }

    case 'dismiss':
      // Escape / Cancel is unambiguous user intent: tear the whole popover down.
      return { ...state, chip: null, composer: null }

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
