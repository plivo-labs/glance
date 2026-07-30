import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

// client.ts is the one annotate module that is NOT global-free: it self-registers listeners
// against the real browser globals (window/document/CSS), which is exactly why it stayed
// excluded from every test in this directory and why mutation 1 (B3b-hard's adversarial
// verification) survived a fully green suite — reverting `paintTexts` to persistently
// CSS.highlights.set(...) every resolving anchor never executed under any test. Proving it dead
// means actually RUNNING the wiring, so this file is the deliberate exception: it assigns
// happy-dom's globals onto globalThis, imports client.ts so its real `glance:paint` /
// `glance:highlight` dispatch runs, and tears every assignment back down in afterAll — scoped to
// this one file, nothing leaks into the rest of the (global-free-by-design) api suite.
//
// happy-dom has no CSS Custom Highlight API (`CSS.highlights`, `Highlight`) — a Map stands in
// (same set/delete shape `applyRanges` calls), so `supportsHighlight` is true and every apply is
// directly observable.

type AnyRecord = Record<string, unknown>

let highlights: Map<string, { ranges: Range[] }>
let posted: unknown[]
let restore: () => void

beforeAll(async () => {
  const win = new Window({ url: 'https://content.example.com/index.html' }) as unknown as Window & AnyRecord
  win.document.body.innerHTML =
    '<p>alpha sentence.</p><p>beta sentence.</p><div id="chart">chart</div><a id="link" href="/next.html">next</a>'

  highlights = new Map()
  class FakeHighlight {
    ranges: Range[]
    constructor(...ranges: Range[]) {
      this.ranges = ranges
    }
  }
  Object.defineProperty(win, 'CSS', { value: { highlights }, configurable: true })
  Object.defineProperty(win, 'Highlight', { value: FakeHighlight, configurable: true })

  // happy-dom's own Range/Element getBoundingClientRect is a zero-stub (no layout model) — badge
  // rect emission would never fire without a fabricated box, exactly as reflow.test.ts stubs it.
  win.Range.prototype.getBoundingClientRect = () => ({ top: 40, left: 2, width: 100, height: 18 }) as DOMRect
  win.Element.prototype.getBoundingClientRect = () => ({ top: 10, left: 5, width: 30, height: 12 }) as DOMRect

  posted = []
  Object.defineProperty(win, 'parent', { value: { postMessage: (msg: unknown) => posted.push(msg) }, configurable: true })
  ;(win as AnyRecord).__GLANCE__ = { siteId: 's1', filePath: 'index.html', appOrigin: 'https://app.example.com' }

  const g = globalThis as unknown as AnyRecord
  const prev = { window: g.window, document: g.document, CSS: g.CSS, Highlight: g.Highlight, requestAnimationFrame: g.requestAnimationFrame }
  g.window = win
  g.document = win.document
  g.CSS = (win as AnyRecord).CSS
  g.Highlight = (win as AnyRecord).Highlight
  g.requestAnimationFrame = (win as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame.bind(win)
  restore = () => Object.assign(g, prev)

  // client.ts reads `window.__GLANCE__` and wires its listeners at IMPORT time, so every global
  // above must exist before this line.
  await import('./client')
})

afterAll(() => restore())

/** Fire a trusted parent→child command the way the real app origin would. */
function send(data: unknown): void {
  const win = (globalThis as unknown as AnyRecord).window as unknown as Window & AnyRecord
  const MessageEventCtor = (win as AnyRecord).MessageEvent as typeof MessageEvent
  win.dispatchEvent(new MessageEventCtor('message', { data, origin: 'https://app.example.com' }) as unknown as Event)
}

describe('client.ts — paint never lights the highlight, only an explicit glance:highlight does (kills mutation 1)', () => {
  test('glance:paint with every text anchor resolving sets NO highlight', () => {
    send({
      type: 'glance:paint',
      anchors: [
        { id: 't1', anchorType: 'text', quote: 'alpha sentence.' },
        { id: 't2', anchorType: 'text', quote: 'beta sentence.' },
      ],
    })
    // The exact regression this test exists to catch: a paint that marks up every commented
    // sentence permanently, the moment ANY anchor is painted — not just when nothing highlights.
    expect(highlights.has('glance-comment')).toBe(false)
  })

  test('glance:highlight for one painted anchor lights exactly that anchor', () => {
    // Self-contained: paints its own anchor rather than relying on the previous test's paint
    // having populated textAnchors — stable under reordering or `bun test -t` on this name alone.
    send({ type: 'glance:paint', anchors: [{ id: 't1', anchorType: 'text', quote: 'alpha sentence.' }] })
    send({ type: 'glance:highlight', ids: ['t1'] })
    expect(highlights.has('glance-comment')).toBe(true)
    expect(highlights.get('glance-comment')?.ranges.map((r) => r.toString())).toEqual(['alpha sentence.'])
  })

  test('glance:highlight with an empty id list clears it — "nothing hovered" must mean "nothing lit"', () => {
    send({ type: 'glance:paint', anchors: [{ id: 't1', anchorType: 'text', quote: 'alpha sentence.' }] })
    send({ type: 'glance:highlight', ids: ['t1'] })
    send({ type: 'glance:highlight', ids: [] })
    expect(highlights.has('glance-comment')).toBe(false)
  })

  test('a later repaint (e.g. a new comment added) still lights nothing on its own', () => {
    send({
      type: 'glance:paint',
      anchors: [{ id: 't1', anchorType: 'text', quote: 'alpha sentence.' }, { id: 't2', anchorType: 'text', quote: 'beta sentence.' }],
    })
    expect(highlights.has('glance-comment')).toBe(false)
  })
})

/** The overlay box currently drawn for an element anchor, or null when nothing is drawn for it. */
function elementBox(id: string): Element | null {
  return document.getElementById('__glance_overlay__')?.querySelector(`[data-glance-anchor="${id}"]`) ?? null
}

/** Fire a real DOM event (capture+bubble) against `target`, the way a page's own listeners see it —
 *  needed (not `send`, which is parent→child only) to prove the IN-PAGE click/mousemove wiring. */
function fireDom(type: string, target: Element, init: MouseEventInit = {}): MouseEvent {
  const win = (globalThis as unknown as AnyRecord).window as unknown as Window & AnyRecord
  const MouseEventCtor = (win as AnyRecord).MouseEvent as typeof MouseEvent
  const evt = new MouseEventCtor(type, { bubbles: true, cancelable: true, button: 0, ...init })
  target.dispatchEvent(evt)
  return evt
}

describe('client.ts — element (pinpoint) capture deleted; ordinary clicks, link-rewrite and existing-anchor painting all survive (slice C2a)', () => {
  test('a plain left click on an ordinary element is never intercepted — the page’s own handler still runs', () => {
    // `glance:mode` is sent here for historical reasons only: under the OLD click handler (deleted
    // in slice C2a) this exact message plus click would have preventDefault + stopPropagation +
    // swallowed the page's own listener — that handler and its `glance:mode` receiver are both gone
    // now, so this send is a no-op. Left in as a red-phase artifact rather than deleted outright:
    // if a stale cached bundle from before C2a is still running in someone's tab, this is the
    // message it would still receive, and this test proves it's harmless either way.
    send({ type: 'glance:mode', mode: 'annotate' })
    const chart = document.getElementById('chart') as Element
    let pageHandlerRan = false
    const onClick = () => {
      pageHandlerRan = true
    }
    chart.addEventListener('click', onClick)
    const evt = fireDom('click', chart)
    chart.removeEventListener('click', onClick)
    expect(evt.defaultPrevented).toBe(false)
    expect(pageHandlerRan).toBe(true)
    expect(posted.some((m) => (m as AnyRecord).type === 'glance:pinpoint')).toBe(false)
  })

  test('a mousemove over an element draws no overlay box', () => {
    // Same historical `glance:mode` no-op as the test above — see its comment.
    send({ type: 'glance:mode', mode: 'annotate' })
    const chart = document.getElementById('chart') as Element
    const before = document.getElementById('__glance_overlay__')?.children.length ?? 0
    fireDom('mousemove', chart)
    const after = document.getElementById('__glance_overlay__')?.children.length ?? 0
    expect(after).toBe(before)
  })

  test('a click on a same-origin link still gets its href rewritten with glance_annotate=1', () => {
    send({ type: 'glance:mode', mode: 'read' }) // back to a clean slate — not what this case is about
    const link = document.getElementById('link') as HTMLAnchorElement
    fireDom('click', link)
    expect(link.getAttribute('href')).toContain('glance_annotate=1')
  })

  test('an existing element thread reports its anchor resolved and draws NO box until it is hovered', () => {
    send({ type: 'glance:paint', anchors: [{ id: 'e1', anchorType: 'element', selector: '#chart' }] })
    // Same ruling as text (B3b): paint REGISTERS an anchor, it never marks the page up. An element
    // box laid down at paint time is the persistent-markup bug in its other half — a permanent
    // orange outline on every commented chart for anyone who opens the page.
    expect(elementBox('e1')).toBeNull()
    const resolvedMsgs = posted.filter((m) => (m as AnyRecord).type === 'glance:pinpoint-resolved')
    const last = resolvedMsgs.at(-1) as AnyRecord
    expect(last.resolved).toEqual(['e1'])
    expect(last.orphaned).toEqual([])
  })

  test('glance:highlight draws the box for exactly the hovered element anchor, and leaving clears it', () => {
    send({
      type: 'glance:paint',
      anchors: [
        { id: 'e1', anchorType: 'element', selector: '#chart' },
        { id: 'e4', anchorType: 'element', selector: '#link' },
      ],
    })

    send({ type: 'glance:highlight', ids: ['e1'] })
    expect(elementBox('e1')).not.toBeNull()
    expect(elementBox('e4')).toBeNull() // exactly the hovered one — never every painted anchor

    send({ type: 'glance:highlight', ids: [] }) // pointer leave
    expect(elementBox('e1')).toBeNull()
  })

  test('a hover posts no rect batch — nothing moved, so the parent gets no redundant redraw', () => {
    send({ type: 'glance:paint', anchors: [{ id: 'e1', anchorType: 'element', selector: '#chart' }] })
    const before = posted.filter((m) => (m as AnyRecord).type === 'glance:anchor-rects').length

    send({ type: 'glance:highlight', ids: ['e1'] })
    send({ type: 'glance:highlight', ids: [] })

    expect(posted.filter((m) => (m as AnyRecord).type === 'glance:anchor-rects')).toHaveLength(before)
    expect(elementBox('e1')).toBeNull() // and the hover still took effect (drawn, then cleared)
  })

  test('a repaint while an element anchor is hovered keeps its box — the hover set is not reflow state', () => {
    send({ type: 'glance:paint', anchors: [{ id: 'e1', anchorType: 'element', selector: '#chart' }] })
    send({ type: 'glance:highlight', ids: ['e1'] })
    // Every reflow (a scroll frame, a repaint when a comment lands) tears the boxes down and rebuilds
    // them. Rebuilding from the anchor list ALONE — hover forgotten — drops the lit box mid-hover.
    send({ type: 'glance:paint', anchors: [{ id: 'e1', anchorType: 'element', selector: '#chart' }] })
    expect(elementBox('e1')).not.toBeNull()
    send({ type: 'glance:highlight', ids: [] })
  })

  test('an element anchor whose selector no longer resolves is reported orphaned', () => {
    send({ type: 'glance:paint', anchors: [{ id: 'e2', anchorType: 'element', selector: '#does-not-exist' }] })
    const resolvedMsgs = posted.filter((m) => (m as AnyRecord).type === 'glance:pinpoint-resolved')
    const last = resolvedMsgs.at(-1) as AnyRecord
    expect(last.resolved).toEqual([])
    expect(last.orphaned).toEqual(['e2'])
  })
})

describe('client.ts — element threads badge too (C2b): the rect batch covers both anchor kinds', () => {
  test('painting a text and an element anchor together emits BOTH in one glance:anchor-rects message', () => {
    send({
      type: 'glance:paint',
      anchors: [
        { id: 't1', anchorType: 'text', quote: 'alpha sentence.' },
        { id: 'e1', anchorType: 'element', selector: '#chart' },
      ],
    })
    const rectMsgs = posted.filter((m) => (m as AnyRecord).type === 'glance:anchor-rects')
    const last = rectMsgs.at(-1) as AnyRecord
    expect((last.rects as AnyRecord[]).map((r) => r.id).sort()).toEqual(['e1', 't1'])
  })

  test('an element anchor whose selector never resolves contributes no rect, while a resolving one alongside it still does', () => {
    // A lone non-resolving anchor would make `.some(r => r.id === 'e3') === false` true EVEN IF NO
    // rect message were sent at all (it stayed green under an elementRectBatch -> [] mutation) —
    // pairing it with a resolving anchor forces this send to actually produce a message, and an
    // exact array match (not `.some`) proves e3 was excluded rather than merely not the only entry.
    send({
      type: 'glance:paint',
      anchors: [
        { id: 't1', anchorType: 'text', quote: 'alpha sentence.' },
        { id: 'e3', anchorType: 'element', selector: '#does-not-exist' },
      ],
    })
    const rectMsgs = posted.filter((m) => (m as AnyRecord).type === 'glance:anchor-rects')
    const last = rectMsgs.at(-1) as AnyRecord
    expect((last.rects as AnyRecord[]).map((r) => r.id)).toEqual(['t1'])
  })
})
