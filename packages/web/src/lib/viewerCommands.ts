// The viewer's remaining outbound decisions (slice B-wire): plain functions over plain data, no
// React, no DOM, no globals — the component only calls these and executes the result. Extracted
// for the same reason lib/badges.ts, lib/commentPopover.ts and lib/highlightTarget.ts were: each
// used to be an inline decision in viewer.tsx that a typo or a hardcoded stand-in could silently
// break with the whole suite staying green.

import type { Thread } from '@/lib/comments'
import type { HighlightState } from '@/lib/highlightTarget'

/** The ONLY place the `glance:highlight` wire literal is written on the parent side — a typo here
 *  breaks THIS test, not the feature (a paint that silently never reaches the iframe). */
export function highlightCommand(state: HighlightState): { type: 'glance:highlight'; ids: string[] } {
  return { type: 'glance:highlight', ids: state.ids }
}

/** The iframe's own box IS the frame viewport (the overlay is mounted as its sibling in the same
 *  wrapper) — a structural type, not HTMLIFrameElement, so this tests with a plain object. Not yet
 *  mounted (null) is {0,0}, which buildBadges already treats as "nothing visible yet". */
export function frameViewport(el: { clientWidth: number; clientHeight: number } | null): { width: number; height: number } {
  if (!el) return { width: 0, height: 0 }
  return { width: el.clientWidth, height: el.clientHeight }
}

/** Which thread a badge click reveals: the FIRST member id that still matches a live thread — not
 *  blindly threadIds[0], because a cluster member can have been resolved or deleted between the
 *  rect batch and the click, and a plain `.find` on the wrong index would then silently open
 *  nothing. An empty id list, or no member matching any thread, is null. */
export function badgeOpenTarget(threadIds: string[], threads: Thread[]): Thread | null {
  const byId = new Map(threads.map((t) => [t.id, t]))
  for (const id of threadIds) {
    const thread = byId.get(id)
    if (thread) return thread
  }
  return null
}
