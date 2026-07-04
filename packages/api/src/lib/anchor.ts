// Anchor storage helpers — no DOM, no network, no resolution. An anchor is just the selected
// quote plus a bounded slice of its surrounding context, all normalized so formatting-only
// edits don't change what we store.
//
// Anchors are NOT resolved server-side. Painting is done in the browser by the annotate client,
// which re-finds the quote in the RENDERED DOM (the correct coordinate space — tags stripped,
// entities decoded). The old server-side reconciler resolved against the raw HTML *source*,
// which never matched a rendered multi-element selection (tags/entities between fragments) and
// so wrongly reported freshly-created comments as `orphaned`. It's gone; the client owns paint.

/** A stored anchor: the selected text plus a bounded slice of its surrounding context. */
export interface Anchor {
  quote: string // normalized exact selection text
  prefix: string // normalized context immediately before the quote (≤ CONTEXT_LEN)
  suffix: string // normalized context immediately after the quote (≤ CONTEXT_LEN)
}

const CONTEXT_LEN = 64

/** Whitespace + unicode fold WITHOUT trimming: NFKC folds compatibility forms (ligatures,
 *  NBSP, full-width) and composes accents; whitespace runs collapse to one space. Boundary
 *  whitespace is preserved so prefix/suffix stay aligned to the gap around the quote. */
function fold(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ')
}

/** Whitespace + unicode fold + trim ends — the normalizer for whole quotes. */
export function normalizeText(s: string): string {
  return fold(s).trim()
}

/** Build a stored anchor from a raw selection. The quote is trimmed (selections don't carry
 *  edge whitespace into the exact match); prefix/suffix keep their boundary space so they
 *  align to the document gap around the quote. Context is bounded so the anchor stays small. */
export function buildAnchor(input: { quote: string; prefix?: string; suffix?: string }): Anchor {
  return {
    quote: normalizeText(input.quote),
    prefix: fold(input.prefix ?? '').slice(-CONTEXT_LEN),
    suffix: fold(input.suffix ?? '').slice(0, CONTEXT_LEN),
  }
}
