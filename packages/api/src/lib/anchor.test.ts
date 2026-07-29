import { describe, expect, test } from 'bun:test'
import {
  ELEMENT_ANCHOR_LIMITS,
  TEXT_CONTEXT_LIMIT,
  TEXT_CONTEXT_VERSION,
  buildElementAnchor,
  normalizeText,
  parseElementAnchor,
  parseTextContext,
  readElementAnchor,
  readTextContext,
} from './anchor'

// Text anchors normalize the stored quote (the client paints it against the rendered DOM). Element
// ("pinpoint") anchors store a client-suggested selector + preview in the JSON `anchor` column,
// gated by the `anchorType` column — the single discriminant.

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

describe('buildElementAnchor — bounded, selector-required', () => {
  test('cleans the fields: trims selector, lowercases tag, collapses preview/fallback whitespace', () => {
    expect(
      buildElementAnchor({ selector: ' #chart > svg ', tag: 'SVG', preview: '  Bar   chart ', textFallback: 'Revenue  by quarter' }),
    ).toEqual({ selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue by quarter' })
  })
  test('optional fields default to empty strings', () => {
    expect(buildElementAnchor({ selector: '#x' })).toEqual({ selector: '#x', tag: '', preview: '', textFallback: '' })
  })
  test('empty / blank selector throws (an element anchor with no selector is meaningless)', () => {
    expect(() => buildElementAnchor({ selector: '' })).toThrow()
    expect(() => buildElementAnchor({ selector: '   ' })).toThrow()
  })
  test('bounds every over-length field to its cap', () => {
    const a = buildElementAnchor({
      selector: 'a'.repeat(2000),
      tag: 'x'.repeat(200),
      preview: 'p'.repeat(500),
      textFallback: 't'.repeat(5000),
    })
    expect(a.selector.length).toBe(ELEMENT_ANCHOR_LIMITS.selector)
    expect(a.tag.length).toBe(ELEMENT_ANCHOR_LIMITS.tag)
    expect(a.preview.length).toBe(ELEMENT_ANCHOR_LIMITS.preview)
    expect(a.textFallback.length).toBe(ELEMENT_ANCHOR_LIMITS.textFallback)
  })
})

describe('parseElementAnchor — untrusted boundary: reject then build', () => {
  test('valid payload → built, bounded anchor', () => {
    expect(parseElementAnchor({ selector: ' #chart ', tag: 'DIV', preview: 'Bar  chart', textFallback: 'Revenue' })).toEqual({
      anchor: { selector: '#chart', tag: 'div', preview: 'Bar chart', textFallback: 'Revenue' },
    })
  })
  test('missing / blank selector → error (no coerce)', () => {
    expect(parseElementAnchor({ tag: 'div' })).toEqual({ error: 'element anchor requires a selector' })
    expect(parseElementAnchor({ selector: '   ' })).toEqual({ error: 'element anchor requires a selector' })
    expect(parseElementAnchor(null)).toEqual({ error: 'element anchor requires a selector' })
  })
  test('any over-cap field → error', () => {
    expect(parseElementAnchor({ selector: 'a'.repeat(ELEMENT_ANCHOR_LIMITS.selector + 1) })).toEqual({
      error: 'element anchor field too long',
    })
    expect(parseElementAnchor({ selector: '#x', preview: 'p'.repeat(ELEMENT_ANCHOR_LIMITS.preview + 1) })).toEqual({
      error: 'element anchor field too long',
    })
  })
})

describe('readElementAnchor — element rows only, legacy never leaks', () => {
  test('surfaces a stored element anchor round-trip', () => {
    const stored = { selector: '#x', tag: 'div', preview: 'A box', textFallback: 'hello' }
    expect(readElementAnchor('element', stored)).toEqual(stored)
  })
  test('legacy text/page rows never leak their deprecated {quote,prefix,suffix} JSON', () => {
    expect(readElementAnchor('text', { quote: 'q', prefix: 'p', suffix: 's' })).toBeNull()
    expect(readElementAnchor('page', null)).toBeNull()
  })
  test('element row without a usable selector → null', () => {
    expect(readElementAnchor('element', {})).toBeNull()
    expect(readElementAnchor('element', null)).toBeNull()
    expect(readElementAnchor('element', { selector: '' })).toBeNull()
  })
})

describe('parseTextContext — the untrusted side of a text anchor', () => {
  test('normalizes + versions a usable context', () => {
    expect(parseTextContext({ prefix: '  lead in  ', suffix: 'tail\ntext' })).toEqual({
      v: TEXT_CONTEXT_VERSION,
      prefix: ' lead in ', // NBSP folded, runs collapsed, edges KEPT (the space is load-bearing)
      suffix: 'tail text',
    })
  })

  test('caps each side toward the quote rather than rejecting (context is a hint, never authority)', () => {
    const prefix = `${'a'.repeat(490)}0123456789`
    const suffix = `0123456789${'b'.repeat(490)}`
    const ctx = parseTextContext({ prefix, suffix })!
    expect(ctx.prefix).toBe(prefix.slice(-TEXT_CONTEXT_LIMIT))
    expect(ctx.suffix).toBe(suffix.slice(0, TEXT_CONTEXT_LIMIT))
  })

  test('keeps the side that IS present when the other is empty', () => {
    expect(parseTextContext({ prefix: '', suffix: 'after' })).toEqual({ v: TEXT_CONTEXT_VERSION, prefix: '', suffix: 'after' })
  })

  test('no usable context → null (nothing to store, so the column stays empty)', () => {
    expect(parseTextContext(undefined)).toBeNull()
    expect(parseTextContext({})).toBeNull()
    expect(parseTextContext({ prefix: '   ', suffix: '' })).toBeNull()
    expect(parseTextContext({ prefix: 42, suffix: ['x'] })).toBeNull()
  })
})

describe('readTextContext — text rows only, legacy context never resurrected', () => {
  test('surfaces a versioned context on a text row', () => {
    const stored = { v: TEXT_CONTEXT_VERSION, prefix: 'before ', suffix: ' after' }
    expect(readTextContext('text', stored)).toEqual({ prefix: 'before ', suffix: ' after' })
  })

  // The `anchor` column held a DIFFERENT {quote,prefix,suffix} model years ago, normalized on
  // another axis. Resurrecting it would silently re-anchor old threads, so the version gate is
  // what makes reusing this column safe.
  test('legacy unversioned {quote,prefix,suffix} is ignored', () => {
    expect(readTextContext('text', { quote: 'q', prefix: 'p', suffix: 's' })).toBeNull()
  })

  test('never reads across anchor kinds', () => {
    const stored = { v: TEXT_CONTEXT_VERSION, prefix: 'a', suffix: 'b' }
    expect(readTextContext('element', stored)).toBeNull()
    expect(readTextContext('page', stored)).toBeNull()
    expect(readTextContext('text', null)).toBeNull()
  })

  // An element anchor and a text context share one column; each reader must ignore the other's shape.
  test('an element anchor is not readable as a text context, and vice versa', () => {
    expect(readTextContext('text', { selector: '#x', tag: 'div', preview: '', textFallback: '' })).toBeNull()
    expect(readElementAnchor('text', { v: TEXT_CONTEXT_VERSION, prefix: 'a', suffix: 'b' })).toBeNull()
  })
})
