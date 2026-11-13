import { describe, expect, test } from 'bun:test'
import { type PdfOptions, parsePdfQuery, pdfDisposition, pdfPagePath, pdfPlan } from './pdf'

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
