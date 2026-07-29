// Text normalization for stored comment quotes. No DOM, no network, no resolution — the browser
// annotate client re-finds the quote in the RENDERED DOM to paint it (the correct coordinate
// space). We store the normalized quote plus a bounded slice of its surrounding text (see "Text-
// quote context" below) that tells repeated occurrences apart; all anchoring itself stays in the
// client. The quote is normalized so formatting-only edits (whitespace runs, NBSP, ligatures,
// accents) don't change what we store.

/** Read an untrusted JSON field as a string, defaulting a non-string (or absent) one to ''. Shared
 *  by every parse/read shim below so "missing" and "wrong type" always degrade the same way. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Collapse whitespace runs WITHOUT trimming. Kept separate from Unicode folding because the
 *  annotate index is already NFKC-folded before it applies the same edge-preserving policy. */
export const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ')

/** NFKC fold (ligatures/NBSP/full-width → canonical form, composes accents) + collapse whitespace
 *  runs to a single space + trim. The one normalizer for a stored quote. */
export function normalizeText(s: string): string {
  return normalizeEdges(s).trim()
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
  if (!str(a.selector).trim()) return { error: 'element anchor requires a selector' }
  for (const [field, cap] of Object.entries(ELEMENT_ANCHOR_LIMITS))
    if (str(a[field]).length > cap) return { error: 'element anchor field too long' }
  return { anchor: buildElementAnchor({ selector: str(a.selector), tag: str(a.tag), preview: str(a.preview), textFallback: str(a.textFallback) }) }
}

// --- Text-quote context -----------------------------------------------------------------------
// A quote can't identify itself when the same words appear more than once — the painter's
// `findRange` takes the first occurrence, so a comment on the second identical sentence would
// paint on the first. Alongside the quote we store a bounded slice of the text on either side,
// captured at selection time, and the painter re-finds the occurrence that best reproduces it.
//
// This shares the `anchor` JSON column with element anchors (`anchorType` remains the discriminant)
// and carries an explicit `v`. The column previously held a DIFFERENT `{quote,prefix,suffix}` model
// on rows that are still in the database; the version gate is what stops that stale, differently-
// normalized context from silently re-anchoring an old thread.

export type TextContext = { prefix: string; suffix: string }
export type StoredTextContext = TextContext & { v: typeof TEXT_CONTEXT_VERSION }

export const TEXT_CONTEXT_VERSION = 2
/** Chars captured, stored, and matched per side of a text quote. */
export const TEXT_CONTEXT_LIMIT = 64

/** Parse an UNTRUSTED context payload. Unlike an element anchor (whose selector is REQUIRED, so a
 *  malformed one is a 400), context is a positioning hint: anything unusable degrades to null and
 *  the thread simply anchors the way it did before context existed. Over-cap input is truncated,
 *  not rejected, for the same reason. */
export function parseTextContext(raw: unknown): StoredTextContext | null {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const prefix = normalizeEdges(str(c.prefix)).slice(-TEXT_CONTEXT_LIMIT)
  const suffix = normalizeEdges(str(c.suffix)).slice(0, TEXT_CONTEXT_LIMIT)
  if (!prefix.trim() && !suffix.trim()) return null
  return { v: TEXT_CONTEXT_VERSION, prefix, suffix }
}

/** Like `normalizeText` but WITHOUT the trim: the space separating the quote from its neighbours is
 *  part of what distinguishes one occurrence from another, so the edges must survive. */
export function normalizeEdges(s: string): string {
  return collapseWhitespace(s.normalize('NFKC'))
}

/** Read shim: surface a stored text context ONLY for versioned text rows. Every other shape —
 *  legacy `{quote,prefix,suffix}`, an element anchor sharing the column, a null — reads as "no
 *  context", which is a complete answer: the painter falls back to first-occurrence matching. */
export function readTextContext(anchorType: string, anchor: unknown): TextContext | null {
  if (anchorType !== 'text' || anchor == null || typeof anchor !== 'object') return null
  const a = anchor as Record<string, unknown>
  if (a.v !== TEXT_CONTEXT_VERSION) return null
  return { prefix: str(a.prefix), suffix: str(a.suffix) }
}

/** Read shim: surface a stored element anchor ONLY for element rows. Legacy text/page rows may
 *  carry stale `{quote,prefix,suffix}` JSON in the deprecated `anchor` column — gating on
 *  `anchorType` keeps that from ever leaking as an element anchor. Returns null when the row isn't
 *  an element anchor or the JSON lacks a usable selector. */
export function readElementAnchor(anchorType: string, anchor: unknown): ElementAnchor | null {
  if (anchorType !== 'element' || anchor == null || typeof anchor !== 'object') return null
  const a = anchor as Record<string, unknown>
  if (typeof a.selector !== 'string' || !a.selector) return null
  return { selector: a.selector, tag: str(a.tag), preview: str(a.preview), textFallback: str(a.textFallback) }
}
