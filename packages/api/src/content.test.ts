import { describe, expect, test } from 'bun:test'
import { contentType, markdown, normalizePath, restOf } from './content'
import { sanitizePath } from './lib/storage'
import { signToken, verifyToken } from './lib/token'

const secret = 'test-secret'
const userId = 'user-123'
const scope = 'sam/site'

describe('signToken / verifyToken (user-bound)', () => {
  test('valid token returns the bound userId for the right user/space/site', async () => {
    const t = await signToken(secret, userId, scope, 300)
    expect(await verifyToken(secret, scope, t)).toBe(userId)
  })
  test('wrong scope (different space/site) is rejected', async () => {
    const t = await signToken(secret, userId, scope, 300)
    expect(await verifyToken(secret, 'sam/other', t)).toBeNull()
  })
  test('expired token is rejected', async () => {
    const t = await signToken(secret, userId, scope, -1)
    expect(await verifyToken(secret, scope, t)).toBeNull()
  })
  test('token signed with a different secret is rejected', async () => {
    const t = await signToken(secret, userId, scope, 300)
    expect(await verifyToken('other-secret', scope, t)).toBeNull()
  })
  test('tampered MAC is rejected', async () => {
    const t = await signToken(secret, userId, scope, 300)
    expect(await verifyToken(secret, scope, `${t.slice(0, -2)}xx`)).toBeNull()
  })
  test('tampered userId segment is rejected (binding covers userId)', async () => {
    const t = await signToken(secret, userId, scope, 300)
    const [exp, , mac] = t.split('.')
    const forged = `${exp}.${btoa('user-999').replace(/=+$/, '')}.${mac}`
    expect(await verifyToken(secret, scope, forged)).toBeNull()
  })
  test('null / malformed tokens are rejected', async () => {
    expect(await verifyToken(secret, scope, null)).toBeNull()
    expect(await verifyToken(secret, scope, undefined)).toBeNull()
    expect(await verifyToken(secret, scope, 'garbage')).toBeNull()
    expect(await verifyToken(secret, scope, 'a.b')).toBeNull()
  })
})

describe('markdown XSS neutralization', () => {
  test('<script> blocks are escaped, not active', async () => {
    const html = await markdown.parse('# Hi\n\n<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
  test('inline event-handler HTML (<img onerror>) is escaped (inert, not a real tag)', async () => {
    const html = await markdown.parse('text <img src=x onerror=alert(1)> more')
    // The raw tag must not survive as a live element — its angle brackets are escaped, so
    // the browser sees inert text, not an <img> that can fire onerror.
    expect(html).not.toContain('<img src=x onerror')
    expect(html).toContain('&lt;img')
  })
  test('normal markdown still renders (headings, links, images, code, tables)', async () => {
    const html = await markdown.parse(
      '# Title\n\n[link](https://example.com)\n\n![alt](https://example.com/a.png)\n\n```\ncode\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    )
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<a href="https://example.com">link</a>')
    expect(html).toContain('<img src="https://example.com/a.png" alt="alt">')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('<table>')
  })
})

describe('normalizePath', () => {
  test('directory paths map to index.html', () => {
    expect(normalizePath('')).toBe('index.html')
    expect(normalizePath('docs/')).toBe('docs/index.html')
  })
  test('file paths pass through', () => {
    expect(normalizePath('a/b/page.html')).toBe('a/b/page.html')
  })
  test('rejects path traversal: .. and . segments are stripped', () => {
    expect(normalizePath('../../etc/passwd')).toBe('etc/passwd')
    expect(normalizePath('a/../../b')).toBe('a/b')
    expect(normalizePath('./a/./b')).toBe('a/b')
  })
  test('leading-slash collapses (no absolute escape)', () => {
    expect(normalizePath('/etc/passwd')).toBe('etc/passwd')
  })
})

describe('restOf', () => {
  test('skips the leading path segments and preserves a trailing slash', () => {
    expect(restOf('https://x/sp/st/docs/', 2)).toBe('docs/')
    expect(restOf('https://x/_t/tok/sp/st/a/b.html', 4)).toBe('a/b.html')
  })
  test('decodes percent-encoding', () => {
    expect(restOf('https://x/sp/st/a%20b.html', 2)).toBe('a b.html')
  })
  test('does not let encoded traversal escape once normalized', () => {
    // The WHATWG URL parser already resolves %2e%2e ("..") during parsing, and
    // normalizePath strips any residual "."/".." segments — so a traversal attempt can
    // never climb out of the site prefix, whatever the exact resolved file ends up being.
    expect(normalizePath(restOf('https://x/sp/st/%2e%2e/secret', 2))).not.toContain('..')
  })
})

describe('sanitizePath (upload-time R2 key hardening)', () => {
  test('strips .. and . segments', () => {
    expect(sanitizePath('../../etc/passwd')).toBe('etc/passwd')
    expect(sanitizePath('a/./b/../c')).toBe('a/b/c')
  })
  test('collapses leading slash (no absolute paths)', () => {
    expect(sanitizePath('/etc/passwd')).toBe('etc/passwd')
  })
  test('normalizes backslashes and drops empty segments', () => {
    expect(sanitizePath('a\\b\\c')).toBe('a/b/c')
    expect(sanitizePath('a//b')).toBe('a/b')
  })
})

describe('contentType', () => {
  test('textual types pin charset=utf-8 (no latin-1 mojibake)', () => {
    expect(contentType('index.html', null)).toBe('text/html; charset=utf-8')
    expect(contentType('app.js', null)).toBe('text/javascript; charset=utf-8')
    expect(contentType('data.json', null)).toBe('application/json; charset=utf-8')
    expect(contentType('logo.svg', null)).toBe('image/svg+xml; charset=utf-8')
    expect(contentType('notes.txt', null)).toBe('text/plain; charset=utf-8')
  })
  test('binary types are left untouched', () => {
    expect(contentType('photo.png', null)).toBe('image/png')
    expect(contentType('font.woff2', null)).toBe('font/woff2')
    expect(contentType('blob', null)).toBe('application/octet-stream')
  })
  test('falls back to the stored type (charset-pinned when textual)', () => {
    expect(contentType('weird.ext', 'text/csv')).toBe('text/csv; charset=utf-8')
    expect(contentType('weird.ext', 'application/zip')).toBe('application/zip')
  })
})
