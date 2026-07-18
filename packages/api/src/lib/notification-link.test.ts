import { describe, expect, test } from 'bun:test'
import { encodePathSegments, notificationLink } from './notification-link'

// S5: the API-mirrored deep link. Absolute URL == join(appUrl, viewer href): encoded path segments,
// review=1 always, thread= only when set, trailing-slash appUrl never doubles the slash. Mirrors
// web/src/lib/mentions.ts notificationHref (packages don't cross-import) but joins an absolute APP_URL.
describe('notificationLink (S5)', () => {
  const appUrl = 'https://glance.example.com'

  test('encodePathSegments encodes ? and # per segment, keeps slashes', () => {
    expect(encodePathSegments('Q3?Report.html')).toBe('Q3%3FReport.html')
    expect(encodePathSegments('notes#draft.html')).toBe('notes%23draft.html')
    expect(encodePathSegments('my file.html')).toBe('my%20file.html')
    expect(encodePathSegments('nested/p.html')).toBe('nested/p.html')
  })

  test('null filePath → site root + review=1, no thread', () => {
    expect(notificationLink(appUrl, { siteLabel: 'acme/doc', filePath: null, threadId: null })).toBe(
      'https://glance.example.com/acme/doc?review=1',
    )
  })

  test('thread= present only when threadId set', () => {
    expect(notificationLink(appUrl, { siteLabel: 'acme/doc', filePath: null, threadId: 't1' })).toBe(
      'https://glance.example.com/acme/doc?thread=t1&review=1',
    )
  })

  test('filePath variants are segment-encoded and leading slashes stripped', () => {
    const cases: Array<[string, string]> = [
      ['Q3?Report.html', 'Q3%3FReport.html'],
      ['notes#draft.html', 'notes%23draft.html'],
      ['my file.html', 'my%20file.html'],
      ['/nested/p.html', 'nested/p.html'],
    ]
    for (const [filePath, encoded] of cases) {
      expect(notificationLink(appUrl, { siteLabel: 'acme/doc', filePath, threadId: 't1' })).toBe(
        `https://glance.example.com/acme/doc/${encoded}?thread=t1&review=1`,
      )
    }
  })

  test('trailing-slash appUrl yields no doubled slash', () => {
    expect(notificationLink('https://glance.example.com/', { siteLabel: 'acme/doc', filePath: null, threadId: null })).toBe(
      'https://glance.example.com/acme/doc?review=1',
    )
  })

  test('missing siteLabel degrades to the absolute root', () => {
    expect(notificationLink(appUrl, { siteLabel: null, filePath: 'x.html', threadId: 't1' })).toBe(
      'https://glance.example.com/',
    )
  })
})
