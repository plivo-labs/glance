import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { CONTEXT_CHARS, computeSelector, describeElement, findRange, isPageSpanning, resolveSelector, selectionContext } from './locator'

// Seam S1: the locator is global-free, so we drive it under a constructed happy-dom document and
// pass nodes in — no GlobalRegistrator, so nothing leaks into the other (server-side) api tests.

function docFrom(html: string): Document {
  const window = new Window()
  window.document.body.innerHTML = html
  return window.document as unknown as Document
}

/** Every element under `root` must round-trip: computeSelector then resolveSelector finds ITSELF. */
function assertRoundTrips(doc: Document) {
  const all = doc.body.querySelectorAll('*')
  expect(all.length).toBeGreaterThan(0)
  for (const el of all) {
    const sel = computeSelector(el)
    expect(resolveSelector(sel, doc)).toBe(el)
  }
}

describe('computeSelector ∘ resolveSelector — round-trips on a stable DOM', () => {
  test('unique id → short id-anchored selector', () => {
    const doc = docFrom('<div id="chart"><svg></svg></div>')
    const svg = doc.querySelector('#chart svg')!
    expect(computeSelector(doc.querySelector('#chart')!)).toBe('[id="chart"]')
    expect(computeSelector(svg)).toBe('[id="chart"] > svg:nth-of-type(1)')
    expect(resolveSelector(computeSelector(svg), doc)).toBe(svg)
  })

  test('no id → body-anchored nth-of-type child path', () => {
    const doc = docFrom('<section><p>a</p><p>b</p></section>')
    const second = doc.querySelectorAll('p')[1]!
    expect(computeSelector(second)).toBe('body > section:nth-of-type(1) > p:nth-of-type(2)')
    expect(resolveSelector(computeSelector(second), doc)).toBe(second)
  })

  test('repeated siblings are disambiguated by nth-of-type', () => {
    const doc = docFrom('<ul><li>1</li><li>2</li><li>3</li></ul>')
    const items = doc.querySelectorAll('li')
    for (const li of items) expect(resolveSelector(computeSelector(li), doc)).toBe(li)
  })

  test('property: every element in a mixed tree round-trips to itself', () => {
    const doc = docFrom(
      '<header><h1>t</h1></header><main id="m"><figure><img alt="x"/><figcaption>c</figcaption></figure><table><tr><td>1</td><td>2</td></tr></table></main>',
    )
    assertRoundTrips(doc)
  })
})

describe('resolveSelector — mutated DOM', () => {
  test('a removed target resolves to null (orphaned → fallback)', () => {
    const doc = docFrom('<div id="chart"><svg></svg></div>')
    const svg = doc.querySelector('#chart svg')!
    const sel = computeSelector(svg)
    svg.remove()
    expect(resolveSelector(sel, doc)).toBeNull()
  })

  test('an id-less reordered sibling resolves to the WRONG node (the fragility textFallback covers)', () => {
    const doc = docFrom('<section><p>a</p><p>b</p></section>') // no ids → nth-of-type path
    const first = doc.querySelectorAll('p')[0]!
    const sel = computeSelector(first) // body > section:nth-of-type(1) > p:nth-of-type(1)
    first.remove() // the "b" paragraph is now nth-of-type(1)
    const resolved = resolveSelector(sel, doc)
    expect(resolved).not.toBeNull()
    expect((resolved as Element).textContent).toBe('b') // resolves, but to the wrong element
  })

  test('a malformed selector yields null, never throws', () => {
    const doc = docFrom('<div></div>')
    expect(resolveSelector('>>>bad(', doc)).toBeNull()
    expect(resolveSelector('', doc)).toBeNull()
  })
})

describe('isPageSpanning — a full-viewport wrapper is not an anchor', () => {
  const vp = { width: 1000, height: 800 }

  test('an element covering (nearly) the whole viewport in both dims spans the page', () => {
    expect(isPageSpanning({ width: 1000, height: 800 }, vp)).toBe(true)
    expect(isPageSpanning({ width: 1000, height: 4000 }, vp)).toBe(true) // taller than the fold
    expect(isPageSpanning({ width: 920, height: 740 }, vp)).toBe(true) // within the 90% cover
  })

  test('a full-width but short block (paragraph, code line) is still anchorable', () => {
    expect(isPageSpanning({ width: 1000, height: 60 }, vp)).toBe(false)
  })

  test('a tall but narrow column is still anchorable', () => {
    expect(isPageSpanning({ width: 300, height: 4000 }, vp)).toBe(false)
  })
})

