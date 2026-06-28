import { describe, expect, test } from 'bun:test'
import { type Anchor, buildAnchor, normalizeText, resolveAnchor } from './anchor'

// Pure anchoring core (Step 1). No DOM, no network. These are the "writable-today" reds:
// they drive the re-anchor ladder (anchored / shifted / suggested / orphaned) into existence
// and pin the false-positive guard (never a confident wrong pick).

describe('normalizeText — folds whitespace + unicode', () => {
  test('collapses whitespace runs and trims', () => {
    expect(normalizeText('  a  \n\t b   ')).toBe('a b')
  })
  test('folds NFC/NFD so a composed accent matches a decomposed one', () => {
    expect(normalizeText('café')).toBe(normalizeText('café'))
  })
  test('folds non-breaking space to a normal space', () => {
    expect(normalizeText('a b')).toBe('a b')
  })
  test('folds compatibility chars (NFKC) — ligature ﬁ → fi', () => {
    expect(normalizeText('ﬁle')).toBe('file')
  })
})

describe('resolveAnchor — the re-anchor ladder', () => {
  test('resolve-exact-unique-anchored: single occurrence → anchored + correct offsets', () => {
    const doc = 'The quick brown fox jumps.'
    const anchor = buildAnchor({ quote: 'brown fox' })
    const res = resolveAnchor(anchor, doc)
    expect(res.status).toBe('anchored')
    expect(normalizeText(doc).slice(res.start as number, res.end as number)).toBe('brown fox')
  })

  test('resolve-repeated-quote-disambiguated: prefix/suffix select the right instance', () => {
    const doc = 'cats and dogs. cats and birds.'
    // Quote 'cats' occurs twice (offset 0 and 15). Context must select the second one.
    const second = buildAnchor({ quote: 'cats', prefix: 'dogs. ', suffix: ' and birds.' })
    const r2 = resolveAnchor(second, doc)
    expect(r2.start).toBe(15)
    expect(r2.status).toBe('anchored')
    // ...and the first one when context points there.
    const first = buildAnchor({ quote: 'cats', suffix: ' and dogs' })
    expect(resolveAnchor(first, doc).start).toBe(0)
  })

  test('resolve-moved-shifted: exact text relocated → shifted + new offsets', () => {
    const oldDoc = 'intro. target phrase. outro.'
    const anchor = buildAnchor({ quote: 'target phrase', prefix: 'intro. ', suffix: '. outro.' })
    const prior = resolveAnchor(anchor, oldDoc)
    expect(prior.status).toBe('anchored')

    const newDoc = 'a much longer intro here. target phrase. outro.'
    const res = resolveAnchor(anchor, newDoc, { start: prior.start as number, end: prior.end as number })
    expect(res.status).toBe('shifted')
    expect(res.start).not.toBe(prior.start)
    expect(normalizeText(newDoc).slice(res.start as number, res.end as number)).toBe('target phrase')
  })

  test('resolve-gone-orphaned: quoted text removed → orphaned, no offsets', () => {
    const anchor = buildAnchor({ quote: 'target phrase', prefix: 'intro. ', suffix: '. outro.' })
    const res = resolveAnchor(anchor, 'completely unrelated content with nothing alike')
    expect(res.status).toBe('orphaned')
    expect(res.start).toBeNull()
    expect(res.end).toBeNull()
  })

  test('resolve-fuzzy-suggested: small edit (above threshold) → suggested', () => {
    const anchor = buildAnchor({ quote: 'the quick brown fox' })
    // 'fox' → 'fix': no exact match, but well above the fuzzy threshold.
    const res = resolveAnchor(anchor, 'before. the quick brown fix jumps. after')
    expect(res.status).toBe('suggested')
    expect(res.start).not.toBeNull()
    expect(normalizeText('before. the quick brown fix jumps. after').slice(res.start as number, res.end as number)).toContain('quick brown')
  })

  test('resolve-ambiguous-not-silently-wrong: repeated quote, no usable context → suggested, never a confident pick', () => {
    const doc = 'foo bar foo bar foo bar'
    const anchor: Anchor = buildAnchor({ quote: 'foo' }) // no prefix/suffix to disambiguate
    const res = resolveAnchor(anchor, doc)
    expect(res.status).toBe('suggested')
    expect(res.status).not.toBe('anchored')
    expect(res.status).not.toBe('shifted')
  })
})
