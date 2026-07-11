import { describe, expect, test } from 'bun:test'
import { RELEASES } from './catalog'
import { countUnread, listReleases, unreadCount } from './query'

const OLD = '2026-01-01T00:00:00.000Z'
const MID = '2026-03-15T12:30:00.000Z'
const NEW = '2026-06-20T09:00:00.000Z'
const three = [{ date: NEW }, { date: MID }, { date: OLD }] // catalog order: newest-first

describe('C1 unread.null — null watermark means everything is unread', () => {
  test('unreadCount(null) over the baked catalog === RELEASES.length', () => {
    expect(unreadCount(null)).toBe(RELEASES.length)
  })
  test('countUnread of a list with a null watermark === list length', () => {
    expect(countUnread(three, null)).toBe(3)
  })
})

describe('C2 unread.count & zero — strictly-> boundary, LITERAL expected counts', () => {
  test('watermark on a MID date → count of strictly-newer (literal 1)', () => {
    expect(countUnread(three, MID)).toBe(1)
  })
  test('watermark on the NEWEST date → 0, not 1', () => {
    expect(countUnread(three, NEW)).toBe(0)
  })
  test('watermark on the OLDEST date → the two strictly-newer (literal 2)', () => {
    expect(countUnread(three, OLD)).toBe(2)
  })
  test('single release: null → 1, equal → 0', () => {
    const one = [{ date: NEW }]
    expect(countUnread(one, null)).toBe(1)
    expect(countUnread(one, NEW)).toBe(0)
  })
})

describe('listReleases returns the baked archive newest-first', () => {
  test('dates are in non-increasing order', () => {
    const dates = listReleases().map((r) => r.date)
    expect([...dates].sort((a, b) => (a < b ? 1 : -1))).toEqual(dates)
  })
})
