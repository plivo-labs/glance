import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { findRange } from './locator'
import {
  type AskKeyMessage,
  type ClearMessage,
  type ClickAwayMessage,
  type CommentKeyMessage,
  type EscapeMessage,
  installSelectionCapture,
  type SelectMessage,
} from './selection'

// Seam S3: the capture policy takes its document, selection getter and emitter as arguments, so it
// runs under a constructed happy-dom window — no GlobalRegistrator, nothing leaks into the other
// (server-side) api tests. Every assertion is on the EMITTED MESSAGES, which is the whole contract
// the parent sees.
//
// happy-dom's Selection is real (addRange/removeAllRanges/collapse mutate it AND dispatch a genuine
// `selectionchange` on the document, per the Selection API spec), so drags and clears here fire the
// same event traffic a browser would. Two limits, called out where they matter:
//   • Range.getBoundingClientRect() is a stub returning an all-zero DOMRect, so the rect is asserted
//     for SHAPE, not values.
//   • a real Selection cannot be emptied without notifying the document, so the one case that needs a
//     silently-collapsed selection uses a minimal stand-in (see below).

const HTML = '<p>Alpha lead in. Revenue is up. trailing words.</p>'

function setup(html = HTML) {
  const window = new Window()
  window.document.body.innerHTML = html
  const doc = window.document as unknown as Document
  const emitted: (SelectMessage | ClearMessage | ClickAwayMessage | EscapeMessage | CommentKeyMessage | AskKeyMessage)[] = []
  let selection: Selection | null = doc.getSelection()

  const dispose = installSelectionCapture({
    doc,
    getSelection: () => selection,
    emit: (msg) => {
      emitted.push(msg)
    },
  })

  /** Select `needle` the way a user's drag ends up: a real range in the real Selection, which fires
   *  real selectionchange events on the way. */
  const select = (needle: string): void => {
    const sel = doc.getSelection() as unknown as { removeAllRanges(): void; addRange(r: Range): void }
    sel.removeAllRanges()
    sel.addRange(findRange(needle, doc)!)
  }
  const collapse = (): void => (doc.getSelection() as unknown as { removeAllRanges(): void }).removeAllRanges()
  /** Swap in a collapsed selection WITHOUT notifying the document — the one thing a real Selection
   *  can't do, and the only way to ask what pointerup alone does with an empty selection. */
  const detach = (): void => {
    selection = { isCollapsed: true, rangeCount: 0, toString: () => '' } as unknown as Selection
  }

  const fire = (type: string, init?: Record<string, unknown>): void => {
    doc.dispatchEvent(new window.KeyboardEvent(type, init as never) as unknown as Event)
  }

  /** The same keystroke, but dispatched AT an element so the handler sees a real `target` — the
   *  only way to ask what a key pressed inside a field on the page does. Bubbles to the document. */
  const fireAt = (selector: string, type: string, init?: Record<string, unknown>): void => {
    doc
      .querySelector(selector)!
      .dispatchEvent(new window.KeyboardEvent(type, { bubbles: true, ...init } as never) as unknown as Event)
  }

  return { doc, window, emitted, dispose, select, collapse, detach, fire, fireAt }
}

