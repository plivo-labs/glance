import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { TEXT_CONTEXT_LIMIT } from '../lib/anchor'
import {
  computeSelector,
  describeElement,
  findRange,
  isPageSpanning,
  newEpoch,
  resolveSelector,
  selectionContext,
  sharedTextIndex,
} from './locator'

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

  // The index is NFKC-folded, so inside a node that folding CHANGED the folded offsets no longer
  // line up with the raw offsets a Range needs. Both drift directions are painted wrong if the
  // folded offset is used raw: an expanding char (ﬁ → fi) runs the highlight past the quote, a
  // composing one (e + ◌́ → é) stops it short.
  test('an expanding character earlier in the node does not shift the painted range', () => {
    const doc = docFrom('<p>ﬁle then TARGET here</p>') // ﬁ is U+FB01: one raw char, two folded
    expect(findRange('TARGET', doc)!.toString()).toBe('TARGET')
  })

  test('an expanding character inside the quote does not over-extend the painted range', () => {
    const doc = docFrom('<p>ﬁrst word</p>')
    expect(findRange('first', doc)!.toString()).toBe('ﬁrst')
  })

  test('a composing sequence inside the quote does not truncate the painted range', () => {
    const doc = docFrom('<p>e\u0301xyz end</p>') // e + combining acute: two raw chars, one folded
    expect(findRange('\u00e9xyz', doc)!.toString()).toBe('e\u0301xyz')
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

  // Deliberately does NOT end in ". " (the last two chars every occurrence's lead-in shares) — that
  // coincidence would let a "dead" prefix still score 2 by accident, masking the very case this rule
  // targets. Ending in a digit guarantees zero shared trailing characters.
  const DEAD_PREFIX = 'Nowhere at all9'

  test('THREE occurrences + context that matches NONE → null, not a silent first-occurrence guess', () => {
    // The quote is genuinely ambiguous (3 hits) and the stored surroundings survive nowhere (score 0
    // everywhere) — painting hits[0] here would confidently badge text its author never selected.
    const doc = docFrom(repeated)
    expect(findRange('Revenue is up.', doc, { prefix: DEAD_PREFIX, suffix: '' })).toBeNull()
  })

  test('a SINGLE occurrence still anchors even when its context matches nothing (nothing to be ambiguous about)', () => {
    const doc = docFrom('<p>Alpha section. Revenue is up. tail</p>')
    const range = findRange('Revenue is up.', doc, { prefix: DEAD_PREFIX, suffix: '' })!
    expect(range).not.toBeNull()
    expect(range.toString()).toBe('Revenue is up.')
  })

  test('TWO occurrences + dead context (score 0 at both) → null', () => {
    const doc = docFrom('<p>Alpha section. Revenue is up. tail</p><p>Beta section. Revenue is up. tail</p>')
    expect(findRange('Revenue is up.', doc, { prefix: DEAD_PREFIX, suffix: '' })).toBeNull()
  })

  test('TWO occurrences + NO context (undefined) → the FIRST occurrence (unchanged — nothing to compare)', () => {
    const doc = docFrom('<p>Alpha section. Revenue is up. tail</p><p>Beta section. Revenue is up. tail</p>')
    const range = findRange('Revenue is up.', doc)!
    expect(range.startContainer.parentElement?.textContent).toContain('Alpha')
  })

  test('TWO occurrences + an empty stored context ({prefix:"",suffix:""}) → the FIRST occurrence (a pre-context thread)', () => {
    const doc = docFrom('<p>Alpha section. Revenue is up. tail</p><p>Beta section. Revenue is up. tail</p>')
    const range = findRange('Revenue is up.', doc, { prefix: '', suffix: '' })!
    expect(range.startContainer.parentElement?.textContent).toContain('Alpha')
  })

  test('TWO occurrences + a context matching with a score of only 1 character → that occurrence, not null', () => {
    // No separating space, so the char right before the quote IS the lead-in's last char: 'z' shares
    // it with the SECOND occurrence ("...xyz") and shares nothing with the first's ("...xyq") — a
    // score of 1 is still a match, not a guess.
    const doc = docFrom('<p>xyqRevenue is up. tail</p><p>xyzRevenue is up. tail</p>')
    const range = findRange('Revenue is up.', doc, { prefix: 'z', suffix: '' })!
    expect(range).not.toBeNull()
    expect(range.startContainer.parentElement?.textContent).toContain('xyz')
  })

  test('THREE occurrences + dead context is still null (the rule is not accidentally two-specific)', () => {
    const doc = docFrom(repeated)
    expect(findRange('Revenue is up.', doc, { prefix: 'Totally absent9', suffix: '' })).toBeNull()
  })

  // REGRESSION (B3a shipped a guard that could not fire): `selectionContext` ALWAYS captures a
  // prefix ending in whitespace and a suffix starting with whitespace (the separator between the
  // quote and its neighbour), and so does the real DOM text on either side of any occurrence. Scored
  // on the raw (untrimmed) strings, that shared boundary space alone was worth 1 point per side — a
  // context that reproduces NOTHING else still scored 2, never the 0 the "orphan it" guard checked
  // for. Two occurrences here share ONLY that boundary space with a gibberish context: on the OLD
  // scoring this resolves (non-null, occurrence #1) — that is the bug, proved live in a browser at
  // /samuel-lawerence/b4-badges. Comparing `.trimEnd()`/`.trimStart()` scores the shared space 0 on
  // both sides, so the guard finally sees the 0 it was always meant to and orphans the anchor.
  test('REGRESSION: sharing ONLY the boundary whitespace must not anchor a dead context', () => {
    const doc = docFrom('<p>Alpha lead. The duplicated sentence appears twice. Alpha tail.</p><p>Beta lead. The duplicated sentence appears twice. Beta tail.</p>')
    const ctx = { prefix: 'zzzz nothing like this exists zzzz ', suffix: ' qqqq neither does this qqqq' }
    expect(findRange('The duplicated sentence appears twice.', doc, ctx)).toBeNull()
  })

  test('a genuine context match still wins over a dead-gibberish sibling and lands on the correct (second) occurrence', () => {
    // Mirrors the real-browser repro: two threads anchored to the same duplicated sentence, one with
    // a context that genuinely describes the SECOND occurrence, the other pure gibberish.
    const doc = docFrom('<p>Alpha lead. The duplicated sentence appears twice. Alpha tail.</p><p>Beta lead. The duplicated sentence appears twice. Beta tail.</p>')
    const range = findRange('The duplicated sentence appears twice.', doc, { prefix: 'Beta lead. ', suffix: ' Beta tail.' })!
    expect(range).not.toBeNull()
    expect(range.startContainer.parentElement?.textContent).toContain('Beta')
  })

  test('a whitespace-only stored context ({prefix:" ",suffix:" "}) is NO context — first occurrence, not null', () => {
    // collapseWhitespace(' ') is ' ', which is truthy, so this must be decided on the TRIMMED value:
    // a context that carries no positional information keeps first-match behaviour like any
    // pre-context thread, rather than scoring 0 (now that boundary whitespace is trimmed away) and
    // being wrongly orphaned.
    const doc = docFrom('<p>Alpha section. Revenue is up. tail</p><p>Beta section. Revenue is up. tail</p>')
    const range = findRange('Revenue is up.', doc, { prefix: ' ', suffix: ' ' })!
    expect(range).not.toBeNull()
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
    expect(ctx.prefix.length).toBeLessThanOrEqual(TEXT_CONTEXT_LIMIT)
    expect(ctx.suffix.length).toBeLessThanOrEqual(TEXT_CONTEXT_LIMIT)
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

  test('an end boundary after a block keeps only text after the quote in the suffix', () => {
    const doc = docFrom('<p>lead in text. Revenue is up.</p><p>after words here.</p>')
    const p = doc.querySelector('p')!
    const range = rangeOver(doc, 'Revenue is up.')
    range.setEnd(p, p.childNodes.length)

    const ctx = selectionContext(range, doc)
    expect(ctx).toEqual({ prefix: 'lead in text. ', suffix: 'after words here.' })
    expect(ctx.suffix).not.toContain('Revenue is up.')
  })

  test('an inline-child start boundary captures the adjacent prefix and round-trips a repeated quote', () => {
    const filler = 'x'.repeat(TEXT_CONTEXT_LIMIT + 1)
    const html = `<p>Alpha lead <em>Revenue is up.</em> tail</p><div>${filler}</div><p>Beta lead <em>Revenue is up.</em> tail</p>`
    const doc = docFrom(html)
    const target = doc.querySelectorAll('p')[1]!
    const quote = target.querySelector('em')!.firstChild!
    const range = doc.createRange()
    range.setStart(target, 1)
    range.setEnd(quote, quote.textContent!.length)

    const ctx = selectionContext(range, doc)
    expect(ctx.prefix.endsWith('Beta lead ')).toBe(true)
    const reopened = docFrom(html)
    const found = findRange('Revenue is up.', reopened, ctx)!
    expect(found.startContainer.parentElement?.parentElement).toBe(reopened.querySelectorAll('p')[1])
  })

  test('a multi-element selection maps both element boundaries around the selected quote', () => {
    const filler = 'x'.repeat(TEXT_CONTEXT_LIMIT + 1)
    const html = `<p>Alpha lead <em>Revenue is </em></p><p><strong>up.</strong> tail</p><div>${filler}</div><p>Beta lead <em>Revenue is </em></p><p><strong>up.</strong> after words here.</p>`
    const doc = docFrom(html)
    const paragraphs = doc.querySelectorAll('p')
    const range = doc.createRange()
    range.setStart(paragraphs[2]!, 1)
    range.setEnd(paragraphs[3]!, 1)

    const ctx = selectionContext(range, doc)
    expect(ctx.suffix.startsWith(' after words here.')).toBe(true)
    expect(ctx.suffix).not.toContain('Revenue is up.')
    const reopened = docFrom(html)
    const found = findRange('Revenue is up.', reopened, ctx)!
    expect(found.startContainer.parentElement?.parentElement).toBe(reopened.querySelectorAll('p')[2])
  })
})

describe('selectionContext — a selection whose edges are not exactly the quote', () => {
  // The stored quote is TRIMMED (`normalizeText`), but the range a drag hands us — or a Chrome
  // double-click, which routinely grabs the adjacent space — is not. Context sliced from those raw
  // edges puts the separating space on the wrong side of the boundary, so at paint time NO
  // occurrence shares a single character with the stored prefix/suffix, every score ties at 0, and
  // the FIRST occurrence wins — the exact bug this feature exists to prevent.
  const QUOTE = 'Revenue is up.'
  const filler = 'x'.repeat(200)

  /** A range over `QUOTE` inside `node`, widened by whole characters on each side. */
  function padded(node: Text, pad: { before?: number; after?: number }): Range {
    const i = node.data.indexOf(QUOTE)
    const range = (node.ownerDocument as Document).createRange()
    range.setStart(node, i - (pad.before ?? 0))
    range.setEnd(node, i + QUOTE.length + (pad.after ?? 0))
    return range
  }

  /** Capture context from the SECOND paragraph of `html`, then re-find the quote in a fresh copy of
   *  the same document — the paint-time path. Returns the paragraph index it landed on. */
  function reFoundParagraph(html: string, pad: { before?: number; after?: number }): number {
    const doc = docFrom(html)
    const target = doc.querySelectorAll('p')[1]!.firstChild as Text
    const ctx = selectionContext(padded(target, pad), doc)
    const reopened = docFrom(html)
    const found = findRange(QUOTE, reopened, ctx)!
    return Array.from(reopened.querySelectorAll('p')).indexOf(found.startContainer.parentElement as Element)
  }

  test('a trailing-space edge still lands on the selected occurrence (suffix decides)', () => {
    // Identical lead-ins, so ONLY the suffix can tell the two occurrences apart.
    const html = `<div>${filler}</div><p>same lead ${QUOTE} alpha tail</p><div>${filler}</div><p>same lead ${QUOTE} beta tail</p>`
    expect(reFoundParagraph(html, { after: 1 })).toBe(1)
  })

  test('a leading-space edge still lands on the selected occurrence (prefix decides)', () => {
    // Identical tails, so ONLY the prefix can tell the two occurrences apart.
    const html = `<p>alpha lead ${QUOTE} same tail</p><div>${filler}</div><p>beta lead ${QUOTE} same tail</p>`
    expect(reFoundParagraph(html, { before: 1 })).toBe(1)
  })

  test('spaces on BOTH edges still land on the selected occurrence', () => {
    const html = `<p>alpha lead ${QUOTE} alpha tail</p><div>${filler}</div><p>beta lead ${QUOTE} beta tail</p>`
    expect(reFoundParagraph(html, { before: 1, after: 1 })).toBe(1)
  })

  test('the captured context is the same whether or not the edges include the spaces', () => {
    const html = `<p>alpha lead ${QUOTE} alpha tail</p><div>${filler}</div><p>beta lead ${QUOTE} beta tail</p>`
    const doc = docFrom(html)
    const target = doc.querySelectorAll('p')[1]!.firstChild as Text
    const exact = selectionContext(padded(target, {}), doc)
    expect(selectionContext(padded(target, { before: 1, after: 1 }), doc)).toEqual(exact)
  })
})

describe('selectionContext — boundaries that map to no indexed text', () => {
  test('a selection inside non-rendered text yields no context at all', () => {
    // A <script>'s text is never indexed, so neither boundary has a folded position. Degrading to
    // an empty context is what makes the thread anchor the way it did before context existed;
    // treating the missing offset as 0 would store the START of the document as its suffix.
    const doc = docFrom('<script>hidden words</script><p>visible text</p>')
    const script = doc.querySelector('script')!.firstChild as Text
    const range = doc.createRange()
    range.setStart(script, 0)
    range.setEnd(script, script.data.length)
    expect(selectionContext(range, doc)).toEqual({ prefix: '', suffix: '' })
  })
})

describe('sharedTextIndex — ONE index per DOM version', () => {
  // Painting N anchors used to walk the whole document N times (findRange rebuilt the index every
  // call). The index is now built once per DOM VERSION and only an explicit newEpoch() rebuilds it.
  // Which events call newEpoch() (and which deliberately do not) is reflow.ts's — see reflow.test.ts.

  test('repeated reads reuse ONE index; a version bump replaces it', () => {
    const doc = docFrom('<p>alpha text</p>')
    const first = sharedTextIndex(doc)
    findRange('alpha text', doc)
    expect(sharedTextIndex(doc)).toBe(first) // no rebuild: same DOM version
    newEpoch()
    expect(sharedTextIndex(doc)).not.toBe(first)
  })

  test('a version bump rebuilds, and the rebuilt index SEES text inserted since', () => {
    const doc = docFrom('<p>first sentence.</p>')
    expect(findRange('first sentence.', doc)).not.toBeNull() // builds the index
    doc.body.insertAdjacentHTML('beforeend', '<p>added later.</p>')
    expect(findRange('added later.', doc)).toBeNull() // still the cached index — no rebuild
    newEpoch()
    expect(findRange('added later.', doc)!.toString()).toBe('added later.') // rebuilt, sees the insert
  })

  test('findRange and selectionContext at the same version read the SAME index', () => {
    // The painter and the capture must never disagree about what the document says: a mutation
    // between the two, with no version bump, must be invisible to BOTH.
    const doc = docFrom('<p>lead in. Revenue is up. tail.</p>')
    const range = findRange('Revenue is up.', doc)!
    doc.body.insertAdjacentHTML('afterbegin', '<p>injected lead.</p>')
    expect(selectionContext(range, doc).prefix).toBe('lead in. ')
  })

  test('the cache is a SINGLE slot — another document evicts, it never aliases', () => {
    // A page has one document, so one slot is right; what must never happen is doc b reading doc a's
    // index. Asserting the eviction (not just "they differ") is what makes this test say something:
    // buildTextIndex returns a fresh object every call, so "they differ" is true either way.
    const a = docFrom('<p>doc a</p>')
    const b = docFrom('<p>doc b</p>')
    const firstA = sharedTextIndex(a)
    expect(sharedTextIndex(b)).not.toBe(firstA)
    expect(sharedTextIndex(a)).not.toBe(firstA) // evicted by b, rebuilt
    expect(findRange('doc b', b)!.toString()).toBe('doc b')
    expect(findRange('doc a', b)).toBeNull()
  })

  test('an index read one beat after the text shrank clamps, it does not throw', () => {
    // The index describes a DOM VERSION and a MutationObserver delivers in a microtask, so an
    // in-place write followed by a re-find in the SAME task still reads the old offsets. Past the
    // live data length that is an IndexSizeError out of range.setStart — thrown inside a paint or a
    // rAF, uncaught, killing painting and badge emission for the rest of the session.
    const doc = docFrom('<p>alpha beta gamma</p>')
    expect(findRange('gamma', doc)).not.toBeNull() // builds the index at the full length
    const text = doc.querySelector('p')!.firstChild as Text
    text.data = 'ab' // shrinks under the cached index; no epoch bump yet
    const range = findRange('gamma', doc)
    expect(range).not.toBeNull()
    expect(range!.toString()).toBe('') // clamped to the end of what is actually there
    newEpoch()
    expect(findRange('gamma', doc)).toBeNull() // and the next version has the truth
  })
})

describe('describeElement — tag + human preview + bounded fallback', () => {
  test('prefers aria-label / alt / title over text', () => {
    const doc = docFrom('<button aria-label="Close dialog">X</button>')
    expect(describeElement(doc.querySelector('button')!)).toEqual({
      tag: 'button',
      preview: 'Close dialog',
      textFallback: 'X',
    })
  })

  test('falls back to collapsed text, then to the tag', () => {
    const doc = docFrom('<p>  hello   world  </p><svg></svg>')
    expect(describeElement(doc.querySelector('p')!)).toEqual({
      tag: 'p',
      preview: 'hello world',
      textFallback: 'hello world',
    })
    expect(describeElement(doc.querySelector('svg')!)).toEqual({ tag: 'svg', preview: 'svg', textFallback: '' })
  })

  test('bounds a huge preview / fallback', () => {
    const doc = docFrom(`<p>${'x'.repeat(1000)}</p>`)
    const d = describeElement(doc.querySelector('p')!)
    expect(d.preview.length).toBe(120)
    expect(d.textFallback.length).toBe(400)
  })
})