describe('findRange — re-find a stored quote in the rendered DOM', () => {
  test('matches a quote across element boundaries + any run of whitespace', () => {
    const doc = docFrom('<p>Hello   <b>brave</b>\n  world</p>')
    const range = findRange('Hello brave world', doc)!
    expect(range).not.toBeNull()
    expect(range.toString()).toBe('Hello   brave\n  world') // spans the real DOM text between the ends
  })

  test('is case-insensitive (survives CSS text-transform)', () => {
    const doc = docFrom('<p>SHOUTING HEADLINE</p>')
    expect(findRange('shouting headline', doc)).not.toBeNull()
  })

  test('a quote that also appears in a <script> anchors to the VISIBLE occurrence', () => {
    // The words appear FIRST in an inline chart-data <script> (unrendered) and again in a paragraph.
    const doc = docFrom('<script>const q = "Total revenue grew"</script><p>Total revenue grew last year</p>')
    const range = findRange('Total revenue grew', doc)!
    expect(range).not.toBeNull()
    expect((range.startContainer as Text).parentElement?.tagName).toBe('P') // NOT the SCRIPT
    expect(range.toString()).toBe('Total revenue grew')
  })

  test('a quote present ONLY inside non-rendered tags does not anchor', () => {
    const doc = docFrom('<script>secret token phrase</script><style>secret token phrase</style><p>visible text</p>')
    expect(findRange('secret token phrase', doc)).toBeNull()
  })

  test('NFKC-equivalent DOM text matches an NFKC-folded quote (ligature)', () => {
    const doc = docFrom('<p>the ﬁle is here</p>') // ﬁ is the U+FB01 ligature; the stored quote uses "fi"
    expect(findRange('the file is here', doc)).not.toBeNull()
  })

  test('NFKC-equivalent DOM text matches an NFKC-folded quote (full-width)', () => {
    const doc = docFrom('<p>ＨＥＬＬＯ world</p>') // full-width latin folds to ASCII under NFKC
    expect(findRange('HELLO world', doc)).not.toBeNull()
  })

  test('an absent quote returns null', () => {
    const doc = docFrom('<p>nothing to see here</p>')
    expect(findRange('a phrase that is not present', doc)).toBeNull()
  })
})

describe('findRange — context disambiguates a REPEATED quote', () => {
  // Three identical sentences; only the surrounding text tells them apart. Without context the
  // first wins (the historical behaviour every stored thread relies on).
  const repeated = '<p>Alpha section. Revenue is up. tail</p><p>Beta section. Revenue is up. tail</p><p>Gamma section. Revenue is up. tail</p>'

  test('no context → the FIRST occurrence (unchanged legacy behaviour)', () => {
    const doc = docFrom(repeated)
    expect(findRange('Revenue is up.', doc)!.startContainer.parentElement?.textContent).toContain('Alpha')
  })

  test('prefix context selects the occurrence it precedes', () => {
    const doc = docFrom(repeated)
    const range = findRange('Revenue is up.', doc, { prefix: 'Beta section. ', suffix: '' })!
    expect(range.startContainer.parentElement?.textContent).toContain('Beta')
  })

  test('suffix context alone also disambiguates', () => {
    const doc = docFrom('<p>Revenue is up. then alpha</p><p>Revenue is up. then beta</p>')
    const range = findRange('Revenue is up.', doc, { prefix: '', suffix: ' then beta' })!
    expect(range.endContainer.parentElement?.textContent).toContain('beta')
  })

  test('context that matches NO occurrence falls back to the first match', () => {
    const doc = docFrom(repeated)
    const range = findRange('Revenue is up.', doc, { prefix: 'Nowhere at all. ', suffix: '' })!
    expect(range.startContainer.parentElement?.textContent).toContain('Alpha')
  })

  test('context matching is whitespace-flexible (stored context is collapsed, the DOM is not)', () => {
    const doc = docFrom('<p>Alpha section. Revenue is up.</p><p>Beta\n   section.   Revenue is up.</p>')
    const range = findRange('Revenue is up.', doc, { prefix: 'Beta section. ', suffix: '' })!
    expect(range.startContainer.parentElement?.textContent).toContain('Beta')
  })

  test('a repeated quote still resolves when the winning occurrence moves to a new element', () => {
    // Same context, different markup: the anchor follows the CONTENT, not the DOM shape.
    const doc = docFrom('<div><span>Beta section. </span><em>Revenue is up.</em></div><p>Alpha section. Revenue is up.</p>')
    const range = findRange('Revenue is up.', doc, { prefix: 'Beta section. ', suffix: '' })!
    expect(range.startContainer.parentElement?.tagName).toBe('EM')
  })
})

