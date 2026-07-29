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
  win.document.body.innerHTML = '<p>alpha sentence.</p><p>beta sentence.</p>'

  highlights = new Map()
  class FakeHighlight {
    ranges: Range[]
    constructor(...ranges: Range[]) {
      this.ranges = ranges
    }
  }
  Object.defineProperty(win, 'CSS', { value: { highlights }, configurable: true })
  Object.defineProperty(win, 'Highlight', { value: FakeHighlight, configurable: true })

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
