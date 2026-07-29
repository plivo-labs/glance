import { describe, expect, test } from 'bun:test'
import { sanitizeAvatarUrl, sizedAvatarUrl } from './avatar'

// The host pin is the whole security story of the avatar proxy: whatever survives sanitize is a
// URL this worker will fetch server-side, so anything not an https googleusercontent photo must
// come back null (→ the route 404s → the client renders initials).

describe('sanitizeAvatarUrl', () => {
  test('keeps an https googleusercontent photo', () => {
    const url = 'https://lh3.googleusercontent.com/a/ACg8ocABC=s96-c'
    expect(sanitizeAvatarUrl(url)).toBe(url)
  })

  test('rejects a non-Google host, including a lookalike suffix', () => {
    expect(sanitizeAvatarUrl('https://evil.example.com/pic.png')).toBeNull()
    expect(sanitizeAvatarUrl('https://notgoogleusercontent.com/pic.png')).toBeNull()
    expect(sanitizeAvatarUrl('https://googleusercontent.com.evil.test/pic.png')).toBeNull()
  })

  test('rejects non-https schemes — including the SSRF-flavoured ones', () => {
    expect(sanitizeAvatarUrl('http://lh3.googleusercontent.com/a/pic')).toBeNull()
    expect(sanitizeAvatarUrl('file:///etc/passwd')).toBeNull()
    expect(sanitizeAvatarUrl('data:image/png;base64,AAAA')).toBeNull()
  })

  test('rejects absent, empty, non-string and unparseable values', () => {
    expect(sanitizeAvatarUrl(undefined)).toBeNull()
    expect(sanitizeAvatarUrl('')).toBeNull()
    expect(sanitizeAvatarUrl(42)).toBeNull()
    expect(sanitizeAvatarUrl('lh3.googleusercontent.com/a/pic')).toBeNull()
  })
})

describe('sizedAvatarUrl', () => {
  test('rewrites Google’s size suffix so a 24px UI never fetches the full-size original', () => {
    expect(sizedAvatarUrl('https://lh3.googleusercontent.com/a/pic=s1024-c')).toBe(
      'https://lh3.googleusercontent.com/a/pic=s96-c',
    )
    expect(sizedAvatarUrl('https://lh3.googleusercontent.com/a/pic=s64')).toBe(
      'https://lh3.googleusercontent.com/a/pic=s96-c',
    )
  })

  test('leaves an unrecognized shape alone', () => {
    const plain = 'https://lh3.googleusercontent.com/a/pic'
    expect(sizedAvatarUrl(plain)).toBe(plain)
  })
})
