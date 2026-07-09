import { describe, expect, test } from 'bun:test'
import { pendingToInput, withMentions } from './comments'

// Seam S2: the pending-anchor → create-payload map is pure, so the viewer's create path is
// verifiable without a browser (the postMessage/iframe layer can't be smoked locally).

describe('pendingToInput — pending anchor → NewThreadInput', () => {
  test('a text pending → a quote payload (no anchorType/element)', () => {
    expect(pendingToInput('index.html', 'looks off', { kind: 'text', quote: 'the quick brown fox' })).toEqual({
      filePath: 'index.html',
      body: 'looks off',
      quote: 'the quick brown fox',
    })
  })

  test('an element pending → an element payload', () => {
    const anchor = { selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' }
    expect(pendingToInput('index.html', 'wrong axis', { kind: 'element', anchor })).toEqual({
      filePath: 'index.html',
      body: 'wrong axis',
      anchorType: 'element',
      element: anchor,
    })
  })

  test('a page pending (audio view — no DOM to anchor to) → a bare page payload, no quote/element', () => {
    expect(pendingToInput('song.mp3', 'love this bridge', { kind: 'page' })).toEqual({
      filePath: 'song.mp3',
      body: 'love this bridge',
      anchorType: 'page',
    })
  })
})

describe('C19 — withMentions: payload carries mentions when ids present, omits when none', () => {
  test('non-empty ids → mentions key added, original fields preserved', () => {
    expect(withMentions({ filePath: 'i.html', body: 'hi' }, ['u1', 'u2'])).toEqual({
      filePath: 'i.html',
      body: 'hi',
      mentions: ['u1', 'u2'],
    })
  })

  test('empty ids → no mentions key', () => {
    expect(withMentions({ body: 'hi' }, [])).toEqual({ body: 'hi' })
  })

  test('absent ids → no mentions key', () => {
    expect(withMentions({ body: 'hi' })).toEqual({ body: 'hi' })
    expect('mentions' in withMentions({ body: 'hi' })).toBe(false)
  })
})
