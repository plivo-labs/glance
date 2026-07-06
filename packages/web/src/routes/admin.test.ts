import { describe, expect, test } from 'bun:test'
import { overflowPage } from './admin'

// Pure page-overflow decision behind the admin sites loader's clamp (#36): a requested page past
// the last available page (e.g. after deleting the last row of the last page) redirects to the
// last valid page; an in-range page is left alone.
const data = (over: { total: number; page: number; pageSize?: number }) => ({
  sites: [],
  page: over.page,
  pageSize: over.pageSize ?? 50,
  total: over.total,
})

describe('overflowPage', () => {
  test('in-range page → no redirect', () => {
    expect(overflowPage(data({ total: 120, page: 1 }))).toBeNull() // 3 pages, on page 1
    expect(overflowPage(data({ total: 120, page: 3 }))).toBeNull() // last page exactly
  })

  test('page past the end → clamp to the last valid page', () => {
    // 120 sites / 50 = 3 pages; deleting the last row of page 3 (now 101 → still 3) is fine, but
    // dropping below a page boundary strands page 3 → clamp back.
    expect(overflowPage(data({ total: 100, page: 3 }))).toBe(2) // now 2 pages, was on 3
    expect(overflowPage(data({ total: 51, page: 3 }))).toBe(2) // 2 pages
  })

  test('empty table clamps to page 1 (never 0)', () => {
    expect(overflowPage(data({ total: 0, page: 2 }))).toBe(1)
    expect(overflowPage(data({ total: 0, page: 1 }))).toBeNull() // first page of an empty set is valid
  })
})
