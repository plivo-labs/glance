import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

// client.ts is the one annotate module that is NOT global-free: it self-registers listeners
// against the real browser globals (window/document/CSS), which is exactly why it stayed
// excluded from every test in this directory — and why a `paintTexts` bug can survive a fully green
// suite: nothing else in this package ever RUNS the wiring. So this file is the deliberate
// exception: it assigns happy-dom's globals onto globalThis, imports client.ts so its real
// `glance:paint` dispatch and its real in-page click handler run, and tears every assignment back
// down in afterAll — scoped to this one file, nothing leaks into the rest of the
// (global-free-by-design) api suite.
//
// happy-dom has no CSS Custom Highlight API (`CSS.highlights`, `Highlight`) — a Map stands in
// (same set/delete shape `applyRanges` calls), so `supportsHighlight` is true and every apply is
// directly observable.

type AnyRecord = Record<string, unknown>

// Every Range / every Element in this document reports one of these two boxes (see beforeAll).
// Disjoint on purpose, so a point can name exactly one anchor kind.
const TEXT_BOX = { top: 40, left: 2, width: 100, height: 18 }
const ELEMENT_BOX = { top: 200, left: 5, width: 30, height: 12 }
const IN_TEXT = { clientX: 50, clientY: 45 }
const IN_ELEMENT = { clientX: 10, clientY: 205 }
const IN_NOTHING = { clientX: 500, clientY: 500 }

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

  // happy-dom has no layout model, so every box is a zero-stub — the click hit-test would never
  // fire without a fabricated one, exactly as reflow.test.ts stubs it. TEXT_BOX and ELEMENT_BOX
  // below are the two boxes every Range / every Element reports here.
  win.Range.prototype.getClientRects = () => [TEXT_BOX] as unknown as DOMRectList
  win.Range.prototype.getBoundingClientRect = () => TEXT_BOX as DOMRect
  win.Element.prototype.getBoundingClientRect = () => ELEMENT_BOX as DOMRect

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

/** Fire a trusted parent→child command the way the real app origin would (or, with `origin`
 *  overridden, the way a hostile embedder would). */
function send(data: unknown, origin = 'https://app.example.com'): void {
  const win = (globalThis as unknown as AnyRecord).window as unknown as Window & AnyRecord
  const MessageEventCtor = (win as AnyRecord).MessageEvent as typeof MessageEvent
  win.dispatchEvent(new MessageEventCtor('message', { data, origin }) as unknown as Event)
}

