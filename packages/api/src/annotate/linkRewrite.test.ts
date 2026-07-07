import { describe, expect, test } from 'bun:test'
import { withAnnotateParam } from './linkRewrite'

const base = 'https://example.com/dir/index.html'

describe('withAnnotateParam — same-origin in-frame link rewrite', () => {
  test('same-origin relative link → param added', () => {
    expect(withAnnotateParam('page2.html', base)).toBe('https://example.com/dir/page2.html?glance_annotate=1')
  })

  test('same-origin absolute link → param added', () => {
    expect(withAnnotateParam('https://example.com/other/page.html', base)).toBe(
      'https://example.com/other/page.html?glance_annotate=1',
    )
  })

  test('cross-origin link → untouched (null)', () => {
    expect(withAnnotateParam('https://other.example/page.html', base)).toBeNull()
  })

  test('existing query + hash are preserved', () => {
    expect(withAnnotateParam('page2.html?foo=bar#section', base)).toBe(
      'https://example.com/dir/page2.html?foo=bar&glance_annotate=1#section',
    )
  })

  test('a link that already carries the param is unchanged', () => {
    expect(withAnnotateParam('page2.html?glance_annotate=1', base)).toBe('https://example.com/dir/page2.html?glance_annotate=1')
  })

  test('an unparseable href yields null, never throws', () => {
    expect(withAnnotateParam('http://[not-valid', base)).toBeNull()
  })

  test('a protocol-relative link to another host is cross-origin → untouched', () => {
    expect(withAnnotateParam('//other.example/page.html', base)).toBeNull()
  })
})
