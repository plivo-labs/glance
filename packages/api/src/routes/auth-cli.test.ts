import { describe, expect, test } from 'bun:test'
import { generateUserCode, isCliStartRateLimited } from './auth'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

describe('generateUserCode', () => {
  test('returns the default length', () => {
    expect(generateUserCode()).toHaveLength(8)
  })

  test('honors an explicit length', () => {
    expect(generateUserCode(12)).toHaveLength(12)
  })

  test('uses only the allowed unambiguous uppercase alphabet', () => {
    const allowed = new Set(ALPHABET.split(''))
    for (let i = 0; i < 2000; i++) {
      for (const ch of generateUserCode()) expect(allowed.has(ch)).toBe(true)
    }
  })

  test('excludes easily-confused chars 0/O/1/I', () => {
    const banned = ['0', 'O', '1', 'I']
    const sample = Array.from({ length: 5000 }, () => generateUserCode()).join('')
    for (const ch of banned) expect(sample.includes(ch)).toBe(false)
  })

  test('is non-repeating across many calls (high entropy)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(generateUserCode())
    // Collisions in 5k draws over 32^8 space are astronomically unlikely.
    expect(seen.size).toBe(5000)
  })
})

/** In-memory stand-in for the KV surface the throttle touches. */
function mockKv(): {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  ttls: Map<string, number | undefined>
} {
  const store = new Map<string, string>()
  const ttls = new Map<string, number | undefined>()
  return {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, value, options) => {
      store.set(key, value)
      ttls.set(key, options?.expirationTtl)
      return Promise.resolve()
    },
    ttls,
  }
}

describe('isCliStartRateLimited', () => {
  test('allows up to the limit then blocks', async () => {
    const kv = mockKv()
    for (let i = 0; i < 5; i++) expect(await isCliStartRateLimited(kv, '1.2.3.4', 5, 60)).toBe(false)
    expect(await isCliStartRateLimited(kv, '1.2.3.4', 5, 60)).toBe(true)
  })

  test('throttles per IP independently', async () => {
    const kv = mockKv()
    for (let i = 0; i < 5; i++) await isCliStartRateLimited(kv, 'a', 5, 60)
    expect(await isCliStartRateLimited(kv, 'a', 5, 60)).toBe(true)
    expect(await isCliStartRateLimited(kv, 'b', 5, 60)).toBe(false)
  })

  test('writes the counter with the window ttl', async () => {
    const kv = mockKv()
    await isCliStartRateLimited(kv, '9.9.9.9', 5, 60)
    expect(kv.ttls.get('cli_start_rl:9.9.9.9')).toBe(60)
  })

  test('treats a missing counter as zero', async () => {
    const kv = mockKv()
    expect(await isCliStartRateLimited(kv, 'fresh', 1, 60)).toBe(false)
    expect(await isCliStartRateLimited(kv, 'fresh', 1, 60)).toBe(true)
  })
})
