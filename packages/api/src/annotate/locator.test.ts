import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { computeSelector, describeElement, findRange, isPageSpanning, resolveSelector } from './locator'

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
