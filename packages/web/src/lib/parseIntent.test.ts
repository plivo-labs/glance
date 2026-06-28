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
const validSelect = { type: 'glance:select', quote: 'the quick brown fox', prefix: 'said ', suffix: ' jumped' }

describe('parseIntent', () => {
  test('parseintent-rejects-wrong-origin', () => {
    expect(parseIntent(ev({ origin: 'https://evil.com', data: validSelect }), expected)).toBeNull()
  })

  test('parseintent-rejects-wrong-source', () => {
    expect(parseIntent(ev({ source: otherWin, data: validSelect }), expected)).toBeNull()
  })

  test('parseintent-rejects-bad-shape-or-oversize', () => {
    expect(parseIntent(ev({ data: { type: 'glance:unknown' } }), expected)).toBeNull()
    expect(parseIntent(ev({ data: 'not-an-object' }), expected)).toBeNull()
    expect(parseIntent(ev({ data: { type: 'glance:select' } }), expected)).toBeNull() // missing quote
    expect(parseIntent(ev({ data: { type: 'glance:select', quote: 'x'.repeat(9000) } }), expected)).toBeNull()
  })

  test('parseintent-accepts-valid-select', () => {
    expect(parseIntent(ev({ data: validSelect }), expected)).toEqual({
      type: 'select',
      quote: 'the quick brown fox',
      prefix: 'said ',
      suffix: ' jumped',
    })
  })

  test('parses a select-clear intent', () => {
    expect(parseIntent(ev({ data: { type: 'glance:select-clear' } }), expected)).toEqual({ type: 'clear' })
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
