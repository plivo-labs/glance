import { describe, expect, test } from 'bun:test'
import { pendingToInput } from './comments'

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
})
