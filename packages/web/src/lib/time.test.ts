import { describe, expect, test } from 'bun:test'
import { timeAgo } from './time'

// Pure helper: build an ISO string N seconds in the past and assert the label. Ages must FLOOR,
// never round up (the #58 bug: Math.round made 90s → "2 minutes", 36h → "2 days"). Expected
// labels come from the same Intl.RelativeTimeFormat config so the suite is locale-agnostic.
const ago = (secs: number): string => timeAgo(new Date(Date.now() - secs * 1000).toISOString())
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const MIN = 60
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('timeAgo', () => {
  test('sub-minute reads "now"', () => {
    expect(ago(0)).toBe(rtf.format(0, 'second'))
    expect(ago(59)).toBe(rtf.format(0, 'second'))
  })

  test('floors minutes — 90s is 1 minute, not 2', () => {
    expect(ago(90)).toBe(rtf.format(-1, 'minute'))
    expect(ago(60)).toBe(rtf.format(-1, 'minute'))
    expect(ago(119)).toBe(rtf.format(-1, 'minute'))
  })

  test('floors hours — 36h is 1 day, not 2', () => {
    expect(ago(36 * HOUR)).toBe(rtf.format(-1, 'day'))
    expect(ago(HOUR)).toBe(rtf.format(-1, 'hour'))
    expect(ago(90 * MIN)).toBe(rtf.format(-1, 'hour'))
  })

  test('floors days up to the 30-day cutoff', () => {
    expect(ago(DAY)).toBe(rtf.format(-1, 'day'))
    expect(ago(29 * DAY)).toBe(rtf.format(-29, 'day'))
  })

  test('at/after 30 days falls back to an absolute date', () => {
    const label = ago(31 * DAY)
    expect(label).not.toMatch(/ago$/)
    expect(label).toBe(new Date(Date.now() - 31 * DAY * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
  })
})
