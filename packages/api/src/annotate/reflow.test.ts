import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { currentEpoch, findRange } from './locator'
import { anchorIdAtPoint, anchorRanges, installIndexInvalidation } from './reflow'

// reflow.ts is global-free, so we drive it under a constructed happy-dom window and inject the
// document / window — no GlobalRegistrator, so nothing leaks into the other (server-side) api
// tests. `epoch` and the shared index are module state that outlives a test; every test here builds
// a FRESH document, and the cache keys on document identity, so it always rebuilds.
//
// happy-dom models no layout: Range.getClientRects and Element.getBoundingClientRect are zero stubs.
// Where a test needs geometry it stubs the rect deliberately (and says which rect).

function windowWith(html: string) {
  const win = new Window()
  // safe-html: static test fixture HTML (windowWith() callers all pass literals)
  win.document.body.innerHTML = html
  return win as unknown as Window & { document: Document; Range: typeof Range; Element: typeof Element }
}

type Box = { top: number; left: number; width: number; height: number }

/** Give every Range in `win` a fabricated client-rect list, keyed on the text it covers. A Range
 *  spanning a line break really does measure as several rects, which is why the hit test reads
 *  getClientRects rather than the bounding box — so the stub returns a LIST. */
function stubRangeRects(win: { Range: typeof Range }, boxes: (text: string) => Box[]) {
  win.Range.prototype.getClientRects = function (this: Range) {
    return boxes(this.toString()) as unknown as DOMRectList
  }
}

/** Give every Element in `win` a fabricated box, keyed on the element's own id (a selector isn't
 *  recoverable from the resolved Element itself). */
function stubElementRects(win: { Element: typeof Element }, box: (id: string) => Box) {
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    return box(this.id) as DOMRect
  }
}

