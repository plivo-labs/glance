import { describe, expect, test } from 'bun:test'
import { parseIntent } from './parseIntent'

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

  test('accepts a ready handshake; missing source check is skippable', () => {
    expect(parseIntent(ev({ data: { type: 'glance:ready', filePath: 'index.html' } }), expected)).toEqual({
      type: 'ready',
      filePath: 'index.html',
    })
    // When the caller cannot yet pin contentWindow, source filtering is skipped (origin still enforced).
    expect(parseIntent(ev({ source: otherWin, data: validSelect }), { origin: CONTENT, source: null })).not.toBeNull()
  })
})
