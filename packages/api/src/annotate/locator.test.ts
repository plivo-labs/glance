import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { computeSelector, describeElement, resolveSelector } from './locator'

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
