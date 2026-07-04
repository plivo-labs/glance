import { describe, expect, test } from 'bun:test'
import { normalizeText } from './anchor'

// No resolution lives server-side anymore (the client paints against the rendered DOM), so the
// only anchor logic left is normalizing the stored quote.

describe('normalizeText — folds whitespace + unicode + trims', () => {
  test('collapses whitespace runs and trims', () => {
    expect(normalizeText('  a  \n\t b   ')).toBe('a b')
  })
  test('folds NFC/NFD so a composed accent matches a decomposed one', () => {
    expect(normalizeText('café')).toBe(normalizeText('café'))
  })
  test('folds non-breaking space to a normal space', () => {
    expect(normalizeText('a b')).toBe('a b')
  })
  test('folds compatibility chars (NFKC) — ligature ﬁ → fi', () => {
    expect(normalizeText('ﬁle')).toBe('file')
  })
})
