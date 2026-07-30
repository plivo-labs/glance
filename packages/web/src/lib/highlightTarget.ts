// The viewer's parent-side highlight decision (slice B3b-hard): which thread ids should be lit in
// the iframe's hover-only CSS Custom Highlight RIGHT NOW. No React, no DOM, no postMessage — the
// component only executes what this reducer says. Modeled on lib/badges.ts's step-plus-identity
// shape, and lib/commentPopover.ts's event-reducer house style.
//
// This seam is what B3b was missing: the decision lived inline in viewer.tsx callbacks (highlight,
// focusAnchor) and client.ts wiring, so nothing proved hover REPLACES rather than unions, that a
// rail click doesn't leave a persistent highlight, or that a deep-link mount lights nothing.

export type HighlightState = { ids: string[] }

export type HighlightEvent =
  | { type: 'hover'; ids: string[] } // a badge or a rail card gained pointer/focus
  | { type: 'leave' } // pointer left / blur
  | { type: 'exitReview' }
  | { type: 'navigate' } // splat nav / deep-link mount

export function initialHighlight(): HighlightState {
  return { ids: [] }
}

const EMPTY: readonly string[] = []

export function stepHighlight(state: HighlightState, event: HighlightEvent): HighlightState {
  const next = event.type === 'hover' ? event.ids : EMPTY
  // A same-shape result returns the SAME object by identity, not a new array-equal one — this is
  // how the caller (viewer.tsx) tells whether to skip the postMessage, exactly like stepBadges'
  // epoch bailout lets a React memo skip a re-render.
  if (sameIds(state.ids, next)) return state
  return { ids: [...next] }
}

function sameIds(a: string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}