describe('installSelectionCapture — only a COMMITTED selection emits a chip intent', () => {
  test('a drag (many selectionchange events, no pointerup) emits NOTHING', () => {
    const { emitted, select, doc, window } = setup()
    // The boundary moving outward, the way a drag extends it — plus extra bare selectionchange
    // events for good measure. The parent must not hear a word until the pointer comes up.
    for (const needle of ['Revenue', 'Revenue is', 'Revenue is up.']) {
      select(needle)
      doc.dispatchEvent(new window.Event('selectionchange') as unknown as Event)
    }
    expect(emitted).toEqual([])
  })

  test('pointerup with a live selection emits exactly one select carrying the quote', () => {
    const { emitted, select, doc, window } = setup()
    select('Revenue is up.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)

    expect(emitted.length).toBe(1)
    const msg = emitted[0] as SelectMessage
    expect(msg.type).toBe('glance:select')
    expect(msg.quote).toBe('Revenue is up.')
    // Captured at commit time, so the parent can re-find THIS occurrence later.
    expect(msg.context.prefix).toBe('Alpha lead in. ')
    expect(msg.context.suffix).toBe(' trailing words.')
    // happy-dom stubs Range.getBoundingClientRect to an all-zero DOMRect: shape, not values.
    expect(Object.keys(msg.rect).sort()).toEqual(['height', 'left', 'top', 'width'])
  })

  test('commit captures blockText from the enclosing block element, whitespace-collapsed', () => {
    const { emitted, select, doc, window } = setup('<div><p>Alpha lead in.\n   Revenue   is up. trailing words.</p></div>')
    select('Revenue is up.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)

    const msg = emitted[0] as SelectMessage
    // The whole enclosing <p>, not the page's <div> wrapper — and every whitespace run collapsed.
    expect(msg.blockText).toBe('Alpha lead in. Revenue is up. trailing words.')
  })

  test('blockText excludes script/style text inside the block', () => {
    // The realistic glance shape: a single-file page whose wrapper DIV carries inline JS/CSS. Raw
    // textContent would ship that source as the AI's "passage"; the visible-text walk must not.
    const { emitted, select, doc, window } = setup(
      '<div><span>Revenue is up.</span><script>const leaked = "js source"</script><style>.leaked{color:red}</style><span>More prose.</span></div>',
    )
    select('Revenue is up.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)

    const msg = emitted[0] as SelectMessage
    expect(msg.blockText).toBe('Revenue is up.More prose.')
  })

  test('blockText is capped at 2000 chars', () => {
    const long = 'x'.repeat(2500)
    const { emitted, select, doc, window } = setup(`<p>${long}</p>`)
    select('xxxxxxxxxx')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)

    const msg = emitted[0] as SelectMessage
    expect(msg.blockText).toBe('x'.repeat(2000))
  })

  test('a keyup on a selection-moving key commits too (shift+arrow never fires pointerup)', () => {
    const { emitted, select, fire } = setup()
    select('Revenue is up.')
    fire('keyup', { key: 'ArrowRight', shiftKey: true })

    expect(emitted.length).toBe(1)
    expect((emitted[0] as SelectMessage).quote).toBe('Revenue is up.')
  })

  test('a keyup on an ordinary typing key does not commit', () => {
    const { emitted, select, fire } = setup()
    select('Revenue is up.')
    fire('keyup', { key: 'x' })
    expect(emitted).toEqual([])
  })
})

describe('installSelectionCapture — the clear is a transition, not a state report', () => {
  test('a collapsed selection at pointerup retires the chip', () => {
    const { emitted, select, detach, doc, window } = setup()
    select('Revenue is up.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)
    detach()
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)

    expect(emitted.map((m) => m.type)).toEqual(['glance:select', 'glance:select-clear'])
  })

  test('losing the selection clears ONCE, not on every subsequent selectionchange', () => {
    const { emitted, select, collapse, doc, window } = setup()
    select('Revenue is up.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)
    collapse() // clicking away / starting the next drag — fires a real selectionchange
    for (let i = 0; i < 5; i++) doc.dispatchEvent(new window.Event('selectionchange') as unknown as Event)
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)

    expect(emitted.map((m) => m.type)).toEqual(['glance:select', 'glance:select-clear'])
  })

  test('a selectionchange with no chip outstanding emits nothing at all', () => {
    const { emitted, doc, window } = setup()
    for (let i = 0; i < 5; i++) doc.dispatchEvent(new window.Event('selectionchange') as unknown as Event)
    expect(emitted).toEqual([])
  })

  test('a fresh selection after a clear emits a new select', () => {
    const { emitted, select, collapse, doc, window } = setup()
    select('Revenue is up.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)
    collapse()
    select('Alpha lead in.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)

    expect(emitted.map((m) => m.type)).toEqual(['glance:select', 'glance:select-clear', 'glance:select'])
    expect((emitted[2] as SelectMessage).quote).toBe('Alpha lead in.')
  })
})

describe('installSelectionCapture — dismissal signals the parent cannot see for itself', () => {
  test('a pointerdown on the document emits exactly one click-away', () => {
    const { emitted, doc, window } = setup()
    doc.dispatchEvent(new window.Event('pointerdown') as unknown as Event)
    expect(emitted).toEqual([{ type: 'glance:click-away' }])
  })

  test('an Escape keydown emits exactly one escape; other keys emit neither signal', () => {
    const { emitted, fire } = setup()
    fire('keydown', { key: 'Escape' })
    expect(emitted).toEqual([{ type: 'glance:escape' }])

    fire('keydown', { key: 'x' })
    fire('keydown', { key: 'ArrowRight' })
    expect(emitted).toEqual([{ type: 'glance:escape' }])
  })

  test('an ordinary drag emits click-away BEFORE the select it precedes', () => {
    // pointerdown starts the drag, pointerup commits it — the parent must tolerate this ordering.
    const { emitted, select, doc, window } = setup()
    doc.dispatchEvent(new window.Event('pointerdown') as unknown as Event)
    select('Revenue is up.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)

    expect(emitted.map((m) => m.type)).toEqual(['glance:click-away', 'glance:select'])
  })

  test('after dispose neither signal is emitted', () => {
    const { emitted, dispose, doc, window, fire } = setup()
    dispose()
    doc.dispatchEvent(new window.Event('pointerdown') as unknown as Event)
    fire('keydown', { key: 'Escape' })

    expect(emitted).toEqual([])
  })
})

describe('installSelectionCapture — C on a live selection (#117)', () => {
  /** Get to the one state the binding exists in: a committed selection the parent has been told about. */
  const withSelection = (s: ReturnType<typeof setup>) => {
    s.select('Revenue is up.')
    s.doc.dispatchEvent(new s.window.Event('pointerup') as unknown as Event)
    s.emitted.length = 0
    return s
  }

  test('c emits a comment-key intent; C (shift) is the same key press', () => {
    const { emitted, fire } = withSelection(setup())
    fire('keydown', { key: 'c' })
    fire('keydown', { key: 'C', shiftKey: true })
    expect(emitted).toEqual([{ type: 'glance:comment-key' }, { type: 'glance:comment-key' }])
  })

  test('with no selection outstanding, c is just a letter on someone else’s page', () => {
    const { emitted, fire } = setup()
    fire('keydown', { key: 'c' })
    expect(emitted).toEqual([])
  })

  test('a cleared selection retires the binding with the chip', () => {
    const s = withSelection(setup())
    s.collapse() // the clear the parent acts on
    s.fire('keydown', { key: 'c' })
    expect(s.emitted).toEqual([{ type: 'glance:select-clear' }])
  })

  test('⌘C / ^C stay copy — the most common thing anyone does with a selection', () => {
    const { emitted, fire } = withSelection(setup())
    fire('keydown', { key: 'c', metaKey: true })
    fire('keydown', { key: 'c', ctrlKey: true })
    fire('keydown', { key: 'c', altKey: true })
    expect(emitted).toEqual([])
  })

  test('c typed into a contenteditable is a character, not a command', () => {
    // The one place a page cursor and a reported selection genuinely coexist: `window.getSelection()`
    // sees inside a contenteditable, so the chip gate alone would not save the keystroke.
    const s = setup('<div contenteditable="true">Alpha lead in. Revenue is up. trailing words.</div>')
    withSelection(s)
    s.fireAt('div', 'keydown', { key: 'c' })
    expect(s.emitted).toEqual([])
  })
})

describe('installSelectionCapture — A on a live selection (ask AI)', () => {
  /** Get to the one state the binding exists in: a committed selection the parent has been told about. */
  const withSelection = (s: ReturnType<typeof setup>) => {
    s.select('Revenue is up.')
    s.doc.dispatchEvent(new s.window.Event('pointerup') as unknown as Event)
    s.emitted.length = 0
    return s
  }

  test('a emits an ask-key intent', () => {
    const { emitted, fire } = withSelection(setup())
    fire('keydown', { key: 'a' })
    expect(emitted).toEqual([{ type: 'glance:ask-key' }])
  })

  test('with no selection outstanding, a emits nothing', () => {
    const { emitted, fire } = setup()
    fire('keydown', { key: 'a' })
    expect(emitted).toEqual([])
  })

  test('a typed into a contenteditable is a character, not a command', () => {
    const s = setup('<div contenteditable="true">Alpha lead in. Revenue is up. trailing words.</div>')
    withSelection(s)
    s.fireAt('div', 'keydown', { key: 'a' })
    expect(s.emitted).toEqual([])
  })

  test('⌘A / ^A stay select-all — the same gate as ⌘C / ^C', () => {
    const { emitted, fire } = withSelection(setup())
    fire('keydown', { key: 'a', metaKey: true })
    fire('keydown', { key: 'a', ctrlKey: true })
    fire('keydown', { key: 'a', altKey: true })
    expect(emitted).toEqual([])
  })
})

describe('installSelectionCapture — dispose', () => {
  test('after dispose no event emits anything', () => {
    const { emitted, select, collapse, dispose, doc, window, fire } = setup()
    dispose()
    select('Revenue is up.')
    doc.dispatchEvent(new window.Event('pointerup') as unknown as Event)
    fire('keyup', { key: 'ArrowRight', shiftKey: true })
    collapse()
    doc.dispatchEvent(new window.Event('selectionchange') as unknown as Event)

    expect(emitted).toEqual([])
  })
})
