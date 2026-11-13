import { describe, expect, test } from 'bun:test'
import { SEARCH_TEXT_CAP, buildSearchText } from './site-search'

describe('buildSearchText', () => {
  const html = (path: string) => ({ path, mimeType: 'text/html' })

  test('entry first, non-text files skipped, unavailable files tolerated', async () => {
    const pages: Record<string, string> = { 'b.html': '<p>second</p>', 'index.html': '<p>first</p>', 'a.css': 'body{}' }
    const files = [html('b.html'), html('index.html'), { path: 'a.css', mimeType: 'text/css' }, html('gone.html')]
    expect(await buildSearchText(files, async (c) => pages[c.path] ?? null, 10)).toBe('first\nsecond')
  })

  test('the per-site cap bounds the text and stops reading further files', async () => {
    let reads = 0
    const big = `<p>${'word '.repeat(9000)}</p>` // ~40k chars of text per file
    const files = Array.from({ length: 20 }, (_, i) => html(`p${i}.html`))
    const text = await buildSearchText(files, async () => {
      reads++
      return big
    }, 20)
    expect(text.length).toBeLessThanOrEqual(SEARCH_TEXT_CAP)
    expect(reads).toBeLessThan(20)
  })
})
