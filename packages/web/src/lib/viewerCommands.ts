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

/** Deep-link URL → rail-open decision (slice C1a). `review=1` is baked into ALREADY-SENT Slack
 *  messages and notification-bell links — it must open the rail forever, so it's a permanent
 *  alias here, not a migration. `rail=1` is the newer name matching the split-out `railOpen`
 *  state; either truthy form opens it, so introducing a new param name never silently drops the
 *  old one. Anything else (missing, `review=0`, `review=yes`, …) is not truthy-coerced — only the
 *  documented `1` counts, everything else means "don't open". */
export function railFromSearch(params: URLSearchParams): boolean {
  return params.get('review') === '1' || params.get('rail') === '1'
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

/** Readiness gate for the notification deep link (`?thread=<id>`), by content kind (slice C1b). An
 *  HTML page has no way to know its threads are ready until the iframe's onLoad fires `loaded` —
 *  but the audio view renders no iframe, so `loaded` never fires and gating on it left `?thread=`
 *  silently dead on an audio page. Audio is ready as soon as its own thread has arrived; either
 *  kind still refuses to reveal a thread that hasn't. */
export function deepLinkReady({ isAudio, loaded, hasThread }: { isAudio: boolean; loaded: boolean; hasThread: boolean }): boolean {
  return hasThread && (isAudio || loaded)
}

/** A reveal request for ReviewRail's deep-link/badge-click focus: `id` is WHICH thread, `nonce` a
 *  caller-bumped counter. The rail used to guard on id alone (`revealedRef.current === id`), so
 *  asking to reveal the SAME thread a second time was silently a no-op — invisible while only a
 *  one-shot page-load deep link could fire it, but wrong the moment a badge click can request the
 *  same thread repeatedly. Gating on the NONCE instead means "reveal again" is "bump the nonce",
 *  even for an unchanged id — while an unchanged nonce across an unrelated re-render is still a
 *  no-op, preserving the property the old ref was protecting. */
export type RevealRequest = { id: string; nonce: number }

export function shouldReveal(request: RevealRequest | null, lastHandledNonce: number | null, hasTarget: boolean): boolean {
  if (!request || !hasTarget) return false
  return request.nonce !== lastHandledNonce
}
