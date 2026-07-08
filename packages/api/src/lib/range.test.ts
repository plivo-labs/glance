import { describe, expect, test } from 'bun:test'
import { decideRange, parseByteRange } from './range'

describe('parseByteRange', () => {
  test('bounded, open-ended, and suffix specs resolve against total', () => {
    expect(parseByteRange('bytes=0-1', 16)).toEqual({ kind: 'single', start: 0, end: 1 })
    expect(parseByteRange('bytes=4-', 16)).toEqual({ kind: 'single', start: 4, end: 15 })
    expect(parseByteRange('bytes=-4', 16)).toEqual({ kind: 'single', start: 12, end: 15 })
  })
  test('an end past total clamps to the last byte', () => {
    expect(parseByteRange('bytes=0-999', 16)).toEqual({ kind: 'single', start: 0, end: 15 })
  })
  test('start at/past total is unsatisfiable', () => {
    expect(parseByteRange('bytes=16-', 16)).toEqual({ kind: 'unsatisfiable' })
  })
  test('a zero-length suffix is unsatisfiable', () => {
    expect(parseByteRange('bytes=-0', 16)).toEqual({ kind: 'unsatisfiable' })
  })
  test('comma-separated multi-range is reported distinctly (caller serves the full body)', () => {
    expect(parseByteRange('bytes=0-1,4-5', 16)).toEqual({ kind: 'multi' })
  })
  test('missing header, wrong unit, or a garbage spec → none (ignored, not unsatisfiable)', () => {
    expect(parseByteRange(undefined, 16)).toEqual({ kind: 'none' })
    expect(parseByteRange('items=0-1', 16)).toEqual({ kind: 'none' })
    expect(parseByteRange('bytes=abc', 16)).toEqual({ kind: 'none' })
  })
  test('last-byte-pos before first-byte-pos is invalid → ignored, not unsatisfiable', () => {
    expect(parseByteRange('bytes=10-5', 16)).toEqual({ kind: 'none' })
  })
})

describe('decideRange — status + header decision shared by both serving paths', () => {
  test('no/garbage/multi range → 200, no range headers set', () => {
    const h = new Headers()
    expect(decideRange(undefined, 16, h)).toEqual({ status: 200 })
    expect(decideRange('bytes=0-1,4-5', 16, h)).toEqual({ status: 200 })
    expect(h.get('content-range')).toBeNull()
  })
  test('single spec → 206 with inclusive bounds + content-range/length', () => {
    const h = new Headers()
    expect(decideRange('bytes=0-3', 8, h)).toEqual({ status: 206, start: 0, end: 3 })
    expect(h.get('content-range')).toBe('bytes 0-3/8')
    expect(h.get('content-length')).toBe('4')
  })
  test('unsatisfiable → 416 with content-range: bytes */total', () => {
    const h = new Headers()
    expect(decideRange('bytes=99-', 8, h)).toEqual({ status: 416 })
    expect(h.get('content-range')).toBe('bytes */8')
  })
})
