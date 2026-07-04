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
