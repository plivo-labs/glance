import { describe, expect, test } from 'bun:test'
import { paintAnchors, pendingToInput, type Thread, withMentions } from './comments'

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

  test('a text pending carries its occurrence context when one was captured', () => {
    const context = { prefix: 'Beta section. ', suffix: ' tail' }
    expect(pendingToInput('index.html', 'this one', { kind: 'text', quote: 'Revenue is up.', context })).toEqual({
      filePath: 'index.html',
      body: 'this one',
      quote: 'Revenue is up.',
      context,
    })
  })

  test('a text pending with no context omits the key entirely (absent ≠ null)', () => {
    expect(pendingToInput('index.html', 'x', { kind: 'text', quote: 'q' })).not.toHaveProperty('context')
  })
})

// Slice C2a's verification found this exact mapping living inline in viewer.tsx's paint callback,
// with no test anywhere: a mutation that dropped element-anchor painting entirely (`return []`) left
// the whole suite green. Extracted here so "an existing element thread still paints" is provable
// without touching the iframe/postMessage plumbing at all.
function mkThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    id: overrides.id,
    filePath: 'index.html',
    anchorType: 'text',
    quote: 'q',
    anchor: null,
    context: null,
    status: 'open',
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    createdBy: null,
    createdByName: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comments: [],
    ...overrides,
  }
}

describe('paintAnchors — which threads the viewer paints into the iframe, and how', () => {
  test('an empty thread list paints nothing', () => {
    expect(paintAnchors([])).toEqual([])
  })

  test('a text thread maps to a text anchor, quote and context carried through', () => {
    const context = { prefix: 'lead ', suffix: ' tail' }
    const threads = [mkThread({ id: 't1', anchorType: 'text', quote: 'the quick brown fox', context })]
    expect(paintAnchors(threads)).toEqual([{ id: 't1', anchorType: 'text', quote: 'the quick brown fox', context }])
  })

  test('an element thread maps to an element anchor carrying its selector — the KEEP-list case', () => {
    const anchor = { selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' }
    const threads = [mkThread({ id: 't1', anchorType: 'element', quote: null, anchor })]
    expect(paintAnchors(threads)).toEqual([{ id: 't1', anchorType: 'element', selector: '#chart > svg' }])
  })

  test('a text thread with no quote, or an element thread with no anchor, is dropped rather than painted empty', () => {
    const threads = [mkThread({ id: 't1', anchorType: 'text', quote: null }), mkThread({ id: 't2', anchorType: 'element', anchor: null })]
    expect(paintAnchors(threads)).toEqual([])
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
