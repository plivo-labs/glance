import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { currentEpoch, findRange, newEpoch } from './locator'
import {
  anchorRectBatch,
  createRectEmitter,
  elementRectBatch,
  highlightRanges,
  installIndexInvalidation,
  measurableRect,
  paintTextAnchors,
  type RectsMessage,
  textRectBatch,
} from './reflow'

// reflow.ts is global-free, so we drive it under a constructed happy-dom window and inject the
// document / window / emitter — no GlobalRegistrator, so nothing leaks into the other (server-side)
// api tests. `epoch` and the shared index are module state that outlives a test; every test here
// builds a FRESH document, and the cache keys on document identity, so it always rebuilds.
//
// happy-dom models no layout: Range.getBoundingClientRect is a zero stub. Where a test needs
// geometry it stubs the rect deliberately (and says which rect). Real coordinates are B4's job.

function windowWith(html: string) {
  const win = new Window()
  win.document.body.innerHTML = html
  return win as unknown as Window & { document: Document; Range: typeof Range; Element: typeof Element }
}

/** Give every Range in `win` the same fabricated box, or a per-quote one. */
function stubRangeRects(
  win: { Range: typeof Range },
  box: (text: string) => { top: number; left: number; width: number; height: number },
) {
  win.Range.prototype.getBoundingClientRect = function (this: Range) {
    return box(this.toString()) as DOMRect
  }
}

/** Give every Element in `win` the same fabricated box, or a per-selector one (keyed on the
 *  element's own id, since a selector isn't recoverable from the resolved Element itself). */
function stubElementRects(
  win: { Element: typeof Element },
  box: (id: string) => { top: number; left: number; width: number; height: number },
) {
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    return box(this.id) as DOMRect
  }
}

const BOX = { top: 40, left: 12, width: 220, height: 18 }

