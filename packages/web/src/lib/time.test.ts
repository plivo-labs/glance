import { describe, expect, test } from 'bun:test'
import { timeAgo } from './time'

// Pure helper: build an ISO string N seconds in the past and assert the compact label. Ages must
// FLOOR, never round up (the #58 bug: Math.round made 90s → "2m", 36h → "2d").
const ago = (secs: number): string => timeAgo(new Date(Date.now() - secs * 1000).toISOString())

const MIN = 60
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('timeAgo', () => {
  test('sub-minute reads "just now"', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(59)).toBe('just now')
  })

  test('floors minutes — 90s is 1m, not 2m', () => {
    expect(ago(90)).toBe('1m ago')
    expect(ago(60)).toBe('1m ago')
    expect(ago(119)).toBe('1m ago')
  })

  test('floors hours — 36h is 1d, not 2d', () => {
    expect(ago(36 * HOUR)).toBe('1d ago')
    expect(ago(HOUR)).toBe('1h ago')
    expect(ago(90 * MIN)).toBe('1h ago')
  })

  test('floors days up to the 30-day cutoff', () => {
    expect(ago(DAY)).toBe('1d ago')
    expect(ago(29 * DAY)).toBe('29d ago')
  })

  test('at/after 30 days falls back to an absolute date', () => {
    const label = ago(31 * DAY)
    expect(label).not.toMatch(/ago$/)
    expect(label).toBe(new Date(Date.now() - 31 * DAY * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
  })
})
