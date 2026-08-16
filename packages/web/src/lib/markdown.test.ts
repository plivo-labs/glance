import { describe, expect, test } from 'bun:test'
import { renderMarkdown } from './markdown'

// Client-side twin of packages/api/src/lib/markdown.ts — same hardened config, so the same three
// hazards are pinned here: raw HTML, and a dangerous URL scheme in a link.

describe('renderMarkdown', () => {
  test('renders bullets, bold, and code', () => {
    const html = renderMarkdown('- item one\n- item two\n\n**bold** and `code`')
    expect(html).toContain('<li>item one</li>')
    expect(html).toContain('<li>item two</li>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
  })

  test('escapes raw HTML instead of passing it through', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('neutralizes a javascript: href', () => {
    const html = renderMarkdown('[x](javascript:alert(1))')
    expect(html).not.toContain('javascript:alert')
    expect(html).toContain('href="#"')
  })
})
