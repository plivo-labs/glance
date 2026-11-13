import { describe, expect, test } from 'bun:test'
import { splitSnippet } from './snippet'

describe('splitSnippet', () => {
  test('marks every typed word case-insensitively; punctuation and regex characters in the query are inert', () => {
    const parts = splitSnippet('Billing runs a bill cycle', 'bill billing')
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Billing', 'bill'])
    expect(parts.map((p) => p.text).join('')).toBe('Billing runs a bill cycle')
    expect(splitSnippet('a (b) c.* d', '(b) .* [')).toEqual([{ text: 'a (b) c.* d', hit: false }])
  })
})
