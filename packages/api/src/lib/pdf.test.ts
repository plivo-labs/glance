import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { containsToken, type PdfOptions, parsePdfQuery, pdfDisposition, pdfPagePath, pdfPlan, redactToken, rewriteLinksScript, titleScript } from './pdf'

const base: PdfOptions = { scheme: 'light', themeHref: null }

describe('parsePdfQuery', () => {
  test('defaults to light, with no theme override', () => {
    expect(parsePdfQuery({})).toEqual(base)
  })

  test('an unknown value is an error, never a silent default', () => {
    for (const q of [{ scheme: 'sepia' }, { theme: 'https://evil.example.com/x.css' }]) {
      expect(parsePdfQuery(q)).toHaveProperty('error')
    }
    expect(parsePdfQuery({ theme: '/_glance/theme/kapow.css?v=ab12' })).toMatchObject({ themeHref: '/_glance/theme/kapow.css?v=ab12' })
  })
})

describe('pdfPlan', () => {
  test('is always A4 with 15mm margins, and follows the viewer\'s light/dark', () => {
    expect(pdfPlan(base)).toMatchObject({ width: '210mm', height: '297mm', margin: { top: '15mm', left: '15mm' }, viewportWidth: 680, scheme: 'light' })
    expect(pdfPlan({ ...base, scheme: 'dark' }).scheme).toBe('dark')
  })
})

describe('pdfPagePath / pdfDisposition', () => {
  test('only documents, never out of the site, and the URL parts are encoded', () => {
    expect(pdfPagePath(undefined)).toBe('')
    expect(pdfPagePath('docs/a b.html')).toBe('docs/a%20b.html')
    expect(pdfPagePath('notes.MD')).toBe('notes.MD')
    for (const bad of ['../x.html', 'a//b.html', './a.html', 'pic.png', 'a\\b.html', 'a.html/']) expect(pdfPagePath(bad)).toBeNull()
  })

  test('the file name is the title, safe for a header, with the UTF-8 form alongside', () => {
    expect(pdfDisposition('Q3: "plan"', 'slug')).toBe(`attachment; filename="Q3 plan.pdf"; filename*=UTF-8''Q3%20plan.pdf`)
    expect(pdfDisposition('R\u00e9sum\u00e9', 'slug')).toContain(`filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`)
    expect(pdfDisposition(null, 'slug')).toContain('filename="slug.pdf"')
  })
})

describe('rewriteLinksScript', () => {
  const PAGE = 'https://content.example.com/_t/SECRET.TOKEN/docs/site/guide/page.html'
  const FROM = 'https://content.example.com/_t/SECRET.TOKEN/'
  const TO = 'https://app.example.com/'

  /** Runs the script in a page at PAGE and returns each link's href attribute afterwards. */
  function links(html: string): string[] {
    const win = new Window({ url: PAGE })
    win.document.body.innerHTML = html
    // happy-dom has no eval: hand the script the page's own document and location.
    new Function('document', 'location', `return ${rewriteLinksScript(FROM, TO)}`)(win.document, win.location)
    return Array.from(win.document.querySelectorAll('a'), (a) => a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '')
  }

  test('a link to this very page, or to a sibling site, leaves the token behind', () => {
    expect(links('<a href="page.html">self</a><a href="">empty</a><a href="../../other/x.html">sibling</a><a href="/_t/SECRET.TOKEN/docs/site/y.html">abs</a>')).toEqual([
      'https://app.example.com/docs/site/guide/page.html',
      'https://app.example.com/docs/site/guide/page.html',
      'https://app.example.com/docs/other/x.html',
      'https://app.example.com/docs/site/y.html',
    ])
  })

  test('a jump to a target that exists stays a jump; a missing target is rewritten like any link', () => {
    expect(links('<h2 id="intro">x</h2><a href="#intro">a</a><a href="page.html#intro">b</a><a href="#gone">c</a><a href="#">d</a>')).toEqual([
      '#intro',
      'page.html#intro',
      'https://app.example.com/docs/site/guide/page.html#gone',
      'https://app.example.com/docs/site/guide/page.html#',
    ])
  })

  test('an SVG link is rewritten too, and links that are not ours are left alone', () => {
    expect(
      links('<svg><a xlink:href="../../other/d.html"><text>t</text></a></svg><a href="https://example.org/p">ext</a><a href="mailto:a@b.co">m</a><a name="anchor">n</a>'),
    ).toEqual(['https://app.example.com/docs/other/d.html', 'https://example.org/p', 'mailto:a@b.co', ''])
  })
})

describe('titleScript', () => {
  const run = (html: string) => {
    const win = new Window({ url: 'https://content.example.com/_t/SECRET.TOKEN/docs/site/index.html' })
    win.document.documentElement.innerHTML = html
    new Function('document', `return ${titleScript('Q3 report')}`)(win.document)
    return win.document.title
  }

  test('a page without a title is named for the site, never for its tokened URL; its own title wins', () => {
    expect(run('<head></head><body>x</body>')).toBe('Q3 report')
    expect(run('<head><title>  </title></head><body>x</body>')).toBe('Q3 report')
    expect(run('<head><title>Mine</title></head><body>x</body>')).toBe('Mine')
  })
})

describe('redactToken / containsToken', () => {
  test('a quoted content URL loses its token, and a message without one is untouched', () => {
    expect(redactToken('net::ERR_ABORTED at https://c.example.com/_t/AAA.bbb_CC-d/docs/site/a.html')).toBe('net::ERR_ABORTED at https://c.example.com/_t/<redacted>/docs/site/a.html')
    expect(redactToken('goto https://c.example.com/_t/AAA.bbb?x=1 failed')).toBe('goto https://c.example.com/_t/<redacted>?x=1 failed')
    expect(redactToken('browser down')).toBe('browser down')
  })

  test('finds the token anywhere in the bytes, and nothing when it is absent or truncated', () => {
    const bytes = (s: string) => new TextEncoder().encode(s)
    expect(containsToken(bytes('%PDF /URI (https://c/_t/AAA.bbb/x)'), 'AAA.bbb')).toBe(true)
    expect(containsToken(bytes('AAA.bbb'), 'AAA.bbb')).toBe(true)
    expect(containsToken(bytes('%PDF /URI (https://app/x) AAA.bb'), 'AAA.bbb')).toBe(false)
    expect(containsToken(bytes(''), 'AAA.bbb')).toBe(false)
    expect(containsToken(bytes('anything'), '')).toBe(false)
  })
})
