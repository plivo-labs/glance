// The viewer's remaining outbound decisions (slice B-wire): plain functions over plain data, no
// React, no DOM, no globals — the component only calls these and executes the result. Extracted
// for the same reason lib/commentPopover.ts was: each used to be an inline decision in viewer.tsx
// that a typo or a hardcoded stand-in could silently break with the whole suite staying green.

/** Deep-link URL → rail-open decision (slice C1a). `review=1` is baked into ALREADY-SENT Slack
 *  messages and notification-bell links — it must open the rail forever, so it's a permanent
 *  alias here, not a migration — the param outlived the mode it was named after. Anything else
 *  (missing, `review=0`, `review=yes`, …) is not truthy-coerced — only the documented `1` counts,
 *  everything else means "don't open". */
export function railFromSearch(params: URLSearchParams): boolean {
  return params.get('review') === '1'
}

/** Readiness gate for the notification deep link (`?thread=<id>`), by content kind (slice C1b). An
 *  HTML page has no way to know its threads are ready until the iframe's onLoad fires `loaded` —
 *  but the audio view renders no iframe, so `loaded` never fires and gating on it left `?thread=`
 *  silently dead on an audio page. Audio is ready as soon as its own thread has arrived; either
 *  kind still refuses to reveal a thread that hasn't. */
export function deepLinkReady({ isAudio, loaded, hasThread }: { isAudio: boolean; loaded: boolean; hasThread: boolean }): boolean {
  return hasThread && (isAudio || loaded)
}

/** A reveal request for ReviewRail's deep-link / anchor-click focus: `id` is WHICH thread, `nonce` a
 *  caller-bumped counter. The rail used to guard on id alone (`revealedRef.current === id`), so
 *  asking to reveal the SAME thread a second time was silently a no-op — invisible while only a
 *  one-shot page-load deep link could fire it, but wrong the moment clicking a highlight can request
 *  the same thread repeatedly. Gating on the NONCE instead means "reveal again" is "bump the nonce",
 *  even for an unchanged id — while an unchanged nonce across an unrelated re-render is still a
 *  no-op, preserving the property the old ref was protecting. */
export type RevealRequest = { id: string; nonce: number }

export function shouldReveal(request: RevealRequest | null, lastHandledNonce: number | null, hasTarget: boolean): boolean {
  if (!request || !hasTarget) return false
  return request.nonce !== lastHandledNonce
}
