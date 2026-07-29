import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_CONTEXT, parseIntent } from './parseIntent'

// parseIntent is a pure filter (writable today, no DOM needed): construct plain event-shaped
// objects. It is NOT a trust guard — these only prove obviously-bogus messages are dropped.

const CONTENT = 'https://glance-content.example.com'
const iframeWin = {} as Window // sentinel identity for the iframe's contentWindow
const otherWin = {} as Window

const ev = (over: { origin?: string; source?: unknown; data?: unknown }): MessageEvent =>
  ({ origin: over.origin ?? CONTENT, source: over.source ?? iframeWin, data: over.data }) as unknown as MessageEvent

const expected = { origin: CONTENT, source: iframeWin }
const validSelect = { type: 'glance:select', quote: 'the quick brown fox' }

describe('parseIntent', () => {
  test('text context cap tracks the API storage contract', () => {
    // packages/web has no dependency/tsconfig path onto packages/api (and must not gain one — that
    // would drag worker-side code into the browser bundle), so the only way to pin this against
    // drift is to read the api's source at test time and compare the live values.
    const anchorPath = join(import.meta.dir, '../../../api/src/lib/anchor.ts')
    const anchorSrc = readFileSync(anchorPath, 'utf8')
    const match = anchorSrc.match(/TEXT_CONTEXT_LIMIT\s*=\s*(\d+)/)
    if (!match) throw new Error(`could not find TEXT_CONTEXT_LIMIT in ${anchorPath}`)
    const apiLimit = Number(match[1])
    expect(MAX_CONTEXT, `MAX_CONTEXT (parseIntent.ts) = ${MAX_CONTEXT} must equal TEXT_CONTEXT_LIMIT (${anchorPath}) = ${apiLimit}`).toBe(apiLimit)
  })

  test('parseintent-rejects-wrong-origin', () => {
    expect(parseIntent(ev({ origin: 'https://evil.com', data: validSelect }), expected)).toBeNull()
  })

  test('parseintent-rejects-wrong-source', () => {
    expect(parseIntent(ev({ source: otherWin, data: validSelect }), expected)).toBeNull()
  })

  test('parseintent-rejects-bad-shape', () => {
    expect(parseIntent(ev({ data: { type: 'glance:unknown' } }), expected)).toBeNull()
    expect(parseIntent(ev({ data: 'not-an-object' }), expected)).toBeNull()
    expect(parseIntent(ev({ data: { type: 'glance:select' } }), expected)).toBeNull() // missing quote
    expect(parseIntent(ev({ data: { type: 'glance:select', quote: '' } }), expected)).toBeNull() // empty quote
  })

  test('parseintent-truncates-long-select-quote', () => {
    // A selection longer than the 2000-char cap must TRUNCATE (preserving the anchor + opening the
    // composer), not be dropped — regression for #30.
    const res = parseIntent(ev({ data: { type: 'glance:select', quote: 'y'.repeat(9000) } }), expected)
    expect(res).toEqual({ type: 'select', quote: 'y'.repeat(2000) })
  })

  test('parseintent-accepts-valid-select', () => {
    expect(parseIntent(ev({ data: validSelect }), expected)).toEqual({
      type: 'select',
      quote: 'the quick brown fox',
    })
  })

  test('parses a select-clear intent', () => {
    expect(parseIntent(ev({ data: { type: 'glance:select-clear' } }), expected)).toEqual({ type: 'clear' })
  })

  test('parses the dismissal intents the parent cannot observe inside the iframe', () => {
    expect(parseIntent(ev({ data: { type: 'glance:click-away' } }), expected)).toEqual({ type: 'clickAway' })
    expect(parseIntent(ev({ data: { type: 'glance:escape' } }), expected)).toEqual({ type: 'escape' })
  })

  test('dismissal intents are rejected on a wrong origin or wrong source, like every other intent', () => {
    for (const type of ['glance:click-away', 'glance:escape']) {
      expect(parseIntent(ev({ origin: 'https://evil.com', data: { type } }), expected)).toBeNull()
      expect(parseIntent(ev({ source: otherWin, data: { type } }), expected)).toBeNull()
    }
  })

  test('parseintent-carries-occurrence-context', () => {
    const res = parseIntent(ev({ data: { ...validSelect, context: { prefix: 'lead in ', suffix: ' tail' } } }), expected)
    expect(res).toMatchObject({ type: 'select', context: { prefix: 'lead in ', suffix: ' tail' } })
  })

  test('parseintent-clamps-context-instead-of-dropping-the-selection', () => {
    // Over-cap context must not cost the comment — the side is truncated, the quote survives.
    const tail = 'quote-adjacent'
    const prefix = `${'p'.repeat(500 - tail.length)}${tail}`
    const res = parseIntent(ev({ data: { ...validSelect, context: { prefix, suffix: '' } } }), expected)
    expect(res).toMatchObject({ type: 'select', quote: 'the quick brown fox' })
    expect((res as { context?: { prefix: string } }).context?.prefix).toBe(prefix.slice(-MAX_CONTEXT))
  })

  test('parseintent-clamps-oversize-suffix-from-the-tail-keeping-the-quote-adjacent-head', () => {
    // Suffix carries signal at its START (nearest the quote), so an over-cap suffix must clamp from
    // the opposite end — mirror of the prefix tail-clamp above, pinning the suffix's OWN clamp side.
    const head = 'quote-adjacent'
    const suffix = `${head}${'s'.repeat(500 - head.length)}`
    const res = parseIntent(ev({ data: { ...validSelect, context: { prefix: '', suffix } } }), expected)
    expect(res).toMatchObject({ type: 'select', quote: 'the quick brown fox' })
    expect((res as { context?: { suffix: string } }).context?.suffix).toBe(suffix.slice(0, MAX_CONTEXT))
  })

  test('parseintent-omits-unusable-context', () => {
    // Absent, empty, and malformed all collapse to ONE shape (undefined) so callers never branch.
    for (const context of [undefined, {}, { prefix: '', suffix: '' }, { prefix: 7 }, 'nope', null]) {
      const res = parseIntent(ev({ data: { ...validSelect, context } }), expected)
      expect(res).toEqual({ type: 'select', quote: 'the quick brown fox' })
    }
  })

  const validPinpoint = { type: 'glance:pinpoint', selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' }

  test('parses a pinpoint intent (selector required, fields carried)', () => {
    expect(parseIntent(ev({ data: validPinpoint }), expected)).toEqual({
      type: 'pinpoint',
      anchor: { selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' },
    })
  })

  test('pinpoint carries an optional rect and defaults missing fields to empty', () => {
    expect(parseIntent(ev({ data: { type: 'glance:pinpoint', selector: '#x', rect: { top: 1, left: 2, width: 3, height: 4 } } }), expected)).toEqual({
      type: 'pinpoint',
      anchor: { selector: '#x', tag: '', preview: '', textFallback: '' },
      rect: { top: 1, left: 2, width: 3, height: 4 },
    })
  })

  test('pinpoint without a selector, or over-cap selector → null', () => {
    expect(parseIntent(ev({ data: { type: 'glance:pinpoint', tag: 'svg' } }), expected)).toBeNull()
    expect(parseIntent(ev({ data: { type: 'glance:pinpoint', selector: 'x'.repeat(9000) } }), expected)).toBeNull()
  })

  const validRect = { top: 1, left: 2, width: 3, height: 4 }
  const anchorRectsBatch = (over: Record<string, unknown> = {}) => ({
    type: 'glance:anchor-rects',
    epoch: 3,
    rects: [
      { id: 'a', rect: validRect },
      { id: 'b', rect: { top: 5, left: 6, width: 7, height: 8 } },
    ],
    ...over,
  })

  test('parses a well-formed anchor-rects batch', () => {
    expect(parseIntent(ev({ data: anchorRectsBatch() }), expected)).toEqual({
      type: 'anchorRects',
      epoch: 3,
      rects: [
        { id: 'a', rect: validRect },
        { id: 'b', rect: { top: 5, left: 6, width: 7, height: 8 } },
      ],
    })
  })

  test('anchor-rects rejects a non-finite epoch instead of coercing it to 0 (the lowest epoch)', () => {
    // num() would turn each of these into 0, the lowest possible epoch — every later, legitimate
    // batch would then look stale forever and the badges would freeze in place.
    expect(parseIntent(ev({ data: anchorRectsBatch({ epoch: undefined }) }), expected)).toBeNull()
    expect(parseIntent(ev({ data: anchorRectsBatch({ epoch: NaN }) }), expected)).toBeNull()
    expect(parseIntent(ev({ data: anchorRectsBatch({ epoch: '3' }) }), expected)).toBeNull()
  })

  test('epoch 0 is a real epoch, not a missing one', () => {
    expect(parseIntent(ev({ data: anchorRectsBatch({ epoch: 0 }) }), expected)).toMatchObject({ epoch: 0 })
  })

  test('anchor-rects with an empty rects array still parses — that message clears the last badge', () => {
    expect(parseIntent(ev({ data: anchorRectsBatch({ rects: [] }) }), expected)).toEqual({
      type: 'anchorRects',
      epoch: 3,
      rects: [],
    })
  })

  test('anchor-rects rejects when rects is not an array', () => {
    expect(parseIntent(ev({ data: anchorRectsBatch({ rects: undefined }) }), expected)).toBeNull()
    expect(parseIntent(ev({ data: anchorRectsBatch({ rects: {} }) }), expected)).toBeNull()
    expect(parseIntent(ev({ data: anchorRectsBatch({ rects: 'nope' }) }), expected)).toBeNull()
  })

  test('an entry with a non-finite edge is dropped, not coerced to 0 — surviving sibling still comes through', () => {
    const res = parseIntent(
      ev({ data: anchorRectsBatch({ rects: [{ id: 'bad', rect: { top: NaN, left: 0, width: 1, height: 1 } }, { id: 'good', rect: validRect }] }) }),
      expected,
    )
    expect(res).toMatchObject({ type: 'anchorRects', rects: [{ id: 'good', rect: validRect }] })
    expect((res as { rects: { id: string; rect: DOMRectLike }[] }).rects).toHaveLength(1)
    expect((res as { rects: { rect: DOMRectLike }[] }).rects.some((r) => r.rect.top === 0)).toBe(false)
  })

  test('an entry with an infinite edge is dropped', () => {
    const res = parseIntent(
      ev({ data: anchorRectsBatch({ rects: [{ id: 'bad', rect: { top: 0, left: 0, width: Infinity, height: 1 } }] }) }),
      expected,
    )
    expect(res).toMatchObject({ type: 'anchorRects', rects: [] })
  })

  test('a collapsed (zero-area) rect is dropped', () => {
    const res = parseIntent(
      ev({ data: anchorRectsBatch({ rects: [{ id: 'collapsed', rect: { top: 0, left: 0, width: 0, height: 0 } }] }) }),
      expected,
    )
    expect(res).toMatchObject({ type: 'anchorRects', rects: [] })
  })

  test('an entry with a missing, non-string, or empty id is dropped', () => {
    for (const id of [undefined, 7, '']) {
      const res = parseIntent(ev({ data: anchorRectsBatch({ rects: [{ id, rect: validRect }] }) }), expected)
      expect(res).toMatchObject({ type: 'anchorRects', rects: [] })
    }
  })

  test('a null entry in rects is dropped, not thrown on — surviving sibling still comes through', () => {
    // A hostile or buggy iframe can post `rects: [null]`. The `typeof entry !== 'object'` guard
    // exists precisely for this: `typeof null === 'object'` in JS, so without the `!entry` half
    // of the check, `entry as Record<string, unknown>` would let `e.id`/`e.rect` explode with
    // "Cannot read properties of null" instead of quietly dropping the garbage entry.
    const res = parseIntent(ev({ data: anchorRectsBatch({ rects: [null, { id: 'good', rect: validRect }] }) }), expected)
    expect(res).toMatchObject({ type: 'anchorRects', rects: [{ id: 'good', rect: validRect }] })
    expect((res as { rects: { id: string; rect: DOMRectLike }[] }).rects).toHaveLength(1)
  })

  test('primitive entries (string, number) in rects are dropped, not thrown on', () => {
    const res = parseIntent(ev({ data: anchorRectsBatch({ rects: ['nope', 7] }) }), expected)
    expect(res).toMatchObject({ type: 'anchorRects', rects: [] })
  })

  test('a rects array of only garbage entries parses to an empty batch, not null', () => {
    // Same reasoning as the empty-array case above: an all-garbage batch must still clear the
    // last badge, not be treated as a malformed message.
    const res = parseIntent(ev({ data: anchorRectsBatch({ rects: [null, 'nope', 7] }) }), expected)
    expect(res).toEqual({ type: 'anchorRects', epoch: 3, rects: [] })
  })

  test('a negative-width entry is accepted verbatim today — deliberate, and harmless', () => {
    // strictRect only gates on `width > 0 || height > 0`, so a negative width alongside a
    // positive height sails through unchanged. This is only reachable from a forged message: a
    // real getBoundingClientRect never returns a negative dimension, and reflow.ts applies the
    // same measurableRect rule before posting. It's harmless too — CSS ignores a negative width,
    // and buildBadges places a badge from left + width, so the value never distorts anything on
    // screen. Pinned here so a future change to strictRect's sign handling is a deliberate choice,
    // not an accidental behaviour change.
    const forged = { top: 0, left: 0, width: -9999, height: 4 }
    const res = parseIntent(ev({ data: anchorRectsBatch({ rects: [{ id: 'forged', rect: forged }] }) }), expected)
    expect(res).toMatchObject({ type: 'anchorRects', rects: [{ id: 'forged', rect: forged }] })
  })

  test('anchor-rects is rejected on a wrong origin, like every other intent', () => {
    expect(parseIntent(ev({ origin: 'https://evil.com', data: anchorRectsBatch() }), expected)).toBeNull()
  })

  test('accepts a ready handshake; missing source check is skippable', () => {
    expect(parseIntent(ev({ data: { type: 'glance:ready', filePath: 'index.html' } }), expected)).toEqual({
      type: 'ready',
      filePath: 'index.html',
    })
    // When the caller cannot yet pin contentWindow, source filtering is skipped (origin still enforced).
    expect(parseIntent(ev({ source: otherWin, data: validSelect }), { origin: CONTENT, source: null })).not.toBeNull()
  })
})
