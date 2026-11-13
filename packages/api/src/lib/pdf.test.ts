import { describe, expect, test } from 'bun:test'
import { type PdfOptions, parsePdfQuery, pdfDisposition, pdfPagePath, pdfPlan } from './pdf'

const base: PdfOptions = { size: 'info', look: 'theme', paper: 'a4', scheme: 'light', themeHref: null }

describe('parsePdfQuery', () => {
  test('defaults to an info-size, as-designed, light A4', () => {
    expect(parsePdfQuery({})).toEqual(base)
  })

  test('an unknown value is an error, never a silent default', () => {
    for (const q of [{ size: 'huge' }, { look: 'neon' }, { paper: 'a3' }, { scheme: 'sepia' }, { theme: 'https://evil.example.com/x.css' }]) {
      expect(parsePdfQuery(q)).toHaveProperty('error')
    }
    expect(parsePdfQuery({ theme: '/_glance/theme/kapow.css?v=ab12' })).toMatchObject({ themeHref: '/_glance/theme/kapow.css?v=ab12' })
  })
})

describe('pdfPlan', () => {
  test('info size is real paper with margins; original size is 1280px-wide pages in the paper ratio', () => {
    expect(pdfPlan(base)).toMatchObject({ width: '210mm', height: '297mm', margin: { top: '15mm' }, viewportWidth: 680 })
    expect(pdfPlan({ ...base, paper: 'letter' })).toMatchObject({ width: '215.9mm', margin: { left: '0.6in' } })
    expect(pdfPlan({ ...base, size: 'full' })).toMatchObject({ width: '1280px', height: '1810px', margin: { top: '0' }, viewportWidth: 1280 })
    expect(pdfPlan({ ...base, size: 'full', paper: 'letter' }).height).toBe('1656px')
  })

  test('as designed keeps screen styles, backgrounds and the viewer scheme; simple is plain light print', () => {
    expect(pdfPlan({ ...base, scheme: 'dark' })).toMatchObject({ media: 'screen', scheme: 'dark', printBackground: true })
    expect(pdfPlan({ ...base, look: 'simple', scheme: 'dark' })).toMatchObject({ media: 'print', scheme: 'light', printBackground: false })
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
    expect(pdfDisposition('Résumé', 'slug')).toContain(`filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`)
    expect(pdfDisposition(null, 'slug')).toContain('filename="slug.pdf"')
  })
})