describe('client.ts — a paint IS the highlight: everything sent is lit, an empty paint clears it', () => {
  test('glance:paint lights EVERY text anchor it is sent', () => {
    send({
      type: 'glance:paint',
      anchors: [
        { id: 't1', anchorType: 'text', quote: 'alpha sentence.' },
        { id: 't2', anchorType: 'text', quote: 'beta sentence.' },
      ],
    })
    expect(highlights.has('glance-comment')).toBe(true)
    expect(highlights.get('glance-comment')?.ranges.map((r) => r.toString())).toEqual(['alpha sentence.', 'beta sentence.'])
  })

  test('an EMPTY paint clears the highlight — this is what closing the rail does to the page', () => {
    send({ type: 'glance:paint', anchors: [{ id: 't1', anchorType: 'text', quote: 'alpha sentence.' }] })
    send({ type: 'glance:paint', anchors: [] })
    // Deleted, not set to an empty Highlight: a registered-but-empty Highlight paints nothing yet
    // stays resident, which is observably different from no highlight at all.
    expect(highlights.has('glance-comment')).toBe(false)
  })

  test('a repaint (a new comment landing) lights the new anchor alongside the old', () => {
    send({ type: 'glance:paint', anchors: [{ id: 't1', anchorType: 'text', quote: 'alpha sentence.' }] })
    expect(highlights.get('glance-comment')?.ranges.map((r) => r.toString())).toEqual(['alpha sentence.'])
    send({
      type: 'glance:paint',
      anchors: [
        { id: 't1', anchorType: 'text', quote: 'alpha sentence.' },
        { id: 't2', anchorType: 'text', quote: 'beta sentence.' },
      ],
    })
    expect(highlights.get('glance-comment')?.ranges.map((r) => r.toString())).toEqual(['alpha sentence.', 'beta sentence.'])
  })

  test('an anchor whose quote no longer resolves is dropped, and its resolving sibling still lights', () => {
    send({
      type: 'glance:paint',
      anchors: [
        { id: 't9', anchorType: 'text', quote: 'a sentence this page never had.' },
        { id: 't1', anchorType: 'text', quote: 'alpha sentence.' },
      ],
    })
    expect(highlights.get('glance-comment')?.ranges.map((r) => r.toString())).toEqual(['alpha sentence.'])
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
    send({ type: 'glance:paint', anchors: [] }) // nothing painted: the rail-closed state
    const chart = document.getElementById('chart') as Element
    let pageHandlerRan = false
    const onClick = () => {
      pageHandlerRan = true
    }
    chart.addEventListener('click', onClick)
    const evt = fireDom('click', chart, IN_ELEMENT)
    chart.removeEventListener('click', onClick)
    expect(evt.defaultPrevented).toBe(false)
    expect(pageHandlerRan).toBe(true)
    expect(posted.some((m) => (m as AnyRecord).type === 'glance:pinpoint')).toBe(false)
  })

  test('a mousemove over an element draws no overlay box', () => {
    send({ type: 'glance:paint', anchors: [] })
    const chart = document.getElementById('chart') as Element
    const before = document.getElementById('__glance_overlay__')?.children.length ?? 0
    fireDom('mousemove', chart)
    const after = document.getElementById('__glance_overlay__')?.children.length ?? 0
    expect(after).toBe(before)
  })

  test('a click on a same-origin link still gets its href rewritten with glance_annotate=1', () => {
    send({ type: 'glance:paint', anchors: [] })
    const link = document.getElementById('link') as HTMLAnchorElement
    fireDom('click', link, IN_NOTHING)
    expect(link.getAttribute('href')).toContain('glance_annotate=1')
  })

  test('an existing element thread gets its box AT PAINT TIME and reports its anchor resolved', () => {
    send({ type: 'glance:paint', anchors: [{ id: 'e1', anchorType: 'element', selector: '#chart' }] })
    // The box is no longer a hover affordance: everything painted is drawn, because the parent only
    // paints while the rail is open.
    expect(elementBox('e1')).not.toBeNull()
    const resolvedMsgs = posted.filter((m) => (m as AnyRecord).type === 'glance:pinpoint-resolved')
    const last = resolvedMsgs.at(-1) as AnyRecord
    expect(last.resolved).toEqual(['e1'])
    expect(last.orphaned).toEqual([])
  })

  test('an empty paint removes every element box too — the page goes back to how its author wrote it', () => {
    send({ type: 'glance:paint', anchors: [{ id: 'e1', anchorType: 'element', selector: '#chart' }] })
    expect(elementBox('e1')).not.toBeNull()
    send({ type: 'glance:paint', anchors: [] })
    expect(elementBox('e1')).toBeNull()
  })

  test('an element anchor whose selector no longer resolves is reported orphaned', () => {
    send({ type: 'glance:paint', anchors: [{ id: 'e2', anchorType: 'element', selector: '#does-not-exist' }] })
    const resolvedMsgs = posted.filter((m) => (m as AnyRecord).type === 'glance:pinpoint-resolved')
    const last = resolvedMsgs.at(-1) as AnyRecord
    expect(last.resolved).toEqual([])
    expect(last.orphaned).toEqual(['e2'])
  })
})

// The page→rail route that replaced the badges. A CSS Custom Highlight takes part in no hit testing
// at all, so this wiring — re-finding the anchors and testing the click point against their rects —
// is the ONLY thing making a highlight clickable; nothing else in the suite executes it.
describe('client.ts — clicking a painted anchor posts glance:anchor-click', () => {
  const clicks = () => posted.filter((m) => (m as AnyRecord).type === 'glance:anchor-click') as AnyRecord[]

  test('a click inside a painted text anchor posts its id and swallows the click', () => {
    send({ type: 'glance:paint', anchors: [{ id: 't1', anchorType: 'text', quote: 'alpha sentence.' }] })
    const before = clicks().length
    const chart = document.getElementById('chart') as Element
    let pageHandlerRan = false
    const onClick = () => {
      pageHandlerRan = true
    }
    chart.addEventListener('click', onClick)
    const evt = fireDom('click', chart, IN_TEXT)
    chart.removeEventListener('click', onClick)

    expect(clicks()).toHaveLength(before + 1)
    expect(clicks().at(-1)?.id).toBe('t1')
    // Swallowed both ways: a highlighted quote inside a link must open its thread, not navigate,
    // and the page's own handlers must not act on it either.
    expect(evt.defaultPrevented).toBe(true)
    expect(pageHandlerRan).toBe(false)
  })

  test('a click inside a painted element anchor posts its id', () => {
    send({ type: 'glance:paint', anchors: [{ id: 'e1', anchorType: 'element', selector: '#chart' }] })
    const before = clicks().length
    fireDom('click', document.getElementById('chart') as Element, IN_ELEMENT)
    expect(clicks()).toHaveLength(before + 1)
    expect(clicks().at(-1)?.id).toBe('e1')
  })

  test('a click that misses every painted anchor is left completely alone', () => {
    send({ type: 'glance:paint', anchors: [{ id: 't1', anchorType: 'text', quote: 'alpha sentence.' }] })
    const before = clicks().length
    const evt = fireDom('click', document.getElementById('chart') as Element, IN_NOTHING)
    expect(clicks()).toHaveLength(before)
    expect(evt.defaultPrevented).toBe(false)
  })

  test('with NOTHING painted (the rail closed) the same click is inert', () => {
    send({ type: 'glance:paint', anchors: [] })
    const before = clicks().length
    const evt = fireDom('click', document.getElementById('chart') as Element, IN_TEXT)
    expect(clicks()).toHaveLength(before)
    expect(evt.defaultPrevented).toBe(false)
  })

  test('a modified or non-left click is never claimed — cmd-click, middle-click, right-click', () => {
    send({ type: 'glance:paint', anchors: [{ id: 't1', anchorType: 'text', quote: 'alpha sentence.' }] })
    const before = clicks().length
    const chart = document.getElementById('chart') as Element
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const evt = fireDom('click', chart, { ...IN_TEXT, ...init })
      expect(evt.defaultPrevented).toBe(false)
    }
    expect(clicks()).toHaveLength(before)
  })
})