/** Let the MutationObserver's microtask deliver. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('measurableRect — geometry that carries no position is DROPPED, not coerced', () => {
  test('a real box passes through unchanged', () => {
    expect(measurableRect({ top: 40, left: 12, width: 220, height: 18 })).toEqual({
      top: 40,
      left: 12,
      width: 220,
      height: 18,
    })
  })

  test('a non-finite edge is null — the parent must never have to coerce one', () => {
    expect(measurableRect({ top: Number.NaN, left: 12, width: 220, height: 18 })).toBeNull()
    expect(measurableRect({ top: 40, left: 12, width: Number.POSITIVE_INFINITY, height: 18 })).toBeNull()
  })

  test('a zero-area box is null — that IS the badge parked at (0,0)', () => {
    // What a collapsed range measures, and what any range inside a display:none subtree measures.
    expect(measurableRect({ top: 0, left: 0, width: 0, height: 0 })).toBeNull()
    // Even mid-page: a position with no extent is not something a badge can point at.
    expect(measurableRect({ top: 640, left: 300, width: 0, height: 0 })).toBeNull()
    // A zero-WIDTH-only box is still a real line box (an empty line, a soft-wrapped edge) — kept.
    expect(measurableRect({ top: 640, left: 300, width: 0, height: 18 })).toEqual({
      top: 640,
      left: 300,
      width: 0,
      height: 18,
    })
  })
})

describe('textRectBatch — one rect per resolving anchor, tagged with the epoch measured under', () => {
  test('carries exactly the anchors that re-find, in order, with their measured rects', () => {
    const win = windowWith('<p>alpha sentence.</p><p>gamma sentence.</p>')
    stubRangeRects(win, (text) => (text.startsWith('alpha') ? BOX : { ...BOX, top: 300 }))
    const batch = textRectBatch(
      [
        { id: 't1', quote: 'alpha sentence.' },
        { id: 't2', quote: 'beta sentence.' }, // not in the document — orphaned
        { id: 't3', quote: 'gamma sentence.' },
      ],
      win.document,
    )
    expect(batch.type).toBe('glance:anchor-rects')
    expect(batch.rects).toEqual([
      { id: 't1', rect: BOX },
      { id: 't3', rect: { ...BOX, top: 300 } },
    ])
  })

  test('the epoch is the CURRENT index version, not a constant', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    stubRangeRects(win, () => BOX)
    const anchors = [{ id: 't1', quote: 'alpha sentence.' }]
    const first = newEpoch()
    expect(first).toBeGreaterThan(0)
    expect(textRectBatch(anchors, win.document).epoch).toBe(first)
    const second = newEpoch()
    expect(second).toBe(first + 1)
    expect(textRectBatch(anchors, win.document).epoch).toBe(second)
  })

  test('a range with no real geometry contributes no rect', () => {
    const win = windowWith('<p>alpha sentence.</p><p>gamma sentence.</p>')
    stubRangeRects(win, (text) => (text.startsWith('alpha') ? { top: 0, left: 0, width: 0, height: 0 } : BOX))
    const batch = textRectBatch(
      [
        { id: 't1', quote: 'alpha sentence.' },
        { id: 't3', quote: 'gamma sentence.' },
      ],
      win.document,
    )
    expect(batch.rects).toEqual([{ id: 't3', rect: BOX }])
  })

  test('a duplicated quote with dead context resolves to null → no rect, while a sibling anchor still gets one', () => {
    // Two occurrences of the same sentence, neither of which the stored context describes: findRange
    // now refuses (ambiguous + unmatched context) rather than guessing the first. That refusal must
    // fall out here as "no rect", not a thrown error or a rect for the wrong occurrence.
    const win = windowWith('<p>Alpha lead. Same quote here. tail</p><p>Beta lead. Same quote here. tail</p><p>unique sentence.</p>')
    stubRangeRects(win, () => BOX)
    const batch = textRectBatch(
      [
        { id: 'dead', quote: 'Same quote here.', context: { prefix: 'Nowhere near9', suffix: '' } },
        { id: 'sibling', quote: 'unique sentence.' },
      ],
      win.document,
    )
    expect(batch.rects).toEqual([{ id: 'sibling', rect: BOX }])
  })
})

describe('elementRectBatch — the element half of the badge batch, same rejection rules as text', () => {
  test('a resolved selector contributes its live bounding box', () => {
    const win = windowWith('<div id="chart">chart</div>')
    stubElementRects(win, () => BOX)
    const rects = elementRectBatch([{ id: 'e1', selector: '#chart' }], win.document)
    expect(rects).toEqual([{ id: 'e1', rect: BOX }])
  })

  test('a selector that resolves to nothing contributes no rect', () => {
    const win = windowWith('<div id="chart">chart</div>')
    stubElementRects(win, () => BOX)
    const rects = elementRectBatch([{ id: 'e1', selector: '#does-not-exist' }], win.document)
    expect(rects).toEqual([])
  })

  test('a resolved element whose box has no area is rejected by measurableRect, exactly like a text one', () => {
    const win = windowWith('<div id="chart">chart</div>')
    stubElementRects(win, () => ({ top: 0, left: 0, width: 0, height: 0 }))
    const rects = elementRectBatch([{ id: 'e1', selector: '#chart' }], win.document)
    expect(rects).toEqual([])
  })

  test('multiple element anchors preserve order, dropping only the ones that fail to resolve', () => {
    const win = windowWith('<div id="chart">chart</div><div id="table">table</div>')
    stubElementRects(win, (id) => (id === 'chart' ? BOX : { ...BOX, top: 300 }))
    const rects = elementRectBatch(
      [
        { id: 'e1', selector: '#chart' },
        { id: 'e2', selector: '#missing' },
        { id: 'e3', selector: '#table' },
      ],
      win.document,
    )
    expect(rects).toEqual([
      { id: 'e1', rect: BOX },
      { id: 'e3', rect: { ...BOX, top: 300 } },
    ])
  })
})

describe('anchorRectBatch — one message, one epoch, covering BOTH anchor kinds', () => {
  test('a batch with both a text and an element anchor emits both, in one message', () => {
    const win = windowWith('<p>alpha sentence.</p><div id="chart">chart</div>')
    stubRangeRects(win, () => BOX)
    stubElementRects(win, () => ({ ...BOX, top: 300 }))
    const batch = anchorRectBatch([{ id: 't1', quote: 'alpha sentence.' }], [{ id: 'e1', selector: '#chart' }], win.document)
    expect(batch.type).toBe('glance:anchor-rects')
    expect(batch.rects).toEqual([
      { id: 't1', rect: BOX },
      { id: 'e1', rect: { ...BOX, top: 300 } },
    ])
  })

  test('the element half carries the SAME epoch as the text half', () => {
    const win = windowWith('<p>alpha sentence.</p><div id="chart">chart</div>')
    stubRangeRects(win, () => BOX)
    stubElementRects(win, () => BOX)
    newEpoch()
    const expected = currentEpoch()
    const batch = anchorRectBatch([{ id: 't1', quote: 'alpha sentence.' }], [{ id: 'e1', selector: '#chart' }], win.document)
    expect(batch.epoch).toBe(expected)
  })

  test('an element anchor whose selector never resolves contributes no rect — only the text side survives', () => {
    const win = windowWith('<p>alpha sentence.</p><div id="chart">chart</div>')
    stubRangeRects(win, () => BOX)
    const batch = anchorRectBatch([{ id: 't1', quote: 'alpha sentence.' }], [{ id: 'e1', selector: '#does-not-exist' }], win.document)
    expect(batch.rects).toEqual([{ id: 't1', rect: BOX }])
  })
})

describe('highlightRanges — the hover-only paint set, never the persistent one', () => {
  test('an empty id list highlights nothing', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    const anchors = [{ id: 't1', quote: 'alpha sentence.' }]
    expect(highlightRanges(anchors, [], win.document)).toEqual([])
  })

  test('one matching id yields one Range over that quote', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    const anchors = [{ id: 't1', quote: 'alpha sentence.' }]
    const ranges = highlightRanges(anchors, ['t1'], win.document)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]?.toString()).toBe('alpha sentence.')
  })

  test('preserves the ORDER of ids, not the order anchors were declared in', () => {
    const win = windowWith('<p>alpha sentence.</p><p>beta sentence.</p>')
    const anchors = [
      { id: 't1', quote: 'alpha sentence.' },
      { id: 't2', quote: 'beta sentence.' },
    ]
    const ranges = highlightRanges(anchors, ['t2', 't1'], win.document)
    expect(ranges.map((r) => r.toString())).toEqual(['beta sentence.', 'alpha sentence.'])
  })

  test('an id matching no anchor is skipped, not thrown', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    const anchors = [{ id: 't1', quote: 'alpha sentence.' }]
    const ranges = highlightRanges(anchors, ['ghost', 't1'], win.document)
    expect(ranges.map((r) => r.toString())).toEqual(['alpha sentence.'])
  })

  test('an anchor whose quote no longer resolves is skipped — same drop rule as textRectBatch', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    const anchors = [{ id: 't1', quote: 'vanished sentence.' }]
    expect(highlightRanges(anchors, ['t1'], win.document)).toEqual([])
  })
})

describe('paintTextAnchors — the ONLY seam client.ts is allowed to decide a paint from (kills mutation 1)', () => {
  // These tests only pin what THIS function returns — a paint producing no ranges. They do NOT
  // guard against `client.ts`'s `paintTexts` calling CSS.highlights.set(...) itself and ignoring
  // this seam entirely: that restoration compiles, returns nothing new here, and every assertion
  // below stays green (mutation 1 proved exactly that). The actual guard against mutation 1 is
  // client.test.ts, which drives client.ts's real wiring end-to-end and asserts the DOM highlight
  // stays unset after a paint.
  test('a paint NEVER produces a highlight range, no matter how many anchors resolve', () => {
    const win = windowWith('<p>alpha sentence.</p><p>beta sentence.</p>')
    const anchors = [
      { id: 't1', quote: 'alpha sentence.' },
      { id: 't2', quote: 'beta sentence.' },
    ]
    const result = paintTextAnchors(anchors)
    expect(result.ranges).toEqual([])
  })

  test('it still hands back the anchors for rect emission — recording is not dropped', () => {
    const anchors = [{ id: 't1', quote: 'alpha sentence.' }]
    expect(paintTextAnchors(anchors).anchors).toEqual(anchors)
  })

  test('only an explicit id list (highlightRanges) produces ranges — never the paint seam', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    const anchors = [{ id: 't1', quote: 'alpha sentence.' }]
    expect(paintTextAnchors(anchors).ranges).toEqual([])
    expect(highlightRanges(anchors, ['t1'], win.document)).toHaveLength(1)
  })
})

describe('createRectEmitter — every frame while there are rects, the empty batch exactly once', () => {
  test('an unchanged set still emits on every call — badges must follow scroll', () => {
    // The pinpoint-resolved message IS change-keyed; this one must not be, or the badges freeze at
    // their first position the moment the page scrolls.
    const win = windowWith('<p>alpha sentence.</p>')
    stubRangeRects(win, () => BOX)
    const sent: RectsMessage[] = []
    const emitRects = createRectEmitter((m) => sent.push(m))
    const anchors = [{ id: 't1', quote: 'alpha sentence.' }]
    emitRects(anchors, [], win.document)
    emitRects(anchors, [], win.document)
    emitRects(anchors, [], win.document)
    expect(sent.length).toBe(3)
    expect(sent[2].rects).toEqual([{ id: 't1', rect: BOX }])
  })

  test('the FIRST empty batch is emitted — it is what clears the last badge — and no later one is', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    stubRangeRects(win, () => BOX)
    const sent: RectsMessage[] = []
    const emitRects = createRectEmitter((m) => sent.push(m))
    emitRects([{ id: 't1', quote: 'alpha sentence.' }], [], win.document)
    emitRects([], [], win.document)
    emitRects([], [], win.document)
    emitRects([], [], win.document)
    expect(sent.length).toBe(2)
    expect(sent[1].rects).toEqual([])
  })

  test('a page that never had a text anchor never posts at all', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    const sent: RectsMessage[] = []
    const emitRects = createRectEmitter((m) => sent.push(m))
    emitRects([], [], win.document)
    emitRects([], [], win.document)
    expect(sent).toEqual([])
  })

  test('an element rect alone (no text anchors) still emits — the empty-batch suppression covers BOTH kinds', () => {
    const win = windowWith('<div id="chart">chart</div>')
    stubElementRects(win, () => BOX)
    const sent: RectsMessage[] = []
    const emitRects = createRectEmitter((m) => sent.push(m))
    emitRects([], [{ id: 'e1', selector: '#chart' }], win.document)
    expect(sent).toEqual([{ type: 'glance:anchor-rects', epoch: currentEpoch(), rects: [{ id: 'e1', rect: BOX }] }])
  })

  test('a text anchor and an element anchor together emit ONE message carrying both', () => {
    const win = windowWith('<p>alpha sentence.</p><div id="chart">chart</div>')
    stubRangeRects(win, () => BOX)
    stubElementRects(win, () => ({ ...BOX, top: 300 }))
    const sent: RectsMessage[] = []
    const emitRects = createRectEmitter((m) => sent.push(m))
    emitRects([{ id: 't1', quote: 'alpha sentence.' }], [{ id: 'e1', selector: '#chart' }], win.document)
    expect(sent).toHaveLength(1)
    expect(sent[0].rects).toEqual([
      { id: 't1', rect: BOX },
      { id: 'e1', rect: { ...BOX, top: 300 } },
    ])
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
