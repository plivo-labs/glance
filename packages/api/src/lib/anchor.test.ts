import { describe, expect, test } from 'bun:test'
import { buildAnchor, normalizeText } from './anchor'

// Anchor storage helpers. No resolution lives server-side anymore (the client paints against the
// rendered DOM), so these just pin the normalization used to store a quote + bounded context.

describe('normalizeText — folds whitespace + unicode', () => {
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

describe('buildAnchor — normalizes quote, keeps bounded boundary context', () => {
  test('trims the quote but preserves boundary space on prefix/suffix', () => {
    const a = buildAnchor({ quote: '  brown fox  ', prefix: 'quick ', suffix: ' jumps' })
    expect(a.quote).toBe('brown fox')
    expect(a.prefix).toBe('quick ')
    expect(a.suffix).toBe(' jumps')
  })
  test('bounds prefix/suffix to the last/first 64 chars', () => {
    const a = buildAnchor({ quote: 'q', prefix: 'p'.repeat(100), suffix: 's'.repeat(100) })
    expect(a.prefix).toHaveLength(64)
    expect(a.suffix).toHaveLength(64)
  })
  test('missing prefix/suffix default to empty', () => {
    const a = buildAnchor({ quote: 'q' })
    expect(a.prefix).toBe('')
    expect(a.suffix).toBe('')
  })
})