// #27 — the boot glance:ready fires exactly once, at import time, so a parent whose listener
// attaches late (warm-cache load: the iframe finishes before the viewer's effect runs) loses it
// forever. glance:ping is the parent's "did I miss it?" probe: the client re-announces, and the
// parent's arbiter already ignores duplicate readys, so a redundant ping costs nothing.
describe('client.ts — glance:ping re-announces glance:ready (#27)', () => {
  const readys = () => posted.filter((m) => (m as AnyRecord).type === 'glance:ready') as AnyRecord[]

  test('a ping from the app origin re-posts glance:ready with the mounted filePath', () => {
    const before = readys().length
    send({ type: 'glance:ping' })
    expect(readys()).toHaveLength(before + 1)
    expect(readys().at(-1)?.filePath).toBe('index.html')
  })

  test('a ping from any other origin is ignored — same trust rule as paint/focus', () => {
    const before = readys().length
    send({ type: 'glance:ping' }, 'https://evil.example.com')
    expect(readys()).toHaveLength(before)
  })
})

describe('client.ts — glance:print prints in the frame realm (the parent cannot call print cross-origin)', () => {
  test('a trusted glance:print calls window.print exactly once; a foreign origin never does', () => {
    const win = (globalThis as unknown as AnyRecord).window as unknown as Window & AnyRecord
    let printed = 0
    Object.defineProperty(win, 'print', { value: () => printed++, configurable: true })

    send({ type: 'glance:print' })
    expect(printed).toBe(1)

    // Same payload from a hostile origin is ignored — commands are trusted ONLY from the app origin.
    send({ type: 'glance:print' }, 'https://evil.example.com')
    expect(printed).toBe(1)
  })
})

describe('client.ts — glance:theme swaps the theme stylesheet inside the frame (viewer-local override)', () => {
  const link = () => document.getElementById('glance-theme') as HTMLLinkElement | null

  test('a trusted href installs the link, a second swaps it in place, null removes it (no boot theme here)', () => {
    send({ type: 'glance:theme', href: '/_glance/theme/kapow.css?v=abc12345' })
    expect(link()?.getAttribute('href')).toBe('/_glance/theme/kapow.css?v=abc12345')

    send({ type: 'glance:theme', href: '/_glance/theme/matrix.css?v=abc12345' })
    expect(link()?.getAttribute('href')).toBe('/_glance/theme/matrix.css?v=abc12345')
    expect(document.querySelectorAll('#glance-theme')).toHaveLength(1)

    // This page booted with NO server-injected theme, so null = remove entirely.
    send({ type: 'glance:theme', href: null })
    expect(link()).toBeNull()
  })

  test('hrefs outside /_glance/theme/ are rejected; foreign origins are ignored', () => {
    send({ type: 'glance:theme', href: 'https://evil.example.com/steal.css' })
    expect(link()).toBeNull()
    send({ type: 'glance:theme', href: '/_glance/theme/../../etc.css' })
    expect(link()).toBeNull()
    send({ type: 'glance:theme', href: '/_glance/theme/kapow.css' }, 'https://evil.example.com')
    expect(link()).toBeNull()
  })
})

describe('client.ts — clicking a mermaid diagram opens it in a modal <dialog> lightbox', () => {
  // The Fullscreen API is blocked in the viewer's content iframe (no allow="fullscreen"), so
  // enlarging goes through a native <dialog>. This is the one runnable check that the wiring —
  // delegation onto `.mermaid`, the SVG clone, showModal — is actually live in the shipped client.
  test('the diagram SVG is cloned into an open dialog, and any click closes it again', () => {
    document.body.insertAdjacentHTML('beforeend', '<pre class="mermaid"><svg id="mermaid-1"><g>node</g></svg></pre>')
    const diagram = document.querySelector('.mermaid') as Element

    fireDom('click', diagram.querySelector('g') as Element)
    const dialog = document.querySelector('dialog.glance-lb') as HTMLDialogElement
    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('svg')?.id).toBe('mermaid-1')
    expect(document.querySelectorAll('svg')).toHaveLength(2) // the original is copied, never moved

    fireDom('click', dialog)
    expect(dialog.open).toBe(false)

    // A click anywhere else on the page is left completely alone.
    fireDom('click', document.getElementById('chart') as Element)
    expect(dialog.open).toBe(false)
    diagram.remove()
  })
})
