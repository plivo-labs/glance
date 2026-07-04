// Text normalization for stored comment quotes. No DOM, no network, no resolution — the browser
// annotate client re-finds the quote in the RENDERED DOM to paint it (the correct coordinate
// space). We store only the normalized quote; there is no prefix/suffix context and no server-side
// anchoring. The quote is normalized so formatting-only edits (whitespace runs, NBSP, ligatures,
// accents) don't change what we store.

/** NFKC fold (ligatures/NBSP/full-width → canonical form, composes accents) + collapse whitespace
 *  runs to a single space + trim. The one normalizer for a stored quote. */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

// --- Element ("pinpoint") anchors -------------------------------------------------------------
// A comment can also anchor to a whole element (a chart, table, image — anything the text-quote
// path can't reach). The hostile iframe SUGGESTS a CSS `selector` (never trusted beyond a
// `querySelector` at paint time) plus the `tag`, a short human `preview` label, and a `textFallback`
// used to describe / re-find the element when the selector no longer resolves. This payload is
// stored in the (otherwise-deprecated) `anchor` JSON column; the `anchorType` column ('element') is
// the SINGLE discriminant — no redundant in-JSON `kind`.

export type ElementAnchor = { selector: string; tag: string; preview: string; textFallback: string }

/** Length caps for the element-anchor fields. The route REJECTS over-cap input (untrusted API
 *  boundary); `buildElementAnchor` also truncates as defense-in-depth for any direct repo call. */
export const ELEMENT_ANCHOR_LIMITS = { selector: 1024, tag: 64, preview: 200, textFallback: 1000 } as const

/** Build the stored element anchor from client-suggested fields: trim + bound every field, lowercase
 *  the tag, collapse whitespace in the human-facing preview/fallback. The selector is REQUIRED —
 *  a blank one throws (an element anchor with no selector is meaningless). */
export function buildElementAnchor(input: { selector: string; tag?: string; preview?: string; textFallback?: string }): ElementAnchor {
  const selector = (input.selector ?? '').trim().slice(0, ELEMENT_ANCHOR_LIMITS.selector)
  if (!selector) throw new Error('element anchor requires a non-empty selector')
  return {
    selector,
    tag: (input.tag ?? '').trim().toLowerCase().slice(0, ELEMENT_ANCHOR_LIMITS.tag),
    preview: normalizeText(input.preview ?? '').slice(0, ELEMENT_ANCHOR_LIMITS.preview),
    textFallback: normalizeText(input.textFallback ?? '').slice(0, ELEMENT_ANCHOR_LIMITS.textFallback),
  }
}

/** Parse + validate an UNTRUSTED element-anchor payload from the API boundary and build the stored
 *  anchor, or return an error to reject with. The annotate client bounds these, but a direct API
 *  call bypasses that, so a missing selector or any over-cap field is rejected here (vs the
 *  defensive truncation `buildElementAnchor` does). Caps are read from ELEMENT_ANCHOR_LIMITS, so the
 *  field list lives in exactly one place. */
export function parseElementAnchor(raw: unknown): { anchor: ElementAnchor } | { error: string } {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (!str(a.selector).trim()) return { error: 'element anchor requires a selector' }
  for (const [field, cap] of Object.entries(ELEMENT_ANCHOR_LIMITS))
    if (str(a[field]).length > cap) return { error: 'element anchor field too long' }
  return { anchor: buildElementAnchor({ selector: str(a.selector), tag: str(a.tag), preview: str(a.preview), textFallback: str(a.textFallback) }) }
}

/** Read shim: surface a stored element anchor ONLY for element rows. Legacy text/page rows may
 *  carry stale `{quote,prefix,suffix}` JSON in the deprecated `anchor` column — gating on
 *  `anchorType` keeps that from ever leaking as an element anchor. Returns null when the row isn't
 *  an element anchor or the JSON lacks a usable selector. */
export function readElementAnchor(anchorType: string, anchor: unknown): ElementAnchor | null {
  if (anchorType !== 'element' || anchor == null || typeof anchor !== 'object') return null
  const a = anchor as Record<string, unknown>
  if (typeof a.selector !== 'string' || !a.selector) return null
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { selector: a.selector, tag: str(a.tag), preview: str(a.preview), textFallback: str(a.textFallback) }
}
