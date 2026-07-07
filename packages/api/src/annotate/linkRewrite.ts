// Pure URL-rewrite decision for the annotate client's link-propagation click handler. GLOBAL-FREE
// (only the standard URL constructor — no window/document), so it is unit-tested directly under
// bun:test with no DOM at all (see locator.ts for the same split-out-the-pure-part pattern).
//
// Bug this fixes: content.ts only injects this client when the request carries ?glance_annotate=1
// (content.ts:160). Relative links inside an uploaded page don't carry it, so every in-iframe
// navigation after the first page loads WITHOUT the client — no glance:ready postMessage, so (a)
// the sidebar's file-level recents never record real navigation, and (b) the viewer's `filePath`
// goes stale, misattributing comments made after navigating. Fix: rewrite the href of a same-origin
// in-frame link to carry the param just before the browser navigates (see client.ts's click listener).

/** Decide whether `href` (a raw anchor `href` attribute, possibly relative) should carry
 *  `glance_annotate=1`, and return the resolved absolute URL with the param set — or null to leave
 *  the link alone. Cross-origin links (and unparseable hrefs) come back null: rewriting them would
 *  leak the param into someone else's origin querystring for no purpose. `base` is the current
 *  document's base URL (respects a `<base href>` tag, falling back to the document URL). Idempotent:
 *  a link that already carries the param round-trips unchanged. */
export function withAnnotateParam(href: string, base: string): string | null {
  let baseUrl: URL
  let url: URL
  try {
    baseUrl = new URL(base)
    url = new URL(href, baseUrl)
  } catch {
    return null
  }
  if (url.origin !== baseUrl.origin) return null
  url.searchParams.set('glance_annotate', '1')
  return url.toString()
}