/** Let the MutationObserver's microtask deliver. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('anchorRanges — a paint IS the highlight: every anchor that resolves is lit', () => {
  test('every painted anchor yields a Range, in the order the anchors were given', () => {
    const win = windowWith('<p>alpha sentence.</p><p>beta sentence.</p>')
    const ranges = anchorRanges(
      [
        { id: 't2', quote: 'beta sentence.' },
        { id: 't1', quote: 'alpha sentence.' },
      ],
      win.document,
    )
    expect(ranges.map((r) => r.toString())).toEqual(['beta sentence.', 'alpha sentence.'])
  })

  test('an empty anchor list lights nothing — that IS how closing the rail clears the page', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    expect(anchorRanges([], win.document)).toEqual([])
  })

  test('an anchor whose quote no longer resolves is skipped, not thrown on', () => {
    // A highlight over text that isn't there anymore is worse than no highlight: the page changed
    // under the stored quote, so the honest result is to light only what still exists.
    const win = windowWith('<p>alpha sentence.</p>')
    const ranges = anchorRanges(
      [
        { id: 't1', quote: 'vanished sentence.' },
        { id: 't2', quote: 'alpha sentence.' },
      ],
      win.document,
    )
    expect(ranges.map((r) => r.toString())).toEqual(['alpha sentence.'])
  })

  test('an anchor with no quote at all (a page comment) contributes nothing', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    expect(anchorRanges([{ id: 't1' }], win.document)).toEqual([])
  })
})

describe('anchorIdAtPoint — which anchor a click landed on (the page→rail route)', () => {
  const QUOTE_BOX: Box = { top: 100, left: 50, width: 200, height: 20 }

  function textDoc() {
    const win = windowWith('<p>alpha sentence.</p><p>beta sentence.</p>')
    stubRangeRects(win, (t) => (t === 'alpha sentence.' ? [QUOTE_BOX] : [{ top: 300, left: 50, width: 200, height: 20 }]))
    return win
  }

  const ANCHORS = [
    { id: 't1', quote: 'alpha sentence.' },
    { id: 't2', quote: 'beta sentence.' },
  ]

  test('a point inside an anchor\'s rect returns that anchor\'s id', () => {
    const win = textDoc()
    expect(anchorIdAtPoint(ANCHORS, [], { x: 60, y: 110 }, win.document)).toBe('t1')
    expect(anchorIdAtPoint(ANCHORS, [], { x: 60, y: 310 }, win.document)).toBe('t2')
  })

  test('a point on the rect\'s edge counts as inside — a click on the first pixel of a highlight is a click on it', () => {
    const win = textDoc()
    expect(anchorIdAtPoint(ANCHORS, [], { x: 50, y: 100 }, win.document)).toBe('t1')
    expect(anchorIdAtPoint(ANCHORS, [], { x: 250, y: 120 }, win.document)).toBe('t1')
  })

  test('a point outside every anchor returns null — that click is the page\'s own, untouched', () => {
    const win = textDoc()
    expect(anchorIdAtPoint(ANCHORS, [], { x: 10, y: 10 }, win.document)).toBeNull()
    expect(anchorIdAtPoint(ANCHORS, [], { x: 60, y: 121 }, win.document)).toBeNull()
  })

  test('nothing painted means nothing can be hit — the closed-rail case', () => {
    const win = textDoc()
    expect(anchorIdAtPoint([], [], { x: 60, y: 110 }, win.document)).toBeNull()
  })

  test('a multi-rect Range (a quote wrapping across lines) is hit on EITHER of its rects', () => {
    // The bug a bounding-box hit test hides: the box between two wrapped lines spans the whole
    // indented gutter, so a click far to the left of the second line's text would "hit" the quote.
    const win = windowWith('<p>alpha sentence.</p>')
    stubRangeRects(win, () => [
      { top: 100, left: 200, width: 100, height: 20 }, // tail of line one
      { top: 120, left: 0, width: 80, height: 20 }, // head of line two
    ])
    const anchors = [{ id: 't1', quote: 'alpha sentence.' }]
    expect(anchorIdAtPoint(anchors, [], { x: 250, y: 110 }, win.document)).toBe('t1')
    expect(anchorIdAtPoint(anchors, [], { x: 40, y: 130 }, win.document)).toBe('t1')
    // Inside the union box, inside NEITHER rect — the gutter under line one's indent.
    expect(anchorIdAtPoint(anchors, [], { x: 150, y: 130 }, win.document)).toBeNull()
  })

  test('an element anchor is hit on its resolved box', () => {
    const win = windowWith('<div id="chart">chart</div>')
    stubElementRects(win, () => ({ top: 0, left: 0, width: 400, height: 300 }))
    expect(anchorIdAtPoint([], [{ id: 'e1', selector: '#chart' }], { x: 200, y: 150 }, win.document)).toBe('e1')
    expect(anchorIdAtPoint([], [{ id: 'e1', selector: '#chart' }], { x: 500, y: 150 }, win.document)).toBeNull()
  })

  test('an element anchor whose selector no longer resolves is skipped, not thrown on', () => {
    const win = windowWith('<div id="chart">chart</div>')
    stubElementRects(win, () => ({ top: 0, left: 0, width: 400, height: 300 }))
    const anchors = [
      { id: 'gone', selector: '#deleted' },
      { id: 'e1', selector: '#chart' },
    ]
    expect(anchorIdAtPoint([], anchors, { x: 200, y: 150 }, win.document)).toBe('e1')
  })

  test('TEXT wins over an element anchor containing it — the more specific of two overlapping hits', () => {
    // A quote inside an element-anchored container: both boxes contain the point, and the one the
    // user can actually see a highlight on is the text.
    const win = windowWith('<div id="chart"><p>alpha sentence.</p></div>')
    stubRangeRects(win, () => [QUOTE_BOX])
    stubElementRects(win, () => ({ top: 0, left: 0, width: 400, height: 300 }))
    const hit = anchorIdAtPoint([{ id: 't1', quote: 'alpha sentence.' }], [{ id: 'e1', selector: '#chart' }], { x: 60, y: 110 }, win.document)
    expect(hit).toBe('t1')
  })
})

describe('installIndexInvalidation — which events end a DOM version', () => {
  test('a text node rewritten IN PLACE bumps the version and the rebuild sees the new text', async () => {
    // `node.data = …` — a React/Vue text update, a counter, a clock. It changes what the document
    // says without touching its structure, so childList alone would never notice.
    const win = windowWith('<p>original sentence.</p>')
    const dispose = installIndexInvalidation({ doc: win.document, win, onInvalidate: () => {} })
    expect(findRange('original sentence.', win.document)).not.toBeNull() // builds the index
    const before = currentEpoch()

    const text = win.document.querySelector('p')!.firstChild as Text
    text.data = 'rewritten sentence.'
    await settle()

    expect(currentEpoch()).toBe(before + 1)
    expect(findRange('rewritten sentence.', win.document)!.toString()).toBe('rewritten sentence.')
    dispose()
  })

  test('an inserted node bumps the version, and the reflow is scheduled after the bump', async () => {
    const win = windowWith('<p>first sentence.</p>')
    // The order matters: a reflow that runs BEFORE the bump re-reads the stale index.
    const seen: number[] = []
    const dispose = installIndexInvalidation({ doc: win.document, win, onInvalidate: () => seen.push(currentEpoch()) })
    findRange('first sentence.', win.document)
    const before = currentEpoch()

    win.document.body.insertAdjacentHTML('beforeend', '<p>added later.</p>')
    await settle()

    expect(currentEpoch()).toBe(before + 1)
    expect(seen).toEqual([before + 1])
    expect(findRange('added later.', win.document)!.toString()).toBe('added later.')
    dispose()
  })

  test('a RESIZE bumps the version — whether text is rendered is a layout verdict', async () => {
    // The regression this guards: a media query reveals mobile-only markup on resize with no DOM
    // change at all. buildTextIndex rejects text whose parent has no client rects, and that verdict
    // is cached, so without a resize bump the revealed text stays un-findable until something else
    // happens to mutate the DOM.
    const win = windowWith('<p>desktop only sentence.</p>')
    const p = win.document.querySelector('p')! as HTMLElement & { getClientRects: () => unknown[] }
    const laidOut = p.getClientRects.bind(p)
    p.getClientRects = () => [] // hidden at this viewport
    const dispose = installIndexInvalidation({ doc: win.document, win, onInvalidate: () => {} })

    expect(findRange('desktop only sentence.', win.document)).toBeNull() // caches the "not rendered" verdict
    p.getClientRects = laidOut // the media query brought it back
    expect(findRange('desktop only sentence.', win.document)).toBeNull() // still the cached verdict

    win.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event('resize'))
    await settle()

    expect(findRange('desktop only sentence.', win.document)!.toString()).toBe('desktop only sentence.')
    dispose()
  })

  test('a SCROLL does not bump the version — the cache exists to survive scrolling', async () => {
    const win = windowWith('<p>first sentence.</p>')
    const dispose = installIndexInvalidation({ doc: win.document, win, onInvalidate: () => {} })
    const before = currentEpoch()
    win.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event('scroll'))
    await settle()
    expect(currentEpoch()).toBe(before)
    dispose()
  })

  test('dispose unwires both channels', async () => {
    const win = windowWith('<p>first sentence.</p>')
    const dispose = installIndexInvalidation({ doc: win.document, win, onInvalidate: () => {} })
    dispose()
    const before = currentEpoch()
    win.document.body.insertAdjacentHTML('beforeend', '<p>added later.</p>')
    win.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event('resize'))
    await settle()
    expect(currentEpoch()).toBe(before)
  })
})
