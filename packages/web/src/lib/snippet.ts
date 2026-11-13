// Splits a search snippet into runs so the palette can emphasize the words the user typed. Pure
// and string-only: the snippet is page text, so it is only ever rendered as React text nodes.
export function splitSnippet(snippet: string, query: string): { text: string; hit: boolean }[] {
  // Tokens are letters/digits/marks only (same shape the server searches with), so they are safe to
  // put in a RegExp without escaping.
  const tokens = [...new Set((query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).filter((t) => t.length >= 2))]
  if (tokens.length === 0) return [{ text: snippet, hit: false }]
  const pattern = new RegExp(`(${tokens.sort((a, b) => b.length - a.length).join('|')})`, 'giu')
  // split() with one capture group alternates non-match / match, so the parity is the hit flag.
  return snippet
    .split(pattern)
    .map((text, i) => ({ text, hit: i % 2 === 1 }))
    .filter((part) => part.text !== '')
}