describe('selectionContext — capture the text around a live selection', () => {
  /** A range over the FIRST occurrence of `needle` in the document's rendered text. */
  function rangeOver(doc: Document, needle: string): Range {
    return findRange(needle, doc)!
  }

  test('returns the collapsed text on either side of the range', () => {
    const doc = docFrom('<p>before words here. Revenue is up. after words here.</p>')
    const ctx = selectionContext(rangeOver(doc, 'Revenue is up.'), doc)
    expect(ctx.prefix.endsWith('before words here. ')).toBe(true)
    expect(ctx.suffix.startsWith(' after words here.')).toBe(true)
  })

  test('reaches across element boundaries and collapses whitespace runs', () => {
    const doc = docFrom('<p>Beta\n   section.   </p><p><em>Revenue is up.</em></p>')
    expect(selectionContext(rangeOver(doc, 'Revenue is up.'), doc).prefix).toContain('Beta section.')
  })

  test('skips non-rendered text (a <script> next to the selection is not context)', () => {
    const doc = docFrom('<script>POISON CONTEXT</script><p>real lead in. Revenue is up.</p>')
    const ctx = selectionContext(rangeOver(doc, 'Revenue is up.'), doc)
    expect(ctx.prefix).not.toContain('POISON')
    expect(ctx.prefix).toContain('real lead in.')
  })

  test('is bounded on both sides', () => {
    const doc = docFrom(`<p>${'a '.repeat(200)}Revenue is up.${' b'.repeat(200)}</p>`)
    const ctx = selectionContext(rangeOver(doc, 'Revenue is up.'), doc)
    expect(ctx.prefix.length).toBeLessThanOrEqual(CONTEXT_CHARS)
    expect(ctx.suffix.length).toBeLessThanOrEqual(CONTEXT_CHARS)
  })

  test('an edge-of-document selection yields empty context on that side', () => {
    const doc = docFrom('<p>Revenue is up. trailing text</p>')
    expect(selectionContext(rangeOver(doc, 'Revenue is up.'), doc).prefix).toBe('')
  })

  test('round-trips: context captured from occurrence N re-finds occurrence N', () => {
    const html = '<p>one. Revenue is up. x</p><p>two. Revenue is up. y</p><p>three. Revenue is up. z</p>'
    const doc = docFrom(html)
    // Capture context for the THIRD occurrence by ranging over its unique surroundings.
    const third = findRange('three. Revenue is up. z', doc)!
    const ctx = selectionContext(third, doc)
    // A fresh document (as if re-opened later) must land on the third occurrence from that context.
    const reopened = docFrom(html)
    const found = findRange('three. Revenue is up. z', reopened, ctx)!
    expect(found.toString()).toContain('three.')
  })
})

describe('describeElement — tag + human preview + bounded fallback', () => {
  test('prefers aria-label / alt / title over text', () => {
    const doc = docFrom('<button aria-label="Close dialog">X</button>')
    expect(describeElement(doc.querySelector('button')!)).toEqual({ tag: 'button', preview: 'Close dialog', textFallback: 'X' })
  })

  test('falls back to collapsed text, then to the tag', () => {
    const doc = docFrom('<p>  hello   world  </p><svg></svg>')
    expect(describeElement(doc.querySelector('p')!)).toEqual({ tag: 'p', preview: 'hello world', textFallback: 'hello world' })
    expect(describeElement(doc.querySelector('svg')!)).toEqual({ tag: 'svg', preview: 'svg', textFallback: '' })
  })

  test('bounds a huge preview / fallback', () => {
    const doc = docFrom(`<p>${'x'.repeat(1000)}</p>`)
    const d = describeElement(doc.querySelector('p')!)
    expect(d.preview.length).toBe(120)
    expect(d.textFallback.length).toBe(400)
  })
})
