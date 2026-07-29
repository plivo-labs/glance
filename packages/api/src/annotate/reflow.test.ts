import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { currentEpoch, findRange, newEpoch } from './locator'
import { createRectEmitter, installIndexInvalidation, measurableRect, type RectsMessage, textRectBatch } from './reflow'

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
  return win as unknown as Window & { document: Document; Range: typeof Range }
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
    emitRects(anchors, win.document)
    emitRects(anchors, win.document)
    emitRects(anchors, win.document)
    expect(sent.length).toBe(3)
    expect(sent[2].rects).toEqual([{ id: 't1', rect: BOX }])
  })

  test('the FIRST empty batch is emitted — it is what clears the last badge — and no later one is', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    stubRangeRects(win, () => BOX)
    const sent: RectsMessage[] = []
    const emitRects = createRectEmitter((m) => sent.push(m))
    emitRects([{ id: 't1', quote: 'alpha sentence.' }], win.document)
    emitRects([], win.document)
    emitRects([], win.document)
    emitRects([], win.document)
    expect(sent.length).toBe(2)
    expect(sent[1].rects).toEqual([])
  })

  test('a page that never had a text anchor never posts at all', () => {
    const win = windowWith('<p>alpha sentence.</p>')
    const sent: RectsMessage[] = []
    const emitRects = createRectEmitter((m) => sent.push(m))
    emitRects([], win.document)
    emitRects([], win.document)
    expect(sent).toEqual([])
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
